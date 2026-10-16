#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Kokoro voice mixes: reading and writing the voice string, the editor's
// rows, the saved-mixes list, and what the Voice dropdown shows.
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadModule(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}
const M = loadModule("../package/contents/ui/ttsAdapters/kokoroMix.js");

let failed = 0;
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        failed++;
        console.error("FAIL", msg, "\n  expected:", e, "\n  actual:  ", a);
    }
}
function ok(cond, msg) {
    if (!cond) {
        failed++;
        console.error("FAIL", msg);
    }
}

// ---- 1. parseVoiceString
let p = M.parseVoiceString("af_heart+af_bella");
ok(p.ok && p.error === "", "plain mix parses");
eq(p.parts, [{ voice: "af_heart", weight: 1 }, { voice: "af_bella", weight: 1 }], "plain mix parts");
p = M.parseVoiceString("af_heart(2)+af_bella(1)");
eq(p.parts, [{ voice: "af_heart", weight: 2 }, { voice: "af_bella", weight: 1 }], "weighted mix parts");
p = M.parseVoiceString("af_heart");
ok(p.ok && p.parts.length === 1 && p.parts[0].weight === 1, "a single voice parses");
p = M.parseVoiceString("  af_heart (3) + af_bella  ");
eq(p.parts, [{ voice: "af_heart", weight: 3 }, { voice: "af_bella", weight: 1 }], "spaces are ignored");
p = M.parseVoiceString("a(10)+b(1)");
ok(p.ok && p.parts[0].weight === 10, "weight 10 is allowed");

// invalid input
for (const [text, err] of [
    ["", "empty"], ["   ", "empty"], [undefined, "empty"], [null, "empty"],
    ["af_heart+", "empty-part"], ["+af_bella", "empty-part"], ["a++b", "empty-part"],
    ["af_heart(0)+b", "bad-weight"], ["af_heart(11)+b", "bad-weight"], ["a(1.5)+b", "bad-weight"],
    ["a()+b", "bad-weight"], ["a(x)+b", "bad-weight"], ["a(-1)+b", "bad-weight"], ["a(2+b", "bad-weight"],
    ["a(2)(3)+b", "bad-weight"],
    ["af heart+b", "bad-voice"], ["af-heart+b", "bad-voice"], ["(2)+b", "bad-voice"], ["a/b", "bad-voice"],
    ["a'b+c", "bad-voice"], ["a\"b+c", "bad-voice"]
]) {
    p = M.parseVoiceString(text);
    ok(!p.ok && p.error === err && p.parts.length === 0, "invalid " + JSON.stringify(text) + " -> " + err + " (got " + p.error + ")");
}
ok(M.isMixString("a+b") && M.isMixString("a(2)") && !M.isMixString("af_heart") && !M.isMixString(""), "isMixString");

// ---- 2. formatVoiceString
eq(M.formatVoiceString([{ voice: "af_heart", weight: 2 }, { voice: "af_bella", weight: 1 }]), "af_heart(2)+af_bella(1)", "weighted format keeps (1)");
eq(M.formatVoiceString([{ voice: "af_heart", weight: 1 }, { voice: "af_bella", weight: 1 }]), "af_heart+af_bella", "all-1 format has no weights");
eq(M.formatVoiceString([{ voice: "af_heart" }, { voice: "af_bella" }]), "af_heart+af_bella", "missing weight is 1");
eq(M.formatVoiceString([{ voice: "a", weight: 99 }, { voice: "b", weight: 0 }]), "a(10)+b(1)", "weights are clamped to 1..10");
eq(M.formatVoiceString([{ voice: "a", weight: 2.6 }, { voice: "b", weight: "x" }]), "a(3)+b(1)", "weights are rounded; junk is 1");
eq(M.formatVoiceString([{ voice: "", weight: 3 }, { voice: " a ", weight: 1 }]), "a", "rows without a voice are skipped");
eq(M.formatVoiceString([]), "", "no rows, no string");
eq(M.formatVoiceString(null), "", "null rows, no string");
eq(M.formatVoiceString([{ voice: "a", weight: 2 }, { voice: "b", weight: 2 }]), "a(2)+b(2)", "equal weights other than 1 are kept");

