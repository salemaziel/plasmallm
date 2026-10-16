/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

.import "sttAdapters/index.js" as SttAdapters
.import "sttAdapters/whisperSetup.js" as WhisperSetup
.import "fallbacks.js" as Fallbacks

function getSttConnection(config) {
    if (!config)
        return null;
    return {
        enabled: !!config.sttEnabled,
        providerName: config.sttProviderName || "",
        endpoint: config.sttApiEndpoint || "",
        model: config.sttModelName || "",
        backend: config.sttBackend || "openai_transcriptions",
        language: config.sttLanguage || "",
        cliBinary: config.sttCliBinary || "whisper",
        cliTask: config.sttCliTask || "transcribe",
        cliDevice: config.sttCliDevice || "",
        cliFp16: !!config.sttCliFp16,
        cliThreads: config.sttCliThreads || 0,
        cliInitialPrompt: config.sttCliInitialPrompt || "",
        cliExtraArgs: config.sttCliExtraArgs || "",
        cppBinary: config.sttCppBinary || "whisper-cli",
        cppModelDirs: config.sttCppModelDirs || ""
    };
}

function isSttConfigured(config) {
    var c = getSttConnection(config);
    if (!c)
        return false;
    var adapter = SttAdapters.get(c.backend);
    if (adapter && typeof adapter.isConfigured === "function")
        return adapter.isConfigured(c);
    if (!c.enabled)
        return false;
    if (!c.endpoint || String(c.endpoint).length === 0)
        return false;
    if (!c.model || String(c.model).length === 0)
        return false;
    return true;
}

function isCliTransport(config) {
    var c = getSttConnection(config);
    var adapter = SttAdapters.get(c && c.backend);
    return !!(adapter && adapter.transport === "cli");
}

function formatFromPath(filePath) {
    if (!filePath)
        return "wav";
    var path = String(filePath);
    path = path.replace(/^file:\/\//, "");
    var dot = path.lastIndexOf(".");
    if (dot < 0)
        return "wav";
    var ext = path.substring(dot + 1).toLowerCase();
    if (ext === "wave")
        return "wav";
    if (ext === "mpeg" || ext === "mpga")
        return "mp3";
    if (ext === "mp4")
        return "m4a";
    if (["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac", "opus"].indexOf(ext) >= 0)
        return ext;
    return "wav";
}

/**
 * Transcribe using dedicated STT settings (not chat profiles).
 * @param {object} opts
 * @param {object} opts.config
 * @param {string} opts.apiKey
 * @param {string} opts.audioBase64
 * @param {string} [opts.format]
 * @param {string} [opts.filePath]
 * @param {function} opts.callback  function(err, { text })
 */
function transcribe(opts) {
    var callback = (opts && opts.callback) || function() {};
    var config = opts.config;
    var conn = getSttConnection(config);
    if (!conn || !isSttConfigured(config)) {
        callback(i18n("Speech-to-text is not configured"), null);
        return;
    }

    var adapter = SttAdapters.get(conn.backend);
    if (!adapter) {
        callback(i18n("Unknown STT backend: %1", conn.backend), null);
        return;
    }

    var format = opts.format || formatFromPath(opts.filePath);

    if (adapter.transport === "cli") {
        if (!opts.filePath || String(opts.filePath).length === 0) {
            callback(i18n("No audio file to transcribe"), null);
            return;
        }
        if (typeof opts.runCommand !== "function") {
            callback(i18n("Whisper CLI runner is not available"), null);
            return;
        }
        if (typeof adapter.buildCommand !== "function" || typeof adapter.parseResult !== "function") {
            callback(i18n("Unknown STT backend: %1", conn.backend), null);
            return;
        }
        var cmd;
        try {
            cmd = adapter.buildCommand({
                filePath: opts.filePath,
                model: conn.model,
                language: conn.language,
                cliBinary: conn.cliBinary,
                cliTask: conn.cliTask,
                cliDevice: conn.cliDevice,
                cliFp16: conn.cliFp16,
                cliThreads: conn.cliThreads,
                cliInitialPrompt: conn.cliInitialPrompt,
                cliExtraArgs: conn.cliExtraArgs,
                cppBinary: conn.cppBinary
            });
        } catch (buildErr) {
            callback(buildErr.message || String(buildErr), null);
            return;
        }
        if (!cmd) {
            callback(i18n("Could not build Whisper command"), null);
            return;
        }
        opts.runCommand(cmd, function(runErr, proc) {
            if (runErr) {
                callback(runErr, null);
                return;
            }
            proc = proc || {};
            var parsed = adapter.parseResult(proc.stdout, proc.stderr, proc.exitCode, opts);
            if (parsed && parsed.err)
                callback(parsed.err, null);
            else
                callback(null, (parsed && parsed.result) || { text: "" });
        });
        return;
    }

    if (typeof adapter.transcribe !== "function") {
        callback(i18n("Unknown STT backend: %1", conn.backend), null);
        return;
    }

    adapter.transcribe({
        endpoint: conn.endpoint,
        providerName: conn.providerName,
        apiKey: opts.apiKey || "",
        model: conn.model,
        audioBase64: opts.audioBase64,
        format: format,
        language: conn.language,
        attribution: opts.attribution,
        callback: callback
    });
}

// ---------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------

function knownBackendIds() {
    return SttAdapters.list().map(function(b) { return b.id; });
}

/** sttBackendModels (a JSON object of backend id -> model) as an object; anything unreadable is empty. */
function parseBackendModels(raw) {
    var obj = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }
    var out = {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
        return out;
    for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === "string")
            out[k] = obj[k];
    }
    return out;
}

