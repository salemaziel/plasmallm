/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

// Voice profiles: named sets of the Speech to Text and Text to Speech
// settings (which programs and voices are used). Every decision lives here so
// Node can test it; the settings pages only call these functions with
// themselves as `page` (an object with cfg_<name> properties).
//
// Deliberately NOT in a profile: the on/off switches and auto-read options,
// mic mode, hold time, max seconds and the panel shortcut, the model/voice/
// price caches, the setup "don't ask again" lists, the saved Kokoro mixes
// (ttsKokoroMixes, shared by every profile), and the API keys (they stay in
// KWallet, looked up by provider and endpoint).

var BUILT_IN_LOCAL_ID = "local-only";
var BUILT_IN_LOCAL_NAME = "Local only";
var FIRST_PROFILE_NAME = "My setup";

// Defaults mirror config/main.xml (tests/voice_profiles.mjs checks that).
var DEFAULTS = {
    sttBackend: "openai_transcriptions",
    sttProviderName: "",
    sttApiEndpoint: "",
    sttModelName: "",
    sttLanguage: "",
    sttCliBinary: "whisper",
    sttCliTask: "transcribe",
    sttCliDevice: "",
    sttCliFp16: false,
    sttCliThreads: 0,
    sttCliInitialPrompt: "",
    sttCliExtraArgs: "",
    sttCppBinary: "whisper-cli",
    sttCppModelDirs: "~/.voicemode/models/whisper:~/.voicemode/services/whisper/models:~/.cache/openwhispr/whisper-models:~/.cache/whisper.cpp",
    sttFallbacks: "[]",
    sttBackendModels: "{}",
    ttsBackend: "spd_say",
    ttsProviderName: "OpenRouter",
    ttsApiEndpoint: "https://openrouter.ai/api/v1",
    ttsModelName: "google/gemini-3.8-flash-lite-tts",
    ttsVoice: "Zephyr",
    ttsResponseFormat: "pcm",
    ttsRate: 0,
    ttsPitch: 0,
    ttsLanguage: "",
    ttsCliBinary: "spd-say",
    ttsCliTemplate: "",
    ttsCliExtraArgs: "",
    ttsSpeedPercent: 100,
    ttsInstructions: "",
    ttsKokoroUrl: "",
    ttsKokoroVoice: "af_heart",
    ttsKokoroFormat: "pcm",
    ttsKokoroVolumePercent: 100,
    ttsKokoroLangCode: "",
    ttsFallbacks: "[]"
};

var VOICE_FIELDS = [
    "sttBackend", "sttProviderName", "sttApiEndpoint", "sttModelName", "sttLanguage",
    "sttCliBinary", "sttCliTask", "sttCliDevice", "sttCliFp16", "sttCliThreads",
    "sttCliInitialPrompt", "sttCliExtraArgs", "sttCppBinary", "sttCppModelDirs",
    "sttFallbacks", "sttBackendModels",
    "ttsBackend", "ttsProviderName", "ttsApiEndpoint", "ttsModelName", "ttsVoice",
    "ttsResponseFormat", "ttsRate", "ttsPitch", "ttsLanguage", "ttsCliBinary",
    "ttsCliTemplate", "ttsCliExtraArgs", "ttsSpeedPercent", "ttsInstructions",
    "ttsKokoroUrl", "ttsKokoroVoice", "ttsKokoroFormat", "ttsKokoroVolumePercent",
    "ttsKokoroLangCode", "ttsFallbacks"
];

// A backend changes what the other fields mean, and a page reacts to a change
// of backend (it may reset the model list), so these go in last.
var BACKEND_FIELDS = ["sttBackend", "ttsBackend"];

// ---------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------

function trimStr(value) {
    return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
}

function isJsonArrayText(text) {
    try {
        return Array.isArray(JSON.parse(text));
    } catch (e) {
        return false;
    }
}

function isJsonObjectText(text) {
    try {
        var v = JSON.parse(text);
        return !!v && typeof v === "object" && !Array.isArray(v);
    } catch (e) {
        return false;
    }
}

