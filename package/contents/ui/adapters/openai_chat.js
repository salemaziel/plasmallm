/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.import "../toolManager.js" as ToolManager
.import "../toolCallNormalizer.js" as ToolCallNormalizer

// Chat Completions strategy for the OpenAI-compatible adapter.
// Dispatched by openai.js when the active provider does not use the
// /v1/responses endpoint. The "neutral" wire shapes (messages array,
// accumulated tool_calls) intentionally match this baseline since other
// adapters translate to/from it.

function sanitizePayload(body) {
    try {
        var copy = JSON.parse(JSON.stringify(body));
        if (copy.messages) {
            for (var i = 0; i < copy.messages.length; i++) {
                var msg = copy.messages[i];
                if (Array.isArray(msg.content)) {
                    for (var j = 0; j < msg.content.length; j++) {
                        var part = msg.content[j];
                        if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
                            var url = part.image_url.url;
                            if (url.startsWith("data:") && url.indexOf("base64,") !== -1) {
                                var parts = url.split("base64,");
                                part.image_url.url = parts[0] + "base64,<truncated, length " + parts[1].length + ">";
                            }
                        }
                    }
                }
            }
        }
        return copy;
    } catch (e) {
        return body;
    }
}

function setHeaders(xhr, apiKey, endpoint) {
    xhr.setRequestHeader("Content-Type", "application/json");
    if (apiKey && apiKey.length > 0) {
        xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
        if (apiKey.indexOf("sk-ant-") === 0 || (endpoint && endpoint.indexOf("anthropic") !== -1)) {
            xhr.setRequestHeader("x-api-key", apiKey);
            xhr.setRequestHeader("anthropic-version", "2023-06-01");
            xhr.setRequestHeader("anthropic-dangerous-direct-browser-access", "true");
        }
    }
}

// Match Exa hosts strictly (api.exa.ai / exa.ai / *.exa.ai), not bare substring.
function isExaEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== "string") return false;
    var m = endpoint.match(/^https?:\/\/([^\/:?#]+)/i);
    if (!m) return false;
    var host = m[1].toLowerCase();
    return host === "api.exa.ai" || host === "exa.ai" || host.length > 7 && host.slice(-7) === ".exa.ai";
}

function fetchModels(endpoint, apiKey, callback) {
    if (isExaEndpoint(endpoint)) {
        var exaModels = ["exa"];
        if (callback) callback(null, exaModels, 200);
        return;
    }
    var xhr = new XMLHttpRequest();
    var url = endpoint.replace(/\/+$/, "") + "/models";

    xhr.open("GET", url);
    xhr.timeout = 30000;
    setHeaders(xhr, apiKey, endpoint);

    xhr.ontimeout = function() {
        callback(i18n("Request timed out after 30 seconds"), null);
    };

    xhr.onreadystatechange = function() {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            if (xhr.status === 200) {
                try {
                    var response = JSON.parse(xhr.responseText);
                    var models = [];
                    if (response.data) {
                        for (var i = 0; i < response.data.length; i++) {
                            models.push(response.data[i].id);
                        }
                    }
                    callback(null, models, xhr.status);
                } catch (e) {
                    callback(i18n("Failed to parse models: %1", e.message), null, xhr.status);
                }
            } else {
                callback(i18n("Failed to fetch models: HTTP %1", xhr.status), null, xhr.status);
            }
        }
    };

    xhr.send();
}

function buildTools(options) {
    var tools = [];

    if (options && options.toolsConfig) {
        var metadata = ToolManager.getEnabledToolsMetadata(options.toolsConfig);
        for (var i = 0; i < metadata.length; i++) {
            tools.push({
                type: "function",
                "function": {
                    name: metadata[i].name,
                    description: metadata[i].description,
                    parameters: metadata[i].parameters
                }
            });
        }
    }

    return tools;
}

function buildContentArray(text, attachments) {
    if (!attachments || attachments.length === 0) return text;
    var parts = [];
    if (text && text.length > 0) {
        parts.push({ type: "text", text: text });
    }
    for (var i = 0; i < attachments.length; i++) {
        var att = attachments[i];
        if (att.dataUrl) {
            parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
        } else if (att.textContent) {
            var label = att.fileName || "file";
            parts.push({ type: "text", text: "--- " + label + " ---\n" + att.textContent });
        }
    }
    return parts;
}

function parseSSEChunks(buffer, lastIndex) {
    var tokens = [];
    var searchFrom = lastIndex;
    while (true) {
        var nlPos = buffer.indexOf("\n", searchFrom);
        if (nlPos === -1) break; // incomplete line — wait for more data
        var line = buffer.substring(searchFrom, nlPos).replace(/\r$/, "");
        searchFrom = nlPos + 1;
        if (line === "") continue;
        if (line.substring(0, 6) !== "data: ") continue;
        var payload = line.substring(6);
        if (payload === "[DONE]") {
            tokens.push({ done: true });
            continue;
        }
        try {
            var obj = JSON.parse(payload);
            // Exa Answer streams may emit a top-level citations array (not under delta).
            if (obj.citations && Array.isArray(obj.citations) && obj.citations.length > 0) {
                tokens.push({ citations: obj.citations });
            }
            if (obj.choices && obj.choices[0]) {
                var choice = obj.choices[0];
                if (choice.delta) {
                    var delta = choice.delta;
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                        tokens.push({ content: delta.content });
                    }
                    // Reasoning text: OpenAI o-series via /chat/completions exposes
                    // `delta.reasoning`; DeepSeek/Qwen-style providers use
                    // `delta.reasoning_content`. Display-only — providers
                    // explicitly say not to round-trip these on chat completions.
                    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
                        tokens.push({ thinking_delta: delta.reasoning });
                    } else if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                        tokens.push({ thinking_delta: delta.reasoning_content });
                    }
                    if (delta.citations && Array.isArray(delta.citations)) {
                        tokens.push({ citations: delta.citations });
                    }
                    if (delta.tool_calls) {
                        tokens.push({ tool_calls_delta: delta.tool_calls });
                    }
                }
                // Non-delta message form (some providers finish with a full message chunk).
                if (choice.message && choice.message.citations && Array.isArray(choice.message.citations)) {
                    tokens.push({ citations: choice.message.citations });
                }
            }
        } catch (e) {
            console.warn("PlasmaLLM OpenAI Chat Adapter: failed to parse SSE chunk:", payload, e);
            // skip unparseable chunks
        }
    }
    return { tokens: tokens, newIndex: searchFrom };
}