/**
 * The saved config as one backend sees it. sttModelName holds the main
 * backend's model, and a model name from one backend means nothing to another,
 * so a fallback takes the model last chosen for it (sttBackendModels).
 */
function configForBackend(config, id, mainId) {
    var c = {};
    for (var k in config)
        c[k] = config[k];
    c.sttBackend = id;
    if (id !== mainId) {
        var models = parseBackendModels(config && config.sttBackendModels);
        c.sttModelName = models[id] || "";
    }
    return c;
}

/** What the notes and messages call a backend: the provider's name for the endpoint backend. */
function backendName(config, id) {
    var provider = String((config && config.sttProviderName) || "").replace(/^\s+|\s+$/g, "");
    if (id === "openai_transcriptions" && provider.length)
        return provider;
    var adapter = SttAdapters.get(id);
    return adapter && adapter.id === id ? adapter.displayName : id;
}

/**
 * Whether a backend could transcribe with the saved settings: the backend's
 * own isConfigured (a blank URL, model or program is not set up) and, for a
 * hosted endpoint, a key. The on/off switch is not part of it.
 */
function isBackendSetUp(config, id, apiKeys) {
    var adapter = SttAdapters.get(id);
    if (!config || !adapter || adapter.id !== id)
        return false;
    var mainId = config.sttBackend || "openai_transcriptions";
    var conn = getSttConnection(configForBackend(config, id, mainId));
    conn.enabled = true;
    if (typeof adapter.isConfigured === "function" && !adapter.isConfigured(conn))
        return false;
    var key = apiKeys && apiKeys[id] !== undefined ? apiKeys[id] : "";
    return Fallbacks.hasRequiredKey(id === "openai_transcriptions", conn.endpoint, key);
}

function _mainId(config) {
    var conn = getSttConnection(config);
    return conn ? conn.backend : "openai_transcriptions";
}

/** Main backend first, then the fallbacks that are set up; the rest are skipped. */
function planFallbacks(config, apiKeys) {
    var mainId = _mainId(config);
    var list = Fallbacks.parseList(config && config.sttFallbacks, mainId, knownBackendIds());
    return Fallbacks.buildOrder(mainId, list, function(id) { return isBackendSetUp(config, id, apiKeys); });
}

