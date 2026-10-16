#!/usr/bin/env node
// whisper.cpp STT adapter: command building, result parsing, model scan.
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadModule(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

// Minimal i18n: substitute %1..%n so error text is assertable.
function i18n(fmt, ...args) {
    return String(fmt).replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1]));
}

const Cpp = loadModule("../package/contents/ui/sttAdapters/whisper_cpp.js", { i18n });

let failed = 0;
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        failed++;
        console.error("FAIL", msg, "\n  expected:", e, "\n  actual:  ", a);
    }
}
function ok(cond, msg) {
    if (!cond) {
        failed++;
        console.error("FAIL", msg);
    }
}
function throws(fn, re, msg) {
    try {
        fn();
        failed++;
        console.error("FAIL", msg, "(did not throw)");
    } catch (e) {
        ok(re.test(e.message), msg + " (got: " + e.message + ")");
    }
}

// identity
eq(Cpp.id, "whisper_cpp", "adapter id");
eq(Cpp.transport, "cli", "cli transport");
eq(Cpp.displayName, "whisper.cpp — C++ (local, faster on CPU)", "display name");

// isConfigured needs enabled + model path
ok(!Cpp.isConfigured({ enabled: false, model: "/m/ggml-base.bin" }), "disabled is not configured");
ok(!Cpp.isConfigured({ enabled: true, model: "" }), "no model is not configured");
ok(Cpp.isConfigured({ enabled: true, model: "/m/ggml-base.bin" }), "model path configures");

// minimal command
eq(Cpp.buildCommand({
        filePath: "/tmp/rec.wav",
        model: "/m/ggml-base.bin",
        cppBinary: "/usr/bin/whisper-cli"
    }),
    "'/usr/bin/whisper-cli' -m '/m/ggml-base.bin' -f '/tmp/rec.wav' -nt -np -l auto",
    "minimal command");

// the default name resolves via PATH, then the fallback paths
var defaultWord = Cpp.binaryWord("");
ok(Cpp.buildCommand({ filePath: "/a.wav", model: "/m/x.bin" }).indexOf(defaultWord + " ") === 0,
    "default binary");
eq(Cpp.binaryWord("whisper-cli"), defaultWord, "bare default name gets the lookup");
ok(defaultWord.indexOf("command -v whisper-cli") >= 0
    && defaultWord.indexOf("\"$HOME\"/'.voicemode/services/whisper/build/bin/whisper-cli'") >= 0,
    "lookup covers PATH and voicemode");
eq(Cpp.binaryWord("my-whisper"), "'my-whisper'", "other names are used as is");

// full option set, in order
eq(Cpp.buildCommand({
        filePath: "/tmp/rec.wav",
        model: "/m/ggml-base.bin",
        cppBinary: "/opt/w/whisper-cli",
        language: "de",
        cliTask: "translate",
        cliThreads: 6,
        cliDevice: "cpu",
        cliInitialPrompt: "Plasma, KDE",
        cliExtraArgs: "-bs 3"
    }),
    "'/opt/w/whisper-cli' -m '/m/ggml-base.bin' -f '/tmp/rec.wav' -nt -np -l de -tr -t 6 -ng --prompt 'Plasma, KDE' -bs 3",
    "full command");

// transcribe task adds nothing; cuda/default device add nothing; threads 0 omitted
const plain = Cpp.buildCommand({
    filePath: "/a.wav", model: "/m/x.bin", cliTask: "transcribe", cliDevice: "cuda", cliThreads: 0
});
ok(plain.indexOf("-tr") < 0, "no -tr for transcribe");
ok(plain.indexOf("-ng") < 0, "no -ng for cuda");
ok(plain.indexOf(" -t ") < 0, "no -t for 0 threads");
ok(Cpp.buildCommand({ filePath: "/a.wav", model: "/m/x.bin", cliDevice: "" }).indexOf("-ng") < 0,
    "no -ng for default device");

