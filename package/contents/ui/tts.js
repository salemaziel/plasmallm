/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.import "ttsAdapters/index.js" as TtsAdapters
.import "ttsAdapters/speechRules.js" as SpeechRules
.import "fallbacks.js" as Fallbacks

function _i18n(str, arg1, arg2) {
    if (typeof i18n === "function") {
        if (arg2 !== undefined)
            return i18n(str, arg1, arg2);
        if (arg1 !== undefined)
            return i18n(str, arg1);
        return i18n(str);
    }
    var res = str;
    if (arg1 !== undefined)
        res = res.replace(/%1/g, String(arg1));
    if (arg2 !== undefined)
        res = res.replace(/%2/g, String(arg2));
    return res;
}

function percentOr100(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? n : 100;
}

function getTtsConnection(config) {
    if (!config)
        return null;
    // Kokoro (local) keeps its own URL, voice and format, so switching
    // backends doesn't overwrite the endpoint backend's settings.
    if ((config.ttsBackend || "") === "kokoro_local") {
        return {
            enabled: !!config.ttsEnabled,
            autoRead: !!config.ttsAutoRead,
            autoReadOnlyVoicePrompted: !!config.ttsAutoReadOnlyVoicePrompted,
            styleHint: config.ttsStyleHint || "",
            backend: "kokoro_local",
            providerName: "",
            endpoint: config.ttsKokoroUrl || "",
            model: "kokoro",
            voice: config.ttsKokoroVoice || "",
            responseFormat: config.ttsKokoroFormat || "",
            speedPercent: percentOr100(config.ttsSpeedPercent),
            instructions: "",
            volumePercent: percentOr100(config.ttsKokoroVolumePercent),
            langCode: config.ttsKokoroLangCode || "",
            rate: 0,
            pitch: 0,
            language: "",
            cliBinary: "",
            cliTemplate: "",
            cliExtraArgs: ""
        };
    }
    // "Model default" is only meaningful to the endpoint backend; the others
    // share the same voice setting and must not be handed its marker.
    var backend = config.ttsBackend || "spd_say";
    var voice = config.ttsVoice || "";
    if (backend !== "openai_speech" && SpeechRules.isModelDefaultVoice(voice))
        voice = "";
    return {
        enabled: !!config.ttsEnabled,
        autoRead: !!config.ttsAutoRead,
        autoReadOnlyVoicePrompted: !!config.ttsAutoReadOnlyVoicePrompted,
        styleHint: config.ttsStyleHint || "",
        backend: backend,
        providerName: config.ttsProviderName || "",
        endpoint: config.ttsApiEndpoint || "",
        model: config.ttsModelName || "",
        voice: voice,
        responseFormat: config.ttsResponseFormat || "",
        speedPercent: percentOr100(config.ttsSpeedPercent),
        instructions: config.ttsInstructions || "",
        volumePercent: 100,
        langCode: "",
        rate: config.ttsRate || 0,
        pitch: config.ttsPitch || 0,
        language: config.ttsLanguage || "",
        cliBinary: config.ttsCliBinary || "spd-say",
        cliTemplate: config.ttsCliTemplate || "",
        cliExtraArgs: config.ttsCliExtraArgs || ""
    };
}

function isTtsConfigured(config) {
    var c = getTtsConnection(config);
    if (!c)
        return false;
    var adapter = TtsAdapters.get(c.backend);
    if (adapter && typeof adapter.isConfigured === "function")
        return adapter.isConfigured(c);
    if (!c.enabled)
        return false;
    return true;
}

/**
 * What to tell the user when speaking can't start. Kokoro (local) with an
 * empty Server URL says so; every other case keeps the generic message.
 * @param {object} config
 * @param {boolean} [withHint]  the generic message also says where to go (the widget's wording)
 */
function notConfiguredMessage(config, withHint) {
    // The strings are written out as i18n("…") calls, not through _i18n():
    // xgettext only picks up i18n, and these were extracted from main.qml
    // before. Without i18n (Node) the plain text is used.
    var tr = typeof i18n === "function";
    if (config && (config.ttsBackend || "") === "kokoro_local" && config.ttsEnabled
            && !String(config.ttsKokoroUrl || "").replace(/^\s+|\s+$/g, "").length)
        return tr ? i18n("Kokoro server URL isn't set. Open Settings → Text to Speech.")
                  : "Kokoro server URL isn't set. Open Settings → Text to Speech.";
    if (withHint)
        return tr ? i18n("Text-to-speech is not configured. Open Text to Speech settings.")
                  : "Text-to-speech is not configured. Open Text to Speech settings.";
    return tr ? i18n("Text-to-speech is not configured") : "Text-to-speech is not configured";
}