// round trip: parse(format(x)) === x and format(parse(s)) === s for tidy strings
for (const s of ["af_heart+af_bella", "af_heart(2)+af_bella(1)", "a(10)+b(3)+c(1)", "af_heart", "a+b+a"]) {
    eq(M.formatVoiceString(M.parseVoiceString(s).parts), s, "round trip " + s);
}
const rowsIn = [{ voice: "x_a", weight: 4 }, { voice: "x_b", weight: 1 }, { voice: "x_a", weight: 2 }];
eq(M.parseVoiceString(M.formatVoiceString(rowsIn)).parts, rowsIn, "rows survive format then parse");
eq(M.formatVoiceString(M.parseVoiceString(" a(1) + b(1) ").parts), "a+b", "all-1 explicit weights are dropped");
// 18 voices mixed (the live server accepts it)
const many = Array.from({ length: 18 }, (_, i) => ({ voice: "v" + i, weight: 1 + (i % 3) }));
eq(M.parseVoiceString(M.formatVoiceString(many)).parts, many, "18 voices round trip");

// ---- 3. rows
eq(M.rowsFromVoice("a(2)+b"), [{ voice: "a", weight: 2 }, { voice: "b", weight: 1 }], "rowsFromVoice");
eq(M.rowsFromVoice("not valid!"), null, "rowsFromVoice of junk is null");
eq(M.rowsFromVoice(""), null, "rowsFromVoice of empty is null");
const r0 = [{ voice: "a", weight: 1 }];
const r1 = M.addRow(r0, " b ");
eq(r1, [{ voice: "a", weight: 1 }, { voice: "b", weight: 1 }], "addRow");
eq(r0, [{ voice: "a", weight: 1 }], "addRow leaves the input alone");
eq(M.setRow(r1, 1, { weight: 7 }), [{ voice: "a", weight: 1 }, { voice: "b", weight: 7 }], "setRow weight");
eq(M.setRow(r1, 0, { voice: "z" }), [{ voice: "z", weight: 1 }, { voice: "b", weight: 1 }], "setRow voice");
eq(M.setRow(r1, 0, { weight: 50 })[0].weight, 10, "setRow clamps");
eq(M.setRow(r1, 5, { weight: 3 }), r1, "setRow out of range changes nothing");
eq(r1[1].weight, 1, "setRow leaves the input alone");
eq(M.removeRow(r1, 0), [{ voice: "b", weight: 1 }], "removeRow");
eq(M.removeRow(r1, -1), r1, "removeRow out of range");
eq(M.rowVoices(["a", "b"], "b"), ["a", "b"], "rowVoices keeps a listed voice in place");
eq(M.rowVoices(["a", "b"], "zz"), ["zz", "a", "b"], "rowVoices adds an unlisted voice");
eq(M.rowVoices([], ""), [], "rowVoices of nothing");

// ---- 4. saved mixes: parse / serialize
eq(M.parseMixes(""), [], "empty setting");
eq(M.parseMixes(undefined), [], "undefined setting");
eq(M.parseMixes("not json"), [], "bad json");
eq(M.parseMixes("{\"a\":1}"), [], "json object is not a list");
eq(M.parseMixes("[1, null, {\"name\":\"x\"}, {\"voice\":\"y\"}, {\"name\":\"\",\"voice\":\"a+b\"}, {\"name\":\"ok\",\"voice\":\"a+b\"}, {\"name\":5,\"voice\":\"a+b\"}]"),
    [{ name: "ok", voice: "a+b" }], "bad entries are dropped");