/** A saved value made to fit the field's type; anything that does not fit becomes the default. */
function coerce(field, value) {
    var def = DEFAULTS[field];
    if (value === undefined || value === null)
        return def;
    if (typeof def === "boolean")
        return value === true || value === "true";
    if (typeof def === "number") {
        var n = Number(value);
        return isFinite(n) ? n : def;
    }
    var s = String(value);
    if (field === "sttFallbacks" || field === "ttsFallbacks")
        return isJsonArrayText(s) ? s : def;
    if (field === "sttBackendModels")
        return isJsonObjectText(s) ? s : def;
    return s;
}

function copyFields(from) {
    var out = {};
    for (var i = 0; i < VOICE_FIELDS.length; i++) {
        var f = VOICE_FIELDS[i];
        out[f] = coerce(f, from ? from[f] : undefined);
    }
    return out;
}

// ---------------------------------------------------------------------
// The saved list
// ---------------------------------------------------------------------

function generateId() {
    return "vp_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function isBuiltIn(profile) {
    return !!profile && profile.id === BUILT_IN_LOCAL_ID;
}

/** One saved profile made complete: every field present and of the right type. A profile saved before a field existed gets that field's default. */
function normalizeProfile(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !trimStr(raw.id).length)
        return null;
    var p = copyFields(raw);
    p.id = trimStr(raw.id);
    p.name = trimStr(raw.name).length ? trimStr(raw.name) : (p.id === BUILT_IN_LOCAL_ID ? BUILT_IN_LOCAL_NAME : FIRST_PROFILE_NAME);
    if (p.id === BUILT_IN_LOCAL_ID) {
        p.name = BUILT_IN_LOCAL_NAME;
        p.builtIn = true;
    }
    return p;
}

/** The saved setting (a JSON array) as a list of complete profiles; anything unreadable is an empty list. */
function load(raw) {
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
    var out = [];
    if (!Array.isArray(arr))
        return out;
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
        var p = normalizeProfile(arr[i]);
        if (!p || seen[p.id])
            continue;
        seen[p.id] = true;
        out.push(p);
    }
    return out;
}

function serialize(profiles) {
    return JSON.stringify(profiles || []);
}

function find(profiles, id) {
    for (var i = 0; i < (profiles || []).length; i++) {
        if (profiles[i].id === id)
            return profiles[i];
    }
    return null;
}

function indexOf(profiles, id) {
    for (var i = 0; i < (profiles || []).length; i++) {
        if (profiles[i].id === id)
            return i;
    }
    return -1;
}

/** The active profile, or the first one when the saved id is gone. */
function getActive(profiles, activeId) {
    var p = find(profiles, activeId);
    if (p)
        return p;
    return profiles && profiles.length ? profiles[0] : null;
}

/** A name nobody else has: "Work" becomes "Work 2" when "Work" exists. */
function uniqueName(profiles, name, exceptId) {
    var base = trimStr(name);
    if (!base.length)
        base = FIRST_PROFILE_NAME;
    function taken(n) {
        for (var i = 0; i < (profiles || []).length; i++) {
            if (profiles[i].id !== exceptId && profiles[i].name.toLowerCase() === n.toLowerCase())
                return true;
        }
        return false;
    }
    if (!taken(base))
        return base;
    var n = 2;
    while (taken(base + " " + n))
        n++;
    return base + " " + n;
}

/**
 * sttBackendModels remembers the model last chosen for each speech-to-text
 * backend (one setting, sttModelName, holds only the main backend's). Returns
 * the new text for the setting, with `model` recorded for `backendId`.
 */