/**
 * A failed run of a speech command: the message, and, when the adapter says
 * the server could not be reached (Kokoro, after its retries), a small info
 * object the widget uses to offer starting it. Null when the run succeeded.
 * @returns {{err: string, info: ?{unreachable: boolean, backend: string, endpoint: string}}|null}
 */
function _failure(adapter, conn, proc) {
    if (!adapter || typeof adapter.parseResult !== "function")
        return null;
    proc = proc || {};
    var parsed = adapter.parseResult(proc.stdout, proc.stderr, proc.exitCode);
    if (!parsed || !parsed.err)
        return null;
    if (parsed.unreachable) {
        var endpoint = String(conn.endpoint || "").replace(/^\s+|\s+$/g, "");
        return {
            err: _i18n("Kokoro isn't running at %1.", endpoint),
            info: { unreachable: true, backend: conn.backend, endpoint: endpoint }
        };
    }
    return { err: parsed.err, info: null };
}

// --- Fallback backends -------------------------------------------------
// A voice profile holds an ordered list of backend ids (ttsFallbacks). When
// the main backend fails, the same text goes to the next one that is set up.
// Fallbacks.* decides the order and the messages; this file runs the commands.

// ttsVoice is one setting shared by the endpoint backend and the two command
// backends, and it holds whatever the main backend uses. A fallback in that
// group therefore starts from the system's default voice instead of being
// handed a voice name that belongs to another engine.
var VOICE_SHARING_BACKENDS = ["openai_speech", "spd_say", "custom_cli"];

function knownBackendIds() {
    return TtsAdapters.list().map(function(b) { return b.id; });
}

/** The saved config as one backend sees it: the same settings, a different backend. */
function configForBackend(config, id, mainId) {
    var c = {};
    for (var k in config)
        c[k] = config[k];
    c.ttsBackend = id;
    if (id !== mainId && VOICE_SHARING_BACKENDS.indexOf(id) >= 0 && VOICE_SHARING_BACKENDS.indexOf(mainId) >= 0)
        c.ttsVoice = "";
    return c;
}

/** The main backend's key (opts.apiKey) and the other backends' keys (opts.apiKeys), as one map. */
function _keyMap(apiKeys, mainId, mainKey) {
    var keys = {};
    for (var k in (apiKeys || {}))
        keys[k] = apiKeys[k];
    if (keys[mainId] === undefined && mainKey)
        keys[mainId] = mainKey;
    return keys;
}

/** What the notes and messages call a backend: the provider's name for the endpoint backend. */
function backendName(config, id) {
    var provider = String((config && config.ttsProviderName) || "").replace(/^\s+|\s+$/g, "");
    if (id === "openai_speech" && provider.length)
        return provider;
    var adapter = TtsAdapters.get(id);
    return adapter && adapter.id === id ? adapter.displayName : id;
}

/**
 * Whether a backend could speak with the saved settings: the backend's own
 * isConfigured (a blank URL, model or command is not set up) and, for a
 * hosted endpoint, a key. The on/off switch is not part of it.
 */
function isBackendSetUp(config, id, apiKeys) {
    var adapter = TtsAdapters.get(id);
    if (!config || !adapter || adapter.id !== id)
        return false;
    var mainId = config.ttsBackend || "spd_say";
    var conn = getTtsConnection(configForBackend(config, id, mainId));
    conn.enabled = true;
    if (typeof adapter.isConfigured === "function" && !adapter.isConfigured(conn))
        return false;
    var key = apiKeys && apiKeys[id] !== undefined ? apiKeys[id] : "";
    return Fallbacks.hasRequiredKey(id === "openai_speech", conn.endpoint, key);
}

/** Main backend first, then the fallbacks that are set up; the rest are skipped. */
function planFallbacks(config, apiKeys) {
    var conn = getTtsConnection(config);
    var mainId = conn ? conn.backend : "spd_say";
    var list = Fallbacks.parseList(config && config.ttsFallbacks, mainId, knownBackendIds());
    return Fallbacks.buildOrder(mainId, list, function(id) { return isBackendSetUp(config, id, apiKeys); });
}

