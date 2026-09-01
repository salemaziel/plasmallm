/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// OpenCode Zen / Go gateway adapter. One apiType, two presets. Each model
// speaks a native protocol (Responses, chat completions, Anthropic messages,
// or Gemini generateContent); this module routes to the existing adapters
// after rewriting URLs/headers via opts.opencodeAuth.
//
// Protocol selection lives in ../opencodeRoute.js — pure, no QML or network,
// covered by tests/opencode_route.mjs. It maps from the official endpoint
// tables (https://opencode.ai/docs/zen/, https://opencode.ai/docs/go) with
// prefix fallbacks for newly listed siblings.
//
// Those tables go stale: OpenCode reshuffles which backend serves a model
// without notice, and a wrong guess fails at the endpoint level rather than
// degrading. So a request whose protocol was *defaulted* rather than matched
// retries on the remaining formats and remembers what worked for the session.
// See RETRY SCOPE below for why that is limited to defaulted routes.

.import "openai_chat.js" as Chat
.import "openai_responses.js" as Responses
.import "anthropic.js" as Anthropic
.import "gemini.js" as Gemini
.import "../opencodeRoute.js" as Route

var id = "opencode";
var displayName = "OpenCode";

var ZEN_BASE = "https://opencode.ai/zen/v1";
var GO_BASE = "https://opencode.ai/zen/go/v1";
var CONSOLE_URL = "https://opencode.ai/auth";

var presets = [
    { name: "OpenCode Zen", url: ZEN_BASE },
    { name: "OpenCode Go",  url: GO_BASE }
];

var capabilities = {
    providerPresets: true,
    customEndpoint: true,
    reasoningEffort: true,
    thinkingBudget: true,
    fetchModels: true,
    reasoningHelp: "OpenCode routes each model to its native API (Responses, chat completions, Anthropic, or Gemini). Reasoning effort and thinking budget apply when the selected model supports them."
};

// The model list is public — no key required — so the settings page can
// populate the dropdown before the user has pasted anything.
var publicModelList = true;

// RETRY SCOPE.
//
// buildTools/buildContentArray run at compose time and emit the *target
// protocol's* shape (anthropic.js wants {type:"image",source:{…}}, gemini.js
// wants {inlineData:{…}}). A payload built for one protocol therefore cannot
// simply be re-sent as another, and converting every pair would mean N×M
// translators.
//
// resolveProtocol returns "chat" as its default for anything it does not
// recognise, which is exactly the low-confidence route most likely to be
// wrong when OpenCode moves a backend. It is also the only shape with
// converters below. So: retry only when the static route *defaulted* to
// "chat". A model matched by an explicit prefix rule (claude-, gemini-,
// gpt-, qwen3., …) is a deliberate, high-confidence route — it gets error
// translation, not a retry that would post a mis-shaped body.
var FALLBACK_ORDER = ["chat", "anthropic", "responses"];

// Session-scoped learning, keyed by model. Only ever written for models whose
// static route defaulted to "chat", so a learned value always describes a
// payload that was built in chat shape and converted on the way out. Never
// consulted by buildTools/buildContentArray — letting it change the built
// shape mid-session would leave earlier history in the old one.
var learnedFormats = {};

function _shallowCopy(obj) {
    var out = {};
    if (!obj) return out;
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) out[k] = obj[k];
    }
    return out;
}

function productFromOpts(opts) {
    return Route.productFromEndpoint(
        opts && opts.endpoint,
        opts && opts.providerName
    );
}

// The static, build-time protocol. Deliberately ignores learnedFormats.
function protocolFor(opts, model) {
    var mid = model;
    if (mid === undefined || mid === null)
        mid = opts && opts.model;
    return Route.resolveProtocol(productFromOpts(opts), mid);
}

function copyOpts(opts, extra) {
    var o = _shallowCopy(opts);
    var k;
    o.opencodeAuth = true;
    if (extra) {
        for (k in extra) {
            if (extra.hasOwnProperty(k))
                o[k] = extra[k];
        }
    }
    return o;
}

// Always read the canonical list for the selected product; a stale custom
// endpoint would otherwise advertise models this account cannot reach.
function canonicalBase(endpoint, opts) {
    var product = Route.productFromEndpoint(
        (opts && opts.endpoint) || endpoint,
        opts && opts.providerName
    );
    return product === "go" ? GO_BASE : ZEN_BASE;
}

function fetchModels(endpoint, apiKey, opts, callback) {
    if (typeof opts === "function") {
        callback = opts;
        opts = null;
    }
    return Chat.fetchModels(canonicalBase(endpoint, opts), apiKey, callback);
}

function buildTools(options) {
    var p = protocolFor(options);
    var o = copyOpts(options);
    if (p === "responses") {
        o.usesResponsesAPI = true;
        return Responses.buildTools(o);
    }
    if (p === "anthropic")
        return Anthropic.buildTools(o);
    if (p === "gemini")
        return Gemini.buildTools(o);
    return Chat.buildTools(o);
}

function buildContentArray(text, attachments, extra) {
    var model = extra;
    var product = "zen";
    if (extra && typeof extra === "object") {
        model = extra.model;
        product = Route.productFromEndpoint(extra.endpoint, extra.providerName);
    }
    var p = Route.resolveProtocol(product, model);
    if (p === "responses")
        return Responses.buildContentArray(text, attachments);
    if (p === "anthropic")
        return Anthropic.buildContentArray(text, attachments);
    if (p === "gemini")
        return Gemini.buildContentArray(text, attachments);
    return Chat.buildContentArray(text, attachments);
}