eq(M.parseMixes("[{\"name\":\"Soft\",\"voice\":\"a+b\"},{\"name\":\"Warm\",\"voice\":\"c+d\"},{\"name\":\"soft\",\"voice\":\"e+f\"}]"),
    [{ name: "Soft", voice: "e+f" }, { name: "Warm", voice: "c+d" }], "duplicate name: first place, last voice");
const tricky = [
    { name: "Dad's \"bedtime\" voice", voice: "af_heart(2)+am_adam(1)" },
    { name: "back\\slash", voice: "a+b" },
    { name: "emoji ☕ and 日本語", voice: "jf_alpha+jm_kumo" },
    { name: "a+b", voice: "c+d" }
];
eq(M.parseMixes(M.serializeMixes(tricky)), tricky, "names with quotes, backslashes and unicode round trip");
ok(JSON.parse(M.serializeMixes(tricky)).length === 4, "serialized text is valid JSON");
eq(M.parseMixes(M.serializeMixes([])), [], "empty list round trip");
eq(M.parseMixes("[{\"name\":\"  two   spaces \",\"voice\":\" a+b \"}]"), [{ name: "two spaces", voice: "a+b" }], "names and voices are tidied");
eq(M.parseMixes("[{\"name\":\"line\\nbreak\",\"voice\":\"a+b\"}]"), [{ name: "line break", voice: "a+b" }], "control characters in names become spaces");

// ---- 5. saveMix / deleteMix
let r = M.saveMix([], "Soft", "af_heart(2)+af_bella");
ok(r.ok && !r.replaced, "first save");
eq(r.list, [{ name: "Soft", voice: "af_heart(2)+af_bella(1)" }], "saved voice is written in full-weight form");
let list = r.list;
r = M.saveMix(list, "Warm", " a + b ");
ok(r.ok, "second save");
eq(r.list[1], { name: "Warm", voice: "a+b" }, "spaces removed from the saved voice");
eq(list.length, 1, "saveMix leaves the input list alone");
list = r.list;
r = M.saveMix(list, "soft", "x+y");
ok(r.ok && r.replaced, "same name in another case replaces");
eq(r.list, [{ name: "soft", voice: "x+y" }, { name: "Warm", voice: "a+b" }], "replacement keeps its place and takes the new spelling");
r = M.saveMix(list, "Soft", "af_heart(2)+af_bella(1)");
ok(r.ok && r.replaced && r.list.length === 2, "saving the same name and same voice again is a replace, not an error");
r = M.saveMix(list, "Other", "a+b");
ok(!r.ok && r.error === "voice-saved-as" && r.existing === "Warm", "the same mix under a second name is refused and names the first");
eq(r.list, list, "refused save returns the list unchanged");
for (const [name, voice, err] of [
    ["", "a+b", "name-empty"], ["   ", "a+b", "name-empty"], [undefined, "a+b", "name-empty"],
    ["x".repeat(41), "a+b", "name-long"],
    ["Fine", "", "voice-invalid"], ["Fine", "a+", "voice-invalid"], ["Fine", "a(0)+b", "voice-invalid"],
    ["Fine", "af_heart", "needs-two"], ["Fine", "af_heart(3)", "needs-two"],
    ["a+b", "c+d", "name-is-voice"], ["a(2)+b", "c+d", "name-is-voice"]
]) {
    r = M.saveMix([], name, voice);
    ok(!r.ok && r.error === err && r.list.length === 0, "saveMix(" + JSON.stringify(name) + ", " + JSON.stringify(voice) + ") -> " + err + " (got " + r.error + ")");
}
ok(M.saveMix([], "x".repeat(40), "a+b").ok, "a 40-character name is allowed");
r = M.saveMix([], "AF_Heart", "a+b", ["af_heart", "af_bella"]);
ok(!r.ok && r.error === "name-is-voice", "a mix can't be named like a real voice (any case)");
ok(M.saveMix([], "Heartfelt", "a+b", ["af_heart"]).ok, "other names are fine with a reserved list");
r = M.saveMix([], "Dad's \"bedtime\"", "a+b");
ok(r.ok && r.list[0].name === "Dad's \"bedtime\"", "quotes in a name are kept");
eq(M.parseMixes(M.serializeMixes(r.list)), r.list, "a saved name with quotes survives the setting");
r = M.saveMix([], "Rock (loud)", "a+b");
ok(r.ok, "a name with brackets that isn't a voice string is allowed");

