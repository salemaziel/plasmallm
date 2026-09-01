/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

// Repairs `tool_calls` arrays before they are sent to a provider or written to
// history.
//
// The OpenAI wire contract says function.arguments is a *string containing a
// JSON object*. Streaming providers break that contract in several ways, and a
// malformed value is sticky: once it lands in a stored assistant message it is
// replayed on every subsequent request, so one bad chunk poisons the whole
// conversation. Strict upstreams (MiniMax, GLM) reject the replay with
// "invalid function arguments json string, tool_call_id: ...".
//
// Observed breakage this module repairs:
//   - no arguments delta at all            -> "" (not valid JSON)
//   - whole object repeated per chunk      -> {"a":1}{"a":1}
//   - parallel calls sharing delta index   -> two argument strings interleaved
//   - stream cut mid-object                -> {"path":"/etc/host
//   - arguments delivered pre-parsed       -> object where a string is required
//   - sparse/holey accumulator arrays      -> null entries in the payload
//
// Everything here is defensive: a call that cannot be salvaged degrades to "{}"
// rather than propagating a payload the provider will reject.

function _tryParse(text) {
    try {
        var v = JSON.parse(text);
        return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) {
        return null;
    }
}

function _compact(obj) {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return "{}";
    }
}

// Walk `s` and return each top-level {...} region. Quote- and escape-aware so
// braces inside string values do not confuse the depth count.
function _scanObjects(s) {
    var objs = [];
    var i = 0;
    var n = s.length;
    while (i < n) {
        while (i < n && " \t\r\n,".indexOf(s.charAt(i)) !== -1) i++;
        if (i >= n || s.charAt(i) !== "{") break;

        var depth = 0;
        var inStr = false;
        var esc = false;
        var end = -1;
        for (var j = i; j < n; j++) {
            var ch = s.charAt(j);
            if (esc) { esc = false; continue; }
            if (ch === "\\") { if (inStr) esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
        }

        if (end === -1) {
            objs.push({ text: s.substring(i), complete: false });
            break;
        }
        objs.push({ text: s.substring(i, end + 1), complete: true });
        i = end + 1;
    }
    return objs;
}

// Balance an object that the stream cut short: close a dangling string, then
// close every still-open bracket.
function _closeTruncated(s) {
    var stack = [];
    var inStr = false;
    var esc = false;
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (esc) { esc = false; continue; }
        if (ch === "\\") { if (inStr) esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
    }
    var out = s;
    if (esc) out = out.substring(0, out.length - 1);
    if (inStr) out += '"';
    for (var k = stack.length - 1; k >= 0; k--) out += (stack[k] === "{" ? "}" : "]");
    return out;
}

// Close the fragment; if that still will not parse, drop trailing key/value
// pairs until what remains does. Preserves the arguments the model did finish.
function _repairTruncated(s) {
    var v = _tryParse(_closeTruncated(s));
    if (v) return v;

    var cut = s;
    for (var guard = 0; guard < 64; guard++) {
        var idx = cut.lastIndexOf(",");
        if (idx <= 0) break;
        cut = cut.substring(0, idx);
        v = _tryParse(_closeTruncated(cut));
        if (v) return v;
    }
    return null;
}

/**
 * Coerce one function.arguments value into a valid JSON object string.
 * Returns { text, status } where status is one of:
 *   ok | empty | coerced | deduped | split | truncated | lost
 */
function repairArguments(raw) {
    if (raw === undefined || raw === null) {
        return { text: "{}", status: "empty" };
    }

    // Some providers hand back an already-parsed object.
    if (typeof raw === "object") {
        if (Array.isArray(raw)) return { text: "{}", status: "lost" };
        return { text: _compact(raw), status: "coerced" };
    }

    if (typeof raw !== "string") {
        return { text: "{}", status: "lost" };
    }

    var s = raw.trim();
    if (s.length === 0) {
        return { text: "{}", status: "empty" };
    }

    var direct = _tryParse(s);
    if (direct) {
        return { text: _compact(direct), status: "ok" };
    }

    // Not parseable as-is: either repeated objects, several calls concatenated,
    // or a truncated fragment.
    var objs = _scanObjects(s);

    if (objs.length > 1) {
        var parsed = [];
        for (var i = 0; i < objs.length; i++) {
            var p = objs[i].complete ? _tryParse(objs[i].text) : _repairTruncated(objs[i].text);
            if (p) parsed.push(p);
        }
        if (parsed.length > 0) {
            var first = _compact(parsed[0]);
            var identical = true;
            for (var k = 1; k < parsed.length; k++) {
                if (_compact(parsed[k]) !== first) { identical = false; break; }
            }
            // Identical repeats are one call echoed per chunk. Differing objects
            // are distinct calls that collapsed into one slot — we can only keep
            // the first, but the caller is told so it can log it.
            return { text: first, status: identical ? "deduped" : "split" };
        }
    }

    if (objs.length === 1) {
        var single = objs[0].complete ? _tryParse(objs[0].text) : _repairTruncated(objs[0].text);
        if (single) {
            return { text: _compact(single), status: objs[0].complete ? "ok" : "truncated" };
        }
    }

    var salvaged = _repairTruncated(s);
    if (salvaged) {
        return { text: _compact(salvaged), status: "truncated" };
    }

    return { text: "{}", status: "lost" };
}

/**
 * Normalize a whole tool_calls array: drop holes and unusable entries, repair
 * each arguments string, guarantee unique non-empty ids.
 *
 * Returns { calls, notes } — notes is a list of human-readable strings
 * describing every repair performed, for console diagnostics.
 */
function normalizeToolCalls(rawCalls) {
    var out = [];
    var notes = [];
    if (!rawCalls || !rawCalls.length) return { calls: out, notes: notes };

    var seenIds = {};
    for (var i = 0; i < rawCalls.length; i++) {
        var tc = rawCalls[i];
        if (!tc || typeof tc !== "object") {
            notes.push("dropped empty tool_calls slot at index " + i);
            continue;
        }

        var fn = tc["function"] || {};
        var name = (typeof fn.name === "string") ? fn.name.trim() : "";
        if (name.length === 0) {
            notes.push("dropped tool call at index " + i + " with no function name");
            continue;
        }

        var rep = repairArguments(fn.arguments);
        if (rep.status !== "ok") {
            notes.push(name + ": arguments " + rep.status);
        }

        var id = (typeof tc.id === "string" && tc.id.length > 0) ? tc.id : "";
        if (id.length === 0) {
            id = "call_" + name + "_" + i;
            notes.push(name + ": synthesized missing tool call id");
        }
        if (seenIds[id]) {
            var base = id;
            var n = 2;
            while (seenIds[id]) { id = base + "_" + n; n++; }
            notes.push(name + ": duplicate tool call id, renamed to " + id);
        }
        seenIds[id] = true;

        var entry = {
            id: id,
            type: tc.type || "function",
            "function": { name: name, arguments: rep.text }
        };
        // Preserve adapter-specific extras (Gemini's thought_signature, for one
        // — dropping it breaks multi-turn function calling with thoughts).
        for (var prop in tc) {
            if (prop !== "id" && prop !== "type" && prop !== "function") entry[prop] = tc[prop];
        }
        out.push(entry);
    }
    return { calls: out, notes: notes };
}

/**
 * Heal a stored tool_calls_json string from chat history. Conversations saved
 * before this module existed can already contain poisoned arguments; without
 * this they would keep failing forever on replay.
 *
 * Returns the original string when nothing needed changing, so callers can
 * cheaply detect whether history was rewritten.
 */
function sanitizeStoredToolCallsJson(json) {
    if (!json || json.length === 0) return json;
    var parsed;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        return "";
    }
    if (!Array.isArray(parsed)) return "";

    var result = normalizeToolCalls(parsed);
    if (result.calls.length === 0) return "";

    var rebuilt = JSON.stringify(result.calls);
    return rebuilt;
}

