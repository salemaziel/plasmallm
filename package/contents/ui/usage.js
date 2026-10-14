/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.pragma library

.import "utils.js" as Utils

// Token usage and cost. Every adapter reads its provider's own usage report
// and hands main.qml one normalized shape through opts.onUsage:
//
//   { inputTokens, outputTokens, reasoningTokens, cachedInputTokens,
//     cacheWriteTokens, cost, costSource, requests }
//
// inputTokens is the whole prompt, cached and cache-write tokens included
// (they are subsets). outputTokens is everything billed as output, reasoning
// included (reasoningTokens is the subset). Providers disagree on both —
// Anthropic reports cache reads outside input_tokens, Gemini reports thoughts
// outside candidatesTokenCount — so each from*() folds them in here.
//
// cost is USD or null. costSource is "reported" when the provider stated the
// charge (OpenRouter's usage.cost), "estimated" when it was computed from the
// models.dev list price, "" when unknown. No price table lives in this file:
// prices come from models.dev at runtime, and a model it does not list shows
// tokens only.
//
// Pure apart from loadModelsDev(), which is the single network fetch.

var MODELS_DEV_URL = "https://models.dev/api.json";

function _n(v) {
    return (typeof v === "number" && isFinite(v) && v > 0) ? v : 0;
}

function _cost(v) {
    return (typeof v === "number" && isFinite(v) && v >= 0) ? v : null;
}

// Builds the normalized object; null when the report carried nothing usable.
function makeUsage(f) {
    var u = {
        inputTokens: _n(f.inputTokens),
        outputTokens: _n(f.outputTokens),
        reasoningTokens: _n(f.reasoningTokens),
        cachedInputTokens: _n(f.cachedInputTokens),
        cacheWriteTokens: _n(f.cacheWriteTokens),
        cost: _cost(f.cost),
        costSource: "",
        requests: 1
    };
    if (u.cost !== null) u.costSource = "reported";
    if (u.inputTokens === 0 && u.outputTokens === 0 && u.cost === null) return null;
    return u;
}

// OpenAI Chat Completions, and every gateway that copies it. OpenRouter adds
// `cost` and prompt_tokens_details.cache_write_tokens; DeepSeek reports cache
// hits as prompt_cache_hit_tokens.
function fromOpenAIChat(u) {
    if (!u || typeof u !== "object") return null;
    var pd = u.prompt_tokens_details || {};
    var cd = u.completion_tokens_details || {};
    return makeUsage({
        inputTokens: u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens,
        outputTokens: u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens,
        reasoningTokens: cd.reasoning_tokens,
        cachedInputTokens: _n(pd.cached_tokens) || _n(u.prompt_cache_hit_tokens),
        cacheWriteTokens: pd.cache_write_tokens,
        cost: u.cost
    });
}

// OpenAI Responses API: response.usage on response.completed.
function fromResponses(u) {
    if (!u || typeof u !== "object") return null;
    var id = u.input_tokens_details || {};
    var od = u.output_tokens_details || {};
    return makeUsage({
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        reasoningTokens: od.reasoning_tokens,
        cachedInputTokens: id.cached_tokens,
        cacheWriteTokens: id.cache_write_tokens,
        cost: u.cost
    });
}

// Anthropic Messages. `u` is message_start's message.usage with
// message_delta's usage merged over it (the delta carries the final
// output_tokens). input_tokens excludes both cache counts.
function fromAnthropic(u) {
    if (!u || typeof u !== "object") return null;
    var read = _n(u.cache_read_input_tokens);
    var write = _n(u.cache_creation_input_tokens);
    return makeUsage({
        inputTokens: _n(u.input_tokens) + read + write,
        outputTokens: u.output_tokens,
        cachedInputTokens: read,
        cacheWriteTokens: write,
        cost: u.cost
    });
}

// Gemini generateContent usageMetadata. It repeats on every chunk with
// running totals, so callers keep the last one rather than summing.
// candidatesTokenCount excludes thoughts; both are billed as output.
function fromGemini(m) {
    if (!m || typeof m !== "object") return null;
    var thoughts = _n(m.thoughtsTokenCount);
    return makeUsage({
        inputTokens: _n(m.promptTokenCount) + _n(m.toolUsePromptTokenCount),
        outputTokens: _n(m.candidatesTokenCount) + thoughts,
        reasoningTokens: thoughts,
        cachedInputTokens: m.cachedContentTokenCount
    });
}