r = M.deleteMix(list, "WARM");
ok(r.ok, "delete ignores case");
eq(r.list, [{ name: "Soft", voice: "af_heart(2)+af_bella(1)" }], "delete removes only that mix");
eq(list.length, 2, "deleteMix leaves the input list alone");
r = M.deleteMix(list, "Nope");
ok(!r.ok && r.error === "not-found" && r.list.length === 2, "deleting an unknown name");
r = M.deleteMix([], "x");
ok(!r.ok && r.error === "not-found", "deleting from nothing");

eq(M.findMix(list, "soft"), list[0], "findMix ignores case");
eq(M.findMix(list, "nope"), null, "findMix miss");
eq(M.findMixByVoice(list, "a+b"), list[1], "findMixByVoice");
eq(M.findMixByVoice(list, "a"), null, "findMixByVoice miss");
eq(M.findMixByVoice(null, "a"), null, "findMixByVoice of no list");

// ---- 6. the voice dropdown
const mixes = [{ name: "Soft", voice: "af_heart(2)+af_bella(1)" }, { name: "Warm", voice: "a+b" }];
const voices = ["af_heart", "af_bella", "am_adam"];
let entries = M.comboEntries(mixes, voices, "af_heart", "Saved mixes");
eq(entries.map(e => e.kind + ":" + e.text), ["heading:Saved mixes", "mix:Soft", "mix:Warm", "voice:af_heart", "voice:af_bella", "voice:am_adam"], "saved mixes first, under a heading, then the voices");
eq(entries[1].voice, "af_heart(2)+af_bella(1)", "a mix entry carries its voice string");
eq(entries[0].voice, "", "a heading carries no voice");
entries = M.comboEntries([], voices, "af_heart", "Saved mixes");
eq(entries.map(e => e.kind), ["voice", "voice", "voice"], "no saved mixes, no heading");
entries = M.comboEntries(mixes, voices, "zz_typed+af_bella", "Saved mixes");
eq(entries.map(e => e.text), ["Saved mixes", "Soft", "Warm", "zz_typed+af_bella", "af_heart", "af_bella", "am_adam"], "a typed voice not on the server is listed after the mixes");
entries = M.comboEntries(mixes, voices, "a+b", "Saved mixes");
ok(entries.filter(e => e.voice === "a+b").length === 1, "a current voice that is a saved mix isn't listed twice");
entries = M.comboEntries(mixes, [], "", "Saved mixes");
eq(entries.map(e => e.text), ["Saved mixes", "Soft", "Warm"], "no voices loaded yet, no current voice");
entries = M.comboEntries(mixes, voices, "af_heart", "Saved mixes");
eq(M.entryIndex(entries, "af_heart(2)+af_bella(1)"), 1, "entryIndex finds the saved mix");
eq(M.entryIndex(entries, "af_bella"), 4, "entryIndex finds a plain voice");
eq(M.entryIndex(entries, "nope"), -1, "entryIndex miss");
eq(M.entryIndex(entries, ""), -1, "entryIndex of empty");
ok(M.entryIndex(M.comboEntries([{ name: "Same", voice: "af_heart" }], voices, "af_heart", "H"), "af_heart") === 1, "a mix wins over a voice with the same string");