// ---------------------------------------------------------------------------
// chat-shape -> other-protocol converters, used only on the retry path.
// ---------------------------------------------------------------------------

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
// verbatim, because it is normally handed parts already built in Responses
// shape. On the retry path they were built in chat shape, so convert:
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

// Text blocks are identical across both APIs, but images are not: OpenAI
// carries a data URL in image_url, Anthropic wants a split base64 source
// block. Convert on the way out so attachments survive a retry onto /messages.
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

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

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
        return i18n("OpenCode has retired this model upstream. Pick a newer one — the model list still advertises it, but no backend serves it.");
    }
    if (lower.indexOf("model is unavailable") !== -1) {
        return i18n("OpenCode currently has no backend for this model. Pick a different one; availability shifts without notice.");
    }
    // Must precede the 401/403 check: a format mismatch answers 401, and
    // reporting it as a rejected key sends the user chasing the wrong problem.
    if (lower.indexOf("not supported for format") !== -1 || lower.indexOf("modelerror") !== -1) {
        return i18n("OpenCode does not serve this model on any wire format PlasmaLLM supports. Pick a different model — this is not a problem with your API key.");
    }
    if (status === 401 || status === 403) {
        return i18n("OpenCode rejected the API key (HTTP %1). Generate one at %2 and paste it into the API key field.", status, CONSOLE_URL);
    }
    if (status === 402) {
        return i18n("OpenCode usage limit reached (HTTP 402). The plan caps spend per 5 hours, week, and month; wait for the window to reset, switch to a free model, or enable balance fallback at %1.", CONSOLE_URL);
    }
    if (status === 429) {
        return i18n("OpenCode rate limited this request (HTTP 429). Wait a moment, or switch model — the limit is shared across the models on your plan.");
    }
    if (looksLikeWrongEndpoint(status, text)) {
        return i18n("OpenCode does not serve this model on either wire format right now (HTTP %1). Pick a different model — availability shifts between backends.", status);
    }
    if (lower.indexOf("invalid function arguments json string") !== -1) {
        return i18n("The upstream rejected a stored tool call as malformed JSON. This conversation's history is corrupt; start a new chat with /clear.");
    }
    if (lower.indexOf("context") !== -1 && lower.indexOf("length") !== -1) {
        return i18n("The conversation exceeded this model's context window. Enable Context Compaction in settings, or start a new chat.");
    }
    return fallbackMessage;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function sendStreaming(opts) {
    var model = opts.model;
    var staticProtocol = protocolFor(opts);

    // Only a defaulted "chat" route may be retried — see RETRY SCOPE.
    var retryable = (staticProtocol === "chat");

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

        var o = copyOpts(opts);
        // The payload was built in `staticProtocol` shape. When that is "chat"
        // and we are trying something else, convert; otherwise it is already
        // correct and must be left alone.
        if (format !== staticProtocol) {
            if (format === "anthropic") {
                o.tools = toAnthropicTools(opts.tools);
                o.messages = convertMessagesForAnthropic(opts.messages);
            } else if (format === "responses") {
                o.usesResponsesAPI = true;
                o.tools = toResponsesTools(opts.tools);
                o.messages = convertMessagesForResponses(opts.messages);
            }
        } else if (format === "responses") {
            o.usesResponsesAPI = true;
        }

        o.onComplete = function(text, error, toolCalls, assistantMsg) {
            var inner = proxy._inner;
            var status = (inner && inner.xhr) ? inner.xhr.status : 0;
            var body = (inner && inner.xhr) ? inner.xhr.responseText : "";

            // Retry on another wire format only when nothing was produced —
            // never after partial output, which would duplicate it.
            var producedNothing = (!text || text.length === 0) && (!toolCalls || toolCalls.length === 0);
            if (retryable && error && producedNothing && looksLikeWrongEndpoint(status, body)) {
                var other = nextUntriedFormat();
                if (other) {
                    console.warn("PlasmaLLM OpenCode: " + model + " rejected on " + format
                                 + " (HTTP " + status + "), retrying as " + other);
                    failures.push({ format: format, status: status, body: body });
                    start(other);
                    return;
                }
            }

            if (!error) {
                // Remember what worked so later turns skip the failed attempts.
                // Guarded by `retryable` so a learned value always describes a
                // payload that was built in chat shape.
                if (retryable && learnedFormats[model] !== format) {
                    learnedFormats[model] = format;
                }
                failures = [];
            } else if (failures.length > 0) {
                // Every format refused. Reporting only the last attempt would
                // blame the wrong thing — a model can answer 503 on one
                // endpoint and 401 on another, which reads as a bad key.
                error = i18n("OpenCode could not serve \"%1\" on any supported wire format (%2). This usually means the model is not available on your plan right now — pick a different one.",
                             model, describeAttempts(format, status));
            } else {
                error = explainError(status, body, error);
            }

            opts.onComplete(text, error, toolCalls, assistantMsg);
        };

        var inner;
        if (format === "anthropic") inner = Anthropic.sendStreaming(o);
        else if (format === "responses") inner = Responses.sendStreaming(o);
        else if (format === "gemini") inner = Gemini.sendStreaming(o);
        else inner = Chat.sendStreaming(o);
        proxy._inner = inner;
        proxy.xhr = inner.xhr;
        if (proxy._timer && inner.setPollTimer) inner.setPollTimer(proxy._timer);
        return inner;
    }

    // A learned format only exists for retryable (chat-built) models.
    var first = staticProtocol;
    if (retryable && learnedFormats[model]) first = learnedFormats[model];
    start(first);
    return proxy;
}