function _isEmptyContent(content) {
    if (content === undefined || content === null) return true;
    if (typeof content === "string") return content.length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return false;
}

/**
 * Give every tool_call in the request a globally unique id.
 *
 * normalizeToolCalls only guarantees uniqueness *within one assistant message*,
 * because that is all it can see. Several adapters synthesize ids from a
 * per-turn counter when the provider sends none ("call_0", "call_1", …), so two
 * turns in the same conversation collide, and a resent history can repeat an id
 * for other reasons too (edit, retry, compaction replay). Lenient providers
 * ignore it; DeepSeek rejects the whole request with a 400 naming the duplicate
 * tool_call_id, which reads as a random mid-conversation failure.
 *
 * The first use of an id keeps it. A later collision is re-issued, and the next
 * unclaimed tool result carrying the old id is renamed to match — messages are
 * in chronological order, so a result always follows its own call. Renaming
 * only ever happens on a request that was already invalid.
 */
function _dedupeToolCallIds(messages) {
    var notes = [];
    var usedIds = {};
    var remap = {};   // oldId -> queue of replacement ids awaiting their result
    var out = [];

    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m) continue;

        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            var calls = [];
            var changed = false;
            for (var k = 0; k < m.tool_calls.length; k++) {
                var call = m.tool_calls[k];
                if (!call) continue;
                var id = call.id || "";

                if (id.length > 0 && usedIds[id]) {
                    var n = 2;
                    var fresh = id + "_dup" + n;
                    while (usedIds[fresh]) { n++; fresh = id + "_dup" + n; }
                    if (!remap[id]) remap[id] = [];
                    remap[id].push(fresh);
                    notes.push("duplicate tool_call_id " + id + " re-issued as " + fresh);

                    var copy = {};
                    for (var p in call) copy[p] = call[p];
                    copy.id = fresh;
                    call = copy;
                    id = fresh;
                    changed = true;
                }

                if (id.length > 0) usedIds[id] = true;
                calls.push(call);
            }

            if (!changed) {
                out.push(m);
            } else {
                var rebuilt = {};
                for (var q in m) rebuilt[q] = m[q];
                rebuilt.tool_calls = calls;
                out.push(rebuilt);
            }
            continue;
        }

        if (m.role === "tool" && m.tool_call_id
            && remap[m.tool_call_id] && remap[m.tool_call_id].length > 0) {
            var renamed = {};
            for (var r in m) renamed[r] = m[r];
            renamed.tool_call_id = remap[m.tool_call_id].shift();
            out.push(renamed);
            continue;
        }

        out.push(m);
    }

    return { messages: out, notes: notes };
}