function sendStreaming(opts) {
    var endpoint = opts.endpoint;
    var apiKey = opts.apiKey;
    var model = opts.model;
    var messages = opts.messages;
    var temperature = opts.temperature;
    var maxTokens = opts.maxTokens;
    var tools = opts.tools;
    var onChunk = opts.onChunk;
    var onThinkingChunk = opts.onThinkingChunk;
    var onComplete = opts.onComplete;

    if (isExaEndpoint(endpoint)) {
        endpoint = "https://api.exa.ai";
        if ((!apiKey || apiKey.trim() === "") && opts.exaApiKey) {
            apiKey = opts.exaApiKey;
        }
        if (!model || model !== "exa") {
            model = "exa";
        }
    }

    var xhr = new XMLHttpRequest();
    var url = endpoint.replace(/\/+$/, "") + "/chat/completions";

    xhr.open("POST", url);
    xhr.timeout = 120000;
    setHeaders(xhr, apiKey, endpoint);

    var pollTimer = null;
    var lastParseIndex = 0;
    var accumulatedText = "";
    var accumulatedToolCalls = []; // [{id, type, function: {name, arguments}}]
    var toolCallSlots = {};        // "i<index>" / "d<id>" -> position in accumulatedToolCalls
    var accumulatedThinkingText = "";
    var accumulatedCitations = [];
    var streamDone = false;
    var completeCalled = false;

    function pushCitations(list) {
        if (!list || !Array.isArray(list)) return;
        for (var c = 0; c < list.length; c++) {
            var item = list[c];
            if (item && typeof item === "object") {
                accumulatedCitations.push(item);
            }
        }
    }

    // Decide which accumulator slot a tool_calls delta belongs to.
    //
    // Providers are inconsistent here. Captured from OpenCode Go's gateway:
    //   glm-5.3     one complete call per delta, indices 0 and 1
    //   minimax-m3  id on the opening delta, fragments after, indices correct
    //   kimi-k3     empty opener then ~15 token-sized fragments per call
    //   gpt-5.6-luna  BOTH parallel calls on index 0, distinguished only by id
    //
    // That last shape is why this cannot key on `index` alone: doing so merges
    // the calls into one named "read_filelist_dir" whose arguments are two JSON
    // objects concatenated — which strict upstreams reject with "invalid
    // function arguments json string". Resolve by id first, fall back to index,
    // and treat a new id arriving on an occupied slot as a new call.
    function resolveToolCallSlot(tcd) {
        var hasIndex = (tcd.index !== undefined && tcd.index !== null);

        if (tcd.id) {
            var byId = toolCallSlots["d" + tcd.id];
            if (byId !== undefined) return byId;
        }

        if (hasIndex) {
            var byIdx = toolCallSlots["i" + tcd.index];
            if (byIdx !== undefined) {
                var held = accumulatedToolCalls[byIdx];
                // Same index, different id => the provider is reusing the index
                // across parallel calls. Open a fresh slot instead of merging.
                if (!(tcd.id && held.id && held.id !== tcd.id)) {
                    if (tcd.id) toolCallSlots["d" + tcd.id] = byIdx;
                    return byIdx;
                }
            }
        } else if (!tcd.id && accumulatedToolCalls.length > 0) {
            // Continuation fragment with neither index nor id: it belongs to the
            // call currently being streamed.
            return accumulatedToolCalls.length - 1;
        }

        var pos = accumulatedToolCalls.length;
        accumulatedToolCalls.push({
            id: tcd.id || "",
            type: tcd.type || "function",
            "function": { name: "", arguments: "" }
        });
        if (hasIndex) toolCallSlots["i" + tcd.index] = pos;
        if (tcd.id) toolCallSlots["d" + tcd.id] = pos;
        return pos;
    }

    function processBuffer() {
        var result = parseSSEChunks(xhr.responseText, lastParseIndex);
        lastParseIndex = result.newIndex;
        for (var i = 0; i < result.tokens.length; i++) {
            var tok = result.tokens[i];
            if (tok.done) {
                streamDone = true;
                continue;
            }
            // Always accept citations (Exa may emit them after content / near end).
            if (tok.citations) {
                pushCitations(tok.citations);
            }
            // After [DONE], ignore further content/tool deltas.
            if (streamDone) continue;
            if (tok.content) {
                accumulatedText += tok.content;
                onChunk(tok.content, accumulatedText);
            }
            if (typeof tok.thinking_delta === "string" && tok.thinking_delta.length > 0) {
                accumulatedThinkingText += tok.thinking_delta;
                if (onThinkingChunk) onThinkingChunk(tok.thinking_delta, accumulatedThinkingText);
            }
            if (tok.tool_calls_delta) {
                for (var t = 0; t < tok.tool_calls_delta.length; t++) {
                    var tcd = tok.tool_calls_delta[t];
                    var idx = resolveToolCallSlot(tcd);
                    var slot = accumulatedToolCalls[idx];

                    if (tcd.id) slot.id = tcd.id;
                    if (tcd.type) slot.type = tcd.type;

                    if (tcd["function"]) {
                        var deltaName = tcd["function"].name;
                        if (deltaName) {
                            // Providers that repeat the complete call on every
                            // chunk would otherwise yield "read_fileread_file".
                            if (slot["function"].name !== deltaName) {
                                slot["function"].name += deltaName;
                            }
                        }

                        var deltaArgs = tcd["function"].arguments;
                        if (deltaArgs !== undefined && deltaArgs !== null && deltaArgs !== "") {
                            if (typeof deltaArgs === "object") {
                                // An object delta is always the complete argument
                                // set, never a fragment — replace, do not append.
                                try { slot["function"].arguments = JSON.stringify(deltaArgs); } catch (e) {}
                            } else {
                                slot["function"].arguments += deltaArgs;
                            }
                        }
                    }
                }
            }
        }
    }

    function sanitizeCiteTitle(title) {
        // Prevent markdown link breakage from ] or ( in titles.
        return String(title).replace(/[\[\]\(\)\n\r]/g, " ").replace(/\s+/g, " ").trim();
    }

    function formatCitations() {
        if (accumulatedCitations.length === 0) return;
        var citeText = "\n\n### Sources & Citations\n";
        var n = 0;
        for (var c = 0; c < accumulatedCitations.length; c++) {
            var cite = accumulatedCitations[c];
            if (!cite || typeof cite !== "object") continue;
            n++;
            var rawUrl = (typeof cite.url === "string") ? cite.url : "";
            var isHttp = /^https?:\/\//i.test(rawUrl);
            var title = sanitizeCiteTitle(cite.title || (isHttp ? rawUrl : "") || ("Source " + n));
            if (isHttp) {
                citeText += n + ". [" + title + "](" + rawUrl + ")\n";
            } else {
                citeText += n + ". " + title + "\n";
            }
        }
        if (n === 0) return;
        accumulatedText += citeText;
        onChunk("", accumulatedText);
    }

    function finish(error) {
        if (completeCalled) return;
        completeCalled = true;
        if (pollTimer && pollTimer.running) pollTimer.stop();

        if (error) {
            console.error("PlasmaLLM OpenAI Chat Adapter: onComplete with error:", error);
            onComplete(accumulatedText, error, null, null);
            return;
        }

        if (accumulatedToolCalls.length > 0) {
            // Never hand a malformed tool_calls array upstream: it is replayed on
            // every later request in the conversation, so one bad chunk would
            // otherwise wedge the whole session.
            var normalized = ToolCallNormalizer.normalizeToolCalls(accumulatedToolCalls);
            ToolCallNormalizer.logNotes("openai_chat", normalized.notes);

            if (normalized.calls.length > 0) {
                if (accumulatedCitations.length > 0) formatCitations();
                var assistantMsg = { role: "assistant", content: accumulatedText || null, tool_calls: normalized.calls };
                onComplete(accumulatedText, null, normalized.calls, assistantMsg);
                return;
            }
            // Every call was unusable — fall through and treat as a text reply.
        }

        if (accumulatedText.length > 0) {
            if (accumulatedCitations.length > 0) formatCitations();
            onComplete(accumulatedText, null, null, null);
            return;
        }

        // Non-streaming fallback: server returned a regular JSON response
        try {
            var response = JSON.parse(xhr.responseText);
            // Top-level citations (some Exa / search APIs)
            if (response.citations && Array.isArray(response.citations)) {
                pushCitations(response.citations);
            }
            if (response.choices && response.choices[0] && response.choices[0].message) {
                var msg = response.choices[0].message;
                if (msg.citations && Array.isArray(msg.citations)) {
                    pushCitations(msg.citations);
                }
                var nonStreamCalls = null;
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    var nsNormalized = ToolCallNormalizer.normalizeToolCalls(msg.tool_calls);
                    ToolCallNormalizer.logNotes("openai_chat/non-streaming", nsNormalized.notes);
                    if (nsNormalized.calls.length > 0) nonStreamCalls = nsNormalized.calls;
                }

                if (nonStreamCalls) {
                    if (typeof msg.content === "string" && msg.content.length > 0) {
                        accumulatedText = msg.content;
                    }
                    if (accumulatedCitations.length > 0) formatCitations();
                    msg = { role: msg.role || "assistant", content: accumulatedText, tool_calls: nonStreamCalls };
                    onComplete(accumulatedText, null, nonStreamCalls, msg);
                } else if (typeof msg.content === "string") {
                    accumulatedText = msg.content;
                    if (accumulatedCitations.length > 0) formatCitations();
                    onComplete(accumulatedText, null, null, null);
                } else {
                    onComplete("", i18n("Invalid response format"));
                }
            } else {
                onComplete("", i18n("Invalid response format"));
            }
        } catch (e) {
            onComplete("", i18n("Failed to parse response: %1", e.message));
        }
    }

    xhr.ontimeout = function() {
        finish(i18n("Request timed out"));
    };

    xhr.onreadystatechange = function() {
        if (xhr.readyState === 3) { // LOADING
            if (pollTimer && !pollTimer.running) pollTimer.start();
            processBuffer();
        } else if (xhr.readyState === 4) { // DONE
            if (pollTimer && pollTimer.running) pollTimer.stop();
            if (xhr.status === 200) {
                processBuffer();
                finish(null);
            } else {
                var errMsg;
                if (xhr.status === 401 || xhr.status === 403) {
                    errMsg = i18n("Authentication failed (HTTP %1) — check your API key", xhr.status);
                } else if (xhr.status === 429) {
                    errMsg = i18n("Rate limited (HTTP 429) — too many requests, try again shortly");
                } else if (xhr.status === 404) {
                    errMsg = i18n("Not found (HTTP 404) — check your API endpoint and model name");
                } else if (xhr.status > 0) {
                    errMsg = i18n("API error %1", xhr.status);
                } else {
                    errMsg = i18n("Request failed (no response) — check your endpoint URL");
                }
                try {
                    var errBody = JSON.parse(xhr.responseText);
                    if (errBody.error && errBody.error.message) {
                        errMsg += ": " + errBody.error.message;
                    }
                } catch (e) {
                    if (xhr.responseText) {
                        errMsg += ": " + xhr.responseText.substring(0, 200);
                    }
                }
                finish(errMsg);
            }
        }
    };

    var translatedMessages = [];
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m.role === "tool" && Array.isArray(m.content)) {
            var raw = "";
            var extraParts = [];
            for (var p = 0; p < m.content.length; p++) {
                var part = m.content[p];
                if (part.type === "text") {
                    raw += part.text;
                } else {
                    extraParts.push(part);
                }
            }
            translatedMessages.push({
                role: "tool",
                tool_call_id: m.tool_call_id,
                content: raw
            });
            if (extraParts.length > 0) {
                var userContent = [{ type: "text", text: "Screenshot from tool. Please evaluate the screen state and continue with the task." }];
                translatedMessages.push({
                    role: "user",
                    content: userContent.concat(extraParts)
                });
            }
        } else {
            translatedMessages.push(m);
        }
    }

    var body = {
        model: model,
        messages: translatedMessages,
        temperature: temperature / 100.0,
        max_tokens: maxTokens,
        stream: true
    };
    if (opts.reasoningEffort && opts.reasoningEffort !== "off") {
        body.reasoning_effort = opts.reasoningEffort;
    }
    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    var payload = JSON.stringify(body, null, 2);
    xhr.send(payload);

    var handle = {
        xhr: xhr,
        pollTimer: null,
        processBuffer: processBuffer,
        setPollTimer: function(timer) {
            pollTimer = timer;
            handle.pollTimer = timer;
        }
    };
    return handle;
}