function _newRun(config, apiKeys) {
    return Fallbacks.createRun(planFallbacks(config, apiKeys), function(id) { return backendName(config, id); });
}

/** Rows for the Fallbacks list on the settings page: [{id, name, setUp, first, last}]. */
function fallbackRows(config, apiKeys) {
    var conn = getTtsConnection(config);
    var mainId = conn ? conn.backend : "spd_say";
    var list = Fallbacks.parseList(config && config.ttsFallbacks, mainId, knownBackendIds());
    return Fallbacks.describe(list, mainId,
        function(id) { return backendName(config, id); },
        function(id) { return isBackendSetUp(config, id, apiKeys); });
}

/** True when `id` is the main backend or is in the fallback list (so its key may be needed). */
function usesBackend(config, id) {
    var conn = getTtsConnection(config);
    var mainId = conn ? conn.backend : "spd_say";
    return id === mainId
        || Fallbacks.parseList(config && config.ttsFallbacks, mainId, knownBackendIds()).indexOf(id) >= 0;
}

/** Backends that can still be added to the list: [{id, name}]. */
function fallbackChoices(config) {
    var conn = getTtsConnection(config);
    var mainId = conn ? conn.backend : "spd_say";
    var list = Fallbacks.parseList(config && config.ttsFallbacks, mainId, knownBackendIds());
    return Fallbacks.addable(list, mainId, knownBackendIds()).map(function(id) {
        return { id: id, name: backendName(config, id) };
    });
}

var KNOWN_GEMINI_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"
];

var KNOWN_OPENAI_VOICES = [
    "alloy", "echo", "fable", "onyx", "nova", "shimmer"
];

function knownGeminiVoices() {
    return KNOWN_GEMINI_VOICES.slice();
}

function knownOpenAiVoices() {
    return KNOWN_OPENAI_VOICES.slice();
}

function providerPresets() {
    return [
        {
            name: "OpenRouter",
            url: "https://openrouter.ai/api/v1",
            model: "google/gemini-3.8-flash-lite-tts",
            voice: "Zephyr",
            responseFormat: "pcm"
        },
        {
            name: "OpenAI",
            url: "https://api.openai.com/v1",
            model: "tts-1",
            voice: "alloy",
            responseFormat: "mp3"
        },
        {
            name: "Custom",
            url: "",
            model: "",
            voice: "",
            responseFormat: "mp3"
        }
    ];
}

function backendChoices() {
    return TtsAdapters.list();
}

function defaultKnownModels() {
    return [
        "google/gemini-3.8-flash-lite-tts",
        "openai/tts-1",
        "openai/tts-1-hd",
        "tts-1",
        "tts-1-hd"
    ];
}

function fetchModels(endpoint, apiKey, backendId, callback) {
    var adapter = TtsAdapters.get(backendId || "openai_speech");
    if (!adapter || typeof adapter.fetchModels !== "function") {
        callback(_i18n("TTS backend does not support model listing"), null);
        return;
    }
    adapter.fetchModels(endpoint, apiKey, callback);
}

/**
 * Sanitize and prepare markdown text for speech synthesis.
 * Strips thought blocks, converts links, and summarizes large code blocks
 * while preserving short code snippets (<= 3 lines, <= 80 chars).
 *
 * @param {string} text
 * @returns {string} cleaned plain text
 */
