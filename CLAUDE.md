# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PlasmaLLM is a KDE Plasma 6 applet (plasmoid): an LLM chat widget with system awareness, tool calling, and desktop automation. It is **pure QML + QML-flavored JavaScript** — no compiler, no bundler, no package manager, no dependencies. Everything ships as the `package/` directory zipped into a `.plasmoid`. Qt interprets the QML at runtime, so "building" means installing files and restarting the shell.

## Commands

```bash
make install-dev      # symlink package/ into ~/.local/share/plasma/plasmoids/ (use this for dev)
make install          # copy package/ instead of symlinking
make remove           # delete the installed plasmoid (run before reinstalling a release build)
plasmashell --replace &                    # reload the widget after any change
journalctl -u plasmashell --follow         # the only real debugger; console.log lands here

make package          # runs check-translations, then prompts interactively for a version number
make package-no-i18n  # same package build, skips translation gating — use this during development
make translations     # regenerate .pot, msgmerge .po files, compile .mo
make check-translations
make clean
```

There is **no linter and no build step.** `make test` runs `tests/` — plain Node scripts over the `.pragma library` JavaScript (wire formats, SSE parsing, tool-call normalization, the memory store). Node is a development-time requirement only; nothing there ships.

**QML is not covered and cannot be** — it needs a running shell. For anything touching `main.qml` or a config page, verification is still manual: `make install-dev`, restart Plasma, exercise the feature, and read `journalctl`. Do not claim a change works without doing that or saying you didn't. `make test` passing is not evidence that the widget loads.

`make package` hard-fails if any `package/contents/locale/*.po` has untranslated *or* fuzzy strings, and `do-package` blocks on an interactive `read` prompt — neither is usable unattended. Adding an `i18n()` string does **not** require updating the `.po` files (the maintainer fills them in at release prep); use `make package-no-i18n` if you need an artifact.

## Architecture

### The engine: `package/contents/ui/main.qml`

~4300 lines, and it is genuinely the center of the system: chat state, the LLM request/tool loop, KWallet access, shell execution, history I/O, STT orchestration, and system-info gathering all live here. `FullRepresentation.qml` is the panel UI; `ChatMessage.qml` renders a single bubble.

### Two parallel message models

`chatMessages` and `displayMessages` (`main.qml:148`) are separate `ListModel`s:

- **`chatMessages`** — the wire history sent to the provider. Provider-neutral, shaped like OpenAI chat-completions (`role`, `content`, `tool_calls_json`, `tool_call_id`, `thinking_blocks_json`). Index 0 is always the system prompt and is mutated in place when config changes.
- **`displayMessages`** — what the user sees, including UI-only roles that never reach the LLM: `tool_pending` (approval card), `tool_result_rich`, `error`.

They are correlated by `msgId` / `turnId` / `apiMsgId`, not by index. Edit, retry, share, and compaction all depend on that pairing — see `findChatIndexForDisplayIndex()` (`main.qml:1063`) before touching either model.

### Provider abstraction

`api.js` → `adapters/index.js` → `adapters/<id>.js`, selected by `Plasmoid.configuration.apiType`. Every adapter exposes the same surface: `id`, `displayName`, `capabilities`, `presets`, `fetchModels`, `buildTools`, `buildContentArray`, `sendStreaming`.

The neutral internal format is the OpenAI shape; non-OpenAI adapters translate on the way out (e.g. `anthropic.js:142 translateMessages()` folds `tool` messages into user `tool_result` blocks and re-sends signed thinking blocks). `openai.js` is a dispatcher, not an implementation — it routes to `openai_chat.js` (`/v1/chat/completions`) or `openai_responses.js` (`/v1/responses`) based on `usesResponsesAPI`, which each preset annotates.

Streaming is hand-rolled: raw `XMLHttpRequest`, incremental SSE buffer parsing at `readyState === 3`. There is no SDK. Adding a provider means writing the wire format and the SSE parser yourself.

`opencode.js` is the exception to "one adapter, one wire format": OpenCode Zen and Go are gateways whose models are split across chat completions, Responses, Anthropic `/messages` and Gemini `generateContent`, so it delegates per model to `openai_chat.js`, `openai_responses.js`, `anthropic.js` or `gemini.js`. It sets `opts.opencodeAuth`, and those adapters rewrite their own URLs and headers for the gateway (see `anthropic.js`'s `/v1` guard and `gemini.js`'s Zen path).

Protocol selection lives in `opencodeRoute.js` — pure, no QML or network, so `tests/opencode_route.mjs` can drive it directly. Those rules come from published endpoint tables and go stale, so a request retries the remaining formats on an endpoint-level rejection and remembers what worked for the session.

**Every route is retryable, and that rests on one invariant: `opencode.js`'s `buildTools`/`buildContentArray` are protocol-blind.** They always delegate to `openai_chat.js`, whatever `resolveProtocol` says; `sendStreaming` converts to the target protocol at send time, on every non-chat attempt including the first. Do not "optimize" that by building the target shape at compose time — a body already built as Anthropic blocks cannot be re-sent as Gemini parts, and covering that needs a translator per ordered pair. Neutral-building keeps it hub-and-spoke: three converters (`convertMessagesForAnthropic`/`ForResponses`/`ForGemini` plus the matching `to*Tools`), because chat shape is a lossless hub and every other adapter already exposes `translateMessages(neutralMessages)`. `tests/opencode.test.js` asserts the invariant directly against tagged stub builders.

