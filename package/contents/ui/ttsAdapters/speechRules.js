/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

// Facts about speech models that both the request builder (openai_speech.js)
// and the settings page need, kept in one place: which audio format to ask
// for, which models are OpenAI's, and the "Model default" voice.

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

/**
 * OpenAI's own speech models, under their own name (tts-1, tts-1-hd,
 * gpt-4o-mini-tts, with an optional date suffix) or through OpenRouter,
 * where every id starts with "openai/".
 */
function isOpenAiModel(model) {
    var m = trimStr(model).toLowerCase();
    if (m.indexOf("openai/") === 0)
        return m.length > 7;
    return /^(tts-1(-hd)?|gpt-[a-z0-9.-]+-tts)(-\d[\w.-]*)?$/.test(m);
}

/**
 * Models known to send raw PCM at 24000 Hz, the only rate the WAV wrapper
 * in openai_speech.js writes. Raw PCM has no header, so a model that sends
 * another rate (fish-audio sends 44100 Hz) plays slow and deep. OpenAI's
 * models and Kokoro send 24000 Hz; Gemini TTS is documented as 24000 Hz
 * 16-bit mono and is the OpenRouter preset's default model.
 */
function sendsPcm24k(model) {
    var m = trimStr(model).toLowerCase();
    if (!m.length)
        return false;
    return isOpenAiModel(m) || m.indexOf("kokoro") >= 0 || m.indexOf("gemini") >= 0;
}

/** The provider preset for any endpoint the user types in themselves. */
function isCustomProvider(providerName) {
    return trimStr(providerName) === "Custom";
}

/**
 * Whether the user's Audio format choice is used for this model: models known
 * to send 24000 Hz PCM, and anything under the Custom preset (the user picked
 * that endpoint and model themselves, so the choice is theirs). On the other
 * presets an unlisted model is always asked for MP3.
 */
function formatIsChoosable(model, providerName) {
    return sendsPcm24k(model) || isCustomProvider(providerName);
}

/**
 * The response_format to request. When the format is choosable (see above) it
 * is what was asked for (`requested`, else `fallback`), unchanged. Otherwise
 * MP3, which carries its own sample rate, whatever was asked for.
 *
 * @param {string} model
 * @param {string} requested
 * @param {string} fallback
 * @param {string} [providerName]  the provider preset; without it only the
 *                                 24 kHz model list counts
 */
function resolveFormat(model, requested, fallback, providerName) {
    if (!formatIsChoosable(model, providerName))
        return "mp3";
    return trimStr(requested) || fallback;
}

// What the settings page stores when "Model default" is chosen as the voice.
// An empty voice is a different thing (a voice never chosen): the request
// builder fills that with a default voice name, as it always has.
var MODEL_DEFAULT_VOICE = "@model-default";

function isModelDefaultVoice(voice) {
    return trimStr(voice) === MODEL_DEFAULT_VOICE;
}

/**
 * The voice list for a model that no endpoint reported voices for.
 * OpenAI's models get their six voices (`openAiVoices`); every other model
 * gets only "Model default". With no model named yet the six are kept, as
 * they always were, so a half-typed model name doesn't empty the list.
 */
function unreportedVoices(model, openAiVoices) {
    if (!trimStr(model).length || isOpenAiModel(model))
        return openAiVoices.slice();
    return [MODEL_DEFAULT_VOICE];
}

/** Stored voice → what the voice box shows (label stands for "Model default"). */
function voiceToText(voice, label) {
    return isModelDefaultVoice(voice) ? label : voice;
}

/** What the voice box shows or holds → the voice to store. */
function textToVoice(text, label) {
    return trimStr(text) === label ? MODEL_DEFAULT_VOICE : text;
}

/**
 * Switching provider presets (the settings page). Each preset gets back what
 * it had when it was left, for as long as the settings window stays open.
 *
 * @param {object} memos       preset name → {endpoint, model, voice, responseFormat}
 * @param {string} leaving     the preset shown now ("" if none)
 * @param {string} target      the preset being picked
 * @param {object} current     the four settings as they are now
 * @param {string[]} presetNames  names of the real presets
 * @returns {{memos: object, restore: object|null, same: boolean}}
 *   memos: a copy with the preset being left stored; restore: what to put
 *   back for `target`, or null to use its built-in values (not visited yet,
 *   nothing entered when it was left, or the same preset picked again).
 */
function planPresetSwitch(memos, leaving, target, current, presetNames) {
    var next = {};
    for (var name in memos) {
        if (Object.prototype.hasOwnProperty.call(memos, name))
            next[name] = memos[name];
    }
    var same = leaving === target;
    if (!same && presetNames.indexOf(leaving) >= 0) {
        next[leaving] = {
            endpoint: current.endpoint || "",
            model: current.model || "",
            voice: current.voice || "",
            responseFormat: current.responseFormat || ""
        };
    }
    var m = same ? null : next[target];
    var usable = !!m && (m.endpoint.length > 0 || m.model.length > 0 || m.voice.length > 0);
    return { memos: next, restore: usable ? m : null, same: same };
}