eq(M.voiceToText("a+b", mixes), "Warm", "the box shows a saved mix by its name");
eq(M.voiceToText("af_heart", mixes), "af_heart", "a plain voice shows as it is");
eq(M.voiceToText("x+y", mixes), "x+y", "an unsaved mix shows as typed");
eq(M.voiceToText("", mixes), "", "empty stays empty");
eq(M.voiceToText(undefined, mixes), "", "undefined shows empty");
eq(M.textToVoice("Warm", mixes), "a+b", "choosing or typing a saved name stores its voice string");
eq(M.textToVoice("warm", mixes), "a+b", "the name match ignores case");
eq(M.textToVoice("af_heart+af_bella", mixes), "af_heart+af_bella", "a typed mix string stays as typed");
eq(M.textToVoice("War", mixes), "War", "a part of a name is just text");
eq(M.textToVoice("", mixes), "", "empty stays empty");
for (const m of mixes)
    eq(M.textToVoice(M.voiceToText(m.voice, mixes), mixes), m.voice, "text/voice mapping round trips for " + m.name);

// ---- 8. Names shaped like voice ids, and a voice used twice (no voice list loaded)
for (const name of ["af_bella", "AF_Bella", "bm_george", "zf_xiaobei", "ef_dora", "jf_alpha", " af_heart ", "xx_anything_at_all", "af_bella_2"]) {
    r = M.saveMix([], name, "x+y");
    ok(!r.ok && r.error === "name-is-voice" && r.list.length === 0, "name " + JSON.stringify(name) + " is refused with no voice list");
    r = M.saveMix([], name, "x+y", []);
    ok(!r.ok && r.error === "name-is-voice", "name " + JSON.stringify(name) + " is refused with an empty voice list");
}
for (const name of ["Soft", "Bedtime_mix", "my_mix_name_long", "a_b", "afbella", "af-bella", "af_", "_bella", "afx_bella", "Warm voice", "Voix 2"]) {
    // Not every one of these is fine, only those that don't look like a voice id:
    const shaped = /^[a-z]{2}_[a-z0-9_]+$/i.test(name);
    r = M.saveMix([], name, "x+y");
    eq(r.ok, !shaped, "name " + JSON.stringify(name) + (shaped ? " looks like a voice id: refused" : " is accepted"));
}
ok(M.looksLikeVoiceId("af_bella") && !M.looksLikeVoiceId("Warm") && !M.looksLikeVoiceId("af_"), "looksLikeVoiceId");
// Existing saved mixes with such a name are still read (only saving checks)
eq(M.parseMixes(JSON.stringify([{ name: "af_bella", voice: "a+b" }])).length, 1, "an older saved mix with such a name still loads");

for (const [voice, dup] of [["af_heart+af_heart", "af_heart"], ["af_heart(2)+af_heart(1)", "af_heart"],
    ["af_heart+af_bella+af_heart", "af_heart"], ["af_heart+AF_HEART", "af_heart"]]) {
    r = M.saveMix([], "Twin", voice);
    ok(!r.ok && r.error === "same-voice" && r.list.length === 0, "mix " + voice + " is refused: same voice twice (got " + r.error + ")");
}
ok(M.saveMix([], "Twin", "af_heart+af_bella").ok, "two different voices are fine");
ok(M.saveMix([], "Trio", "af_heart(2)+af_bella+am_adam").ok, "three different voices are fine");
eq(M.repeatedVoice([{ voice: "a" }, { voice: "b" }, { voice: "a" }, { voice: "a" }, { voice: "c" }, { voice: "c" }]), ["a", "c"], "each repeated voice is listed once");
eq(M.repeatedVoice([{ voice: "" }, { voice: "" }]), [], "empty rows are not a repeat");
r = M.saveMix([], "Twin", "af_heart+af_heart", ["af_heart"]);
eq(r.error, "same-voice", "also refused with a voice list");
// A single repeated voice reports needs-two first (one distinct voice written twice is two parts)
eq(M.saveMix([], "Fine", "af_heart").error, "needs-two", "one voice: still needs two");