Two consequences worth knowing. `convertContentForAnthropic` must reproduce `anthropic.js`'s own `isImageMime` guard — it is now on the *only* path to `/messages`, and a non-image data URL sent as an image block is rejected; Gemini and Responses have no such restriction, so their converters deliberately don't filter. And the static route now only picks the *first* attempt, with a format learned this session outranking it — the published tables are exactly what goes stale.

`looksLikeWrongEndpoint` gates the retry and exists because OpenCode signals a format mismatch as **HTTP 401** with a `ModelError` body — reading that as an auth failure would tell the user to regenerate a working key. The other two bounds are unchanged: never retry after partial output, never try the same format twice.

### Tool-call normalization

`toolCallNormalizer.js` is a mandatory pass, not a nicety. The OpenAI contract says `function.arguments` is a *string containing a JSON object*, and streaming providers break it constantly — no arguments delta at all, the whole object repeated per chunk, parallel calls sharing a delta `index`, or a stream cut mid-object. A malformed value is sticky: it gets stored in `tool_calls_json` and replayed on every later request, so one bad chunk wedges the entire conversation with an error naming a `tool_call_id` (`invalid function arguments json string` on strict upstreams like MiniMax and GLM).

Three call sites, all required:
- every adapter normalizes before `onComplete` — malformed calls never enter history;
- `main.qml` heals stored `tool_calls_json` on read, so conversations saved before this existed recover;
- `reconcileToolCallMessages()` runs on the assembled request, dropping tool calls whose results were cut off by compaction or the `maxApiMessages` slice (and vice versa) — providers reject either half on its own.

`normalizeToolCalls` preserves unknown properties on a call; don't "clean that up", Gemini's `thought_signature` rides there.

### Tool calling

Registry is `tools/index.js` (module + optional config QML page per tool). `toolManager.js` builds schemas, resolves enabled/auto-run state, enforces the path whitelist, and synthesizes **custom script tools** from user-defined command templates in config.

**Read `package/contents/ui/tools/TOOLS.md` before adding or modifying a tool** — it documents the module contract (`sandboxed`, `sideEffect`, `outputScheme`, `uiHidden`), the security model, and the `context` object passed to `execute()`.

The loop: `sendToLLM()` (`main.qml:2944`) → provider returns `tool_calls` → queued into `root.pendingToolCalls` → `processNextToolCall()` (`main.qml:3381`) either auto-runs or pushes a `tool_pending` approval card → `executeTool()` → `handleToolOutput()` (`main.qml:3524`) appends a `tool` message → back to `sendToLLM()`. Tool results must round-trip through `chatMessages` or the provider will reject the next request.

Security layers, all enforced client-side before execution: enabled-vs-auto-run per tool, path whitelist for `sandboxed` tools (`ToolManager.isPathAllowed`), a required `justification` argument on system-touching tools, and home-path redaction (`contractAllPaths`) so results never leak the username back to the LLM.

### Shell execution

`P5Support.DataSource { engine: "executable" }` — two instances: `executable` (`main.qml:1343`) for internal commands and `toolsExec` for tool calls. **The source key is the command string itself.** `onNewData` dispatches by checking which bookkeeping array/map contains that source (`pendingSysInfoCommands`, `terminalCommands`, `saveCommands`, `historyFetchCommands`, …). Identical command strings collide, which is why commands embed generated markers and `mktemp` paths. Always register a new command in the right bookkeeping structure and `disconnectSource()` when done.

`sessionRunner.js` optionally wraps `run_command` in a tmux/screen session so long-running commands stream into a real terminal.

### Secrets

API keys live in **KWallet only**, never in config. Access is async D-Bus (`walletCall()`, `main.qml:1971`) against folder `PlasmaLLM` in `kdewallet`. Slot names are computed in `api.js` (`chatKeySlot` / `searchKeySlot` / `sttKeySlot`, plus legacy-slot parsers and `migrateApiKeySlotScheme()` for the scheme migration). Changing a slot-naming function silently orphans users' stored keys — extend the legacy readers instead.

### Configuration

`package/contents/config/main.xml` holds ~155 entries in a single `General` group; `config/config.qml` lists the config pages. Read anywhere via `Plasmoid.configuration.<key>`.

Adding a setting usually means three edits: the `main.xml` entry, a control on the relevant `config*.qml` page, and — if it affects the system prompt — a handler in the long `Connections` block at the end of `main.qml` (`main.qml:3871`+) that calls `initSystemPrompt()`. `BaseConfigPage.qml` is the shared page shell.

`profiles.js` layers named provider profiles on top of that flat config: `applyToConfig`/`captureFromConfig` sync a profile object with `Plasmoid.configuration`, and the `*FromKCM`/`*ToKCM` variants do the same against a live config page.

