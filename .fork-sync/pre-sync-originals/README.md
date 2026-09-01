# Pre-sync snapshots — 2026-09-01

Verbatim copies of the fork's OpenCode provider and the adapter files it builds
on, taken from `fix/widget-seam-phase1` at `58fde75` immediately before the
merge of `upstream/master` (`0baf0c1`).

Kept for diffing while the merged adapter is validated against the live gateway.
These files are reference copies only — nothing imports them.

| File | Role in the fork's OpenCode path |
|---|---|
| `opencode.js` | The provider: model→wire-format routing, runtime fallback across formats with session-scoped learning, gateway error translation |
| `openai_chat.js` | Chat-completions strategy the provider delegates to |
| `openai_responses.js` | Responses strategy (routing target for `grok-4.5`, `gpt-5.6-luna`) |
| `anthropic.js` | Messages strategy (routing target for the `qwen*` family) |
| `index.js` | Adapter registry the provider is registered in |
| `toolCallNormalizer.js` | Streamed tool-call id/index normalization |
| `opencode.test.js` | The fork's test coverage for the above |

## Recovering any of these

They are also reachable from git without this directory:

    git show presync-20260901-0131:package/contents/ui/adapters/opencode.js

`presync-20260901-0131` tags `58fde75`, the fork tip before the merge.

## Reverting the OpenCode path wholesale

    git checkout presync-20260901-0131 -- package/contents/ui/adapters/opencode.js
    git rm package/contents/ui/opencodeRoute.js

Then drop the `.import "../opencodeRoute.js"` line and re-run `make test`.