/** Rows for the Fallbacks list on the settings page: [{id, name, setUp, first, last}]. */
function fallbackRows(config, apiKeys) {
    var mainId = _mainId(config);
    var list = Fallbacks.parseList(config && config.sttFallbacks, mainId, knownBackendIds());
    return Fallbacks.describe(list, mainId,
        function(id) { return backendName(config, id); },
        function(id) { return isBackendSetUp(config, id, apiKeys); });
}

/** True when `id` is the main backend or is in the fallback list (so its key may be needed). */
function usesBackend(config, id) {
    var mainId = _mainId(config);
    return id === mainId
        || Fallbacks.parseList(config && config.sttFallbacks, mainId, knownBackendIds()).indexOf(id) >= 0;
}

/** Backends that can still be added to the list: [{id, name}]. */
function fallbackChoices(config) {
    var mainId = _mainId(config);
    var list = Fallbacks.parseList(config && config.sttFallbacks, mainId, knownBackendIds());
    return Fallbacks.addable(list, mainId, knownBackendIds()).map(function(id) {
        return { id: id, name: backendName(config, id) };
    });
}

/**
 * True when any backend that may be tried needs the recording as base64 (the
 * endpoint backend does; the program backends read the file themselves).
 */
function chainNeedsBase64(config, apiKeys) {
    var order = planFallbacks(config, apiKeys).order;
    for (var i = 0; i < order.length; i++) {
        var adapter = SttAdapters.get(order[i]);
        if (adapter && adapter.transport !== "cli")
            return true;
    }
    return false;
}

/** True when any backend that may be tried reads the recording from disk. */
function chainNeedsFile(config, apiKeys) {
    var order = planFallbacks(config, apiKeys).order;
    for (var i = 0; i < order.length; i++) {
        var adapter = SttAdapters.get(order[i]);
        if (adapter && adapter.transport === "cli")
            return true;
    }
    return false;
}

/**
 * Transcribe the same recording with the main backend and, on any failure
 * (including an empty transcript), with each fallback that is set up in turn.
 * The caller keeps the recording until the callback runs and removes it then.
 *
 * @param {object} opts  as for transcribe(), plus
 * @param {object} [opts.apiKeys]   backend id -> key (opts.apiKey is the main backend's)
 * @param {function} [opts.isCancelled]
 * @param {function} opts.callback  function(err, { text }, meta); meta.note says which
 *                                  backend did it when a fallback did, meta.info is the
 *                                  unreachable info of a failed endpoint (if any)
 */
function transcribeChain(opts) {
    var callback = (opts && opts.callback) || function() {};
    var config = opts.config;
    var mainId = _mainId(config);
    var keys = {};
    for (var k in (opts.apiKeys || {}))
        keys[k] = opts.apiKeys[k];
    if (keys[mainId] === undefined && opts.apiKey)
        keys[mainId] = opts.apiKey;

    if (!isSttConfigured(config)) {
        callback(i18n("Speech-to-text is not configured"), null, { note: "", info: null });
        return;
    }

    var run = Fallbacks.createRun(planFallbacks(config, keys), function(id) { return backendName(config, id); });

    function attempt(id, done) {
        var one = {};
        for (var p in opts)
            one[p] = opts[p];
        one.config = configForBackend(config, id, mainId);
        one.apiKey = keys[id] || "";
        one.callback = function(err, result) {
            if (err) {
                done(err, null, null);
                return;
            }
            var text = result && result.text !== undefined && result.text !== null ? String(result.text).replace(/^\s+|\s+$/g, "") : "";
            if (!text.length) {
                done(i18n("No speech detected."), null, null);
                return;
            }
            done(null, result, null);
        };
        // The recording is only read as base64 when the chain needs it.
        var adapter = SttAdapters.get(id);
        if (adapter && adapter.transport !== "cli" && !opts.audioBase64) {
            done(i18n("No audio data to send"), null, null);
            return;
        }
        transcribe(one);
    }

    Fallbacks.runChain({
        run: run,
        kind: "stt",
        attempt: attempt,
        isCancelled: opts.isCancelled,
        callback: function(err, result, meta) {
            // A cancelled chain still reports back, so the caller can delete the recording.
            if (meta.cancelled) {
                callback(err, null, { note: "", backend: "", info: null, run: meta.run, cancelled: true });
                return;
            }
            callback(err, result, { note: meta.note || "", backend: meta.backend, info: meta.info, run: meta.run });
        }
    });
}

