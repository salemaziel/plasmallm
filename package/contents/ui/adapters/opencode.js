/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// OpenCode Go adapter (https://opencode.ai/docs/go/).
//
// OpenCode Go is a single subscription fronting a curated set of coding models
// (GLM, Kimi, DeepSeek, MiniMax, Qwen, MiMo, Grok, GPT Luna). It is a gateway,
// not a model host: requests are forwarded to whichever upstream actually owns
// the model, so errors surface in the *upstream's* dialect and the set of
// models reachable on a given wire format changes over time.
//
// Three wire formats are served from the same account and the same key:
//   OpenAI chat  https://opencode.ai/zen/go/v1/chat/completions  (Bearer)
//   Anthropic    https://opencode.ai/zen/go/v1/messages          (x-api-key)
//   OpenAI resp  https://opencode.ai/zen/go/v1/responses         (Bearer)
//
// A model is generally reachable on exactly one of them, and picking wrong
// fails at the endpoint level rather than degrading. This adapter routes by
// model, and on an endpoint-level rejection with no output retries on the
// remaining formats, remembering what worked for the rest of the session.

.import "openai_chat.js" as Chat
.import "anthropic.js" as Anthropic
.import "openai_responses.js" as Responses

var id = "opencode";
var displayName = "OpenCode Go";

// The OpenAI-format base. The Anthropic strategy appends "/v1/messages" itself,
// so it is handed the parent path instead.
var OPENAI_BASE = "https://opencode.ai/zen/go/v1";
var ANTHROPIC_BASE = "https://opencode.ai/zen/go";
var CONSOLE_URL = "https://opencode.ai/auth";

var presets = [
    { name: "OpenCode Go", url: OPENAI_BASE }
];

var capabilities = {
    providerPresets: true,
    customEndpoint: true,
    reasoningEffort: true,
    thinkingBudget: false,
    fetchModels: true,
    reasoningHelp: "OpenCode Go serves reasoning models (GLM, DeepSeek, Kimi, MiniMax) over chat completions; thoughts arrive as reasoning_content and are shown when effort is not Off."
};

// The model list is public — no key required — so the settings page can populate
// the dropdown before the user has pasted anything.
var publicModelList = true;

// Routing, measured against the live gateway (2026-08-17: all 26 advertised
// models on chat/completions and messages, a subset on responses) and checked
// against the endpoint tables in the OpenCode Go docs:
//
//   chat + messages   minimax-m3 / m2.7 / m2.5, kimi-k3
//   chat only         glm-5 / 5.1 / 5.2 / 5.3, kimi-k2.5 / k2.6 / k2.7-code,
//                     mimo-v2.5 / v2.5-pro, hy3
//   messages only     every qwen3.x (-plus and -max alike) -> HTTP 503
//                     "Endpoint is unavailable." on chat/completions
//   responses         grok-4.5, gpt-5.6-luna
//   unreachable       deepseek-v4-* (403 RegionError, China-hosted opt-in),
//                     mimo-v2-pro / v2-omni (deprecated upstream), hy3-preview
//
// The formats are not strictly partitioned — glm-5.3 answers on responses too —
// so routing is by model rather than by probing for whatever replies.
//
// gpt-5.6-luna answers on chat/completions as well, but is routed to responses
// deliberately. On chat/completions the gateway shims its Responses output into
// chat deltas, and the shim is lossy: tool-call ids arrive as "fc_tmp_..."
// (a Responses function-call item id) and both parallel calls land on delta
// index 0, which is what corrupts the arguments string. Streamed natively from
// /responses the same prompt yields two clean items on output_index 0 and 1,
// each with its own id and its own arguments delta. Routing here removes the
// cause; toolCallNormalizer still covers the symptom.
//
// Qwen is a whole-family prefix rule, so a new qwen3.9-plus routes correctly on
// day one. Everything else defaults to chat/completions and self-corrects
// through the runtime fallback below as OpenCode reshuffles its backends.
var MODEL_FORMATS = {
    "grok-4.5": "responses",
    "gpt-5.6-luna": "responses"
};

var MODEL_PREFIX_FORMATS = [
    { prefix: "qwen", format: "anthropic" }
];

