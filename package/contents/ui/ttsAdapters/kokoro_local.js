/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Local Kokoro (kokoro-fastapi) backend. The server speaks the OpenAI
// /audio/speech format, so requests go through openai_speech.js with
// Kokoro's own settings: its URL, voice, format, speed, volume and language.

.import "openai_speech.js" as OpenaiSpeech

var id = "kokoro_local";
var displayName = "Kokoro (local)";
var transport = "endpoint";

var MODEL = "kokoro";
var DEFAULT_VOICE = "af_heart";
var DEFAULT_FORMAT = "pcm";

// The unit this plasmoid installs restarts uvicorn after a fixed number of
// requests; a synthesize call that lands in that gap retries instead of failing.
// It retries only when the connection fails, not when the server answers with
// an HTTP error, so a real error from Kokoro still shows up at once.
var RESTART_RETRIES = 8;

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

/** A blank Server URL means Kokoro is not set up (or was declined). */
function isConfigured(conn) {
    if (!conn || !conn.enabled)
        return false;
    return trimStr(conn.endpoint).length > 0;
}

/**
 * @param {object} opts  as for OpenaiSpeech.buildCommand, plus
 * @param {number} [opts.volumeMultiplier]  1 = unchanged
 * @param {string} [opts.langCode]          "" = from the voice name
 */
function buildCommand(opts) {
    opts = opts || {};
    var extra = {};
    var vol = Number(opts.volumeMultiplier);
    if (isFinite(vol) && vol > 0 && Math.abs(vol - 1) > 0.001)
        extra.volume_multiplier = Math.round(vol * 100) / 100;
    var lang = trimStr(opts.langCode);
    if (lang.length)
        extra.lang_code = lang;
    return OpenaiSpeech.buildCommand({
        text: opts.text,
        endpoint: opts.endpoint,
        apiKey: "",
        model: MODEL,
        voice: trimStr(opts.voice) || DEFAULT_VOICE,
        responseFormat: trimStr(opts.responseFormat) || DEFAULT_FORMAT,
        speed: opts.speed,
        extraFields: extra,
        retries: RESTART_RETRIES,
        tempDir: opts.tempDir
    });
}

function buildStopCommand() {
    return OpenaiSpeech.buildStopCommand();
}

/**
 * As the endpoint adapter's, plus "unreachable" when curl could not connect
 * (exit 7, which the synthesize command only returns once its retries ran
 * out): nothing is listening at the Server URL.
 */
function parseResult(stdout, stderr, exitCode) {
    var res = OpenaiSpeech.parseResult(stdout, stderr, exitCode);
    if (res.err && (exitCode === 7 || exitCode === "7"))
        res.unreachable = true;
    return res;
}

/**
 * The server's voices (GET /audio/voices), in the same callback shape as
 * the other adapters: function(err, models, voices) with voices["*"].
 */
function fetchModels(endpoint, apiKey, callback) {
    callback = callback || function() {};
    OpenaiSpeech.fetchModels(endpoint, "", function(err, models, voices) {
        if (err) {
            callback(err, null);
            return;
        }
        var list = voices && Array.isArray(voices["*"]) ? voices["*"] : [];
        if (!list.length) {
            callback("No Kokoro voices were reported by " + endpoint, null);
            return;
        }
        callback(null, [MODEL], { "*": list }, {}, true);
    });
}