function cleanTextForSpeech(text) {
    if (!text || typeof text !== "string")
        return "";

    var s = text;

    // Strip thought / thinking blocks completely (preserve line boundary)
    s = s.replace(/<thought[\s\S]*?<\/thought>/gi, "\n");
    s = s.replace(/<think[\s\S]*?<\/think>/gi, "\n");

    // Handle code blocks (```lang\n...\n```)
    s = s.replace(/```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function(match, code) {
        var trimmed = (code || "").trim();
        if (!trimmed.length)
            return " ";
        var lines = trimmed.split("\n");
        // Allow short snippets (<= 3 lines and <= 80 characters) to be read
        if (lines.length <= 3 && trimmed.length <= 80)
            return " " + trimmed + " ";
        return " [code block] ";
    });
    // A fence never closed (reply cut off mid-block) is still code.
    s = s.replace(/```[\s\S]*$/, " [code block] ");

    // Remove images: ![alt](url)
    s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");

    // Convert links: [text](url) -> text
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    // Inline code: `code` -> code
    s = s.replace(/`([^`]+)`/g, "$1");

    // Headers: # Header -> Header. (allow leading spaces)
    s = s.replace(/^[ \t]*#{1,6}\s+(.+)$/gm, "$1. ");

    // Blockquotes: > quote -> quote
    s = s.replace(/^[ \t]*>\s*(.+)$/gm, "$1 ");

    // Bold / italic / strikethrough
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/\*([^*]+)\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/_([^_]+)_/g, "$1");
    s = s.replace(/~~([^~]+)~~/g, "$1");

    // Strip HTML tags (except style hints, which are applied after this step)
    s = s.replace(/<[^>]+>/g, " ");

    // Decode basic HTML entities
    s = s.replace(/&amp;/g, "&")
         .replace(/&lt;/g, "<")
         .replace(/&gt;/g, ">")
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'")
         .replace(/&nbsp;/g, " ");

    // Collapse multiple spaces and newlines
    s = s.replace(/[ \t\r\n]+/g, " ").trim();

    return s;
}

/**
 * Apply speech style/tone hints to the cleaned text.
 * E.g. `<sarcastic>`, `[whispering]`, `<speak><prosody pitch="+10%">{text}</prosody></speak>`
 *
 * @param {string} cleanedText
 * @param {string} styleHint
 * @returns {string} styled text
 */
function applyStyleHint(cleanedText, styleHint) {
    if (!cleanedText || !cleanedText.length)
        return "";

    var hint = String(styleHint || "").trim();
    if (!hint.length)
        return cleanedText;

    // Explicit placeholder: {text}
    if (hint.indexOf("{text}") >= 0)
        return hint.replace(/\{text\}/g, cleanedText);

    // Single opening XML tag: <sarcastic> -> <sarcastic>text</sarcastic>
    var tagMatch = hint.match(/^<([a-zA-Z0-9_-]+)>$/);
    if (tagMatch) {
        var tag = tagMatch[1];
        return "<" + tag + ">" + cleanedText + "</" + tag + ">";
    }

    // Bracketed speech tag: [whispering] -> [whispering] text
    if (/^\[[a-zA-Z0-9_\s-]+\]$/.test(hint)) {
        return hint + " " + cleanedText;
    }

    // Single identifier token without tags: sarcastic -> <sarcastic>text</sarcastic>
    if (/^[a-zA-Z0-9_-]+$/.test(hint)) {
        return "<" + hint + ">" + cleanedText + "</" + hint + ">";
    }

    // Full XML/SSML structure, e.g. <speak>...</speak>
    if (/^<[a-zA-Z0-9_-]+[\s\S]*>$/.test(hint)) {
        return hint + " " + cleanedText;
    }

    // Natural language style hints (e.g. "fake russian voice") steer the LLM's text
    // generation via the system prompt rather than prepending literal words to audio synthesis.
    return cleanedText;
}

/**
 * Full preparation pipeline: cleans text and applies style hint.
 *
 * @param {string} rawText
 * @param {string} [styleHint]
 * @returns {string} prepared text
 */
function prepareTextForSpeech(rawText, styleHint) {
    var cleaned = cleanTextForSpeech(rawText);
    if (!cleaned.length)
        return "";
    return applyStyleHint(cleaned, styleHint);
}

/**
 * Build the command to stop speech playback immediately.
 * @param {string} [backendId]
 * @returns {string}
 */
function buildStopCommand(backendId) {
    var adapter = TtsAdapters.get(backendId);
    if (adapter && typeof adapter.buildStopCommand === "function")
        return adapter.buildStopCommand();
    return "pkill -f '/tmp/plasmallm_tts' 2>/dev/null; spd-say -S 2>/dev/null";
}

/**
 * Build the adapter command for already-prepared text. Throws on bad config.
 */
function buildSpeechCommand(adapter, conn, preparedText, apiKey) {
    return adapter.buildCommand({
        text: preparedText,
        endpoint: conn.endpoint,
        apiKey: apiKey || "",
        model: conn.model,
        voice: conn.voice,
        responseFormat: conn.responseFormat,
        providerName: conn.providerName || "",
        speed: (conn.speedPercent || 100) / 100,
        instructions: conn.instructions || "",
        volumeMultiplier: (conn.volumePercent || 100) / 100,
        langCode: conn.langCode || "",
        rate: conn.rate,
        pitch: conn.pitch,
        language: conn.language,
        cliBinary: conn.cliBinary,
        cliTemplate: conn.cliTemplate,
        extraArgs: conn.cliExtraArgs
    });
}

// Chunk sizes for speaking a reply while it streams. The first chunk is one
// sentence so the voice starts early; later ones group sentences so there
// are fewer requests and the phrasing sounds natural.
var STREAM_FIRST_CHUNK_MIN = 4;
var STREAM_CHUNK_TARGET = 120;
var STREAM_CHUNK_MAX = 300;

// [start, end) ranges of code fences and <think>/<thought> blocks; an
// unclosed one runs to Infinity. Chunks are never cut inside these, so the
// speech cleaner still sees whole blocks.
function _blockedRanges(text) {
    var ranges = [];
    var fences = [];
    var re = /```/g;
    var m;
    while ((m = re.exec(text)) !== null)
        fences.push(m.index);
    for (var i = 0; i < fences.length; i += 2) {
        ranges.push([fences[i], i + 1 < fences.length ? fences[i + 1] + 3 : Infinity]);
    }
    var thinkRe = /<(think|thought)\b[^>]*>/gi;
    while ((m = thinkRe.exec(text)) !== null) {
        var close = text.toLowerCase().indexOf("</" + m[1].toLowerCase() + ">", m.index);
        var end = close >= 0 ? close + m[1].length + 3 : Infinity;
        ranges.push([m.index, end]);
        if (end === Infinity)
            break;
        thinkRe.lastIndex = end;
    }
    return ranges;
}