// nextVoice: the editor's "+ Add voice" row
const vl = ["af_heart", "af_bella", "am_adam"];
eq(M.nextVoice([], vl), "af_heart", "first voice for an empty editor");
eq(M.nextVoice([{ voice: "af_heart", weight: 1 }], vl), "af_bella", "skips a voice a row uses");
eq(M.nextVoice([{ voice: "af_heart", weight: 1 }, { voice: "af_bella", weight: 2 }], vl), "am_adam", "skips two");
eq(M.nextVoice([{ voice: "AF_HEART", weight: 1 }], vl), "af_bella", "case-insensitive");
eq(M.nextVoice([{ voice: "af_heart", weight: 1 }], []), "", "no voice list: an empty row, not a copy of af_heart");
eq(M.nextVoice([], []), "", "no voice list and no rows: empty");
eq(M.nextVoice([], undefined), "", "no voice list at all: empty");
eq(M.nextVoice(vl.map(v => ({ voice: v, weight: 1 })), vl), "", "all voices used: empty, not a repeat");
// Starting the editor from one voice with no list never gives af_heart+af_heart
{
    let rows = M.rowsFromVoice("af_heart");
    while (rows.length < 2) rows = M.addRow(rows, M.nextVoice(rows, []));
    eq(M.formatVoiceString(rows), "af_heart", "editor from af_heart with no list: second row stays empty, so the result is one voice");
    r = M.saveMix([], "Dup", M.formatVoiceString(rows));
    eq(r.error, "needs-two", "and it can't be saved as a mix");
}

// ---- 9. The heading in the Voice box can never be a voice
{
    const es = M.comboEntries(mixes, voices, "af_heart", "Saved mixes");
    eq(es[0].kind, "heading", "heading is first (the tests below rely on it)");
    ok(M.isHeadingIndex(es, 0), "index 0 is the heading");
    ok(!M.isHeadingIndex(es, 1) && !M.isHeadingIndex(es, es.length - 1), "mixes and voices are not headings");
    ok(!M.isHeadingIndex(es, -1) && !M.isHeadingIndex(es, es.length) && !M.isHeadingIndex(es, 99) && !M.isHeadingIndex(null, 0) && !M.isHeadingIndex(undefined, 0), "out of range and no list: not a heading");
    ok(M.isHeadingText(es, "Saved mixes") && M.isHeadingText(es, "saved mixes") && M.isHeadingText(es, "  Saved mixes "), "the heading's text is recognised (any case, spaces)");
    ok(!M.isHeadingText(es, "Saved") && !M.isHeadingText(es, "") && !M.isHeadingText(es, "Warm") && !M.isHeadingText(es, "af_heart"), "other text is not");
    ok(!M.isHeadingText(M.comboEntries([], voices, "af_heart", "Saved mixes"), "Saved mixes"), "with no saved mixes there is no heading, so the text is just text");
    ok(M.isHeadingText(M.comboEntries(mixes, voices, "af_heart", "Gespeicherte Mixe"), "Gespeicherte Mixe"), "a translated heading is recognised");
    eq(M.stepOverHeading(es, 0), 1, "landing on the heading moves to the next entry (the first mix)");
    eq(M.stepOverHeading(es, 1), 1, "an entry that isn't a heading stays");
    eq(M.stepOverHeading([{ kind: "heading", text: "h", voice: "" }], 0), -1, "only a heading: nowhere to go");
    eq(M.stepOverHeading([], 0), -1, "no entries: nowhere to go");
    eq(M.stepOverHeading(es, -1), 1, "no selection: the first entry that can be chosen");
    // What the Voice box does for each way of reaching the heading, as a pure walk-through:
    // none of them may produce a stored voice equal to the heading's text.
    const box = (typed) => M.isHeadingText(es, typed) ? null : M.textToVoice(typed, mixes);
    eq(box("Saved mixes"), null, "typed or shown heading text: nothing is stored");
    eq(box("Warm"), "a+b", "a mix name: its voice string");
    eq(box("af_bella"), "af_bella", "a voice: itself");
}

if (failed) {
    console.error("kokoro_mix: " + failed + " failed");
    process.exit(1);
}
console.log("kokoro_mix: all passed");