// ~/ expansion keeps the rest quoted
eq(Cpp.buildCommand({
        filePath: "/a.wav",
        model: "~/my models/ggml-base.bin",
        cppBinary: "~/bin/whisper-cli"
    }),
    "\"$HOME\"/'bin/whisper-cli' -m \"$HOME\"/'my models/ggml-base.bin' -f '/a.wav' -nt -np -l auto",
    "tilde expansion");

// quoting of hostile values
const evil = Cpp.buildCommand({
    filePath: "/tmp/it's $(x).wav",
    model: "/m/a b'; rm -rf x.bin",
    language: "en; id",
    cliInitialPrompt: "a'b"
});
ok(evil.indexOf("-f '/tmp/it'\\''s $(x).wav'") >= 0, "file path quote-escaped");
ok(evil.indexOf("-m '/m/a b'\\''; rm -rf x.bin'") >= 0, "model path quote-escaped");
ok(evil.indexOf("-l 'en; id'") >= 0, "language quoted when not a plain token");
ok(evil.indexOf("--prompt 'a'\\''b'") >= 0, "prompt quote-escaped");

// validation
throws(function() { Cpp.buildCommand({ model: "/m/x.bin" }); }, /No audio file/, "missing file");
throws(function() { Cpp.buildCommand({ filePath: "/a.wav" }); }, /not configured/, "missing model");
throws(function() { Cpp.buildCommand({ filePath: "/a.wav", model: "base" }); }, /full path/, "bare model id rejected");
throws(function() { Cpp.buildCommand({ filePath: "/a.wav", model: "/m/x.bin", cliTask: "bogus" }); }, /Invalid Whisper task/, "bad task");
throws(function() { Cpp.buildCommand({ filePath: "/a.wav", model: "/m/x.bin", cliDevice: "tpu" }); }, /Invalid Whisper device/, "bad device");

// parseResult
eq(Cpp.parseResult(" Hello there.\n How are you?\n\n", "", 0),
    { err: null, result: { text: "Hello there. How are you?" } }, "lines joined with spaces");
eq(Cpp.parseResult("", "", 0), { err: null, result: { text: "" } }, "empty transcript");
eq(Cpp.parseResult("", "", "0"), { err: null, result: { text: "" } }, "string exit code 0");
eq(Cpp.parseResult("", "error: failed to read model\n", 2),
    { err: "whisper.cpp failed (exit 2): error: failed to read model", result: null }, "failure with stderr");
eq(Cpp.parseResult("", "", 127),
    { err: "whisper.cpp failed (exit 127)", result: null }, "failure without detail");
eq(Cpp.parseResult("partial", "", 1),
    { err: "whisper.cpp failed (exit 1): partial", result: null }, "failure falls back to stdout");

// help command
eq(Cpp.buildHelpCommand("~/w/whisper-cli"), "\"$HOME\"/'w/whisper-cli' --help", "help command");
eq(Cpp.buildHelpCommand(""), defaultWord + " --help", "help command default");

// scan command + parse
const scan = Cpp.buildScanCommand("~/a:/b c::  /d ");
ok(scan.indexOf("for d in \"$HOME\"/'a' '/b c' '/d'; do") === 0, "scan folders expanded and quoted");
ok(scan.indexOf("-name 'ggml-*.bin'") >= 0, "scan matches ggml-*.bin");
ok(scan.indexOf("! -name 'for-tests-*'") >= 0, "scan skips for-tests");
ok(scan.indexOf("! -iname '*silero*'") >= 0, "scan skips silero");
ok(Cpp.buildScanCommand("").indexOf("voicemode") >= 0, "empty folder list uses defaults");
eq(Cpp.parseScanOutput("/m/ggml-base.bin\n\n/m/ggml-base.bin\nnoise\n  /n/ggml-small.bin \n"),
    ["/m/ggml-base.bin", "/n/ggml-small.bin"], "scan output deduped, absolute paths only");

// fetchModels is a no-op list
let fetched = null;
Cpp.fetchModels("", "", function(err, models) { fetched = [err, models]; });
eq(fetched, [null, []], "fetchModels returns empty list");

if (failed) {
    console.error(failed + " whisper_cpp check(s) failed");
    process.exit(1);
}
console.log("whisper_cpp: all checks passed");
