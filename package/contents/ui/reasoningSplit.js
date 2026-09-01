/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

// Inline reasoning tags.
//
// Every adapter here treats reasoning as OUT-OF-BAND: a distinct SSE event
// (`thinking_delta` on Anthropic, `response.reasoning` on Responses, thought
// parts on Gemini) which becomes an onThinkingChunk call and lands in the
// italic panel. That assumption holds for the frontier APIs.
//
// It does not hold for open-weight models served OVER those same APIs.
// minimax, GLM, DeepSeek-R1 and Qwen on OpenCode's /messages route emit their
// scratchpad as literal <think>...</think> inside the ordinary text stream and
// never send a reasoning event at all. The abstraction is per-API; this
// behaviour is per-MODEL, so it falls straight through: the reasoning is shown
// as if it were the reply, and — worse — it is stored in the message content
// and replayed to the model on every later turn.
//
// This module is the one place that knows about the tag form.

var TAG_NAMES = ["think", "thinking"];

// Only treat tags as reasoning when the response OPENS with one (leading
// whitespace ignored). Models that inline their scratchpad always put it
// first, and this makes it impossible to mangle a reply that merely discusses
// or code-fences a <think> tag further down. A narrower rule that is right is
// worth more than a broad one that eats legitimate text.
function _leadingOpen(s) {
    var i = 0;
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    for (var t = 0; t < TAG_NAMES.length; t++) {
        var open = "<" + TAG_NAMES[t] + ">";
        if (s.substr(i, open.length) === open) return TAG_NAMES[t];
    }
    return null;
}

function _findOpen(s, from) {
    var best = -1, bestName = null;
    for (var t = 0; t < TAG_NAMES.length; t++) {
        var idx = s.indexOf("<" + TAG_NAMES[t] + ">", from);
        if (idx !== -1 && (best === -1 || idx < best)) { best = idx; bestName = TAG_NAMES[t]; }
    }
    return best === -1 ? null : { idx: best, name: bestName };
}

// A tag can be cut in half across two SSE deltas, so a trailing fragment that
// could still become an open tag must be withheld rather than shown. It is
// re-examined on the next chunk, because split() always re-reads the whole
// accumulated text rather than tracking partial state.
function _trimPartialTag(s) {
    var lt = s.lastIndexOf("<");
    if (lt === -1) return s;
    var tail = s.slice(lt);
    if (tail.indexOf(">") !== -1) return s; // already a complete tag, not a fragment
    for (var t = 0; t < TAG_NAMES.length; t++) {
        var open = "<" + TAG_NAMES[t] + ">";
        if (open.indexOf(tail) === 0) return s.slice(0, lt);
    }
    return s;
}

/**
 * Split streamed text into the visible reply and the inlined reasoning.
 *
 * Re-reads the whole accumulated string every call rather than carrying
 * partial-tag state between chunks. Responses are a few KB, so the cost is
 * irrelevant, and it makes the function pure — which is what lets a caller
 * recover from OpenCode's format-retry simply by calling it again.
 *
 * @returns {{visible: string, thinking: string, open: boolean, inline: boolean}}
 *   `open` is true while a <think> block is still unterminated (mid-stream).
 *   `inline` is false when no leading tag was found, in which case `visible`
 *   is the input verbatim and callers must pass the text through untouched.
 */
function split(text) {
    var s = String(text === null || text === undefined ? "" : text);
    if (!_leadingOpen(s))
        return { visible: s, thinking: "", open: false, inline: false };

    var visible = "", thinking = "", i = 0, open = false;
    while (i < s.length) {
        var found = _findOpen(s, i);
        if (!found) { visible += s.slice(i); break; }
        visible += s.slice(i, found.idx);
        var afterOpen = found.idx + found.name.length + 2;
        var closeTag = "</" + found.name + ">";
        var close = s.indexOf(closeTag, afterOpen);
        if (close === -1) {
            // Still streaming inside the block.
            thinking += s.slice(afterOpen);
            open = true;
            break;
        }
        thinking += s.slice(afterOpen, close);
        i = close + closeTag.length;
    }

    visible = _trimPartialTag(visible);
    // The reply almost always begins "\n\n" after the closing tag; keeping it
    // would leave every such message opening on blank lines.
    visible = visible.replace(/^\s+/, "");
    return { visible: visible, thinking: thinking, open: open, inline: true };
}

/**
 * Wrap a streaming opts object so inlined reasoning is routed to the thinking
 * channel instead of the reply. A no-op for models that emit native reasoning
 * events: without a leading tag `split()` reports `inline: false` and every
 * delta is forwarded byte-for-byte.
 *
 * Deliberately does NOT synthesise thinkingBlocks. Those are provider-native
 * SIGNED blocks that get replayed verbatim (Anthropic extended-thinking with
 * tool use, Gemini multi-turn); an unsigned block invented here would be
 * rejected on the next request. The reasoning still persists, because the
 * display record's own `thinking` field is saved with the chat.
 */
function wrapStreamOpts(opts) {
    if (!opts || (!opts.onChunk && !opts.onComplete)) return opts;

    var origChunk = opts.onChunk;
    var origThinking = opts.onThinkingChunk;
    var origComplete = opts.onComplete;

    var emittedVisible = "";
    var emittedThinking = "";
    var prevAccumulated = "";

    function reset() { emittedVisible = ""; emittedThinking = ""; prevAccumulated = ""; }

    function pump(accumulated) {
        // OpenCode retries a rejected model on another wire format, which
        // restarts the stream. Detect that by prefix, NOT by length: a retry
        // can easily produce a longer string than the attempt it replaces, and
        // a length test then silently diffs the new answer against the old
        // one and emits a fragment of it.
        if (accumulated.indexOf(prevAccumulated) !== 0) reset();
        prevAccumulated = accumulated;

        var r = split(accumulated);
        if (!r.inline) return null;

        if (origThinking && r.thinking.length > emittedThinking.length) {
            var td = r.thinking.slice(emittedThinking.length);
            emittedThinking = r.thinking;
            origThinking(td, emittedThinking);
        }
        if (r.visible.length > emittedVisible.length) {
            var vd = r.visible.slice(emittedVisible.length);
            emittedVisible = r.visible;
            if (origChunk) origChunk(vd, emittedVisible);
        }
        return r;
    }

    var wrapped = {};
    for (var k in opts) { if (opts.hasOwnProperty(k)) wrapped[k] = opts[k]; }

    if (origChunk) {
        wrapped.onChunk = function(delta, accumulated) {
            var acc = String(accumulated === undefined || accumulated === null ? "" : accumulated);
            if (pump(acc) === null) origChunk(delta, accumulated);
        };
    }

    if (origComplete) {
        wrapped.onComplete = function(fullText, error, toolCalls, assistantMsg) {
            var full = String(fullText === undefined || fullText === null ? "" : fullText);
            var r = split(full);
            if (!r.inline) { origComplete(fullText, error, toolCalls, assistantMsg); return; }
            // Safety net for a non-incremental adapter: if the stream never
            // pumped, the panel would otherwise stay empty.
            if (origThinking && r.thinking.length > emittedThinking.length) {
                origThinking(r.thinking.slice(emittedThinking.length), r.thinking);
                emittedThinking = r.thinking;
            }
            reset();
            // Passing r.visible is what keeps the tags out of the stored
            // message, and therefore out of every later request's history.
            origComplete(r.visible, error, toolCalls, assistantMsg);
        };
    }

    return wrapped;
}
