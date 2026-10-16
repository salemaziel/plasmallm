/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Local whisper.cpp CLI (`whisper-cli`) driven with a ggml model file.
// Host (main.qml) executes the command via the Plasma executable engine.
// whisper-cli decodes and resamples wav/mp3/ogg/flac itself, so 44.1/48 kHz
// recordings need no conversion step.

var id = "whisper_cpp";
var displayName = "whisper.cpp — C++ (local, faster on CPU)";
var transport = "cli";

var KNOWN_TASKS = ["transcribe", "translate"];
var KNOWN_DEVICES = ["cpu", "cuda"];

var DEFAULT_BINARY = "whisper-cli";
var DEFAULT_MODEL_DIRS = "~/.voicemode/models/whisper:~/.voicemode/services/whisper/models:~/.cache/openwhispr/whisper-models:~/.cache/whisper.cpp";

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function isSafeToken(value) {
    return /^[A-Za-z0-9._-]+$/.test(String(value || ""));
}

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

// Where whisper.cpp builds usually land when they are not on PATH: the copy
// built from the Speech settings page (whisperSetup.js) first, so it wins
// over another CPU build, then voicemode's install, then `cmake --install`.
var OWN_BUILD_BINARY = "~/.local/share/plasmallm/whisper.cpp/build/bin/whisper-cli";
var FALLBACK_BINARIES = [
    OWN_BUILD_BINARY,
    "~/.voicemode/services/whisper/build/bin/whisper-cli",
    "~/.local/bin/whisper-cli"
];

function defaultBinary() {
    return DEFAULT_BINARY;
}

function defaultModelDirs() {
    return DEFAULT_MODEL_DIRS;
}

/**
 * Quote a filesystem path for the shell, expanding a leading "~" or "~/" to
 * "$HOME" while keeping the rest single-quoted: "~/a b" → "$HOME"/'a b'.
 */
function shellPath(path) {
    var p = trimStr(path);
    if (p === "~")
        return '"$HOME"';
    if (p.indexOf("~/") === 0)
        return '"$HOME"/' + shellQuote(p.substring(2));
    return shellQuote(p);
}

/**
 * Shell word for the binary. A full path is used as is. The default name
 * resolves through PATH first, then FALLBACK_BINARIES, and stays the bare
 * name when none exists so the shell's "not found" error still names it.
 */
function binaryWord(binary) {
    var b = trimStr(binary) || DEFAULT_BINARY;
    if (b !== DEFAULT_BINARY)
        return shellPath(b);
    var paths = FALLBACK_BINARIES.map(shellPath).join(" ");
    return '"$(command -v ' + DEFAULT_BINARY + ' || { for p in ' + paths
        + '; do [ -x "$p" ] && echo "$p" && exit 0; done; echo ' + DEFAULT_BINARY + '; })"';
}

function isAbsoluteOrHome(path) {
    var p = trimStr(path);
    return p.charAt(0) === "/" || p === "~" || p.indexOf("~/") === 0;
}

function isConfigured(conn) {
    if (!conn || !conn.enabled)
        return false;
    if (!conn.model || trimStr(conn.model).length === 0)
        return false;
    return true;
}

// Models are discovered on disk by the settings page (see buildScanCommand);
// there is nothing to fetch over the network.
function fetchModels(endpoint, apiKey, callback) {
    callback = callback || function() {};
    callback(null, [], 200);
}

/**
 * Shell command that prints the absolute path of every ggml-*.bin model
 * under the colon-separated folder list, one per line, sorted. Skips
 * for-tests-* and silero (VAD) files.
 */
function buildScanCommand(modelDirs) {
    var raw = trimStr(modelDirs) || DEFAULT_MODEL_DIRS;
    var dirs = raw.split(":").map(trimStr).filter(function(d) { return d.length > 0; });
    if (!dirs.length)
        return "";
    var words = dirs.map(shellPath).join(" ");
    return "for d in " + words + "; do "
        + "[ -d \"$d\" ] && find \"$d\" -maxdepth 2 -type f -name 'ggml-*.bin' "
        + "! -name 'for-tests-*' ! -iname '*silero*' 2>/dev/null; "
        + "done | sort -u";
}

