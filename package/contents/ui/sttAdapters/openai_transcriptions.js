/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// OpenAI-compatible / OpenRouter speech-to-text via POST /audio/transcriptions.
// OpenRouter takes a JSON body with base64 input_audio; every other host
// (OpenAI, Groq, local whisper servers) takes the standard multipart upload.

.import "../utils.js" as Utils

var id = "openai_transcriptions";
var displayName = "OpenAI-compatible transcriptions";
var transport = "http";

function isConfigured(conn) {
    if (!conn || !conn.enabled)
        return false;
    if (!conn.endpoint || String(conn.endpoint).length === 0)
        return false;
    if (!conn.model || String(conn.model).length === 0)
        return false;
    return true;
}

// OpenRouter app attribution (see applyOpenRouterAttribution in utils.js for
// the explicit-true opt-out rule). Model listing calls setHeaders without
// opts and stays unattributed.
function setHeaders(xhr, apiKey, endpoint, opts, contentType) {
    xhr.setRequestHeader("Content-Type", contentType || "application/json");
    if (apiKey && apiKey.length > 0) {
        xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
    }
    Utils.applyOpenRouterAttribution(xhr, opts, endpoint);
}

function hostOf(endpoint) {
    return Utils.hostOf(endpoint);
}

function isOpenAiHost(endpoint) {
    var h = hostOf(endpoint);
    return h === "api.openai.com" || h === "openai.com";
}

function parseModelIds(responseText) {
    var response = JSON.parse(responseText);
    var models = [];
    if (response && response.data) {
        for (var i = 0; i < response.data.length; i++) {
            if (response.data[i] && response.data[i].id)
                models.push(response.data[i].id);
        }
    }
    return models;
}

// { modelId: pricing } from a /models response that carries `pricing`
// (OpenRouter); empty for hosts that don't publish prices.
function parseModelPricing(responseText) {
    var out = {};
    try {
        var response = JSON.parse(responseText);
        var data = response && Array.isArray(response.data) ? response.data : [];
        for (var i = 0; i < data.length; i++) {
            if (data[i] && data[i].id && data[i].pricing && typeof data[i].pricing === "object")
                out[data[i].id] = data[i].pricing;
        }
    } catch (e) {}
    return out;
}

// OpenRouter is the only host known to want the JSON input_audio body.
function usesJsonBody(endpoint) {
    var h = hostOf(endpoint);
    return h === "openrouter.ai" || /\.openrouter\.ai$/.test(h);
}

var _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(b64) {
    var clean = String(b64 || "").replace(/[^A-Za-z0-9+/]/g, "");
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var o = 0, buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
        buf = (buf << 6) | _B64.indexOf(clean.charAt(i));
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (buf >> bits) & 0xff;
        }
    }
    return o === out.length ? out : out.subarray(0, o);
}

function _asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++)
        out[i] = str.charCodeAt(i) & 0xff;
    return out;
}

var _AUDIO_MIME = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", webm: "audio/webm",
    m4a: "audio/mp4", flac: "audio/flac" };

// multipart/form-data body for /audio/transcriptions. fields is a flat
// { name: value } map; the audio goes in the "file" part.
// Returns { contentType, body: Uint8Array }.
function buildMultipartBody(fields, audioBytes, format, boundary) {
    var fmt = format || "wav";
    boundary = boundary || ("plasmallm" + Date.now().toString(16) + Math.floor(Math.random() * 1e9).toString(16));
    var head = "";
    for (var name in fields) {
        if (fields[name] === undefined || fields[name] === null || fields[name] === "")
            continue;
        head += "--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
            + String(fields[name]) + "\r\n";
    }
    head += "--" + boundary + "\r\n"
        + "Content-Disposition: form-data; name=\"file\"; filename=\"audio." + fmt + "\"\r\n"
        + "Content-Type: " + (_AUDIO_MIME[fmt] || "application/octet-stream") + "\r\n\r\n";
    var tail = "\r\n--" + boundary + "--\r\n";
    var a = _asciiBytes(head), c = _asciiBytes(tail);
    var body = new Uint8Array(a.length + audioBytes.length + c.length);
    body.set(a, 0);
    body.set(audioBytes, a.length);
    body.set(c, a.length + audioBytes.length);
    return { contentType: "multipart/form-data; boundary=" + boundary, body: body };
}

function knownOpenAiSttModels() {
    return [
        "gpt-transcribe",
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "whisper-1"
    ];
}

/**
 * List STT models. OpenRouter requires output_modalities=transcription;
 * default GET /models omits whisper/gpt-transcribe entirely.
 *
 * Strategy:
 *  1) Try /models?output_modalities=transcription (OpenRouter and any host that supports it)
 *  2) Fall back to plain /models
 *  3) Seed known OpenAI STT ids if still empty and host is OpenAI
 */