/**
 * Make an assembled messages array internally consistent before it is sent.
 *
 * Providers enforce a pairing rule: every assistant tool_call must be answered
 * by a tool message, and every tool message must answer a known tool_call. Both
 * halves get broken routinely here — context compaction starts the window after
 * an assistant message but before its results, and the trailing
 * `maxApiMessages` slice cuts results off the end. The resulting request is
 * rejected outright ("must be followed by tool messages responding to each
 * tool_call_id"), which reads to the user as a random mid-conversation failure.
 *
 * Drops unanswered calls and unmatched results so the request is always valid.
 * Returns { messages, notes }.
 */
function reconcileToolCallMessages(messages) {
    var notes = [];
    if (!messages || messages.length === 0) return { messages: messages || [], notes: notes };

    // Uniqueness first: the pairing pass below keys on id, so a duplicate would
    // otherwise let one result vouch for two different calls.
    var deduped = _dedupeToolCallIds(messages);
    messages = deduped.messages;
    for (var d = 0; d < deduped.notes.length; d++) notes.push(deduped.notes[d]);

    // Which call ids does a tool result exist for?
    var answered = {};
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m && m.role === "tool" && m.tool_call_id) answered[m.tool_call_id] = true;
    }

    var out = [];
    var kept = {};
    for (var j = 0; j < messages.length; j++) {
        var msg = messages[j];
        if (!msg) continue;

        if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
            var keepCalls = [];
            for (var k = 0; k < msg.tool_calls.length; k++) {
                var call = msg.tool_calls[k];
                if (call && call.id && answered[call.id]) {
                    keepCalls.push(call);
                    kept[call.id] = true;
                } else {
                    notes.push("dropped unanswered tool call " +
                               ((call && call["function"] && call["function"].name) || "?") +
                               " (" + ((call && call.id) || "no id") + ")");
                }
            }

            if (keepCalls.length === msg.tool_calls.length) {
                out.push(msg);
                continue;
            }

            // An assistant turn that was nothing but dropped calls carries no
            // information; omit it rather than sending an empty message.
            if (keepCalls.length === 0 && _isEmptyContent(msg.content)) {
                continue;
            }

            var rebuilt = { role: msg.role, content: msg.content };
            for (var prop in msg) {
                if (prop !== "role" && prop !== "content" && prop !== "tool_calls") rebuilt[prop] = msg[prop];
            }
            if (keepCalls.length > 0) rebuilt.tool_calls = keepCalls;
            out.push(rebuilt);
            continue;
        }

        out.push(msg);
    }

    // Second pass: discard results whose call did not survive.
    var final = [];
    for (var t = 0; t < out.length; t++) {
        var om = out[t];
        if (om.role === "tool" && om.tool_call_id && !kept[om.tool_call_id]) {
            notes.push("dropped orphaned tool result for " + om.tool_call_id);
            continue;
        }
        final.push(om);
    }

    return { messages: final, notes: notes };
}

/**
 * Console diagnostics. Silent when nothing was repaired.
 */
function logNotes(where, notes) {
    if (!notes || notes.length === 0) return;
    for (var i = 0; i < notes.length; i++) {
        console.warn("PlasmaLLM [" + where + "] tool call repair: " + notes[i]);
    }
}
