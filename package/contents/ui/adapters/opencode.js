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
// degrading. So a request rejected at the endpoint level retries on the
// remaining formats and remembers what worked for the session. See RETRY
// SCOPE below for how that stays hub-and-spoke rather than N×M.

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
// Every format is retryable, because the payload is always built in one
// neutral shape and converted at send time.
//
// The alternative — letting buildTools/buildContentArray emit the *target*
// protocol's shape at compose time — is what would force an N×M problem: a
// body already built as Anthropic blocks cannot be re-sent as Gemini parts
// without a translator for every ordered pair. Building neutrally instead
// makes this hub-and-spoke: one converter per protocol, three in total.
//
// Chat shape is the hub, and it is a lossless one — openai_chat.js's
// buildContentArray keeps an attachment's data URL whole and inlines text
// attachments as text parts, so it carries everything the other builders
// carry. Everything past the content array is already neutral: anthropic.js,
// gemini.js and openai_responses.js each expose translateMessages(neutral),
// which handles roles, tool calls, tool results and thinking blocks from the
// OpenAI shape. Only the tools array and the user content parts ever needed
// converting, which is why the spoke count is small.
//
// The static route still picks the *first* attempt, so a high-confidence
// prefix match costs no extra round trip. It just no longer dead-ends when
// OpenCode moves that model to another backend.
//
// Discipline that is not about shape stays: retry only on an endpoint-level
// rejection (looksLikeWrongEndpoint), never after partial output, and never
// the same format twice.
var FALLBACK_ORDER = ["chat", "anthropic", "responses", "gemini"];

// Session-scoped learning, keyed by model. Every payload is built in the same
// neutral shape, so a learned value is valid for any route. Never consulted by
// buildTools/buildContentArray — those must stay neutral, and letting a learned
// value change the built shape would defeat the conversion path.
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

// Tools and content are always built in the neutral chat shape; sendStreaming
// converts to whichever protocol it is actually attempting. See RETRY SCOPE —
// building per-protocol here is what would make a retry impossible.
function buildTools(options) {
    return Chat.buildTools(copyOpts(options));
}

// `extra` carries {model, endpoint, providerName} from api.js. It is no longer
// consulted — the shape is neutral regardless of route — but the parameter
// stays because api.js passes it positionally for this apiType.
function buildContentArray(text, attachments, extra) {
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

// OpenAI chat {type,function:{name,description,parameters}} -> Gemini's single
// functionDeclarations wrapper. Gemini takes one tool object holding every
// declaration, not one object per function, so an empty set is [] rather than
// a wrapper around nothing.
function toGeminiTools(tools) {
    var fns = [];
    if (!tools) return fns;
    for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        var fn = t && t["function"];
        if (!fn || !fn.name) continue;
        fns.push({
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} }
        });
    }
    if (fns.length === 0) return [];
    return [{ functionDeclarations: fns }];
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

// The three converters differ only in how they map one content part, so the
// message walk itself is shared. String content (the common case, and every
// tool result) is passed through — each translateMessages already accepts it.
// Thinking blocks ride along untouched: their signature fields are read by
// name (`signature` for Anthropic, `thoughtSignature` for Gemini), so one
// protocol's signatures are ignored rather than rejected by another.
function mapMessageContent(messages, convertContent) {
    if (!messages) return messages;
    var out = [];
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m && Array.isArray(m.content)) {
            var copy = _shallowCopy(m);
            copy.content = convertContent(m.content);
            out.push(copy);
        } else {
            out.push(m);
        }
    }
    return out;
}

function convertMessagesForResponses(messages) {
    return mapMessageContent(messages, convertContentForResponses);
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
            // Mirror anthropic.js's own isImageMime guard. /messages accepts an
            // image block only for image/* — a PDF data URL sent as one is
            // rejected outright. Gemini and Responses have no such restriction,
            // which is why only this converter filters on mime.
            if (m && m[1].indexOf("image/") === 0) {
                out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
                continue;
            }
            // A non-data URL cannot be inlined either; drop rather than send a
            // block the Messages API will reject.
            continue;
        }
        out.push(part);
    }
    return out;
}

function convertMessagesForAnthropic(messages) {
    return mapMessageContent(messages, convertContentForAnthropic);
}

// Gemini parts are untyped: text is {text}, an inline image is {inlineData}.
// gemini.js's toParts() passes an array straight through — it assumes anything
// array-shaped already came from its own buildContentArray — so the conversion
// has to happen here or the parts reach generateContent as OpenAI blocks.
function convertContentForGemini(content) {
    if (!Array.isArray(content)) return content;
    var out = [];
    for (var i = 0; i < content.length; i++) {
        var part = content[i];
        if (!part) continue;
        if (part.type === "text") {
            out.push({ text: part.text || "" });
            continue;
        }
        if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
            var m = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
            if (m)
                out.push({ inlineData: { mimeType: m[1], data: m[2] } });
            // generateContent has no remote-URL part; dropping a non-data URL
            // beats sending a block the API rejects outright.
            continue;
        }
        out.push(part);
    }
    return out;
}

function convertMessagesForGemini(messages) {
    return mapMessageContent(messages, convertContentForGemini);
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
        // opts.tools/messages are always in neutral chat shape, whatever the
        // route — so convert for every non-chat format, first attempt included.
        // Always converting from the same source is what makes the formats
        // reachable in any order.
        if (format === "anthropic") {
            o.tools = toAnthropicTools(opts.tools);
            o.messages = convertMessagesForAnthropic(opts.messages);
        } else if (format === "responses") {
            o.usesResponsesAPI = true;
            o.tools = toResponsesTools(opts.tools);
            o.messages = convertMessagesForResponses(opts.messages);
        } else if (format === "gemini") {
            o.tools = toGeminiTools(opts.tools);
            o.messages = convertMessagesForGemini(opts.messages);
        }

        o.onComplete = function(text, error, toolCalls, assistantMsg) {
            var inner = proxy._inner;
            var status = (inner && inner.xhr) ? inner.xhr.status : 0;
            var body = (inner && inner.xhr) ? inner.xhr.responseText : "";

            // Retry on another wire format only when nothing was produced —
            // never after partial output, which would duplicate it.
            var producedNothing = (!text || text.length === 0) && (!toolCalls || toolCalls.length === 0);
            if (error && producedNothing && looksLikeWrongEndpoint(status, body)) {
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
                if (learnedFormats[model] !== format) {
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

    // The static route is the opening bid; a format proven this session beats
    // it, since the published tables are exactly what goes stale.
    var first = learnedFormats[model] || staticProtocol;
    start(first);
    return proxy;
}