function fetchModels(endpoint, apiKey, callback) {
    callback = callback || function() {};
    var base = (endpoint || "").replace(/\/+$/, "");
    if (!base) {
        callback(i18n("STT endpoint is not configured"), null);
        return;
    }

    function getJson(url, onDone) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.timeout = 30000;
        setHeaders(xhr, apiKey);
        xhr.ontimeout = function() { onDone(i18n("Request timed out after 30 seconds"), null, 0); };
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE)
                return;
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    onDone(null, parseModelIds(xhr.responseText), xhr.status,
                        parseModelPricing(xhr.responseText));
                } catch (e) {
                    onDone(i18n("Failed to parse models: %1", e.message || String(e)), null, xhr.status);
                }
            } else {
                onDone(i18n("Failed to fetch models: HTTP %1", xhr.status), null, xhr.status);
            }
        };
        try {
            xhr.send();
        } catch (sendErr) {
            onDone(i18n("Model list request failed: %1", sendErr.message || String(sendErr)), null, 0);
        }
    }

    var transcriptionUrl = base + "/models?output_modalities=transcription";
    var plainUrl = base + "/models";

    // Hosts that ignore output_modalities (Groq) return their chat models
    // too; keep only speech-looking ids when there are any. OpenRouter's
    // list is already filtered and has STT models these names would miss.
    function speechOnly(models) {
        if (base.indexOf("openrouter.ai") >= 0)
            return models;
        var picked = [];
        for (var i = 0; i < models.length; i++) {
            if (/whisper|transcri|stt|speech/i.test(models[i]))
                picked.push(models[i]);
        }
        return picked.length > 0 ? picked : models;
    }

    getJson(transcriptionUrl, function(err, models, status, prices) {
        if (!err && models && models.length > 0) {
            callback(null, speechOnly(models), status, prices);
            return;
        }
        // OpenRouter: empty/error on plain list still won't include STT; try plain anyway for other hosts.
        getJson(plainUrl, function(err2, models2, status2, prices2) {
            if (!err2 && models2 && models2.length > 0) {
                callback(null, speechOnly(models2), status2, prices2);
                return;
            }
            if (isOpenAiHost(endpoint)) {
                callback(null, knownOpenAiSttModels(), 200);
                return;
            }
            // Prefer the transcription-query error if both failed.
            if (err && (!models2 || models2.length === 0))
                callback(err, null, status || status2);
            else if (err2)
                callback(err2, null, status2);
            else
                callback(i18n("No STT models returned"), null, status2 || status);
        });
    });
}

/**
 * Transcribe base64-encoded audio.
 * @param {object} opts
 * @param {string} opts.endpoint  Base URL ending in /v1 (or provider root)
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.audioBase64  Raw base64 (no data: URI prefix)
 * @param {string} opts.format       e.g. wav, mp3, ogg, webm, m4a, flac
 * @param {string} [opts.language]   Optional ISO-639-1 code
 * @param {function} opts.callback   function(err, result) result = { text }
 */
function transcribe(opts) {
    var callback = opts.callback || function() {};
    var endpoint = (opts.endpoint || "").replace(/\/+$/, "");
    if (!endpoint) {
        callback(i18n("STT endpoint is not configured"), null);
        return;
    }
    if (!opts.audioBase64 || opts.audioBase64.length === 0) {
        callback(i18n("No audio data to transcribe"), null);
        return;
    }
    if (!opts.model || String(opts.model).length === 0) {
        callback(i18n("STT model is not configured"), null);
        return;
    }

    var xhr = new XMLHttpRequest();
    var url = endpoint + "/audio/transcriptions";
    xhr.open("POST", url);
    xhr.timeout = 90000;
    var language = (opts.language && String(opts.language).trim().length > 0)
        ? String(opts.language).trim() : "";
    var payload;
    if (usesJsonBody(endpoint)) {
        setHeaders(xhr, opts.apiKey, endpoint, opts);
        var body = {
            model: opts.model,
            input_audio: {
                data: opts.audioBase64,
                format: opts.format || "wav"
            }
        };
        if (language)
            body.language = language;
        payload = JSON.stringify(body);
    } else {
        var mp = buildMultipartBody({ model: opts.model, language: language, response_format: "json" },
            base64ToBytes(opts.audioBase64), opts.format || "wav");
        setHeaders(xhr, opts.apiKey, endpoint, opts, mp.contentType);
        payload = mp.body.buffer;
    }

    xhr.ontimeout = function() {
        callback(i18n("Speech-to-text request timed out"), null);
    };

    xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE)
            return;
        if (xhr.status >= 200 && xhr.status < 300) {
            try {
                var response = JSON.parse(xhr.responseText);
                var text = (response && typeof response.text === "string") ? response.text : "";
                callback(null, { text: text });
            } catch (e) {
                callback(i18n("Failed to parse STT response: %1", e.message || String(e)), null);
            }
            return;
        }
        var detail = "";
        try {
            var errObj = JSON.parse(xhr.responseText);
            if (errObj && errObj.error) {
                if (typeof errObj.error === "string")
                    detail = errObj.error;
                else if (errObj.error.message)
                    detail = errObj.error.message;
            } else if (errObj && errObj.message) {
                detail = errObj.message;
            }
        } catch (e2) {
            detail = (xhr.responseText || "").substring(0, 240);
        }
        if (detail)
            callback(i18n("STT failed (HTTP %1): %2", xhr.status, detail), null);
        else
            callback(i18n("STT failed (HTTP %1)", xhr.status), null);
    };

    try {
        xhr.send(payload);
    } catch (sendErr) {
        callback(i18n("STT request failed: %1", sendErr.message || String(sendErr)), null);
    }
}