function _isBlocked(ranges, pos) {
    for (var i = 0; i < ranges.length; i++) {
        if (pos > ranges[i][0] && pos < ranges[i][1])
            return true;
    }
    return false;
}

// True when `seg` (the paragraph so far) ends inside inline code, bold,
// italics, or a link, so cutting there would leave markup or a URL to be
// read aloud. Markdown spans can cross a single line break, not a blank line.
function _inlineOpen(seg) {
    var s = seg.replace(/```/g, "").replace(/^[ \t]*[*+-][ \t]/gm, "");
    if ((s.match(/`/g) || []).length % 2 === 1)
        return true;
    if ((s.match(/\*\*/g) || []).length % 2 === 1)
        return true;
    if ((s.replace(/\*\*/g, "").match(/\*/g) || []).length % 2 === 1)
        return true;
    // Underscores inside words (snake_case) are not emphasis.
    var underOpen = (s.match(/(^|[^\w])_+(?=\S)/g) || []).length;
    var underClose = (s.match(/\S_+(?=[^\w]|$)/g) || []).length;
    if (underOpen > underClose)
        return true;
    if (s.lastIndexOf("[") > s.lastIndexOf("]"))
        return true;
    var linkUrl = s.lastIndexOf("](");
    if (linkUrl >= 0 && s.indexOf(")", linkUrl + 2) < 0)
        return true;
    return false;
}

/**
 * Take the finished part of a streaming reply as chunks to speak.
 *
 * @param {string} text        Reply text so far (raw markdown)
 * @param {number} offset      Where the previous call stopped
 * @param {boolean} isFinal    The reply is complete; take everything left
 * @param {boolean} firstChunk Nothing has been spoken yet; one sentence is enough
 * @returns {{chunks: string[], offset: number}}
 */
