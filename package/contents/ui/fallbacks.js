/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

// Fallback backends for speech output and input. Every decision lives here
// so Node can test it: which backends are tried and in what order, which are
// skipped, when a reply sticks to the backend that worked, and what the
// messages say. The callers (tts.js, stt.js) only run the commands.

var MAX_REASON = 120;

function trimStr(value) {
    return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
}

function sub(text, a, b, c) {
    var res = String(text);
    if (a !== undefined)
        res = res.replace(/%1/g, String(a));
    if (b !== undefined)
        res = res.replace(/%2/g, String(b));
    if (c !== undefined)
        res = res.replace(/%3/g, String(c));
    return res;
}

// ---------------------------------------------------------------------
// The saved list
// ---------------------------------------------------------------------

/**
 * Clean a list of backend ids: strings only, trimmed, no blanks, none twice,
 * never the main backend, and, when `knownIds` is given, only known ones.
 */
function normalizeList(list, mainId, knownIds) {
    var out = [];
    if (!Array.isArray(list))
        return out;
    var main = trimStr(mainId);
    for (var i = 0; i < list.length; i++) {
        if (typeof list[i] !== "string")
            continue;
        var id = trimStr(list[i]);
        if (!id.length || id === main || out.indexOf(id) >= 0)
            continue;
        if (Array.isArray(knownIds) && knownIds.indexOf(id) < 0)
            continue;
        out.push(id);
    }
    return out;
}

/** The saved setting (a JSON array of ids) as a list; anything unreadable is empty. */
function parseList(raw, mainId, knownIds) {
    var arr = raw;
    if (typeof raw === "string") {
        if (!trimStr(raw).length)
            return [];
        try {
            arr = JSON.parse(raw);
        } catch (e) {
            return [];
        }
    }
    return normalizeList(arr, mainId, knownIds);
}

function serialize(list) {
    return JSON.stringify(Array.isArray(list) ? list : []);
}

/** Backends that can still be added: not the main one and not already listed. */
function addable(list, mainId, knownIds) {
    var cur = normalizeList(list, mainId, null);
    var main = trimStr(mainId);
    var out = [];
    for (var i = 0; i < (knownIds || []).length; i++) {
        var id = knownIds[i];
        if (id !== main && cur.indexOf(id) < 0)
            out.push(id);
    }
    return out;
}

/** The list with `id` added at the end; unchanged when it is the main backend, listed already, or unknown. */
function addFallback(list, mainId, id, knownIds) {
    var cur = normalizeList(list, mainId, knownIds);
    id = trimStr(id);
    if (!id.length || id === trimStr(mainId) || cur.indexOf(id) >= 0)
        return cur;
    if (Array.isArray(knownIds) && knownIds.indexOf(id) < 0)
        return cur;
    cur.push(id);
    return cur;
}

function removeFallback(list, id) {
    return normalizeList(list, "", null).filter(function(x) { return x !== id; });
}

/** Move `id` by `delta` places (-1 up, +1 down); it stops at either end. */
function moveFallback(list, id, delta) {
    var cur = normalizeList(list, "", null);
    var from = cur.indexOf(id);
    if (from < 0)
        return cur;
    var to = Math.max(0, Math.min(cur.length - 1, from + delta));
    if (to === from)
        return cur;
    cur.splice(from, 1);
    cur.splice(to, 0, id);
    return cur;
}

/**
 * Rows for the settings list: [{id, name, setUp, first, last}] in order.
 * @param {function} nameOf  function(id) -> display name
 * @param {function} isSetUp function(id) -> boolean
 */
function describe(list, mainId, nameOf, isSetUp) {
    var cur = normalizeList(list, mainId, null);
    var rows = [];
    for (var i = 0; i < cur.length; i++) {
        rows.push({
            id: cur[i],
            name: nameOf(cur[i]),
            setUp: !!isSetUp(cur[i]),
            first: i === 0,
            last: i === cur.length - 1
        });
    }
    return rows;
}