// Gemini Interactions API Usage object (interaction.usage on
// interaction.completed, or a step delta's metadata.total_usage). Thought
// and tool-use tokens are reported separately from input/output.
function fromInteractions(u) {
    if (!u || typeof u !== "object") return null;
    var thoughts = _n(u.total_thought_tokens);
    return makeUsage({
        inputTokens: _n(u.total_input_tokens) + _n(u.total_tool_use_tokens),
        outputTokens: _n(u.total_output_tokens) + thoughts,
        reasoningTokens: thoughts,
        cachedInputTokens: u.total_cached_tokens
    });
}

// Sums two normalized usages (either may be null). Cost stays null only when
// neither side has one; costIncomplete marks a sum where some request had
// tokens but no price, so the total is a lower bound.
function addUsage(a, b) {
    if (!a) return b ? JSON.parse(JSON.stringify(b)) : null;
    if (!b) return JSON.parse(JSON.stringify(a));
    var out = {
        inputTokens: _n(a.inputTokens) + _n(b.inputTokens),
        outputTokens: _n(a.outputTokens) + _n(b.outputTokens),
        reasoningTokens: _n(a.reasoningTokens) + _n(b.reasoningTokens),
        cachedInputTokens: _n(a.cachedInputTokens) + _n(b.cachedInputTokens),
        cacheWriteTokens: _n(a.cacheWriteTokens) + _n(b.cacheWriteTokens),
        cost: null,
        costSource: "",
        requests: (a.requests || 1) + (b.requests || 1)
    };
    var ca = _cost(a.cost), cb = _cost(b.cost);
    if (ca !== null || cb !== null) {
        out.cost = (ca || 0) + (cb || 0);
        out.costSource = (a.costSource === "estimated" || b.costSource === "estimated") ? "estimated" : "reported";
    }
    out.costIncomplete = !!(a.costIncomplete || b.costIncomplete || (out.cost !== null && (ca === null || cb === null)));
    // Pricing hints survive only when both sides share a model, so a later
    // repricing never applies one model's rate to another's tokens.
    if (a.model && a.model === b.model) {
        out.model = a.model;
        if (a.pricing) out.pricing = a.pricing;
        if (a.pricingCtx) out.pricingCtx = a.pricingCtx;
    }
    return out;
}

// Parses a stored usage_json / usageJson string; null for "" or garbage, so
// chats saved before usage existed load as "no usage".
function parse(json) {
    if (!json || typeof json !== "string") return null;
    try {
        var u = JSON.parse(json);
        return (u && typeof u === "object") ? u : null;
    } catch (e) {
        return null;
    }
}

// --- Stream options --------------------------------------------------------

// Chat Completions only reports usage on a stream when the request asks with
// stream_options.include_usage. A server that validates strictly can reject
// the unknown field and fail the whole request, so it is sent only to hosts
// documented to accept it. Others still get their usage read if they send it
// unasked (Mistral, most local servers).
var STREAM_USAGE_HOSTS = [
    "api.openai.com", "openrouter.ai", "api.deepseek.com", "api.together.xyz",
    "api.fireworks.ai", "api.groq.com", "api.x.ai", "api.deepinfra.com"
];
// Gemini's OpenAI-compatible endpoint is deliberately absent: its docs do not
// list stream_options, and it reports usage on the final chunk unasked.

function acceptsStreamOptions(endpoint) {
    var host = Utils.hostOf(endpoint);
    if (!host) return false;
    if (Utils.isOpenRouterHost(host)) return true;
    return STREAM_USAGE_HOSTS.indexOf(host) !== -1;
}

// --- models.dev pricing ----------------------------------------------------

// Hosts whose models.dev entry has no `api` URL to match against. A mapping,
// not prices: it only says which models.dev provider lists this endpoint.
var HOST_PROVIDERS = {
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "google",
    "aiplatform.googleapis.com": "google-vertex",
    "api.groq.com": "groq",
    "api.mistral.ai": "mistral",
    "api.x.ai": "xai",
    "api.cerebras.ai": "cerebras",
    "api.deepinfra.com": "deepinfra",
    "api.cohere.ai": "cohere",
    "api.cohere.com": "cohere",
    "api.together.xyz": "togetherai",
    "api.perplexity.ai": "perplexity"
};

function _stripUrl(u) {
    return String(u || "").toLowerCase().replace(/\/+$/, "");
}