// Order the runtime fallback walks when the routed format rejects the request
// at the endpoint level. chat/completions serves the most models, so it is
// tried first among the alternatives.
var FALLBACK_ORDER = ["openai", "anthropic", "responses"];

// Session-scoped learning from actual responses.
var learnedFormats = {};

function formatFor(model) {
    if (!model) return "openai";
    if (learnedFormats[model]) return learnedFormats[model];
    if (MODEL_FORMATS[model]) return MODEL_FORMATS[model];
    var lower = String(model).toLowerCase();
    for (var i = 0; i < MODEL_PREFIX_FORMATS.length; i++) {
        if (lower.indexOf(MODEL_PREFIX_FORMATS[i].prefix) === 0) {
            return MODEL_PREFIX_FORMATS[i].format;
        }
    }
    return "openai";
}

function _shallowCopy(obj) {
    var out = {};
    if (!obj) return out;
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) out[k] = obj[k];
    }
    return out;
}

function fetchModels(endpoint, apiKey, opts, callback) {
    if (typeof opts === "function") {
        callback = opts;
        opts = null;
    }
    // Always read the canonical list; a stale custom endpoint would otherwise
    // return models this account cannot reach.
    return Chat.fetchModels(OPENAI_BASE, apiKey, callback);
}

function buildTools(options) {
    // Built in OpenAI shape unconditionally; converted per-request when a model
    // turns out to need the Anthropic format.
    return Chat.buildTools(options);
}

function buildContentArray(text, attachments) {
    return Chat.buildContentArray(text, attachments);
}

// OpenAI {type,function:{name,description,parameters}} -> Anthropic
// {name,description,input_schema}.
function toAnthropicTools(tools) {
    var out = [];
    if (!tools) return out;
    for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        var fn = t && t["function"];
        if (!fn || !fn.name) continue;
        out.push({
            name: fn.name,
            description: fn.description || "",
            input_schema: fn.parameters || { type: "object", properties: {} }
        });
    }
    return out;
}

// OpenAI chat {type,function:{name,description,parameters}} -> Responses' flat
// {type:"function",name,description,parameters}.
function toResponsesTools(tools) {
    var out = [];
    if (!tools) return out;
    for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        var fn = t && t["function"];
        if (!fn || !fn.name) continue;
        out.push({
            type: "function",
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} }
        });
    }
    return out;
}

// The Responses strategy's translateMessages passes an array content through
// verbatim, because openai.js hands it parts that were already built in
// Responses shape. Here they are always built in chat shape, so convert:
// text -> input_text, image_url -> input_image (a bare URL string, not an
// object). Applies to tool results too — translateMessages reads their text
// from parts typed input_text.
function convertContentForResponses(content) {
    if (!Array.isArray(content)) return content;
    var out = [];
    for (var i = 0; i < content.length; i++) {
        var part = content[i];
        if (!part) continue;
        if (part.type === "text") {
            out.push({ type: "input_text", text: part.text || "" });
        } else if (part.type === "image_url" && part.image_url && part.image_url.url) {
            out.push({ type: "input_image", image_url: part.image_url.url });
        } else {
            out.push(part);
        }
    }
    return out;
}

function convertMessagesForResponses(messages) {
    if (!messages) return messages;
    var out = [];
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m && Array.isArray(m.content)) {
            var copy = _shallowCopy(m);
            copy.content = convertContentForResponses(m.content);
            out.push(copy);
        } else {
            out.push(m);
        }
    }
    return out;
}

// Content parts are built in OpenAI shape (buildContentArray delegates to the
// chat strategy, and it has no idea which model the turn will use). Text blocks
// are identical across both APIs, but images are not: OpenAI carries a data URL
// in image_url, Anthropic wants a split base64 source block. Convert on the way
// out so attachments survive a request routed to /messages.
function convertContentForAnthropic(content) {
    if (!Array.isArray(content)) return content;
    var out = [];
    for (var i = 0; i < content.length; i++) {
        var part = content[i];
        if (part && part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
            var m = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
            if (m) {
                out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
                continue;
            }
            // A non-data URL cannot be inlined; drop it rather than send a block
            // the Messages API will reject outright.
            continue;
        }
        out.push(part);
    }
    return out;
}

