# Tests

```bash
make test          # or ./tests/run.sh
node tests/memory.test.js   # a single suite
```

Node is the only requirement, and only for running these — nothing here ships in
the `.plasmoid`, and the widget itself still has no dependencies.

## What this can and cannot cover

QML cannot be instantiated outside a Plasma shell, so `main.qml` and the config
pages are **not** covered here. What is covered is everything that was moved out
of QML deliberately: the `.pragma library` JavaScript, which is where the wire
formats, the parsing, and the ranking live. Assertions here are cheap; the
things they check are not — a mis-parsed SSE chunk wedges a conversation
permanently, and a tool that fails to register is invisible rather than broken.

Verifying the QML remains manual: `make install-dev`, restart Plasma, use the
feature, read `journalctl -u plasmashell --follow`.

## The suites

| Suite | What it pins down |
| --- | --- |
| `normalizer.test.js` | `function.arguments` is always a parseable JSON object, whatever the provider streamed, and `tool_call_id`s are unique across a request. Malformed values are sticky — they get stored and replayed forever — so this is the highest-value file here. |
| `stream.test.js` | Replays the SSE shapes that corrupt tool calls (no arguments delta, the whole object repeated per chunk, parallel calls sharing an `index`, a stream cut mid-object) through the real `openai_chat.js`. |
| `responses.test.js` | Real `/v1/responses` traces captured from Grok 4.5 and GPT 5.6 Luna, which emit function calls in two structurally different ways on the same endpoint. |
| `opencode.test.js` | OpenCode Go's per-model routing across three wire formats, the one-shot fallback, and error attribution — including the 401 that means "wrong endpoint", not "bad key". |
| `memory.test.js` | The memory store: tolerant parsing, dedupe, the pin budget, eviction that never takes a pinned entry, and TF-IDF recall. |
| `prompt.test.js` | The assembled system prompt, especially that the memory-archive line stays silent when `recall` has been gated out. |
| `registry.test.js` | That tools reach `toolManager` at all. A module missing from `tools/index.js` produces no error — the model just never sees the tool. |
| `shell-roundtrip.test.js` | Memories survive the literal `printf '%s' '<escaped>'` command `main.qml` builds, run through a real bash. Quotes, `$(id -u)`, backslashes, `%s`, newlines. |

## Writing one

`paths.js` resolves the QML tree; `qmlmodule.js` loads a `.pragma library` file
with its `.import` chain resolved, for suites that want a module's real
dependencies. Suites that need to stub a dependency strip the imports
themselves instead — `opencode.test.js` and `stream.test.js` both do.

A suite is a plain Node script that prints `N passed, M failed` on its last line
and exits non-zero on failure. No framework, matching the rest of the project.
