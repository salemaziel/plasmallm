/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// OpenRouter and OpenAI-compatible speech endpoint adapter.
// Supports OpenRouter (google/gemini-3.8-flash-lite-tts with raw PCM)
// and OpenAI (tts-1, tts-1-hd with MP3), as well as custom endpoints.

.import "../utils.js" as Utils
.import "speechRules.js" as SpeechRules

var id = "openai_speech";
var displayName = "OpenRouter / OpenAI speech endpoint";
var transport = "endpoint";

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

function isConfigured(conn) {
    if (!conn || !conn.enabled)
        return false;
    if (!conn.endpoint || String(conn.endpoint).length === 0)
        return false;
    if (!conn.model || String(conn.model).length === 0)
        return false;
    return true;
}

function defaultVoiceForModel(model) {
    var m = String(model || "").toLowerCase();
    if (m.indexOf("gemini") >= 0)
        return "Zephyr";
    if (m.indexOf("kokoro") >= 0)
        return "af_heart";
    return "alloy";
}

function defaultFormatForModel(model) {
    var m = String(model || "").toLowerCase();
    if (m.indexOf("gemini") >= 0)
        return "pcm";
    return "mp3";
}

/**
 * Build shell command to synthesize speech from endpoint and play it.
 *
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.text
 * @param {string} [opts.voice]         SpeechRules.MODEL_DEFAULT_VOICE leaves
 *                                      the voice field out of the request
 * @param {string} [opts.responseFormat]  pcm | mp3; only honoured for models
 *                                      known to send 24000 Hz PCM and under the
 *                                      Custom preset, every other model is
 *                                      asked for mp3
 * @param {string} [opts.providerName]  the provider preset ("Custom" lets the
 *                                      user's responseFormat through)
 * @param {string} [opts.tempDir]
 * @param {number} [opts.speed]         0.25–4; sent only when not 1, since
 *                                      some OpenRouter models reject any other
 * @param {string} [opts.instructions]  how the voice should sound; never sent
 *                                      to tts-1 / tts-1-hd, which reject it
 * @param {object} [opts.extraFields]   merged into the request (Kokoro's
 *                                      volume_multiplier, lang_code)
 * @param {number} [opts.retries]       how many times to retry, one second
 *                                      apart, to ride out a server restart;
 *                                      only when the connection fails (curl
 *                                      exit 7), never on HTTP errors; none
 *                                      unless given
 * @returns {string} shell command
 */
