/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Kokoro voice mixes. Kokoro-FastAPI takes a voice string like "af_heart+af_bella",
// or with weights, "af_heart(2)+af_bella(1)". This reads and writes that string,
// and keeps the list of mixes the user saved by name (a JSON list of
// {name, voice}, stored in the ttsKokoroMixes setting).
//
// Pure functions only, so the settings page and the tests share them.

.pragma library

var MIN_WEIGHT = 1;
var MAX_WEIGHT = 10;
var MAX_NAME = 40;

var VOICE_RE = /^[A-Za-z0-9_]+$/;
var WEIGHT_RE = /^[0-9]+$/;
var PART_RE = /^([A-Za-z0-9_]+)\s*(?:\(([^()]*)\))?$/;

function trimStr(value) {
    return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
}

/** A whole number from MIN_WEIGHT to MAX_WEIGHT; anything else becomes MIN_WEIGHT. */
function clampWeight(weight) {
    var n = Math.round(Number(weight));
    if (!isFinite(n))
        return MIN_WEIGHT;
    return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, n));
}

/** True for text that looks like a mix (more than one voice, or weights). */
function isMixString(text) {
    return /[+(]/.test(String(text || ""));
}

/**
 * Reads "a+b" or "a(2)+b(1)".
 * @returns {{ok: boolean, parts: Array<{voice: string, weight: number}>, error: string}}
 *   error: "" | "empty" | "empty-part" | "bad-voice" | "bad-weight"
 *   Weights must be whole numbers from 1 to 10. Spaces around a part are ignored.
 */
function parseVoiceString(text) {
    var s = trimStr(text);
    var res = { ok: false, parts: [], error: "" };
    if (!s.length) {
        res.error = "empty";
        return res;
    }
    var pieces = s.split("+");
    for (var i = 0; i < pieces.length; i++) {
        var piece = trimStr(pieces[i]);
        if (!piece.length) {
            res.parts = [];
            res.error = "empty-part";
            return res;
        }
        var m = PART_RE.exec(piece);
        if (!m) {
            res.parts = [];
            res.error = /^[A-Za-z0-9_]+\(/.test(piece) ? "bad-weight" : "bad-voice";
            return res;
        }
        var weight = MIN_WEIGHT;
        if (m[2] !== undefined) {
            var w = trimStr(m[2]);
            if (!WEIGHT_RE.test(w) || Number(w) < MIN_WEIGHT || Number(w) > MAX_WEIGHT) {
                res.parts = [];
                res.error = "bad-weight";
                return res;
            }
            weight = Number(w);
        }
        res.parts.push({ voice: m[1], weight: weight });
    }
    res.ok = true;
    return res;
}

/**
 * Parts → the string sent to Kokoro. When every weight is 1 the weights are
 * left out (af_heart+af_bella); otherwise every voice carries its own
 * (af_heart(2)+af_bella(1)). Parts without a voice are skipped.
 */
function formatVoiceString(parts) {
    var list = [];
    (parts || []).forEach(function(p) {
        var v = trimStr(p && p.voice);
        if (v.length)
            list.push({ voice: v, weight: clampWeight(p.weight) });
    });
    var weighted = list.some(function(p) { return p.weight !== 1; });
    return list.map(function(p) { return weighted ? p.voice + "(" + p.weight + ")" : p.voice; }).join("+");
}

// ---------------------------------------------------------------- rows
// The editor's rows are the same {voice, weight} objects as the parts.
// These return new arrays and leave the one passed in alone.

/** Voice string → rows, or null when it can't be shown as rows (bad syntax). */
function rowsFromVoice(text) {
    var p = parseVoiceString(text);
    return p.ok ? p.parts : null;
}

function addRow(rows, voice) {
    return (rows || []).concat([{ voice: trimStr(voice), weight: MIN_WEIGHT }]);
}

function removeRow(rows, index) {
    var out = (rows || []).slice();
    if (index >= 0 && index < out.length)
        out.splice(index, 1);
    return out;
}

/** Changes the fields given (voice and/or weight) of one row. */
function setRow(rows, index, fields) {
    var out = (rows || []).slice();
    if (!(index >= 0 && index < out.length))
        return out;
    var cur = out[index];
    var next = { voice: cur.voice, weight: cur.weight };
    if (fields && fields.voice !== undefined)
        next.voice = trimStr(fields.voice);
    if (fields && fields.weight !== undefined)
        next.weight = clampWeight(fields.weight);
    out[index] = next;
    return out;
}

/** The voice list for one row's dropdown: the server's voices, plus the row's own voice if the server doesn't list it. */
function rowVoices(voices, current) {
    var list = (voices || []).slice();
    var c = trimStr(current);
    if (c.length && list.indexOf(c) === -1)
        list.unshift(c);
    return list;
}

// ---------------------------------------------------------------- saved mixes

function cleanName(name) {
    return trimStr(String(name === undefined || name === null ? "" : name).replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " "));
}

function sameName(a, b) {
    return cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
}

function indexOfName(list, name) {
    for (var i = 0; i < list.length; i++) {
        if (sameName(list[i].name, name))
            return i;
    }
    return -1;
}

/**
 * The ttsKokoroMixes setting → [{name, voice}]. Bad JSON, a non-list, and
 * entries without a name or a voice are dropped. A name that comes twice
 * keeps its first position and its last voice (the same as saving over it).
 */
function parseMixes(json) {
    var raw;
    try {
        raw = JSON.parse(String(json || "[]"));
    } catch (e) {
        return [];
    }
    if (!Array.isArray(raw))
        return [];
    var out = [];
    raw.forEach(function(e) {
        if (!e || typeof e.name !== "string" || typeof e.voice !== "string")
            return;
        var name = cleanName(e.name);
        var voice = trimStr(e.voice);
        if (!name.length || !voice.length)
            return;
        var at = indexOfName(out, name);
        if (at >= 0)
            out[at] = { name: out[at].name, voice: voice };
        else
            out.push({ name: name, voice: voice });
    });
    return out;
}

function serializeMixes(list) {
    return JSON.stringify((list || []).map(function(m) { return { name: m.name, voice: m.voice }; }));
}

function findMix(list, name) {
    var i = indexOfName(list || [], name);
    return i >= 0 ? list[i] : null;
}

/** The first saved mix whose voice string is exactly this one, or null. */
function findMixByVoice(list, voice) {
    var v = trimStr(voice);
    var l = list || [];
    for (var i = 0; i < l.length; i++) {
        if (l[i].voice === v)
            return l[i];
    }
    return null;
}

/**
 * Kokoro voice ids are two letters (language and gender), an underscore and a
 * name: af_bella, bm_george. Typing one in the Voice box must mean that voice,
 * so a mix can't carry such a name, even when no voice list is loaded to say so.
 */
function looksLikeVoiceId(text) {
    return /^[a-z]{2}_[a-z0-9_]+$/i.test(trimStr(text));
}

/** Voices that appear more than once in the parts (any case), each listed once. */
function repeatedVoice(parts) {
    var seen = {};
    var dup = [];
    (parts || []).forEach(function(p) {
        var key = trimStr(p && p.voice).toLowerCase();
        if (!key.length)
            return;
        if (seen[key] === 1)
            dup.push(trimStr(p.voice));
        seen[key] = (seen[key] || 0) + 1;
    });
    return dup;
}

/**
 * The voice for a new row of the editor: the first of the server's voices that
 * no row uses yet. With no voices to pick from (the server is down) it is "",
 * which leaves the row empty, rather than a second copy of a voice already
 * in the mix.
 */
function nextVoice(rows, voices) {
    var used = {};
    (rows || []).forEach(function(r) { used[trimStr(r && r.voice).toLowerCase()] = true; });
    var list = voices || [];
    for (var i = 0; i < list.length; i++) {
        if (!used[trimStr(list[i]).toLowerCase()])
            return list[i];
    }
    return "";
}

/**
 * Saves a mix under a name, replacing the one with that name (letters in any
 * case count as the same name; the position is kept, the new spelling wins).
 * The voice string is stored in its plain form (spaces gone, weights tidied).
 *
 * @param {Array} list      the saved mixes
 * @param {string} name
 * @param {string} voice    a voice string with at least two voices
 * @param {string[]} [reserved]  names of real voices; a mix can't use one
 * @returns {{ok: boolean, list: Array, replaced: boolean, error: string, existing: string}}
 *   error: "" | "name-empty" | "name-long" | "name-is-voice" | "voice-invalid"
 *          | "needs-two" | "same-voice" | "voice-saved-as" (existing = that mix's name)
 *   "name-is-voice" also covers a name shaped like a Kokoro voice id (af_bella),
 *   whether or not the server's voice list is loaded to say so.
 */
function saveMix(list, name, voice, reserved) {
    var cur = (list || []).slice();
    var res = { ok: false, list: cur, replaced: false, error: "", existing: "" };
    var n = cleanName(name);
    if (!n.length) {
        res.error = "name-empty";
        return res;
    }
    if (n.length > MAX_NAME) {
        res.error = "name-long";
        return res;
    }
    var named = parseVoiceString(n);
    var lower = n.toLowerCase();
    var isVoice = (reserved || []).some(function(v) { return String(v).toLowerCase() === lower; })
        || looksLikeVoiceId(n)
        || (named.ok && isMixString(n));
    if (isVoice) {
        res.error = "name-is-voice";
        return res;
    }
    var p = parseVoiceString(voice);
    if (!p.ok) {
        res.error = "voice-invalid";
        return res;
    }
    if (p.parts.length < 2) {
        res.error = "needs-two";
        return res;
    }
    if (repeatedVoice(p.parts).length) {
        res.error = "same-voice";
        return res;
    }
    var plain = formatVoiceString(p.parts);
    var other = findMixByVoice(cur, plain);
    if (other && !sameName(other.name, n)) {
        res.error = "voice-saved-as";
        res.existing = other.name;
        return res;
    }
    var at = indexOfName(cur, n);
    if (at >= 0) {
        cur[at] = { name: n, voice: plain };
        res.replaced = true;
    } else {
        cur.push({ name: n, voice: plain });
    }
    res.ok = true;
    res.list = cur;
    return res;
}

/** @returns {{ok: boolean, list: Array, error: string}}  error: "" | "not-found" */
function deleteMix(list, name) {
    var cur = (list || []).slice();
    var at = indexOfName(cur, name);
    if (at < 0)
        return { ok: false, list: cur, error: "not-found" };
    cur.splice(at, 1);
    return { ok: true, list: cur, error: "" };
}

// ---------------------------------------------------------------- the voice box

/**
 * What the Voice dropdown lists: a "Saved mixes" heading and the mixes by
 * name (only when there are any), then the voice currently set if the server
 * doesn't list it (typed, or an unsaved mix), then the server's voices.
 * Each entry is {kind: "heading" | "mix" | "voice", text, voice}; a heading
 * has no voice and can't be chosen.
 */
function comboEntries(mixes, voices, current, headingText) {
    var out = [];
    var m = mixes || [];
    if (m.length) {
        out.push({ kind: "heading", text: String(headingText || ""), voice: "" });
        m.forEach(function(e) { out.push({ kind: "mix", text: e.name, voice: e.voice }); });
    }
    var list = (voices || []).slice();
    var cur = trimStr(current);
    if (cur.length && list.indexOf(cur) === -1 && !findMixByVoice(m, cur))
        out.push({ kind: "voice", text: cur, voice: cur });
    list.forEach(function(v) { out.push({ kind: "voice", text: v, voice: v }); });
    return out;
}

/** Index in comboEntries() of the voice string: its saved mix, else the voice itself, else -1. */
function entryIndex(entries, voice) {
    var v = trimStr(voice);
    var first = -1;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].kind === "heading" || entries[i].voice !== v)
            continue;
        if (entries[i].kind === "mix")
            return i;
        if (first < 0)
            first = i;
    }
    return first;
}