function takeSpeakableChunks(text, offset, isFinal, firstChunk) {
    text = String(text || "");
    var start = Math.max(0, Math.min(offset || 0, text.length));
    var chunks = [];
    // A first chunk of a few characters at least, so a list marker like
    // "1." is not spoken on its own.
    var minLen = firstChunk ? STREAM_FIRST_CHUNK_MIN : STREAM_CHUNK_TARGET;
    var ranges = _blockedRanges(text);

    function emit(end) {
        var piece = text.substring(start, end);
        start = end;
        if (piece.replace(/\s+/g, "").length > 0) {
            chunks.push(piece);
            minLen = STREAM_CHUNK_TARGET;
        }
    }

    function inlineOpenAt(pos) {
        var para = text.lastIndexOf("\n\n", pos - 1);
        var paraStart = Math.max(start, para >= 0 ? para + 2 : 0);
        return _inlineOpen(text.substring(paraStart, pos));
    }

    var re = /[.!?…]+["'”’)\]*_]*(?=\s)|\n+/g;
    re.lastIndex = start;
    var m;
    while ((m = re.exec(text)) !== null) {
        var b = m.index + m[0].length;
        if (_isBlocked(ranges, b))
            continue;
        // A blank line always ends inline markup; anything else is checked.
        if (m[0].indexOf("\n\n") < 0 && inlineOpenAt(b))
            continue;
        if (b - start >= minLen)
            emit(b);
    }

    // No sentence end for a long stretch: cut at the last comma or space.
    while (!isFinal && text.length - start > STREAM_CHUNK_MAX) {
        var span = text.substring(start, start + STREAM_CHUNK_MAX);
        var cut = span.lastIndexOf(", ");
        cut = cut > 0 ? cut + 2 : span.lastIndexOf(" ") + 1;
        if (cut <= 0 || _isBlocked(ranges, start + cut) || inlineOpenAt(start + cut))
            break;
        emit(start + cut);
    }

    if (isFinal && start < text.length)
        emit(text.length);

    return { chunks: chunks, offset: start };
}

/**
 * Speak a reply chunk by chunk while it is still being written.
 *
 * Endpoint backends (synthesize + play commands) synthesize up to two chunks
 * ahead and play strictly in order; single-command backends (spd-say, CLI)
 * run one chunk after another.
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {string} [opts.apiKey]
 * @param {function} opts.runCommand   function(cmd, callback, onReady)
 * @param {function} [opts.isCancelled]
 * @param {function} [opts.onReady]    first audio is about to play (or the queue ended)
 * @param {function} [opts.onDone]     function(err, info, extra) after the last chunk, or when
 *                                     every backend failed. info is set when a server could not
 *                                     be reached (see _failure), even if a fallback then worked;
 *                                     extra.note says which backend spoke when it was not the main one
 * @param {function} [opts.onIdle]     everything pushed so far has played (more may come)
 * @param {function} [opts.onBusy]     a chunk was pushed after the queue went idle
 * @param {object} [opts.apiKeys]      keys by backend id for the fallbacks (opts.apiKey is the main one's)
 *
 * With fallbacks (config.ttsFallbacks), a chunk that fails is tried again on the
 * next backend that is set up, and the rest of the reply stays on the backend
 * that worked. A new queue (the next reply) starts from the main backend again.
 * @returns {{push: function(text, [styleHint]), finish: function, cancel: function}}
 */
function createSpeechQueue(opts) {
    opts = opts || {};
    var conn = getTtsConnection(opts.config);
    var adapter = conn ? TtsAdapters.get(conn.backend) : null;
    var mainId = conn ? conn.backend : "spd_say";
    var apiKeys = _keyMap(opts.apiKeys, mainId, opts.apiKey);
    var run = conn ? _newRun(opts.config, apiKeys) : null;
    var items = [];
    var playIdx = 0;
    var playing = false;
    var finished = false;
    var done = false;
    var onReady = opts.onReady || null;
    var AHEAD = 2;
    var idle = true;
    var runSeq = 0;

    function notifyReady() {
        if (typeof onReady === "function") {
            var f = onReady;
            onReady = null;
            try { f(); } catch (e) {}
        }
    }

    function end(err, info, extra) {
        if (done)
            return;
        done = true;
        notifyReady();
        if (typeof opts.onDone === "function")
            opts.onDone(err || null, info || null, extra || { note: "" });
    }

    function cancelled() {
        return typeof opts.isCancelled === "function" && opts.isCancelled();
    }

    function resultFailure(it, proc) {
        return _failure(TtsAdapters.get(it.backend), getTtsConnection(configForBackend(opts.config, it.backend, mainId)), proc);
    }

    // The command for one chunk on one backend; throws like buildSpeechCommand.
    function buildItem(it, backendId) {
        var attemptConn = getTtsConnection(configForBackend(opts.config, backendId, mainId));
        var cmd = buildSpeechCommand(TtsAdapters.get(backendId), attemptConn, it.prepared, apiKeys[backendId] || "");
        if (!cmd || !cmd.length)
            throw new Error(_i18n("Could not build TTS command"));
        it.backend = backendId;
        it.cmd = cmd;
        it.twoPhase = !!(cmd.synthesizeCmd && cmd.playCmd);
        it.state = "new";
    }

    // The chunk failed on the backend it was built for. Move the reply on to
    // the next backend that is set up and build the chunk again for it, or
    // finish with the combined error when none is left.
    function retryChunk(it, err, info) {
        var failedErr = err;
        var failedInfo = info;
        for (;;) {
            var next = run.failedOn(it.backend, failedErr, failedInfo);
            if (next === null) {
                end(run.allFailedMessage(), run.unreachableInfo());
                return false;
            }
            try {
                buildItem(it, next);
                return true;
            } catch (buildErr) {
                it.backend = next;
                failedErr = buildErr.message || String(buildErr);
                failedInfo = null;
            }
        }
    }

    function startSynth(it) {
        it.state = "synth";
        opts.runCommand(it.cmd.synthesizeCmd, function(err, proc) {
            if (done)
                return;
            var f = err ? { err: err, info: null } : resultFailure(it, proc);
            if (f) {
                if (retryChunk(it, f.err, f.info))
                    pump();
                return;
            }
            it.state = "ready";
            pump();
        }, function() {});
    }

    function startPlay(it) {
        playing = true;
        it.state = "play";
        notifyReady();
        // Single commands get a unique no-op prefix: the command text is the
        // runner's key, and the same sentence twice must not collide.
        var playCmd = it.twoPhase ? it.cmd.playCmd
            : ": plasmallm_tts_run_" + (++runSeq) + "_" + Date.now().toString(36) + "; " + it.cmd;
        opts.runCommand(playCmd, function(err, proc) {
            playing = false;
            if (done)
                return;
            var f = err ? { err: err, info: null } : (it.twoPhase ? null : resultFailure(it, proc));
            if (f) {
                // A single command (spd-say, a custom program) is the whole
                // job, so it can move to a fallback; a failed player cannot.
                if (!it.twoPhase && retryChunk(it, f.err, f.info)) {
                    pump();
                    return;
                }
                if (it.twoPhase)
                    end(f.err, f.info);
                return;
            }
            playIdx++;
            pump();
        }, function() {});
    }

    function pump() {
        if (done)
            return;
        if (cancelled()) {
            done = true;
            notifyReady();
            return;
        }
        if (!playing && playIdx < items.length) {
            var next = items[playIdx];
            if (next.twoPhase ? next.state === "ready" : next.state === "new")
                startPlay(next);
        }
        // AHEAD chunks prepared beyond the one playing.
        var limit = playIdx + AHEAD + (playing ? 1 : 0);
        for (var i = playIdx; i < items.length && i < limit; i++) {
            if (items[i].twoPhase && items[i].state === "new")
                startSynth(items[i]);
        }
        if (!playing && playIdx >= items.length) {
            if (finished) {
                end(null, run ? run.unreachableInfo() : null, { note: run ? run.note("tts") : "" });
            } else if (!idle) {
                idle = true;
                if (typeof opts.onIdle === "function")
                    opts.onIdle();
            }
        }
    }

    return {
        push: function(text, styleHint) {
            if (done || finished)
                return;
            if (!conn || !adapter || !isTtsConfigured(opts.config)) {
                end(notConfiguredMessage(opts.config));
                return;
            }
            if (typeof opts.runCommand !== "function") {
                end(_i18n("TTS command runner is not available"));
                return;
            }
            var prepared = prepareTextForSpeech(text,
                styleHint !== undefined && styleHint !== null ? styleHint : conn.styleHint);
            if (!prepared.length)
                return;
            // Built for the backend the reply is on now: the main one, or the
            // fallback it moved to.
            var it = { prepared: prepared, backend: run.current(), cmd: null, twoPhase: false, state: "new" };
            var firstErr = null;
            try {
                buildItem(it, it.backend);
            } catch (buildErr) {
                firstErr = buildErr.message || String(buildErr);
            }
            if (firstErr !== null) {
                // A command that cannot be built counts as that backend failing.
                if (!retryChunk(it, firstErr, null))
                    return;
            }
            items.push(it);
            if (idle) {
                idle = false;
                if (typeof opts.onBusy === "function")
                    opts.onBusy();
            }
            pump();
        },
        finish: function() {
            finished = true;
            pump();
        },
        cancel: function() {
            done = true;
        }
    };
}

/**
 * Speak text using the configured TTS backend.
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {string} opts.text
 * @param {string} [opts.apiKey]
 * @param {object} [opts.apiKeys]     keys by backend id for the fallbacks (opts.apiKey is the main one's)
 * @param {function} opts.runCommand  function(cmd, callback)
 * @param {function} opts.callback    function(err, result); on a failure result is
 *                                    null, or {unreachable, backend, endpoint} when
 *                                    the server could not be reached (see _failure).
 *                                    On success result.note says which backend spoke
 *                                    when a fallback did, and result.failedInfo is that
 *                                    unreachable info for a failure along the way.
 *
 * With config.ttsFallbacks, a failure moves the same text on to the next
 * backend that is set up; when every one fails, err holds the main backend's
 * error and one line per fallback.
 */
function speak(opts) {
    var callback = (opts && opts.callback) || function() {};
    var onReady = (opts && opts.onReady) || null;
    function notifyReady() {
        if (typeof onReady === "function") {
            try { onReady(); } catch (e) {}
            onReady = null;
        }
    }

    var config = opts && opts.config;
    var conn = getTtsConnection(config);

    if (!conn || !isTtsConfigured(config)) {
        notifyReady();
        callback(notConfiguredMessage(config), null);
        return;
    }

    var adapter = TtsAdapters.get(conn.backend);
    if (!adapter) {
        notifyReady();
        callback(_i18n("Unknown TTS backend: %1", conn.backend), null);
        return;
    }

    var preparedText = prepareTextForSpeech(opts.text, conn.styleHint);
    if (!preparedText.length) {
        notifyReady();
        callback(_i18n("No speech content to read aloud"), null);
        return;
    }

    if (typeof opts.runCommand !== "function") {
        notifyReady();
        callback(_i18n("TTS command runner is not available"), null);
        return;
    }

    var mainId = conn.backend;
    var apiKeys = _keyMap(opts.apiKeys, mainId, opts.apiKey);
    var run = _newRun(config, apiKeys);

    // One backend's try: build the command and run it. done(err, result, info)
    // reports how it went; with no fallbacks that is the whole job.
    function attempt(id, done) {
        var attemptAdapter = TtsAdapters.get(id);
        var attemptConn = getTtsConnection(configForBackend(config, id, mainId));
        var cmd;
        try {
            cmd = buildSpeechCommand(attemptAdapter, attemptConn, preparedText, apiKeys[id] || "");
        } catch (buildErr) {
            done(buildErr.message || String(buildErr), null, null);
            return;
        }
        if (!cmd || !cmd.length) {
            done(_i18n("Could not build TTS command"), null, null);
            return;
        }

        // Two-phase execution (synthesize -> onReady -> playback) for endpoint backends
        if (cmd.synthesizeCmd && cmd.playCmd) {
            opts.runCommand(cmd.synthesizeCmd, function(synErr, synProc) {
                if (synErr) {
                    done(synErr, null, null);
                    return;
                }
                var synFailure = _failure(attemptAdapter, attemptConn, synProc);
                if (synFailure) {
                    done(synFailure.err, null, synFailure.info);
                    return;
                }

                if (typeof opts.isCancelled === "function" && opts.isCancelled()) {
                    notifyReady();
                    return;
                }

                // Audio has returned from endpoint and is ready on disk!
                // Signal ready NOW so chat bubble displays at the exact moment playback starts.
                notifyReady();

                opts.runCommand(cmd.playCmd, function(playErr, playProc) {
                    if (playErr) {
                        done(playErr, null, null);
                        return;
                    }
                    done(null, { success: true }, null);
                });
            }, notifyReady);
            return;
        }

        opts.runCommand(cmd, function(runErr, proc) {
            if (runErr) {
                done(runErr, null, null);
                return;
            }
            var failure = _failure(attemptAdapter, attemptConn, proc);
            if (failure) {
                done(failure.err, null, failure.info);
                return;
            }
            done(null, { success: true }, null);
        }, notifyReady);
    }

    Fallbacks.runChain({
        run: run,
        kind: "tts",
        attempt: attempt,
        isCancelled: opts.isCancelled,
        callback: function(err, result, meta) {
            if (meta.cancelled)
                return;
            notifyReady();
            if (err) {
                callback(err, meta.info);
                return;
            }
            // The note and failedInfo are only there when a fallback spoke:
            // what to tell the user, and a server that could not be reached on
            // the way (the widget still offers to start it).
            var res = { success: true };
            if (meta.note) {
                res.note = meta.note;
                res.backend = meta.backend;
            }
            if (meta.info)
                res.failedInfo = meta.info;
            callback(null, res);
        }
    });
}