function _isLocalHost(host) {
    return host === "localhost" || host === "0.0.0.0" || host.charAt(0) === "["
        || /\.(local|lan|internal)$/.test(host)
        || /^(127|10)\.\d+\.\d+\.\d+$/.test(host)
        || /^192\.168\.\d+\.\d+$/.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
}

// models.dev provider ids that price requests for this connection, best
// first. ctx: { apiType, endpoint, geminiAuthMethod }. `data` (the parsed
// api.json, may be null) adds matches against each provider's `api` URL,
// which covers OpenRouter, OpenCode Zen/Go, DeepSeek, Fireworks and the
// long tail without a table here. Empty when nothing matches — a custom or
// local endpoint is never guessed at, since the same model id can cost
// different amounts on different hosts.
function pricingProviders(ctx, data) {
    ctx = ctx || {};
    var apiType = String(ctx.apiType || "");
    if (apiType === "gemini" || apiType === "gemini_interactions") {
        return [ctx.geminiAuthMethod === "agentplatform" ? "google-vertex" : "google"];
    }
    var endpoint = _stripUrl(ctx.endpoint);
    var host = Utils.hostOf(endpoint);
    // A local server costs nothing, whatever models.dev lists for some other
    // product that happens to default to localhost.
    if (!host || _isLocalHost(host)) return [];

    var out = [];
    if (data && typeof data === "object") {
        // Longest `api` prefix wins: OpenCode Go's .../zen/go/v1 must beat
        // Zen's .../zen/v1 on the same host.
        var best = "", bestLen = 0, hostHits = [];
        for (var id in data) {
            if (!data.hasOwnProperty(id)) continue;
            var api = _stripUrl(data[id] && data[id].api);
            if (!api) continue;
            if (endpoint.indexOf(api) === 0 && api.length > bestLen) {
                best = id;
                bestLen = api.length;
            }
            if (Utils.hostOf(api) === host) hostHits.push(id);
        }
        if (best) out.push(best);
        else if (hostHits.length === 1) out.push(hostHits[0]);
    }
    var mapped = HOST_PROVIDERS[host];
    if (!mapped && /(^|\.|-)aiplatform\.googleapis\.com$/.test(host)) mapped = "google-vertex";
    if (!mapped && Utils.isOpenRouterHost(host)) mapped = "openrouter";
    if (mapped && out.indexOf(mapped) === -1) out.push(mapped);
    return out;
}