function convertMessagesForAnthropic(messages) {
    if (!messages) return messages;
    var out = [];
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m && Array.isArray(m.content)) {
            var copy = _shallowCopy(m);
            copy.content = convertContentForAnthropic(m.content);
            out.push(copy);
        } else {
            out.push(m);
        }
    }
    return out;
}

// Does this failure mean "wrong endpoint for this model" rather than "your
// request was bad"? Checked against the HTTP status and raw body so it does not
// depend on the localized error string the strategy produced.
//
// The gateway signals a format mismatch in at least two different ways, and one
// of them is an HTTP 401 that has nothing to do with the key:
//
//   /chat/completions, qwen3.7-plus  503 "Endpoint is unavailable."
//   /responses, minimax-m3           401 {"type":"ModelError","message":
//                                     "Model minimax-m3 is not supported for
//                                      format openai"}
//
// So the body has to be matched before the status is trusted. Reading that 401
// as an auth failure would report a bad API key and skip the retry that would
// have succeeded.
function looksLikeWrongEndpoint(status, body) {
    var text = String(body || "").toLowerCase();
    if (text.indexOf("not supported for format") !== -1) return true;
    if (text.indexOf("modelerror") !== -1) return true;
    if (status === 404) return true;
    if (status === 503) {
        return text.indexOf("endpoint is unavailable") !== -1
            || text.indexOf("no endpoint") !== -1
            || text.indexOf("not supported") !== -1;
    }
    return false;
}

// Translate gateway/upstream errors into something actionable. OpenCode relays
// the upstream verbatim, so the raw text is often a provider-internal code the
// user has no way to interpret.
function explainError(status, body, fallbackMessage) {
    var text = String(body || "");
    var lower = text.toLowerCase();

    // Region-locked models (the DeepSeek v4 family) answer 403 with a
    // RegionError that has nothing to do with the key being wrong.
    if (lower.indexOf("regionerror") !== -1 || lower.indexOf("hosted in china") !== -1) {
        return i18n("This model is only served from OpenCode's China-hosted region and needs explicit opt-in on your account. Enable it at %1, or pick a different model.", CONSOLE_URL);
    }
    if (lower.indexOf("has been deprecated") !== -1) {
        return i18n("OpenCode Go has retired this model upstream. Pick a newer one — the model list still advertises it, but no backend serves it.");
    }
    if (lower.indexOf("model is unavailable") !== -1) {
        return i18n("OpenCode Go currently has no backend for this model. Pick a different one; availability shifts without notice.");
    }
    // Must precede the 401/403 check: a format mismatch answers 401, and
    // reporting it as a rejected key sends the user chasing the wrong problem.
    if (lower.indexOf("not supported for format") !== -1 || lower.indexOf("modelerror") !== -1) {
        return i18n("OpenCode Go does not serve this model on any wire format PlasmaLLM supports. Pick a different model — this is not a problem with your API key.");
    }
    if (status === 401 || status === 403) {
        return i18n("OpenCode Go rejected the API key (HTTP %1). Generate one at %2 and paste it into the API key field.", status, CONSOLE_URL);
    }
    if (status === 402) {
        return i18n("OpenCode Go usage limit reached (HTTP 402). The plan caps spend per 5 hours, week, and month; wait for the window to reset, switch to a free model, or enable balance fallback at %1.", CONSOLE_URL);
    }
    if (status === 429) {
        return i18n("OpenCode Go rate limited this request (HTTP 429). Wait a moment, or switch model — the limit is shared across the models on your plan.");
    }
    if (looksLikeWrongEndpoint(status, text)) {
        return i18n("OpenCode Go does not serve this model on either wire format right now (HTTP %1). Pick a different model — availability shifts between backends.", status);
    }
    if (lower.indexOf("invalid function arguments json string") !== -1) {
        return i18n("The upstream rejected a stored tool call as malformed JSON. This conversation's history is corrupt; start a new chat with /clear.");
    }
    if (lower.indexOf("context") !== -1 && lower.indexOf("length") !== -1) {
        return i18n("The conversation exceeded this model's context window. Enable Context Compaction in settings, or start a new chat.");
    }
    return fallbackMessage;
}