function recordBackendModel(modelsText, backendId, model) {
    var map = {};
    try {
        var parsed = JSON.parse(modelsText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            map = parsed;
    } catch (e) {
        map = {};
    }
    var id = trimStr(backendId);
    if (!id.length)
        return JSON.stringify(map);
    var m = trimStr(model);
    if (m.length)
        map[id] = m;
    else
        delete map[id];
    return JSON.stringify(map);
}

// ---------------------------------------------------------------------
// The built-in "Local only"
// ---------------------------------------------------------------------

/**
 * Local speech programs only. Everything else starts as a copy of `base` (the
 * current settings), so the whisper.cpp program, the model folders and the
 * Kokoro address found by setup carry over. A model name from the previous
 * speech-to-text backend means nothing to whisper.cpp, so the model is the one
 * last chosen for it, or blank until the page offers its setup.
 */
function localOnlyProfile(base) {
    var p = copyFields(base);
    var models = {};
    try {
        var parsed = JSON.parse(p.sttBackendModels);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            models = parsed;
    } catch (e) {
        models = {};
    }
    p.sttBackend = "whisper_cpp";
    p.sttModelName = typeof models.whisper_cpp === "string" ? models.whisper_cpp : "";
    p.ttsBackend = "kokoro_local";
    p.sttFallbacks = "[]";
    p.ttsFallbacks = "[]";
    p.id = BUILT_IN_LOCAL_ID;
    p.name = BUILT_IN_LOCAL_NAME;
    p.builtIn = true;
    return p;
}

/** "Reset to built-in": the two backends go back to local and the fallbacks are cleared; the rest stays. */
function resetBuiltIn(profile) {
    if (!isBuiltIn(profile))
        return profile;
    var base = localOnlyProfile(profile);
    for (var i = 0; i < VOICE_FIELDS.length; i++) {
        var f = VOICE_FIELDS[i];
        if (f === "sttBackend" || f === "ttsBackend" || f === "sttFallbacks" || f === "ttsFallbacks" || f === "sttModelName")
            continue;
        base[f] = profile[f];
    }
    // The model stays when it was chosen for whisper.cpp, else the last one chosen for it.
    if (profile.sttBackend === "whisper_cpp")
        base.sttModelName = profile.sttModelName;
    return base;
}

/**
 * First use. With no saved profiles: "My setup" holds the current settings and
 * "Local only" is added. With saved profiles: the built-in one is added if it
 * has gone missing, and the active id is repaired. Nothing saved is changed.
 *
 * @returns {{profiles: object[], activeId: string, changed: boolean}}
 */
function ensureDefaults(raw, activeId, page) {
    var profiles = load(raw);
    var changed = false;
    var current = capturedValues(page);
    if (!profiles.length) {
        var mine = copyFields(current);
        mine.id = generateId();
        mine.name = FIRST_PROFILE_NAME;
        profiles.push(mine);
        activeId = mine.id;
        changed = true;
    }
    if (!find(profiles, BUILT_IN_LOCAL_ID)) {
        profiles.push(localOnlyProfile(current));
        changed = true;
    }
    if (!find(profiles, activeId)) {
        activeId = profiles[0].id;
        changed = true;
    }
    return { profiles: profiles, activeId: activeId, changed: changed };
}

// ---------------------------------------------------------------------
// Moving values between a profile and a settings page
// ---------------------------------------------------------------------

/** The page's current values, one per field. */
function capturedValues(page) {
    var out = {};
    for (var i = 0; i < VOICE_FIELDS.length; i++) {
        var f = VOICE_FIELDS[i];
        out[f] = page ? page["cfg_" + f] : undefined;
    }
    return out;
}

/**
 * One string that changes whenever any profile setting on the page changes.
 * A page binds to it to notice edits (reading the values here is what lets
 * the binding see them change).
 */
function valuesKey(page) {
    return JSON.stringify(capturedValues(page));
}

/** A copy of `profile` holding what the page has now. */
function captureFromPage(profile, page) {
    if (!profile)
        return null;
    var p = {};
    for (var k in profile)
        p[k] = profile[k];
    var cur = capturedValues(page);
    for (var i = 0; i < VOICE_FIELDS.length; i++) {
        var f = VOICE_FIELDS[i];
        if (cur[f] !== undefined)
            p[f] = coerce(f, cur[f]);
        else if (p[f] === undefined)
            p[f] = DEFAULTS[f];
    }
    return p;
}

/** Put the profile's values on the page. The backends are set last. */
function applyToPage(profile, page) {
    if (!profile || !page)
        return;
    var full = copyFields(profile);
    for (var i = 0; i < VOICE_FIELDS.length; i++) {
        var f = VOICE_FIELDS[i];
        if (BACKEND_FIELDS.indexOf(f) < 0)
            page["cfg_" + f] = full[f];
    }
    for (var j = 0; j < BACKEND_FIELDS.length; j++)
        page["cfg_" + BACKEND_FIELDS[j]] = full[BACKEND_FIELDS[j]];
}

// ---------------------------------------------------------------------
// What the bar does
// ---------------------------------------------------------------------

/**
 * Switch profiles. The profile being left takes what the page holds, then the
 * target is put on the page, so switching back is the undo.
 *
 * @returns {{profiles: object[], activeId: string}}  `page` is changed too
 */
function switchTo(profiles, activeId, targetId, page) {
    var target = find(profiles, targetId);
    if (!target || targetId === activeId)
        return { profiles: profiles, activeId: activeId };
    var list = [];
    for (var i = 0; i < profiles.length; i++) {
        list.push(profiles[i].id === activeId ? captureFromPage(profiles[i], page) : profiles[i]);
    }
    applyToPage(find(list, targetId), page);
    return { profiles: list, activeId: targetId };
}

/** The list with the active profile holding what the page has now (for saveConfig). */
function saveActive(profiles, activeId, page) {
    var list = [];
    for (var i = 0; i < profiles.length; i++)
        list.push(profiles[i].id === activeId ? captureFromPage(profiles[i], page) : profiles[i]);
    return list;
}

/** A new profile from the page's current settings. The page itself is not changed. */
function createProfile(profiles, name, page) {
    var p = copyFields(capturedValues(page));
    p.id = generateId();
    p.name = uniqueName(profiles, name);
    return { profiles: profiles.concat([p]), profile: p };
}

/** A copy of an existing profile. The built-in one is copied as an ordinary profile. */
function duplicate(profiles, id, name) {
    var src = find(profiles, id);
    if (!src)
        return { profiles: profiles, profile: null };
    var p = copyFields(src);
    p.id = generateId();
    p.name = uniqueName(profiles, trimStr(name).length ? name : src.name + " copy");
    return { profiles: profiles.concat([p]), profile: p };
}

/** The built-in profile keeps its name. */
function rename(profiles, id, name) {
    var p = find(profiles, id);
    if (!p || isBuiltIn(p) || !trimStr(name).length)
        return { profiles: profiles, renamed: false };
    var list = profiles.map(function(x) {
        if (x.id !== id)
            return x;
        var c = {};
        for (var k in x)
            c[k] = x[k];
        c.name = uniqueName(profiles, name, id);
        return c;
    });
    return { profiles: list, renamed: true };
}

/**
 * Delete a profile. The built-in one cannot be deleted. Deleting the active
 * profile picks the one before it (or the first); the caller then applies it.
 *
 * @returns {{profiles: object[], activeId: string, removed: boolean}}
 */
function remove(profiles, activeId, id) {
    var p = find(profiles, id);
    if (!p || isBuiltIn(p) || profiles.length <= 1)
        return { profiles: profiles, activeId: activeId, removed: false };
    var at = indexOf(profiles, id);
    var list = profiles.filter(function(x) { return x.id !== id; });
    var nextActive = activeId;
    if (id === activeId)
        nextActive = list[Math.max(0, at - 1)].id;
    return { profiles: list, activeId: nextActive, removed: true };
}

/** Put the built-in profile back to local. If it is active, the caller applies it again. */
function resetProfile(profiles, id) {
    var p = find(profiles, id);
    if (!p || !isBuiltIn(p))
        return { profiles: profiles, reset: false };
    return {
        profiles: profiles.map(function(x) { return x.id === id ? resetBuiltIn(x) : x; }),
        reset: true
    };
}