function buildCommand(opts) {
    opts = opts || {};
    var text = String(opts.text || "");
    if (!text.trim().length)
        throw new Error("No text to speak");

    var endpoint = Utils.withScheme(trimStr(opts.endpoint)).replace(/\/+$/, "");
    if (!endpoint.length)
        throw new Error("TTS endpoint is not configured");

    var model = trimStr(opts.model);
    if (!model.length)
        throw new Error("TTS model is not configured");

    var url = endpoint + "/audio/speech";
    var omitVoice = SpeechRules.isModelDefaultVoice(opts.voice);
    var voice = trimStr(opts.voice) || defaultVoiceForModel(model);
    var format = SpeechRules.resolveFormat(model, opts.responseFormat, defaultFormatForModel(model), opts.providerName);
    var apiKey = trimStr(opts.apiKey);

    var tempDir = opts.tempDir || "/tmp/plasmallm_tts";
    var stamp = Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

    var jsonFile = tempDir + "/req_" + stamp + ".json";
    var audioFile = tempDir + "/speech_" + stamp + "." + (format === "pcm" ? "pcm" : "mp3");
    var wavFile = tempDir + "/speech_" + stamp + ".wav";

    var payload = {
        model: model,
        input: text,
        voice: voice,
        response_format: format
    };
    // "Model default": the model picks its own voice. Some models reject any
    // voice name that is not theirs, and an empty one.
    if (omitVoice)
        delete payload.voice;

    var speed = Number(opts.speed);
    if (isFinite(speed) && speed > 0) {
        speed = Math.round(Math.max(0.25, Math.min(4, speed)) * 100) / 100;
        if (speed !== 1)
            payload.speed = speed;
    }
    var instructions = trimStr(opts.instructions);
    if (instructions.length && !/^(openai\/)?tts-1(-hd)?$/i.test(model))
        payload.instructions = instructions;
    var extra = opts.extraFields || {};
    for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k))
            payload[k] = extra[k];
    }

    var payloadStr = JSON.stringify(payload);

    // Opt-in: retry only when the connection itself fails (curl exit 7, a
    // server that is restarting). curl's own --retry would also retry HTTP
    // 408/429/5xx replies, which delays a real error by the whole retry window.
    var retries = Math.floor(Number(opts.retries));
    retries = (isFinite(retries) && retries > 0) ? Math.min(retries, 30) : 0;

    var curlCall = "CODE=$(curl -s -X POST " + shellQuote(url)
        + " -H 'Content-Type: application/json'"
        + (apiKey.length ? (" -H 'Authorization: Bearer " + apiKey.replace(/'/g, "'\\''") + "'") : "")
        + " -d @" + shellQuote(jsonFile)
        + " -o " + shellQuote(audioFile)
        + " -w '%{http_code}')";

    var scriptParts = [
        "mkdir -p " + shellQuote(tempDir),
        "printf '%s' " + shellQuote(payloadStr) + " > " + shellQuote(jsonFile),
        retries > 0 ? withConnectRetry(curlCall, retries) : curlCall,
        'if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ]; then '
            + 'cat ' + shellQuote(audioFile) + ' 1>&2; '
            + 'rm -f ' + shellQuote(jsonFile) + ' ' + shellQuote(audioFile) + '; '
            + 'exit 1; '
            + 'fi',
        // A 200 reply with no audio in it is a failure too: without this the
        // player runs on an empty file and the reply is silently lost.
        'if [ ! -s ' + shellQuote(audioFile) + ' ]; then '
            + "echo 'The speech server returned no audio.' 1>&2; "
            + 'rm -f ' + shellQuote(jsonFile) + ' ' + shellQuote(audioFile) + '; '
            + 'exit 1; '
            + 'fi'
    ];

    var playParts = [];

    if (format === "pcm") {
        // Convert raw 24kHz 16-bit mono PCM into standard WAV
        var pcmToWav = "python3 -c \"import wave, sys; "
            + "d=open('" + audioFile.replace(/'/g, "'\\''") + "','rb').read(); "
            + "w=wave.open('" + wavFile.replace(/'/g, "'\\''") + "','wb'); "
            + "w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); "
            + "w.writeframes(d); w.close()\"";
        scriptParts.push(pcmToWav);
        playParts.push("(pw-play " + shellQuote(wavFile) + " 2>/dev/null || paplay " + shellQuote(wavFile) + " 2>/dev/null || aplay " + shellQuote(wavFile) + " 2>/dev/null)");
        playParts.push("rm -f " + shellQuote(jsonFile) + " " + shellQuote(audioFile) + " " + shellQuote(wavFile));
    } else {
        playParts.push("(pw-play " + shellQuote(audioFile) + " 2>/dev/null || paplay " + shellQuote(audioFile) + " 2>/dev/null || ffplay -nodisp -autoexit " + shellQuote(audioFile) + " 2>/dev/null)");
        playParts.push("rm -f " + shellQuote(jsonFile) + " " + shellQuote(audioFile));
    }

    scriptParts.push("echo TTS_READY");

    var synthCmd = scriptParts.join(" && ");
    var playCmd = playParts.join("; ");
    var fullCmd = synthCmd + " && " + playCmd;

    var res = new String(fullCmd);
    res.synthesizeCmd = synthCmd;
    res.playCmd = playCmd;
    return res;
}

/**
 * Wrap a `CODE=$(curl ...)` assignment in a loop that runs it again, one
 * second apart, up to `retries` more times, but only while curl exits 7
 * (could not connect). Any other outcome ends the loop: success, an HTTP
 * error reply (CODE then holds the status), or a different curl failure,
 * which is passed on as the script's exit code like an unwrapped call.
 */
function withConnectRetry(curlCall, retries) {
    return "{ TRY=0; while :; do " + curlCall + "; RC=$?; "
        + "{ [ \"$RC\" -eq 7 ] && [ \"$TRY\" -lt " + retries + " ]; } || break; "
        + "TRY=$((TRY+1)); sleep 1; done; "
        + "[ \"$RC\" -eq 0 ] || exit \"$RC\"; }";
}

/**
 * Build the command to stop speech playback immediately.
 * @returns {string}
 */
function buildStopCommand() {
    return "pkill -f '/tmp/plasmallm_tts' 2>/dev/null; pkill -f 'pw-play.*/tmp/plasmallm_tts' 2>/dev/null; pkill -f 'paplay.*/tmp/plasmallm_tts' 2>/dev/null";
}

function parseResult(stdout, stderr, exitCode) {
    if (exitCode !== 0 && exitCode !== "0") {
        var raw = trimStr(stderr) || trimStr(stdout) || ("Exit code " + exitCode);
        var detail = raw;
        try {
            var errObj = JSON.parse(raw);
            if (errObj && errObj.error) {
                if (typeof errObj.error === "string")
                    detail = errObj.error;
                else if (errObj.error.message)
                    detail = errObj.error.message;
            } else if (errObj && errObj.message) {
                detail = errObj.message;
            }
        } catch (e) {
            if (detail.length > 250)
                detail = detail.substring(0, 250);
        }
        return { err: "Text-to-speech request failed: " + detail, result: null };
    }
    return { err: null, result: { success: true } };
}

var DEFAULT_TTS_MODELS = [
    "google/gemini-3.8-flash-lite-tts",
    "openai/tts-1",
    "openai/tts-1-hd",
    "tts-1",
    "tts-1-hd"
];

function defaultKnownModels() {
    return DEFAULT_TTS_MODELS.slice();
}

function isSpeechModel(entry, id) {
    var arch = entry && typeof entry === "object" ? entry.architecture : null;
    var out = arch && Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
    if (out.indexOf("speech") >= 0)
        return true;
    var lower = id.toLowerCase();
    return lower.indexOf("tts") >= 0 || lower.indexOf("speech") >= 0
        || lower.indexOf("audio") >= 0 || lower.indexOf("kokoro") >= 0;
}

/**
 * Fetch available TTS models from the endpoint, seeded with known TTS models.
 *
 * Voices come from two places: OpenRouter lists `supported_voices` on each
 * model, and Kokoro-FastAPI style servers answer GET /audio/voices with one
 * list for the whole server. The voices map is keyed by model id, with "*"
 * holding the server-wide list.
 *
 * @param {string} endpoint
 * @param {string} apiKey
 * The model list is what the endpoint reports; the built-in defaults are
 * used only when it reports no speech models (unreachable, or no /models).
 * `prices` maps model id to the endpoint's `pricing` object (OpenRouter).
 *
 * `reported` (5th callback argument) is true when the models came from the
 * endpoint and false when the built-in defaults were substituted.
 *
 * @param {function} callback function(err, models, voices, prices, reported)
 */
function fetchModels(endpoint, apiKey, callback) {
    callback = callback || function() {};
    var base = Utils.withScheme(trimStr(endpoint)).replace(/\/+$/, "");
    if (!base.length) {
        callback("TTS endpoint is not configured", null);
        return;
    }

    var defaultModels = defaultKnownModels();

    function setHeaders(xhr, key) {
        xhr.setRequestHeader("Accept", "application/json");
        var k = trimStr(key);
        if (k.length > 0) {
            xhr.setRequestHeader("Authorization", "Bearer " + k);
        }
    }

    function getJson(url, done) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.timeout = 25000;
        setHeaders(xhr, apiKey);
        var finished = false;
        function finish(json) {
            if (finished) return;
            finished = true;
            done(json);
        }
        xhr.ontimeout = function() { finish(null); };
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE)
                return;
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    finish(JSON.parse(xhr.responseText));
                } catch (e) {
                    finish(null);
                }
            } else {
                finish(null);
            }
        };
        try {
            xhr.send();
        } catch (e) {
            finish(null);
        }
    }

    function voiceNames(list) {
        var names = [];
        if (!Array.isArray(list))
            return names;
        for (var i = 0; i < list.length; i++) {
            var v = list[i];
            var name = typeof v === "string" ? v : (v && (v.id || v.name) ? (v.id || v.name) : "");
            if (name && names.indexOf(name) === -1)
                names.push(name);
        }
        return names;
    }

    // output_modalities=speech asks OpenRouter for TTS models (its default
    // listing is text-only); other servers ignore the parameter.
    getJson(base + "/models?output_modalities=speech", function(json) {
        var voices = {};
        var prices = {};
        var found = [];
        var data = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
        for (var i = 0; i < data.length; i++) {
            var id = typeof data[i] === "string" ? data[i] : (data[i] && data[i].id ? data[i].id : "");
            if (!id || !isSpeechModel(data[i], id)) continue;
            // Kokoro-FastAPI also lists tts-1 / tts-1-hd: compatibility
            // names for the same model. Only "kokoro" is shown.
            if (data[i] && data[i].owned_by === "kokoro" && /^tts-1(-hd)?$/.test(id)) continue;
            if (found.indexOf(id) === -1)
                found.push(id);
            if (data[i] && data[i].pricing && typeof data[i].pricing === "object")
                prices[id] = data[i].pricing;
            var mv = voiceNames(data[i] && data[i].supported_voices);
            if (mv.length > 0)
                voices[id] = mv;
        }

        getJson(base + "/audio/voices", function(vjson) {
            var sv = voiceNames(vjson && (Array.isArray(vjson) ? vjson : vjson.voices));
            if (sv.length > 0)
                voices["*"] = sv;
            callback(null, found.length > 0 ? found : defaultModels, voices, prices, found.length > 0);
        });
    });
}