function fetchModels(endpoint, apiKey, backendId, callback) {
    var adapter = SttAdapters.get(backendId || "openai_transcriptions");
    if (!adapter || typeof adapter.fetchModels !== "function") {
        callback(i18n("STT backend does not support model listing"), null);
        return;
    }
    adapter.fetchModels(endpoint, apiKey, callback);
}

function backendChoices() {
    return SttAdapters.list();
}

function whisperCacheCheckCommand(model, cliBinary) {
    var adapter = SttAdapters.get("whisper_cli");
    if (!adapter || typeof adapter.buildCacheCheckCommand !== "function")
        return "";
    return adapter.buildCacheCheckCommand(model, cliBinary);
}

function whisperIsCt2(cliBinary) {
    var adapter = SttAdapters.get("whisper_cli");
    return !!(adapter && typeof adapter.isCt2Binary === "function" && adapter.isCt2Binary(cliBinary));
}

function whisperDownloadSizeHint(model) {
    var adapter = SttAdapters.get("whisper_cli");
    if (!adapter || typeof adapter.downloadSizeHint !== "function")
        return "";
    return adapter.downloadSizeHint(model);
}

function whisperCudaCheckCommand(cliBinary) {
    var adapter = SttAdapters.get("whisper_cli");
    if (!adapter || typeof adapter.buildCudaCheckCommand !== "function")
        return "";
    return adapter.buildCudaCheckCommand(cliBinary);
}

function whisperCppScanCommand(modelDirs) {
    var adapter = SttAdapters.get("whisper_cpp");
    if (!adapter || typeof adapter.buildScanCommand !== "function")
        return "";
    return adapter.buildScanCommand(modelDirs);
}

function whisperCppParseScan(stdout) {
    var adapter = SttAdapters.get("whisper_cpp");
    if (!adapter || typeof adapter.parseScanOutput !== "function")
        return [];
    return adapter.parseScanOutput(stdout);
}

function whisperCppHelpCommand(cppBinary) {
    var adapter = SttAdapters.get("whisper_cpp");
    if (!adapter || typeof adapter.buildHelpCommand !== "function")
        return "";
    return adapter.buildHelpCommand(cppBinary);
}

// Local Whisper setup (detection, recommendation, install script).
function whisperProbeCommand(cppBinary, cliBinary, cppModel, marker) {
    return WhisperSetup.buildProbeCommand(cppBinary, cliBinary, cppModel, marker);
}

function whisperParseProbe(stdout) {
    return WhisperSetup.parseProbe(stdout);
}

function whisperRecommend(probe, opts) {
    return WhisperSetup.recommend(probe, opts);
}

function whisperInstallScript(kind, flavor, probe, opts) {
    return WhisperSetup.buildInstallScript(kind, flavor, probe, opts);
}

function whisperLaunchCommand(script, marker) {
    return WhisperSetup.buildLaunchCommand(script, marker);
}

function whisperUpdateDeclined(current, addIds, removeIds) {
    return WhisperSetup.updateDeclined(current, addIds, removeIds);
}

function providerPresets() {
    return [
        { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
        { name: "OpenAI",     url: "https://api.openai.com/v1" },
        { name: "Groq",       url: "https://api.groq.com/openai/v1" },
        { name: "Custom",     url: "" }
    ];
}