function sendStreaming(opts) {
    var model = opts.model;
    var triedFormats = {};
    var failures = [];

    function nextUntriedFormat() {
        for (var i = 0; i < FALLBACK_ORDER.length; i++) {
            if (!triedFormats[FALLBACK_ORDER[i]]) return FALLBACK_ORDER[i];
        }
        return null;
    }

    function describeAttempts(lastFormat, lastStatus) {
        var parts = [];
        for (var i = 0; i < failures.length; i++) {
            parts.push(failures[i].format + ": HTTP " + failures[i].status);
        }
        parts.push(lastFormat + ": HTTP " + lastStatus);
        return parts.join(", ");
    }

    // Proxy handle: main.qml holds this for cancellation and stream polling, and
    // it must stay valid across a format retry that swaps the underlying xhr.
    var proxy = {
        xhr: null,
        pollTimer: null,
        processBuffer: function() {
            if (proxy._inner && proxy._inner.processBuffer) proxy._inner.processBuffer();
        },
        setPollTimer: function(timer) {
            proxy.pollTimer = timer;
            proxy._timer = timer;
            if (proxy._inner && proxy._inner.setPollTimer) proxy._inner.setPollTimer(timer);
        },
        _inner: null,
        _timer: null
    };

    function start(format) {
        triedFormats[format] = true;

        var options = _shallowCopy(opts);
        if (format === "anthropic") {
            options.endpoint = ANTHROPIC_BASE;
            options.tools = toAnthropicTools(opts.tools);
            options.messages = convertMessagesForAnthropic(opts.messages);
        } else if (format === "responses") {
            // The Responses strategy appends "/responses" to the endpoint, so
            // it takes the same /v1 base as chat completions.
            options.endpoint = OPENAI_BASE;
            options.tools = toResponsesTools(opts.tools);
            options.messages = convertMessagesForResponses(opts.messages);
        } else {
            options.endpoint = OPENAI_BASE;
        }

        options.onComplete = function(text, error, toolCalls, assistantMsg) {
            var inner = proxy._inner;
            var status = (inner && inner.xhr) ? inner.xhr.status : 0;
            var body = (inner && inner.xhr) ? inner.xhr.responseText : "";

            // Retry on the other wire format only when nothing was produced —
            // never after partial output, which would duplicate it.
            var producedNothing = (!text || text.length === 0) && (!toolCalls || toolCalls.length === 0);
            if (error && producedNothing && looksLikeWrongEndpoint(status, body)) {
                var other = nextUntriedFormat();
                if (other) {
                    console.warn("PlasmaLLM OpenCode Go: " + model + " rejected on " + format
                                 + " (HTTP " + status + "), retrying as " + other);
                    failures.push({ format: format, status: status, body: body });
                    start(other);
                    return;
                }
            }

            if (!error) {
                // Remember what worked so later turns skip the failed attempts.
                if (learnedFormats[model] !== format) {
                    learnedFormats[model] = format;
                }
                failures = [];
            } else if (failures.length > 0) {
                // Every format refused. Reporting only the last attempt would
                // blame the wrong thing — a model can answer 503 on one
                // endpoint and 401 on another, which reads as a bad key.
                error = i18n("OpenCode Go could not serve \"%1\" on any supported wire format (%2). This usually means the model is not available on your plan right now — pick a different one.",
                             model, describeAttempts(format, status));
            } else {
                error = explainError(status, body, error);
            }

            opts.onComplete(text, error, toolCalls, assistantMsg);
        };

        var inner;
        if (format === "anthropic") inner = Anthropic.sendStreaming(options);
        else if (format === "responses") inner = Responses.sendStreaming(options);
        else inner = Chat.sendStreaming(options);
        proxy._inner = inner;
        proxy.xhr = inner.xhr;
        if (proxy._timer && inner.setPollTimer) inner.setPollTimer(proxy._timer);
        return inner;
    }

    start(formatFor(model));
    return proxy;
}