// The models.dev cost object ({input, output, cache_read, cache_write,
// tiers}, USD per 1M tokens) for `model`, or null.
function findModelCost(data, providerIds, model) {
    if (!data || !providerIds || !model) return null;
    var name = String(model);
    var variants = [name, name.replace(/^models\//, ""), name.replace(/^.*\/models\//, "")];
    for (var p = 0; p < providerIds.length; p++) {
        var entry = data[providerIds[p]];
        if (!entry || !entry.models) continue;
        var models = entry.models;
        for (var v = 0; v < variants.length; v++) {
            var m = models[variants[v]];
            if (m && _isCost(m.cost)) return m.cost;
        }
        // Case-insensitive last resort (user-typed ids).
        var lower = variants[1].toLowerCase();
        for (var key in models) {
            if (models.hasOwnProperty(key) && key.toLowerCase() === lower && _isCost(models[key].cost))
                return models[key].cost;
        }
    }
    return null;
}

function _isCost(c) {
    return !!c && typeof c.input === "number" && typeof c.output === "number";
}

// Long-context models charge more once the prompt passes a size; models.dev
// lists those as `tiers`. Picks the highest tier the prompt exceeds.
function _ratesFor(cost, inputTokens) {
    var rates = cost;
    var crossed = -1;
    var tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
    for (var i = 0; i < tiers.length; i++) {
        var t = tiers[i];
        var size = t && t.tier && t.tier.type === "context" ? t.tier.size : 0;
        if (size > 0 && inputTokens > size && size > crossed && _isCost(t)) {
            rates = t;
            crossed = size;
        }
    }
    return rates;
}

// USD estimate for one usage at a models.dev cost object.
function estimateCost(usage, cost) {
    if (!usage || !_isCost(cost)) return null;
    var input = _n(usage.inputTokens);
    var cached = Math.min(_n(usage.cachedInputTokens), input);
    var write = Math.min(_n(usage.cacheWriteTokens), input - cached);
    var fresh = input - cached - write;
    var r = _ratesFor(cost, input);
    var readRate = typeof r.cache_read === "number" ? r.cache_read : r.input;
    var writeRate = typeof r.cache_write === "number" ? r.cache_write : r.input;
    return (fresh * r.input + cached * readRate + write * writeRate
            + _n(usage.outputTokens) * r.output) / 1e6;
}

// Fills in an estimated cost when the provider reported none. Returns a new
// object; a reported cost is never replaced.
function priceUsage(usage, data, providerIds, model) {
    if (!usage) return null;
    var out = JSON.parse(JSON.stringify(usage));
    if (_cost(out.cost) !== null) return out;
    var est = estimateCost(out, findModelCost(data, providerIds, model));
    if (est !== null) {
        out.cost = est;
        out.costSource = "estimated";
    }
    return out;
}

// Sums every stored per-request usage string. Used for the chat total, so
// it is recomputed from whatever messages are loaded.
function totalOf(jsonList) {
    var total = null;
    for (var i = 0; i < jsonList.length; i++) {
        var u = parse(jsonList[i]);
        if (u) total = addUsage(total, u);
    }
    return total;
}

// --- Formatting (language-neutral; labels are added in QML via i18n) -------

function formatTokens(n) {
    n = _n(n);
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
}

function formatUsd(c) {
    if (c === 0) return "$0";
    if (c < 0.0001) return "<$0.0001";
    if (c < 1) return "$" + c.toFixed(4);
    return "$" + c.toFixed(2);
}

// "$0.0123" when reported, "~$0.0123" when estimated, "" when unknown.
function formatCost(usage) {
    if (!usage || _cost(usage.cost) === null) return "";
    return (usage.costSource === "estimated" ? "~" : "") + formatUsd(usage.cost);
}

// Per-1M list price as "$0.15", trimmed of trailing zeros.
function formatRate(r) {
    if (typeof r !== "number" || !isFinite(r)) return "";
    var s = r >= 1 ? r.toFixed(2) : r.toFixed(4);
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    return "$" + s;
}

// { modelId: {input: "$x", output: "$y", free: bool} } for every model the
// picker shows that models.dev prices on this connection.
function priceLabels(data, ctx, models) {
    var out = {};
    if (!data || !models) return out;
    var ids = pricingProviders(ctx, data);
    if (ids.length === 0) return out;
    for (var i = 0; i < models.length; i++) {
        var c = findModelCost(data, ids, models[i]);
        if (!c) continue;
        out[models[i]] = {
            input: formatRate(c.input),
            output: formatRate(c.output),
            free: c.input === 0 && c.output === 0
        };
    }
    return out;
}

// --- models.dev fetch, once per session ------------------------------------

var _modelsDev = null;
var _modelsDevWaiters = [];
var _modelsDevInFlight = false;
var _modelsDevFailedAt = 0;

// The parsed api.json if it has been fetched, else null.
function cachedModelsDev() {
    return _modelsDev;
}

// Calls back with the parsed models.dev api.json (null on failure). A
// .pragma library is one instance per engine, so this is shared by every
// adapter and page: fetched at most once a session, with concurrent callers
// queued behind the one request. A failure is retried after ten minutes, not
// on every call.
function loadModelsDev(callback) {
    if (_modelsDev) { if (callback) callback(_modelsDev); return; }
    if (_modelsDevFailedAt && (Date.now() - _modelsDevFailedAt) < 600000) {
        if (callback) callback(null);
        return;
    }
    if (callback) _modelsDevWaiters.push(callback);
    if (_modelsDevInFlight) return;
    _modelsDevInFlight = true;

    function done(data) {
        _modelsDevInFlight = false;
        if (data) _modelsDev = data;
        else _modelsDevFailedAt = Date.now();
        var waiters = _modelsDevWaiters;
        _modelsDevWaiters = [];
        for (var i = 0; i < waiters.length; i++) {
            try { waiters[i](data); } catch (e) { console.warn("PlasmaLLM usage: models.dev callback failed:", e); }
        }
    }

    var xhr = new XMLHttpRequest();
    xhr.open("GET", MODELS_DEV_URL);
    xhr.timeout = 15000;
    xhr.ontimeout = function() { done(null); };
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        var data = null;
        if (xhr.status === 200) {
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        }
        done(data && typeof data === "object" ? data : null);
    };
    xhr.send();
}