### System prompt

Composed by `Api.buildSystemPrompt()` from system info, the user template, `ToolManager.buildSystemPromptSection()`, session-multiplexer and approval-mode sections, and `DriverManager.getDrivingInstructions()`. Rebuilt whenever a relevant config key changes, and written back into `chatMessages` index 0.

### History and compaction

Chats are JSONL at `$XDG_DATA_HOME/plasmallm/chats/*.jsonl` (v2: `_type` of `meta` / `compaction` / `api` / `display`). `legacyChatLoader.js` reads v1 files and synthesizes the turn metadata they lack. `contextCompactor.js` summarizes older turns through a separately-configured endpoint (`configCompaction.qml`) to shrink the context.

Compaction is lossy in the prompt but not in storage: the summary is required to cite message ids, and its footer tells the model it can pull the verbatim text back with `restore_context` (or a file's contents with `recall_attachment`). That citation-plus-retrieval pattern is the model for anything else that has to shrink context.

### Long-term memory

Facts that outlive a conversation, in JSONL at `$XDG_DATA_HOME/plasmallm/memories.jsonl`. `memoryStore.js` is a `.pragma library` holding every decision (parse, dedupe, tiering, ranking, prompt formatting); `main.qml` owns the file I/O and reaches the tools through a `context.memory` bridge (`add` / `update` / `remove` / `search` / `list`).

Two tiers, because always-injecting every memory does not scale:

- **pinned** (`PINNED_CHAR_BUDGET`, 6000 characters) — written into the system prompt every request. New memories pin themselves while there is room, so a small store behaves exactly like a flat always-injected list.
- **archived** — everything else. Never injected; found through the `recall` tool, which scores entries with TF-IDF (`searchMemories`). The prompt carries only a count and tag list.

**The pinned budget is characters, not entries.** What the tier costs is prompt space, and entries vary by more than an order of magnitude (`MAX_TEXT` is 500; a real memory is often ~60). A count cap sized for worst-case entries binds far too early on typical ones — it would archive facts, putting them behind a `recall` the model has to think to call, while most of the space it was protecting sat unused. `MAX_PINNED` survives only as a ceiling on pathological counts of tiny entries; characters normally bind first. Use `hasPinRoom()` rather than comparing counts.

Three invariants worth keeping: a pin over budget is **refused and reported**, never granted by evicting another pin; store-cap eviction only ever takes archived entries — a memory that silently stops being visible is worse than one that was never saved; and a reference that matches more than one entry is **refused with the candidates listed**, never resolved to the first hit (`resolveTarget`). That last one matters most for `forget`: deleting is irreversible, and "the printer" can easily name three saved facts. `updateMemory` exists so a correction keeps the entry's id, created stamp, tags, pinned state and use count — forget-then-remember resets all of them. `parseJsonl` reads a record with no `pinned` field as pinned, so upgrading from the pre-tier format cannot drop anything out of the prompt.

`Plasmoid.configuration.memoryEnabled` gates both halves (the three tools and the prompt section) the way `compactionEnabled` gates `restore_context`. `api.js` checks that `recall` actually survived tool gating before printing the archive index — never advertise a tool the model was not given. `configMemory.qml` edits the file in its own QML context and bumps `memoryRevision` to make the widget re-read it.

### Other subsystems

- **Desktop automation** — `driverManager.js` + `tools/driver/*` drive an external `plasmallm-desktop-driver` over D-Bus / the RemoteDesktop portal (screenshots, a11y tree, click/type/scroll, window control).
- **Voice input** — `stt.js` + `sttAdapters/` + `VoiceCapture.qml`; Qt Multimedia capture with `pw-record`/`ffmpeg`/`arecord` shell fallbacks.
- **LaTeX** — `latex_renderer.py` runs as a python3 D-Bus service using matplotlib mathtext; when unavailable, `api.js` falls back to a pure-JS box layout renderer (`parseLatexToBox`, `replaceLatexSymbols`).
- **Web search** — `search_adapters/` (DuckDuckGo, SearXNG, Ollama, Exa) behind the `web_search` tool.

## Conventions

- QML JS dialect: `var` declarations and the `function` keyword — no arrow functions, no `let`/`const`.
- Shared JS libraries use `.pragma library` and cross-import with `.import "x.js" as X`. `.pragma library` files cannot touch QML objects, which is why anything needing `Plasmoid.configuration` takes it as an argument (`config`, `opts`, `context`).
- Theme colors come from `Kirigami.Theme`, never hardcoded.
- Import order: Qt, KDE Plasma, P5Support, Kirigami, local JS.
- **No external dependencies.** Optional runtime tools (`tmux`, `matplotlib`, `ffmpeg`) must degrade gracefully.
- SPDX header on every new file: `SPDX-FileCopyrightText: 2026 Joshua Roman` / `SPDX-License-Identifier: GPL-2.0-or-later`.
- User-facing strings go through `i18n()` — `xgettext` scans only `.qml` and `.js` under `contents/ui` and `contents/config`.
- Branch from `master` as `feature/<description>` or `fix/<description>`; one logical change per PR.