/** True when this entry is the "Saved mixes" heading (or any heading): it is not a voice. */
function isHeadingIndex(entries, index) {
    var e = entries && index >= 0 && index < entries.length ? entries[index] : null;
    return !!e && e.kind === "heading";
}

/**
 * True when the text in the box is a heading's own text. The box shows that
 * text when the keyboard (Up, or Enter on the highlighted heading) or inline
 * completion lands on the heading, and it must never be stored as a voice.
 */
function isHeadingText(entries, text) {
    var t = trimStr(text).toLowerCase();
    if (!t.length)
        return false;
    return (entries || []).some(function(e) { return e.kind === "heading" && trimStr(e.text).toLowerCase() === t; });
}

/**
 * Where the box goes when it lands on a heading: the next entry that is not
 * a heading (the keyboard moves past it), or -1 when there is none.
 */
function stepOverHeading(entries, index) {
    var list = entries || [];
    for (var i = Math.max(0, index); i < list.length; i++) {
        if (list[i].kind !== "heading")
            return i;
    }
    return -1;
}

/** What the box shows for a stored voice string: the saved mix's name, else the string. */
function voiceToText(voice, mixes) {
    var m = findMixByVoice(mixes, voice);
    return m ? m.name : String(voice === undefined || voice === null ? "" : voice);
}

/** What gets stored for the text in the box: a saved mix's name becomes its voice string, other text stays as typed. */
function textToVoice(text, mixes) {
    var m = findMix(mixes, text);
    return m ? m.voice : String(text === undefined || text === null ? "" : text);
}