// ---------------------------------------------------------------------
// What counts as set up
// ---------------------------------------------------------------------

/** True when the endpoint is a machine on this computer or a private network, where no key is needed. */
function isLocalEndpoint(url) {
    var u = trimStr(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    var host = u.replace(/[\/?#].*$/, "").replace(/^[^@]*@/, "");
    if (host.charAt(0) === "[")
        host = host.replace(/^\[([^\]]*)\].*$/, "$1");
    else
        host = host.replace(/:\d*$/, "");
    host = host.toLowerCase();
    if (!host.length)
        return false;
    if (host === "localhost" || host === "::1" || /\.local$/.test(host) || /\.localhost$/.test(host))
        return true;
    var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (!m)
        return false;
    var a = parseInt(m[1], 10);
    var b = parseInt(m[2], 10);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * A hosted endpoint is only set up with a key. `needsKey` says whether the
 * backend sends one at all (the endpoint backends do; the local ones don't).
 */
function hasRequiredKey(needsKey, endpoint, key) {
    if (!needsKey)
        return true;
    if (isLocalEndpoint(endpoint))
        return true;
    return trimStr(key).length > 0;
}

// ---------------------------------------------------------------------
// The order backends are tried in
// ---------------------------------------------------------------------

/**
 * @param {string} mainId
 * @param {string[]} list         the saved fallbacks
 * @param {function} isSetUp      function(id) -> boolean
 * @returns {{order: string[], skipped: string[], list: string[]}}
 *   order: the main backend, then the fallbacks that are set up, in the saved order;
 *   skipped: the fallbacks that are not set up; list: the cleaned saved list
 */
function buildOrder(mainId, list, isSetUp) {
    var main = trimStr(mainId);
    var cleaned = normalizeList(list, main, null);
    var order = [main];
    var skipped = [];
    for (var i = 0; i < cleaned.length; i++) {
        if (isSetUp(cleaned[i]))
            order.push(cleaned[i]);
        else
            skipped.push(cleaned[i]);
    }
    return { order: order, skipped: skipped, list: cleaned };
}

/** A short reason for the chat note: the first line of the error, trimmed and capped. */
function shortReason(err, info) {
    if (info && info.unreachable)
        return typeof i18n === "function" ? i18n("isn't running") : "isn't running";
    var line = trimStr(String(err === undefined || err === null ? "" : err).split("\n")[0]).replace(/\s+/g, " ");
    if (!line.length)
        return typeof i18n === "function" ? i18n("unknown error") : "unknown error";
    if (line.length > MAX_REASON)
        line = line.substring(0, MAX_REASON - 1) + "…";
    return line;
}

/**
 * One reply or one recording going through the backends. Tracks which one is
 * current, what failed, and writes the messages.
 *
 * @param {{order: string[], skipped: string[], list: string[]}} plan  from buildOrder
 * @param {function} nameOf  function(id) -> display name
 */
function createRun(plan, nameOf) {
    var order = plan.order.slice();
    var skipped = plan.skipped.slice();
    var list = plan.list.slice();
    var pos = 0;
    var failures = [];
    var tr = typeof i18n === "function";

    function failureFor(id) {
        for (var i = 0; i < failures.length; i++) {
            if (failures[i].id === id)
                return failures[i];
        }
        return null;
    }

    var run = {
        order: order,
        skipped: skipped,
        failures: failures,

        /** The backend to use now, or null when every one has failed. */
        current: function() {
            return pos < order.length ? order[pos] : null;
        },

        /**
         * The attempt on `id` failed. Moves on to the next backend and returns
         * it, or null when none is left. A failure on a backend that was
         * already passed (a second chunk that was in flight) records nothing
         * and returns the backend now in use.
         */
        failedOn: function(id, err, info) {
            if (pos >= order.length)
                return null;
            if (id !== order[pos])
                return order[pos];
            failures.push({ id: id, name: nameOf(id), err: String(err === undefined || err === null ? "" : err), info: info || null });
            pos++;
            return pos < order.length ? order[pos] : null;
        },

        /** True when everything that was tried failed. */
        exhausted: function() {
            return pos >= order.length;
        },

        /** A backend other than the main one has been moved to (and it did not fail all). */
        usedFallback: function() {
            return pos > 0 && pos < order.length;
        },

        /**
         * The first failure that said the server could not be reached, in the
         * shape the widget uses to offer starting it; null when none did.
         */
        unreachableInfo: function() {
            for (var i = 0; i < failures.length; i++) {
                if (failures[i].info && failures[i].info.unreachable)
                    return failures[i].info;
            }
            return null;
        },

        /**
         * The one-line chat note, or "" when the main backend did the job.
         * @param {string} kind  "tts" or "stt"
         */
        note: function(kind) {
            if (!run.usedFallback())
                return "";
            var used = nameOf(order[pos]);
            var parts = [];
            for (var i = 0; i < failures.length; i++) {
                var why = shortReason(failures[i].err, failures[i].info);
                parts.push(tr ? i18n("%1 failed: %2", failures[i].name, why) : sub("%1 failed: %2", failures[i].name, why));
            }
            var failedText = parts.join("; ");
            if (kind === "stt")
                return tr ? i18n("Transcribed with %1 (%2)", used, failedText) : sub("Transcribed with %1 (%2)", used, failedText);
            return tr ? i18n("Spoken with %1 (%2)", used, failedText) : sub("Spoken with %1 (%2)", used, failedText);
        },

        /**
         * What to show when nothing worked: the main backend's error, then one
         * line per fallback (its error, or that it was skipped). With no
         * fallbacks configured this is exactly the main backend's error.
         */
        allFailedMessage: function() {
            var lines = [];
            var main = failureFor(order[0]);
            lines.push(main ? main.err : "");
            for (var i = 0; i < list.length; i++) {
                var f = failureFor(list[i]);
                var name = nameOf(list[i]);
                if (f)
                    lines.push(tr ? i18n("Fallback %1: %2", name, f.err) : sub("Fallback %1: %2", name, f.err));
                else if (skipped.indexOf(list[i]) >= 0)
                    lines.push(tr ? i18n("Fallback %1: not set up, skipped", name) : sub("Fallback %1: not set up, skipped", name));
                else
                    lines.push(tr ? i18n("Fallback %1: not tried", name) : sub("Fallback %1: not tried", name));
            }
            return lines.join("\n");
        }
    };
    return run;
}

/**
 * Try the backends one after another until one works.
 *
 * @param {object} opts
 * @param {object} opts.run         from createRun
 * @param {function} opts.attempt   function(id, done) where done(err, result, info)
 *                                  reports one backend's outcome (err null = success)
 * @param {function} [opts.isCancelled]  stop quietly (no callback) when this returns true
 * @param {function} opts.callback  function(err, result, meta); meta = {run, backend,
 *                                  info, note}: the backend that worked, the
 *                                  unreachable info of any failure along the way, and the note
 * @param {string} [opts.kind]      "tts" or "stt" (for the note)
 */
function runChain(opts) {
    var run = opts.run;
    function cancelled() {
        return typeof opts.isCancelled === "function" && opts.isCancelled();
    }
    function step() {
        var id = run.current();
        if (id === null) {
            opts.callback(run.allFailedMessage(), null, { run: run, backend: "", info: run.unreachableInfo(), note: "" });
            return;
        }
        opts.attempt(id, function(err, result, info) {
            if (!err) {
                opts.callback(null, result, { run: run, backend: id, info: run.unreachableInfo(), note: run.note(opts.kind) });
                return;
            }
            if (cancelled()) {
                opts.callback(err, null, { run: run, backend: "", info: null, note: "", cancelled: true });
                return;
            }
            run.failedOn(id, err, info);
            step();
        });
    }
    step();
}
