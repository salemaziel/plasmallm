#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Voice profiles: first-time setup, switching (the profile left takes what the
// page holds, then the target is applied), the built-in "Local only", and that
// every profile field really exists in main.xml and BaseConfigPage.qml.
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(__dirname, "../package/contents/ui/");

function loadModule(file) {
    let code = fs.readFileSync(file, "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

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

const VP = loadModule(ui + "voiceProfiles.js");
const SpeechRules = loadModule(ui + "ttsAdapters/speechRules.js");
const xml = fs.readFileSync(path.join(__dirname, "../package/contents/config/main.xml"), "utf8");
const base = fs.readFileSync(ui + "BaseConfigPage.qml", "utf8");

// ---------------------------------------------------------------------
// The fields line up with main.xml and BaseConfigPage.qml
// ---------------------------------------------------------------------
function xmlEntry(name) {
    const m = new RegExp('<entry name="' + name + '" type="(\\w+)">([\\s\\S]*?)</entry>').exec(xml);
    if (!m) return null;
    const d = /<default>([\s\S]*?)<\/default>/.exec(m[2]);
    return { type: m[1], def: d ? d[1] : null };
}
function xmlDefault(entry) {
    if (entry.type === "Bool") return entry.def === "true";
    if (entry.type === "Int") return Number(entry.def);
    return entry.def === null ? "" : entry.def;
}
for (const f of VP.VOICE_FIELDS) {
    const e = xmlEntry(f);
    ok(!!e, f + " is an entry in main.xml");
    if (!e) continue;
    eq(VP.DEFAULTS[f], xmlDefault(e), f + ": the profile default matches main.xml");
    const qmlType = e.type === "Bool" ? "bool" : e.type === "Int" ? "int" : "string";
    ok(new RegExp("property " + qmlType + " cfg_" + f + "\\n").test(base), "cfg_" + f + " is declared in BaseConfigPage.qml as " + qmlType);
    ok(new RegExp("property " + qmlType + " cfg_" + f + "Default\\n").test(base), "cfg_" + f + "Default is declared in BaseConfigPage.qml");
}
for (const f of ["voiceProfiles", "activeVoiceProfileId"]) {
    ok(!!xmlEntry(f), f + " is an entry in main.xml");
    ok(/property string cfg_voiceProfiles\n/.test(base) && /property string cfg_activeVoiceProfileId\n/.test(base), "profile storage settings are declared");
}
eq(VP.VOICE_FIELDS.length, new Set(VP.VOICE_FIELDS).size, "no field is listed twice");
eq(Object.keys(VP.DEFAULTS).sort(), VP.VOICE_FIELDS.slice().sort(), "DEFAULTS and VOICE_FIELDS list the same fields");

// Every speech setting is either in a profile or deliberately left out.
const LEFT_OUT = {
    sttProfileId: "legacy, migrated once",
    sttMigratedFromProfile: "legacy flag",
    sttEnabled: "on/off switch",
    sttMaxSeconds: "behaviour", sttMicMode: "behaviour", sttAutoHoldMs: "behaviour", sttPanelShortcut: "machine/keyboard",
    sttAvailableModels: "cache", sttModelPrices: "cache",
    sttSetupDeclined: "setup choice for this machine",
    ttsEnabled: "on/off switch", ttsAutoRead: "behaviour", ttsAutoReadOnlyVoicePrompted: "behaviour", ttsWaitUntilReady: "behaviour",
    ttsStreamSpeech: "behaviour", ttsStyleHint: "behaviour", ttsAllowAgentStyleControl: "behaviour",
    ttsAvailableModels: "cache", ttsAvailableVoices: "cache",
    ttsKokoroMixes: "saved mixes are shared by every profile",
    ttsSetupDeclined: "setup choice for this machine"
};
{
    const names = [...xml.matchAll(/<entry name="((?:stt|tts)\w*)"/g)].map(m => m[1]);
    ok(names.length > 40, "found the speech settings in main.xml (" + names.length + ")");
    for (const n of names) {
        const inProfile = VP.VOICE_FIELDS.indexOf(n) >= 0;
        const leftOut = Object.prototype.hasOwnProperty.call(LEFT_OUT, n);
        ok(inProfile !== leftOut, n + (inProfile && leftOut ? " is both in a profile and left out" : " is neither in a profile nor deliberately left out"));
    }
    for (const n of Object.keys(LEFT_OUT))
        ok(names.indexOf(n) >= 0, n + " (left out) still exists in main.xml");
    ok(VP.VOICE_FIELDS.indexOf("ttsKokoroMixes") < 0, "saved Kokoro mixes are not per profile");
}

// ---------------------------------------------------------------------
// A page to work on
// ---------------------------------------------------------------------
function pageWith(values, log) {
    const store = {};
    const page = {};
    for (const f of VP.VOICE_FIELDS)
        store[f] = VP.DEFAULTS[f];
    Object.assign(store, values || {});
    store.ttsKokoroMixes = '[{"name":"mine","voice":"af_heart(1)"}]';
    for (const f of VP.VOICE_FIELDS.concat(["ttsKokoroMixes"])) {
        Object.defineProperty(page, "cfg_" + f, {
            get: () => store[f],
            set: v => { store[f] = v; if (log) log.push(f); },
            enumerable: true
        });
    }
    return page;
}
const mySettings = {
    sttBackend: "openai_transcriptions", sttProviderName: "Groq", sttApiEndpoint: "https://api.groq.com/openai/v1", sttModelName: "whisper-large-v3-turbo",
    sttCppBinary: "/opt/whisper/bin/whisper-cli", sttCppModelDirs: "/data/models",
    ttsBackend: "openai_speech", ttsProviderName: "OpenRouter", ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "openai/tts-1",
    ttsVoice: "alloy", ttsResponseFormat: "mp3", ttsSpeedPercent: 110, ttsKokoroUrl: "http://127.0.0.1:8880/v1", ttsKokoroVoice: "af_sky"
};

// ---------------------------------------------------------------------
// First use
// ---------------------------------------------------------------------
let profiles, activeId;
{
    const page = pageWith(mySettings);
    const first = VP.ensureDefaults("", "", page);
    ok(first.changed, "first use: something to save");
    eq(first.profiles.length, 2, "first use: two profiles");
    eq(first.profiles.map(p => p.name), ["My setup", "Local only"], "first use: My setup, then Local only");
    const mine = first.profiles[0];
    for (const f of VP.VOICE_FIELDS)
        eq(mine[f], mySettings[f] !== undefined ? mySettings[f] : VP.DEFAULTS[f], "first use: My setup holds the current " + f);
    eq(first.activeId, mine.id, "first use: My setup is active");
    ok(/^vp_/.test(mine.id), "first use: a generated id");
    ok(!mine.builtIn, "My setup is an ordinary profile");

    const local = first.profiles[1];
    eq(local.id, "local-only", "Local only has a fixed id");
    ok(local.builtIn === true, "Local only is built in");
    eq(local.sttBackend, "whisper_cpp", "Local only: whisper.cpp for input");
    eq(local.ttsBackend, "kokoro_local", "Local only: Kokoro for output");
    eq(local.sttCppBinary, "/opt/whisper/bin/whisper-cli", "Local only keeps the whisper.cpp program found by setup");
    eq(local.sttCppModelDirs, "/data/models", "Local only keeps the model folders");
    eq(local.ttsKokoroUrl, "http://127.0.0.1:8880/v1", "Local only keeps the Kokoro address");
    eq(local.ttsKokoroVoice, "af_sky", "Local only keeps the Kokoro voice");
    eq(local.sttModelName, "", "Local only: a model name from another backend is not carried over");
    profiles = first.profiles;
    activeId = first.activeId;

    // nothing to change the second time
    const again = VP.ensureDefaults(VP.serialize(profiles), activeId, page);
    ok(!again.changed, "second use: nothing changes");
    eq(again.profiles, profiles, "second use: the saved profiles are kept as they are");

    // the built-in one is put back if it went missing; a bad active id is repaired
    const missing = VP.ensureDefaults(VP.serialize([mine]), "gone", page);
    eq(missing.profiles.map(p => p.id), [mine.id, "local-only"], "the built-in profile is added back");
    eq(missing.activeId, mine.id, "an active id that no longer exists falls back to the first profile");
    ok(missing.changed, "and that is saved");
}

// ---------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------
{
    const log = [];
    const page = pageWith(mySettings, log);
    // the user edits something before switching
    page.cfg_ttsSpeedPercent = 125;
    page.cfg_sttLanguage = "es";
    log.length = 0;

    const res = VP.switchTo(profiles, activeId, "local-only", page);
    eq(res.activeId, "local-only", "switched");
    const left = VP.find(res.profiles, activeId);
    eq(left.ttsSpeedPercent, 125, "the profile being left took the edit made before the switch");
    eq(left.sttLanguage, "es", "including the other page's settings");
    eq(left.sttApiEndpoint, "https://api.groq.com/openai/v1", "and the Groq endpoint");
    eq(page.cfg_sttBackend, "whisper_cpp", "the page now has the local input");
    eq(page.cfg_ttsBackend, "kokoro_local", "and the local output");
    eq(page.cfg_ttsKokoroMixes, '[{"name":"mine","voice":"af_heart(1)"}]', "saved Kokoro mixes are untouched by a switch");
    eq(log.slice(-2).sort(), ["sttBackend", "ttsBackend"], "the backends are set last");
    eq(log.filter(f => f === "sttBackend").length, 1, "each backend is set once");
    // switching to the profile already active does nothing
    const same = VP.switchTo(res.profiles, res.activeId, "local-only", page);
    eq(same.profiles, res.profiles, "switching to the active profile changes nothing");
    const unknown = VP.switchTo(res.profiles, res.activeId, "nope", page);
    eq(unknown.activeId, "local-only", "switching to an unknown profile changes nothing");

    // an edit on Local only is kept there, then back to My setup restores everything
    page.cfg_ttsKokoroVoice = "bf_emma";
    const back = VP.switchTo(res.profiles, res.activeId, activeId, page);
    eq(page.cfg_sttBackend, "openai_transcriptions", "back: the Groq backend");
    eq(page.cfg_sttProviderName, "Groq", "back: the provider");
    eq(page.cfg_sttApiEndpoint, "https://api.groq.com/openai/v1", "back: the Groq endpoint");
    eq(page.cfg_sttModelName, "whisper-large-v3-turbo", "back: the model");
    eq(page.cfg_ttsBackend, "openai_speech", "back: the output backend");
    eq(page.cfg_ttsVoice, "alloy", "back: the voice");
    eq(page.cfg_ttsSpeedPercent, 125, "back: the edit made before the first switch is still there");
    eq(VP.find(back.profiles, "local-only").ttsKokoroVoice, "bf_emma", "Local only kept the edit made while it was active");

    // saveConfig: what the active profile holds follows the page
    page.cfg_ttsPitch = 7;
    const saved = VP.saveActive(back.profiles, back.activeId, page);
    eq(VP.find(saved, activeId).ttsPitch, 7, "saving writes the page's values into the active profile");
    eq(VP.find(saved, "local-only").ttsKokoroVoice, "bf_emma", "and leaves the others alone");
}

// ---------------------------------------------------------------------
// The Model default voice travels with a profile
// ---------------------------------------------------------------------
{
    const page = pageWith({ ttsVoice: SpeechRules.MODEL_DEFAULT_VOICE, ttsBackend: "kokoro_local" });
    const created = VP.createProfile(profiles, "Travel", page);
    eq(created.profile.ttsVoice, SpeechRules.MODEL_DEFAULT_VOICE, "the Model default voice is stored in a profile");
    const round = VP.load(VP.serialize(created.profiles));
    const p = VP.find(round, created.profile.id);
    eq(p.ttsVoice, SpeechRules.MODEL_DEFAULT_VOICE, "and survives saving and loading");
    const other = pageWith({});
    VP.applyToPage(p, other);
    eq(other.cfg_ttsVoice, SpeechRules.MODEL_DEFAULT_VOICE, "and is put on the page");
    // bad values are repaired
    const bad = VP.load(JSON.stringify([{ id: "x", name: "X", ttsRate: "abc", sttCliFp16: "true", sttCliThreads: "4" }]));
    eq(bad[0].ttsRate, 0, "a number that is not a number takes the default");
    eq(bad[0].sttCliFp16, true, "a yes/no value is read");
    eq(bad[0].sttCliThreads, 4, "a number saved as text is read");
}

// ---------------------------------------------------------------------
// A profile saved before a field existed
// ---------------------------------------------------------------------
{
    const old = JSON.stringify([{ id: "vp_old", name: "Old", sttBackend: "whisper_cli", ttsBackend: "spd_say" }]);
    const loaded = VP.load(old);
    eq(loaded.length, 1, "an old profile loads");
    for (const f of VP.VOICE_FIELDS) {
        if (f !== "sttBackend" && f !== "ttsBackend")
            eq(loaded[0][f], VP.DEFAULTS[f], "old profile: " + f + " filled from the defaults");
    }
    eq(loaded[0].sttBackend, "whisper_cli", "old profile: saved fields are kept");
    eq(VP.load("garbage"), [], "unreadable saved profiles load as none");
    eq(VP.load(""), [], "no saved profiles load as none");
    eq(VP.load('[{"name":"no id"},{"id":"a","name":"A"},{"id":"a","name":"dup"}]').map(p => p.id), ["a"], "entries without an id and repeated ids are dropped");
    const page = pageWith({});
    VP.applyToPage(loaded[0], page);
    eq(page.cfg_ttsKokoroFormat, "pcm", "applying an old profile sets the new fields to their defaults");
}

// ---------------------------------------------------------------------
// New, copy, rename, delete
// ---------------------------------------------------------------------
{
    const page = pageWith(mySettings);
    const made = VP.createProfile(profiles, "Work", page);
    eq(made.profiles.length, 3, "new: a third profile");
    eq(made.profile.name, "Work", "new: named");
    eq(made.profile.sttApiEndpoint, "https://api.groq.com/openai/v1", "new: starts from the page's current settings");
    eq(VP.createProfile(made.profiles, "work", page).profile.name, "work 2", "new: a name already used gets a number");
    eq(VP.createProfile(made.profiles, "   ", page).profile.name, "My setup 2", "new: a blank name gets the default name, numbered because My setup exists");
    eq(VP.createProfile([], "   ", page).profile.name, "My setup", "new: a blank name gets the default name");

    const copy = VP.duplicate(made.profiles, made.profile.id, "");
    eq(copy.profile.name, "Work copy", "copy: named after the original");
    ok(copy.profile.id !== made.profile.id, "copy: its own id");
    eq(copy.profile.ttsSpeedPercent, 110, "copy: same settings");
    const copyLocal = VP.duplicate(made.profiles, "local-only", "My local");
    ok(!copyLocal.profile.builtIn && copyLocal.profile.id !== "local-only", "a copy of Local only is an ordinary profile");
    eq(copyLocal.profile.ttsBackend, "kokoro_local", "and keeps its settings");
    eq(VP.duplicate(made.profiles, "nope", "x").profile, null, "copying something absent does nothing");

    const renamed = VP.rename(made.profiles, made.profile.id, "Office");
    ok(renamed.renamed, "rename works");
    eq(VP.find(renamed.profiles, made.profile.id).name, "Office", "renamed");
    eq(VP.find(made.profiles, made.profile.id).name, "Work", "the original list is not changed");
    ok(!VP.rename(made.profiles, "local-only", "Other").renamed, "Local only cannot be renamed");
    ok(!VP.rename(made.profiles, made.profile.id, "  ").renamed, "a blank name is refused");
    eq(VP.find(VP.rename(made.profiles, made.profile.id, "my setup").profiles, made.profile.id).name, "my setup 2", "a name used by another profile gets a number");
    eq(VP.find(VP.rename(made.profiles, made.profile.id, "Work").profiles, made.profile.id).name, "Work", "keeping the same name is fine");

    const ids = made.profiles.map(p => p.id);
    const delActive = VP.remove(made.profiles, made.profile.id, made.profile.id);
    ok(delActive.removed, "delete works");
    eq(delActive.profiles.map(p => p.id), ids.slice(0, 2), "deleted");
    eq(delActive.activeId, "local-only", "deleting the active profile picks the one before it");
    const delOther = VP.remove(made.profiles, ids[0], made.profile.id);
    eq(delOther.activeId, ids[0], "deleting another profile keeps the active one");
    const delFirst = VP.remove(made.profiles, ids[0], ids[0]);
    eq(delFirst.activeId, "local-only", "deleting the first active profile picks the next one");
    const noLocal = VP.remove(made.profiles, activeId, "local-only");
    ok(!noLocal.removed, "Local only cannot be deleted");
    eq(noLocal.profiles.length, 3, "and stays");
    const lone = VP.remove([VP.find(made.profiles, "local-only")], "local-only", "local-only");
    ok(!lone.removed, "the last profile cannot be deleted");
}

// ---------------------------------------------------------------------
// Reset to built-in
// ---------------------------------------------------------------------
{
    const edited = profiles.map(p => p.id === "local-only"
        ? Object.assign({}, p, { sttBackend: "openai_transcriptions", ttsBackend: "spd_say", ttsKokoroVoice: "bf_emma", sttModelName: "x" })
        : p);
    const r = VP.resetProfile(edited, "local-only");
    ok(r.reset, "reset works on Local only");
    const p = VP.find(r.profiles, "local-only");
    eq([p.sttBackend, p.ttsBackend], ["whisper_cpp", "kokoro_local"], "reset: the two backends are local again");
    eq(p.ttsKokoroVoice, "bf_emma", "reset: the other settings stay");
    eq(p.sttModelName, "", "reset: a model from another backend is not kept");
    ok(p.builtIn === true && p.name === "Local only", "reset: still the built-in profile");
    ok(!VP.resetProfile(edited, activeId).reset, "reset does nothing on an ordinary profile");
    // reset keeps the whisper.cpp model when it was already on whisper.cpp
    const keep = VP.resetProfile(profiles.map(p => p.id === "local-only" ? Object.assign({}, p, { sttModelName: "/m/ggml-base.bin" }) : p), "local-only");
    eq(VP.find(keep.profiles, "local-only").sttModelName, "/m/ggml-base.bin", "reset: a whisper.cpp model is kept");
}

// The saved text for a built-in profile can't be turned into an ordinary one
{
    const tampered = VP.load(JSON.stringify([{ id: "local-only", name: "Renamed", sttBackend: "whisper_cpp" }]));
    eq(tampered[0].name, "Local only", "the built-in name is fixed");
    ok(tampered[0].builtIn === true, "and it stays built in");
}

// ---------------------------------------------------------------------
// Noticing edits (the pages bind to this to keep the active profile current)
// ---------------------------------------------------------------------
{
    const page = pageWith(mySettings);
    const before = VP.valuesKey(page);
    eq(VP.valuesKey(page), before, "same settings: same key");
    page.cfg_ttsVoice = "nova";
    ok(VP.valuesKey(page) !== before, "a voice change changes the key");
    const afterVoice = VP.valuesKey(page);
    page.cfg_sttLanguage = "es";
    ok(VP.valuesKey(page) !== afterVoice, "a language change changes the key");
    const afterLanguage = VP.valuesKey(page);
    page.cfg_voiceProfiles = "[]";
    page.cfg_activeVoiceProfileId = "x";
    eq(VP.valuesKey(page), afterLanguage, "the profile list itself is not a profile setting");
}

// ---------------------------------------------------------------------
// The Defaults button must not wipe saved profiles
// ---------------------------------------------------------------------
{
    const saved = VP.serialize(profiles);
    eq(VP.keepSavedProfiles(saved, ""), saved, "Defaults writing an empty list keeps the saved profiles");
    eq(VP.keepSavedProfiles(saved, "[]"), saved, "an empty array is a wipe too");
    eq(VP.keepSavedProfiles(saved, "not json"), saved, "unreadable text is a wipe too");
    eq(VP.keepSavedProfiles(saved, '[{"name":"no id"}]'), saved, "a list with no usable profile is a wipe too");
    const edited = VP.serialize(VP.rename(profiles, profiles[0].id, "Renamed").profiles);
    eq(VP.keepSavedProfiles(saved, edited), edited, "a real change goes through");
    eq(VP.keepSavedProfiles("", saved), saved, "first use: nothing saved yet, so the new list goes through");
    eq(VP.keepSavedProfiles("", ""), "", "first use with nothing: stays empty");
    eq(VP.keepSavedProfiles("[]", ""), "", "nothing worth keeping: the new value goes through");

    eq(VP.keepActiveProfileId("vp_1", ""), "vp_1", "Defaults writing a blank active id keeps the saved one");
    eq(VP.keepActiveProfileId("vp_1", "   "), "vp_1", "a blank id is a wipe");
    eq(VP.keepActiveProfileId("vp_1", "local-only"), "local-only", "switching profile goes through");
    eq(VP.keepActiveProfileId("", "vp_2"), "vp_2", "first use goes through");

    // Every settings page extends BaseConfigPage and carries these two settings,
    // so the guard has to be there and has to use the functions above.
    const guard = base.replace(/\s+/g, " ");
    ok(/onCfg_voiceProfilesChanged: \{[^}]*VoiceProfiles\.keepSavedProfiles\(_keptVoiceProfiles, cfg_voiceProfiles\)[^}]*cfg_voiceProfiles = kept/.test(guard),
        "BaseConfigPage puts a wiped profile list back");
    ok(/onCfg_activeVoiceProfileIdChanged: \{[^}]*VoiceProfiles\.keepActiveProfileId\(_keptActiveVoiceProfileId, cfg_activeVoiceProfileId\)[^}]*cfg_activeVoiceProfileId = kept/.test(guard),
        "BaseConfigPage puts a wiped active id back");
    ok(/Component\.onCompleted: \{ _keptVoiceProfiles = cfg_voiceProfiles; _keptActiveVoiceProfileId = cfg_activeVoiceProfileId;/.test(guard),
        "the saved values are remembered when the page opens");
}

// ---------------------------------------------------------------------
// A model list still loading during a profile switch is dropped
// (QML cannot run here, so this reads the page source for the guard)
// ---------------------------------------------------------------------
function functionBody(src, name) {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) return null;
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
}
for (const page of ["configTts.qml", "configSpeech.qml"]) {
    const src = fs.readFileSync(ui + page, "utf8");
    ok(/property int _voiceGen: 0/.test(src), page + ": has a profile-switch counter");
    const after = functionBody(src, "afterVoiceProfileApplied");
    ok(after !== null && /^\s*_voiceGen\+\+;/.test(after), page + ": the counter is bumped first thing when a profile is applied");
    ok(after !== null && /fetchInProgress = false;/.test(after), page + ": a fetch left running does not block the new profile's own fetch");
    const fetch = functionBody(src, "fetchModels");
    ok(fetch !== null, page + ": has fetchModels");
    if (fetch !== null) {
        const start = fetch.indexOf("var startedGen = _voiceGen;");
        const stale = fetch.indexOf("if (startedGen !== _voiceGen)");
        const reset = fetch.indexOf("fetchInProgress = false;", fetch.indexOf("fetchInProgress = true;"));
        ok(start >= 0 && start > fetch.indexOf("fetchInProgress = true;"), page + ": fetchModels notes the counter when it starts");
        ok(stale > start && stale < reset, page + ": the result is dropped, before it touches anything, when the counter has moved on");
    }
}
{
    const cli = functionBody(fs.readFileSync(ui + "configSpeech.qml", "utf8"), "applyCliModelList");
    ok(cli !== null && cli.indexOf("var startedGen = _voiceGen;") >= 0 && cli.indexOf("if (startedGen !== _voiceGen)") > cli.indexOf("var startedGen"),
        "configSpeech.qml: the Whisper CLI model list is dropped too when the profile changed meanwhile");
}

if (failed) {
    console.error(failed + " failing check(s)");
    process.exit(1);
}
console.log("voice_profiles: all checks passed");