function parseScanOutput(stdout) {
    var seen = {};
    var out = [];
    String(stdout || "").split("\n").forEach(function(line) {
        var p = trimStr(line);
        if (p.length && p.charAt(0) === "/" && !seen[p]) {
            seen[p] = true;
            out.push(p);
        }
    });
    return out;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {string} opts.model             Absolute path (or ~/…) to a ggml .bin
 * @param {string} [opts.language]        Empty = auto
 * @param {string} [opts.cppBinary]       whisper-cli path or command name
 * @param {string} [opts.cliTask]         transcribe | translate
 * @param {string} [opts.cliDevice]       cpu → -ng; anything else leaves GPU on
 * @param {number} [opts.cliThreads]
 * @param {string} [opts.cliInitialPrompt]
 * @param {string} [opts.cliExtraArgs]
 * @returns {string} shell command (transcript on stdout)
 */
function buildCommand(opts) {
    opts = opts || {};
    var filePath = String(opts.filePath || "");
    if (!filePath.length)
        throw new Error(i18n("No audio file to transcribe"));

    var model = trimStr(opts.model);
    if (!model.length)
        throw new Error(i18n("STT model is not configured"));
    if (!isAbsoluteOrHome(model))
        throw new Error(i18n("whisper.cpp model must be the full path to a ggml .bin file"));

    var parts = [];
    parts.push(binaryWord(opts.cppBinary));
    parts.push("-m");
    parts.push(shellPath(model));
    parts.push("-f");
    parts.push(shellQuote(filePath));
    parts.push("-nt");
    parts.push("-np");

    var language = trimStr(opts.language) || "auto";
    parts.push("-l");
    parts.push(isSafeToken(language) ? language : shellQuote(language));

    var task = trimStr(opts.cliTask);
    if (task.length && task !== "transcribe") {
        if (KNOWN_TASKS.indexOf(task) < 0)
            throw new Error(i18n("Invalid Whisper task"));
        parts.push("-tr");
    }

    var threads = parseInt(opts.cliThreads, 10);
    if (!isNaN(threads) && threads > 0) {
        parts.push("-t");
        parts.push(String(threads));
    }

    var device = trimStr(opts.cliDevice);
    if (device.length) {
        if (KNOWN_DEVICES.indexOf(device) < 0)
            throw new Error(i18n("Invalid Whisper device"));
        if (device === "cpu")
            parts.push("-ng");
    }

    var prompt = String(opts.cliInitialPrompt || "");
    if (trimStr(prompt).length) {
        parts.push("--prompt");
        parts.push(shellQuote(prompt));
    }

    var extra = trimStr(opts.cliExtraArgs);
    if (extra.length)
        parts.push(extra);

    return parts.join(" ");
}

/** Command for the settings page Test button. */
function buildHelpCommand(cppBinary) {
    return binaryWord(cppBinary) + " --help";
}

function truncateDetail(text) {
    var s = trimStr(text);
    var max = 500;
    if (s.length > max)
        s = s.substring(s.length - max);
    return s;
}

function parseResult(stdout, stderr, exitCode, opts) {
    if (exitCode !== 0 && exitCode !== "0") {
        var detail = truncateDetail(trimStr(stderr) || trimStr(stdout));
        var err;
        if (detail)
            err = i18n("whisper.cpp failed (exit %1): %2", exitCode, detail);
        else
            err = i18n("whisper.cpp failed (exit %1)", exitCode);
        return { err: err, result: null };
    }
    var text = String(stdout || "").split("\n")
        .map(trimStr)
        .filter(function(l) { return l.length > 0; })
        .join(" ");
    return { err: null, result: { text: text } };
}
