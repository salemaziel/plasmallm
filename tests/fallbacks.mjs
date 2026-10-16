#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Fallback backends for speech output and input: the saved list, the order
// backends are tried in, which are skipped, sticking to the working backend
// for the rest of a reply, the chat notes, the all-failed message, and the
// same recording going to the next speech-to-text backend.
import fs from "fs";
import http from "http";
import path from "path";
import vm from "vm";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function i18n(fmt, ...args) {
    return String(fmt).replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1]));
}

function loadModule(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

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

const ui = "../package/contents/ui/";
const F = loadModule(ui + "fallbacks.js", { i18n });

// ---------------------------------------------------------------------
// The saved list
// ---------------------------------------------------------------------
const KNOWN = ["spd_say", "openai_speech", "kokoro_local", "custom_cli"];

eq(F.parseList('["openai_speech","spd_say"]', "kokoro_local", KNOWN), ["openai_speech", "spd_say"], "list is read in order");
eq(F.parseList("", "kokoro_local", KNOWN), [], "blank setting is an empty list");
eq(F.parseList("not json", "kokoro_local", KNOWN), [], "unreadable setting is an empty list");
eq(F.parseList('{"a":1}', "kokoro_local", KNOWN), [], "an object is not a list");
eq(F.parseList('["kokoro_local","spd_say"]', "kokoro_local", KNOWN), ["spd_say"], "the main backend is never in its own list");
eq(F.parseList('["spd_say","spd_say","openai_speech"]', "kokoro_local", KNOWN), ["spd_say", "openai_speech"], "no backend twice");
eq(F.parseList('["nope","spd_say",7,null]', "kokoro_local", KNOWN), ["spd_say"], "unknown ids and non-strings are dropped");
eq(F.parseList(["spd_say"], "kokoro_local", KNOWN), ["spd_say"], "an array is accepted as is");
eq(F.serialize(["a", "b"]), '["a","b"]', "list is saved as JSON");
eq(F.serialize(undefined), "[]", "nothing saves as []");

eq(F.addFallback([], "kokoro_local", "spd_say", KNOWN), ["spd_say"], "add");
eq(F.addFallback(["spd_say"], "kokoro_local", "openai_speech", KNOWN), ["spd_say", "openai_speech"], "add goes to the end");
eq(F.addFallback(["spd_say"], "kokoro_local", "spd_say", KNOWN), ["spd_say"], "adding twice changes nothing");
eq(F.addFallback([], "kokoro_local", "kokoro_local", KNOWN), [], "the main backend cannot be added");
eq(F.addFallback([], "kokoro_local", "bogus", KNOWN), [], "an unknown backend cannot be added");
eq(F.removeFallback(["a", "b", "c"], "b"), ["a", "c"], "remove");
eq(F.removeFallback(["a"], "z"), ["a"], "removing something absent changes nothing");
eq(F.moveFallback(["a", "b", "c"], "c", -1), ["a", "c", "b"], "move up");
eq(F.moveFallback(["a", "b", "c"], "a", 1), ["b", "a", "c"], "move down");
eq(F.moveFallback(["a", "b", "c"], "a", -1), ["a", "b", "c"], "the first cannot move up");
eq(F.moveFallback(["a", "b", "c"], "c", 1), ["a", "b", "c"], "the last cannot move down");
eq(F.moveFallback(["a", "b"], "zz", 1), ["a", "b"], "moving something absent changes nothing");
eq(F.addable(["spd_say"], "kokoro_local", KNOWN), ["openai_speech", "custom_cli"], "addable: not the main one, not already listed");

const rows = F.describe(["openai_speech", "spd_say"], "kokoro_local", id => id.toUpperCase(), id => id === "spd_say");
eq(rows.map(r => [r.id, r.name, r.setUp, r.first, r.last]),
    [["openai_speech", "OPENAI_SPEECH", false, true, false], ["spd_say", "SPD_SAY", true, false, true]],
    "list rows say which backends are set up and which end is which");

// ---------------------------------------------------------------------
// What counts as set up (a key for a hosted endpoint)
// ---------------------------------------------------------------------
for (const u of ["http://127.0.0.1:8880/v1", "localhost:11434", "http://localhost/v1", "http://192.168.1.5:8000", "http://10.0.0.2/v1",
    "http://172.20.1.1/v1", "http://[::1]:8880/v1", "http://box.local:9000", "http://user:pw@127.0.0.1/v1"])
    ok(F.isLocalEndpoint(u), "local endpoint: " + u);
for (const u of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1", "http://172.40.0.1/v1", "http://8.8.8.8/v1", "", "https://localhost.evil.com/v1"])
    ok(!F.isLocalEndpoint(u), "hosted endpoint: " + u);
ok(F.hasRequiredKey(true, "https://openrouter.ai/api/v1", "sk-x"), "hosted endpoint with a key is set up");
ok(!F.hasRequiredKey(true, "https://openrouter.ai/api/v1", ""), "hosted endpoint without a key is not set up");
ok(!F.hasRequiredKey(true, "https://openrouter.ai/api/v1", "   "), "a blank key is no key");
ok(F.hasRequiredKey(true, "http://127.0.0.1:8880/v1", ""), "a local server needs no key");
ok(F.hasRequiredKey(false, "https://openrouter.ai/api/v1", ""), "a backend that sends no key needs none");

// ---------------------------------------------------------------------
// The order, and the run
// ---------------------------------------------------------------------
{
    const plan = F.buildOrder("kokoro_local", ["openai_speech", "spd_say", "custom_cli"], id => id !== "openai_speech");
    eq(plan.order, ["kokoro_local", "spd_say", "custom_cli"], "main first, then the set-up fallbacks in saved order");
    eq(plan.skipped, ["openai_speech"], "a fallback that is not set up is skipped");
    eq(plan.list, ["openai_speech", "spd_say", "custom_cli"], "the cleaned saved list is kept");
    const none = F.buildOrder("kokoro_local", [], () => true);
    eq(none.order, ["kokoro_local"], "no fallbacks: the main backend alone");
    const dup = F.buildOrder("kokoro_local", ["kokoro_local", "spd_say", "spd_say"], () => true);
    eq(dup.order, ["kokoro_local", "spd_say"], "no backend is tried twice");
}

const names = { kokoro_local: "Kokoro (local)", openai_speech: "OpenRouter", spd_say: "Speech Dispatcher" };
const nameOf = id => names[id] || id;
const planOf = (main, list, setUp) => F.buildOrder(main, list, id => !setUp || setUp.indexOf(id) >= 0);

{
    const run = F.createRun(planOf("kokoro_local", ["openai_speech", "spd_say"]), nameOf);
    eq(run.current(), "kokoro_local", "starts on the main backend");
    eq(run.note("tts"), "", "no note while the main backend is in use");
    eq(run.usedFallback(), false, "main backend: no fallback used");
    eq(run.failedOn("kokoro_local", "boom", { unreachable: true, backend: "kokoro_local", endpoint: "http://x" }), "openai_speech", "a failure moves to the next backend");
    eq(run.current(), "openai_speech", "now on the fallback");
    eq(run.usedFallback(), true, "fallback used");
    // a chunk that was already in flight on the old backend fails later
    eq(run.failedOn("kokoro_local", "late", null), "openai_speech", "a late failure on a backend already left changes nothing");
    eq(run.current(), "openai_speech", "still on the fallback");
    eq(run.failures.length, 1, "the late failure was not counted twice");
    eq(run.note("tts"), "Spoken with OpenRouter (Kokoro (local) failed: isn't running)", "note names the backend used and why the main one failed");
    eq(run.note("stt"), "Transcribed with OpenRouter (Kokoro (local) failed: isn't running)", "speech-to-text note");
    eq(run.unreachableInfo(), { unreachable: true, backend: "kokoro_local", endpoint: "http://x" }, "the unreachable info is kept for the Kokoro notification");
    eq(run.failedOn("openai_speech", "HTTP 401\nsecond line", null), "spd_say", "next fallback");
    eq(run.note("tts"), "Spoken with Speech Dispatcher (Kokoro (local) failed: isn't running; OpenRouter failed: HTTP 401)", "the note lists each failure, first line only");
    eq(run.failedOn("spd_say", "no speech-dispatcher", null), null, "none left");
    ok(run.exhausted(), "exhausted");
    eq(run.note("tts"), "", "no success note when everything failed");
    eq(run.allFailedMessage(), "boom\nFallback OpenRouter: HTTP 401\nsecond line\nFallback Speech Dispatcher: no speech-dispatcher",
        "all failed: the main error, then one entry per fallback");
}
{
    // with no fallbacks the message is exactly the main backend's error
    const run = F.createRun(planOf("kokoro_local", []), nameOf);
    eq(run.failedOn("kokoro_local", "only error", null), null, "no fallback to move to");
    eq(run.allFailedMessage(), "only error", "no fallbacks: the main error alone");
}
{
    // skipped and untried fallbacks are listed
    const run = F.createRun(planOf("kokoro_local", ["openai_speech", "spd_say"], ["kokoro_local", "spd_say"]), nameOf);
    run.failedOn("kokoro_local", "main down", null);
    run.failedOn("spd_say", "also down", null);
    eq(run.allFailedMessage(), "main down\nFallback OpenRouter: not set up, skipped\nFallback Speech Dispatcher: also down",
        "a fallback that is not set up is listed as skipped, in list order");
}
{
    const run = F.createRun(planOf("kokoro_local", ["spd_say"]), nameOf);
    run.failedOn("kokoro_local", "main down", null);
    eq(run.allFailedMessage(), "main down\nFallback Speech Dispatcher: not tried", "a fallback not reached yet says so");
}
{
    const long = "x".repeat(300);
    const run = F.createRun(planOf("kokoro_local", ["spd_say"]), nameOf);
    run.failedOn("kokoro_local", long, null);
    ok(run.note("tts").length < 200, "a long error is cut short in the note");
    const blank = F.createRun(planOf("kokoro_local", ["spd_say"]), nameOf);
    blank.failedOn("kokoro_local", "", null);
    ok(blank.note("tts").indexOf("unknown error") > 0, "an empty error still gets a reason");
}

// runChain
function chain(setUp, outcomes, opts) {
    opts = opts || {};
    const run = F.createRun(planOf("kokoro_local", ["openai_speech", "spd_say"], setUp), nameOf);
    const tried = [];
    let result = null;
    let calls = 0;
    F.runChain({
        run, kind: "tts",
        isCancelled: opts.isCancelled,
        attempt: (id, done) => {
            tried.push(id);
            const o = outcomes[id];
            done(o.err || null, o.err ? null : { success: true }, o.info || null);
        },
        callback: (err, res, meta) => { calls++; result = { err, res, meta }; }
    });
    return { tried, result, calls };
}
{
    let r = chain(null, { kokoro_local: {}, openai_speech: {}, spd_say: {} });
    eq(r.tried, ["kokoro_local"], "main works: nothing else is tried");
    eq(r.result.meta.note, "", "no note");
    r = chain(null, { kokoro_local: { err: "down", info: { unreachable: true, backend: "kokoro_local", endpoint: "e" } }, openai_speech: {}, spd_say: {} });
    eq(r.tried, ["kokoro_local", "openai_speech"], "main fails: the first fallback is tried");
    eq(r.result.err, null, "the fallback worked");
    eq(r.result.meta.backend, "openai_speech", "the backend that worked is reported");
    ok(r.result.meta.note.indexOf("Spoken with OpenRouter") === 0, "and the note says so");
    eq(r.result.meta.info && r.result.meta.info.unreachable, true, "the unreachable info is passed on even though a fallback worked");
    r = chain(null, { kokoro_local: { err: "a" }, openai_speech: { err: "b" }, spd_say: {} });
    eq(r.tried, ["kokoro_local", "openai_speech", "spd_say"], "tried in order");
    eq(r.result.meta.backend, "spd_say", "second fallback works");
    r = chain(null, { kokoro_local: { err: "a" }, openai_speech: { err: "b" }, spd_say: { err: "c" } });
    eq(r.tried, ["kokoro_local", "openai_speech", "spd_say"], "each backend once");
    eq(r.result.err, "a\nFallback OpenRouter: b\nFallback Speech Dispatcher: c", "all failed: main error plus a line per fallback");
    eq(r.calls, 1, "one answer");
    r = chain(["kokoro_local", "spd_say"], { kokoro_local: { err: "a" }, openai_speech: { err: "never" }, spd_say: {} });
    eq(r.tried, ["kokoro_local", "spd_say"], "a fallback that is not set up is never run");
    let n = 0;
    r = chain(null, { kokoro_local: { err: "a" }, openai_speech: {}, spd_say: {} }, { isCancelled: () => true });
    eq(r.result.meta.cancelled, true, "cancelled: reported as cancelled");
    eq(r.tried, ["kokoro_local"], "cancelled: no fallback is tried");
}

// ---------------------------------------------------------------------
// Speech output: speak() and the streaming queue, with the real adapters
// ---------------------------------------------------------------------
const SpdSay = loadModule(ui + "ttsAdapters/spd_say.js");
const Utils = loadModule(ui + "utils.js");
const SpeechRules = loadModule(ui + "ttsAdapters/speechRules.js");
const OpenaiSpeech = loadModule(ui + "ttsAdapters/openai_speech.js", { Utils, SpeechRules });
const CustomCli = loadModule(ui + "ttsAdapters/custom_cli.js");
const KokoroLocal = loadModule(ui + "ttsAdapters/kokoro_local.js", { OpenaiSpeech });
const TtsAdapters = {
    backends: { spd_say: SpdSay, openai_speech: OpenaiSpeech, kokoro_local: KokoroLocal, custom_cli: CustomCli },
    get(id) { return this.backends[id || "spd_say"] || this.backends.spd_say; },
    list() {
        return [SpdSay, OpenaiSpeech, KokoroLocal, CustomCli].map(a => ({ id: a.id, name: a.displayName }));
    }
};
const Tts = loadModule(ui + "tts.js", { TtsAdapters, SpeechRules, Fallbacks: F, i18n });

const KOKORO = "http://127.0.0.1:8880/v1";
const HOSTED = "https://openrouter.ai/api/v1";
const ttsCfg = (extra) => Object.assign({
    ttsEnabled: true, ttsBackend: "kokoro_local", ttsKokoroUrl: KOKORO, ttsKokoroVoice: "af_heart", ttsKokoroFormat: "pcm",
    ttsProviderName: "OpenRouter", ttsApiEndpoint: HOSTED, ttsModelName: "openai/tts-1", ttsVoice: "alloy", ttsResponseFormat: "mp3",
    ttsFallbacks: '["openai_speech","spd_say"]'
}, extra || {});
const OKPROC = { stdout: "TTS_READY", stderr: "", exitCode: 0 };
const DOWN = { stdout: "", stderr: "curl: (7) Failed to connect", exitCode: 7 };
const HTTP401 = { stdout: "", stderr: '{"error":{"message":"bad key"}}', exitCode: 1 };

// which backend a command is for
function whoIs(cmd) {
    if (cmd.indexOf("spd-say") >= 0) return "spd_say";
    if (cmd.indexOf("127.0.0.1:8880") >= 0) return "kokoro_local";
    if (cmd.indexOf("openrouter.ai") >= 0) return "openai_speech";
    return "play";
}
function speakWith(config, answers, extra) {
    const log = [];
    let out = null;
    Tts.speak(Object.assign({
        config, text: "Hello there.", apiKey: "", apiKeys: { openai_speech: "sk-test" },
        runCommand: (cmd, cb) => {
            const who = whoIs(String(cmd));
            log.push(who);
            cb(null, answers[who] || OKPROC);
        },
        callback: (err, res) => { out = { err, res }; }
    }, extra || {}));
    return { log, out };
}

// setup helpers used by the settings page
{
    const cfg = ttsCfg();
    eq(Tts.fallbackRows(cfg, { openai_speech: "sk" }).map(r => [r.id, r.setUp]), [["openai_speech", true], ["spd_say", true]], "rows: both set up");
    eq(Tts.fallbackRows(cfg, {}).map(r => [r.id, r.setUp]), [["openai_speech", false], ["spd_say", true]], "rows: a hosted endpoint without a key is not set up");
    eq(Tts.fallbackRows(ttsCfg({ ttsApiEndpoint: "" }), { openai_speech: "sk" }).map(r => r.setUp), [false, true], "rows: a blank URL is not set up");
    // A blank program name reads as the default (spd-say), so the command
    // backend is set up unless the adapter itself says otherwise.
    eq(Tts.fallbackRows(ttsCfg({ ttsFallbacks: '["custom_cli"]' }), {}).map(r => r.setUp), [true], "rows: custom command with the default program is set up");
    eq(Tts.fallbackRows(ttsCfg({ ttsFallbacks: '["custom_cli"]', ttsCliBinary: "espeak" }), {}).map(r => r.setUp), [true], "rows: custom command with a program is set up");
    eq(Tts.fallbackRows(ttsCfg({ ttsFallbacks: '["kokoro_local"]', ttsBackend: "spd_say" }), {}).map(r => r.setUp), [true], "rows: Kokoro with a URL is set up");
    eq(Tts.fallbackRows(ttsCfg({ ttsFallbacks: '["kokoro_local"]', ttsBackend: "spd_say", ttsKokoroUrl: "" }), {}).map(r => r.setUp), [false], "rows: Kokoro with a blank URL is not set up");
    eq(Tts.fallbackRows(cfg, { openai_speech: "sk" })[0].name, "OpenRouter", "rows: the endpoint backend is named by its provider");
    eq(Tts.fallbackChoices(cfg).map(c => c.id), ["custom_cli"], "choices: not the main one, not already listed");
    ok(Tts.usesBackend(cfg, "openai_speech") && Tts.usesBackend(cfg, "kokoro_local") && !Tts.usesBackend(cfg, "custom_cli"), "usesBackend: main or listed");
    eq(Tts.planFallbacks(ttsCfg({ ttsFallbacks: '["kokoro_local","spd_say"]' }), {}).order, ["kokoro_local", "spd_say"], "the main backend is not repeated from the list");
}

// speak()
{
    let r = speakWith(ttsCfg(), {});
    eq(r.log, ["kokoro_local", "play"], "main works: only the main backend runs");
    eq(r.out.err, null, "main works: success");
    eq(r.out.res, { success: true }, "main works: no note, no backend field");

    r = speakWith(ttsCfg(), { kokoro_local: DOWN });
    eq(r.log, ["kokoro_local", "openai_speech", "play"], "Kokoro down: the same text goes to the next backend");
    eq(r.out.err, null, "fallback worked");
    eq(r.out.res.note, "Spoken with OpenRouter (Kokoro (local) failed: isn't running)", "note says which and why");
    eq(r.out.res.backend, "openai_speech", "backend reported");
    eq(r.out.res.failedInfo, { unreachable: true, backend: "kokoro_local", endpoint: KOKORO }, "Kokoro 'isn't running' info still passed back");

    r = speakWith(ttsCfg(), { kokoro_local: HTTP401, openai_speech: HTTP401 });
    eq(r.log, ["kokoro_local", "openai_speech", "spd_say"], "two fail: the third is tried");
    eq(r.out.res.note, "Spoken with Speech Dispatcher (local CLI) (Kokoro (local) failed: Text-to-speech request failed: bad key; OpenRouter failed: Text-to-speech request failed: bad key)", "note lists both");

    r = speakWith(ttsCfg(), { kokoro_local: DOWN, openai_speech: HTTP401, spd_say: { stdout: "", stderr: "spd-say: not found", exitCode: 127 } });
    eq(r.out.res, { unreachable: true, backend: "kokoro_local", endpoint: KOKORO }, "all failed: the second argument is the unreachable info, not a result");
    ok(r.out.err.split("\n")[0] === "Kokoro isn't running at " + KOKORO + ".", "all failed: first line is the main backend's error");
    ok(/\nFallback OpenRouter: Text-to-speech request failed: bad key\n/.test(r.out.err), "all failed: one line for the endpoint");
    ok(/\nFallback Speech Dispatcher \(local CLI\): /.test(r.out.err), "all failed: one line for the last one");
    eq(r.out.err.split("\n").length, 3, "all failed: exactly main plus one line each");

    // the Kokoro notification must still fire when everything failed
    {
        let cbArgs = null;
        Tts.speak({
            config: ttsCfg(), text: "Hello there.", apiKeys: { openai_speech: "sk" },
            runCommand: (cmd, cb) => { const w = whoIs(String(cmd)); cb(null, w === "kokoro_local" ? DOWN : HTTP401); },
            callback: (err, res) => { cbArgs = [err, res]; }
        });
        eq(cbArgs[1], { unreachable: true, backend: "kokoro_local", endpoint: KOKORO }, "all failed: the unreachable info comes back as the second argument");
    }

    // not set up: never run
    r = speakWith(ttsCfg(), { kokoro_local: DOWN }, { apiKeys: {} });
    eq(r.log, ["kokoro_local", "spd_say"], "an endpoint with no key is skipped");
    r = speakWith(ttsCfg(), { kokoro_local: DOWN, spd_say: HTTP401 }, { apiKeys: {} });
    ok(/Fallback OpenRouter: not set up, skipped/.test(r.out.err), "the skipped fallback is named in the all-failed message");

    // no fallbacks: behaves as before
    r = speakWith(ttsCfg({ ttsFallbacks: "[]" }), { kokoro_local: HTTP401 });
    eq(r.log, ["kokoro_local"], "no fallbacks: only the main backend runs");
    eq(r.out.err, "Text-to-speech request failed: bad key", "no fallbacks: exactly the main error");
    r = speakWith(ttsCfg({ ttsFallbacks: undefined }), { kokoro_local: DOWN });
    eq(r.out.err, "Kokoro isn't running at " + KOKORO + ".", "setting missing: exactly the main error");

    // main not configured: no fallback attempt
    r = speakWith(ttsCfg({ ttsEnabled: false }), {});
    eq(r.log, [], "text-to-speech off: nothing runs");
    r = speakWith(ttsCfg({ ttsKokoroUrl: "" }), {});
    eq(r.log, [], "main backend not set up: reported as before, no fallback tried");
    ok(/Kokoro server URL isn't set/.test(r.out.err), "main not set up: the usual message");

    // empty audio from the endpoint (reported by the synth script as exit 1)
    r = speakWith(ttsCfg({ ttsBackend: "openai_speech", ttsFallbacks: '["spd_say"]' }),
        { openai_speech: { stdout: "", stderr: "The speech server returned no audio.", exitCode: 1 } });
    eq(r.log, ["openai_speech", "spd_say"], "empty audio counts as a failure");
    ok(/returned no audio/.test(r.out.res.note), "the note says why");

    // a command that cannot be built counts as that backend failing
    {
        const brokenCustom = { buildCommand: () => { throw new Error("template is broken"); }, parseResult: CustomCli.parseResult,
            isConfigured: CustomCli.isConfigured, id: "custom_cli", displayName: "Custom CLI command" };
        const saved = TtsAdapters.backends.custom_cli;
        TtsAdapters.backends.custom_cli = brokenCustom;
        r = speakWith(ttsCfg({ ttsBackend: "custom_cli", ttsFallbacks: '["spd_say"]' }), {});
        TtsAdapters.backends.custom_cli = saved;
        eq(r.log, ["spd_say"], "a main backend that cannot build its command moves on to the fallback");
        ok(r.out.res.note.indexOf("template is broken") > 0, "and the note says why");
    }

    // a cancelled speak does not move on
    {
        const log = [];
        let called = false;
        Tts.speak({
            config: ttsCfg(), text: "Hello there.", apiKeys: { openai_speech: "sk" },
            isCancelled: () => true,
            runCommand: (cmd, cb) => { log.push(whoIs(String(cmd))); cb(null, DOWN); },
            callback: () => { called = true; }
        });
        eq(log, ["kokoro_local"], "cancelled: no fallback is tried");
        ok(!called, "cancelled: no callback");
    }
}

// The voice setting is shared by some backends
{
    const cfg = { ttsEnabled: true, ttsBackend: "custom_cli", ttsVoice: "en-us+f3", ttsFallbacks: '["openai_speech","spd_say"]',
        ttsCliBinary: "espeak", ttsApiEndpoint: HOSTED, ttsModelName: "openai/tts-1", ttsProviderName: "OpenRouter" };
    eq(Tts.configForBackend(cfg, "openai_speech", "custom_cli").ttsVoice, "", "another engine's voice name is not handed to the endpoint");
    eq(Tts.configForBackend(cfg, "spd_say", "custom_cli").ttsVoice, "", "nor to the system voice");
    eq(Tts.configForBackend(cfg, "custom_cli", "custom_cli").ttsVoice, "en-us+f3", "the main backend keeps its voice");
    eq(Tts.configForBackend({ ttsVoice: "Zephyr", ttsBackend: "kokoro_local" }, "openai_speech", "kokoro_local").ttsVoice, "Zephyr", "Kokoro keeps its own voice setting, so the endpoint voice is untouched");
    eq(cfg.ttsBackend, "custom_cli", "the saved config is not changed");

    // "Model default" marker as a profile's voice
    const MD = SpeechRules.MODEL_DEFAULT_VOICE;
    ok(typeof MD === "string" && MD.length > 0, "the Model default marker exists");
    const log = [];
    Tts.speak({
        config: { ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: HOSTED, ttsModelName: "openai/tts-1", ttsVoice: MD, ttsResponseFormat: "mp3",
            ttsFallbacks: '["spd_say"]' },
        text: "Hello there.", apiKey: "sk",
        runCommand: (cmd, cb) => {
            const c = String(cmd);
            log.push(c);
            cb(null, c.indexOf("openrouter.ai") >= 0 ? HTTP401 : OKPROC);
        },
        callback: () => {}
    });
    ok(log[0].indexOf('"voice"') < 0, "Model default: the endpoint is sent no voice");
    ok(log.length === 2 && log[1].indexOf("spd-say") >= 0 && log[1].indexOf(MD) < 0, "Model default: the marker is never handed to the system voice fallback");
}

// The streaming queue
function deferred() {
    const log = [];
    const pending = [];
    return {
        log, pending,
        run(cmd, cb) { log.push(String(cmd)); pending.push({ cmd: String(cmd), cb }); },
        complete(match, proc) {
            const i = pending.findIndex(p => p.cmd.indexOf(match) >= 0);
            if (i < 0) throw new Error("no pending command matching " + match);
            const p = pending.splice(i, 1)[0];
            p.cb(null, proc || OKPROC);
        },
        has(match) { return pending.some(p => p.cmd.indexOf(match) >= 0); }
    };
}
const synthFor = (fr, who, text) => fr.log.filter(c => c.indexOf("curl") >= 0 && whoIs(c) === who && (!text || c.indexOf(text) >= 0));

{
    // chunk 1 fails on Kokoro; the rest of the reply stays on the fallback
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({ config: ttsCfg(), apiKeys: { openai_speech: "sk" }, runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x]) });
    q.push("Alpha one.");
    fr.complete("Alpha", DOWN);
    eq(synthFor(fr, "openai_speech", "Alpha").length, 1, "the failed chunk is tried again on the next backend");
    q.push("Bravo two.");
    q.push("Charlie three.");
    eq(synthFor(fr, "kokoro_local", "Bravo").length, 0, "later chunks do not go back to the backend that failed");
    eq(synthFor(fr, "openai_speech", "Bravo").length, 1, "later chunks use the one that worked");
    q.finish();
    fr.complete("Alpha");
    fr.complete("(pw-play");
    fr.complete("Bravo");
    fr.complete("(pw-play");
    fr.complete("Charlie");
    fr.complete("(pw-play");
    eq(done.length, 1, "one onDone");
    eq(done[0][0], null, "no error");
    eq(done[0][2].note, "Spoken with OpenRouter (Kokoro (local) failed: isn't running)", "one note for the whole reply");
    eq(done[0][1], { unreachable: true, backend: "kokoro_local", endpoint: KOKORO }, "Kokoro 'isn't running' info passed on although a fallback spoke");

    // the next reply starts from the main backend again
    const fr2 = deferred();
    const q2 = Tts.createSpeechQueue({ config: ttsCfg(), apiKeys: { openai_speech: "sk" }, runCommand: fr2.run, onDone: () => {} });
    q2.push("Delta four.");
    eq(synthFor(fr2, "kokoro_local", "Delta").length, 1, "the next reply starts on the main backend");
}
{
    // two chunks in flight on the main backend both fail: the reply moves on once
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({ config: ttsCfg(), apiKeys: { openai_speech: "sk" }, runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x]) });
    q.push("Alpha one.");
    q.push("Bravo two.");
    eq(synthFor(fr, "kokoro_local").length, 2, "two chunks are being prepared on the main backend");
    fr.complete("Bravo", DOWN);
    fr.complete("Alpha", DOWN);
    eq(synthFor(fr, "spd_say").length, 0, "the second failure does not skip past the first fallback");
    eq(synthFor(fr, "openai_speech", "Alpha").length, 1, "chunk 1 on the first fallback");
    eq(synthFor(fr, "openai_speech", "Bravo").length, 1, "chunk 2 on the first fallback");
    q.finish();
    fr.complete("Alpha");
    fr.complete("(pw-play");
    fr.complete("Bravo");
    fr.complete("(pw-play");
    eq(done[0][2].note, "Spoken with OpenRouter (Kokoro (local) failed: isn't running)", "the main backend is listed once");
}
{
    // everything fails
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({ config: ttsCfg({ ttsFallbacks: '["openai_speech"]' }), apiKeys: { openai_speech: "sk" }, runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x]) });
    q.push("Alpha one.");
    fr.complete("Alpha", DOWN);
    fr.complete("Alpha", HTTP401);
    eq(done.length, 1, "one onDone when everything failed");
    eq(done[0][0], "Kokoro isn't running at " + KOKORO + ".\nFallback OpenRouter: Text-to-speech request failed: bad key", "main error plus a line for the fallback");
    eq(done[0][1] && done[0][1].unreachable, true, "the Kokoro info comes back with the failure");
    q.push("Bravo two.");
    eq(synthFor(fr, "kokoro_local", "Bravo").length, 0, "nothing runs after the queue ended");
}
{
    // a fallback that is not set up is skipped
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({ config: ttsCfg(), apiKeys: {}, runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x]) });
    q.push("Alpha one.");
    fr.complete("Alpha", DOWN);
    eq(synthFor(fr, "openai_speech").length, 0, "the endpoint with no key is skipped");
    ok(fr.log.some(c => c.indexOf("spd-say") >= 0), "the next one that is set up runs");
}
{
    // a single-command backend (spd-say) as the main one moves on when it fails
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({
        config: ttsCfg({ ttsBackend: "spd_say", ttsFallbacks: '["openai_speech"]' }), apiKeys: { openai_speech: "sk" },
        runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x])
    });
    q.push("Alpha one.");
    fr.complete("spd-say", { stdout: "", stderr: "spd-say: no server", exitCode: 1 });
    eq(synthFor(fr, "openai_speech", "Alpha").length, 1, "a failed single command goes to the fallback");
    q.finish();
    fr.complete("Alpha");
    fr.complete("(pw-play");
    eq(done[0][0], null, "and the reply finishes");
    ok(/^Spoken with OpenRouter \(Speech Dispatcher \(local CLI\) failed/.test(done[0][2].note), "with its note");
}
{
    // no fallbacks: the error is exactly as before
    const fr = deferred();
    const done = [];
    const q = Tts.createSpeechQueue({ config: ttsCfg({ ttsFallbacks: "[]" }), runCommand: fr.run, onDone: (e, i, x) => done.push([e, i, x]) });
    q.push("Alpha one.");
    fr.complete("Alpha", HTTP401);
    eq(done[0][0], "Text-to-speech request failed: bad key", "no fallbacks: the plain error");
}

// ---------------------------------------------------------------------
// The empty-audio check in the endpoint backend's script, run for real
// ---------------------------------------------------------------------
function runBash(cmd) {
    return new Promise(resolve => {
        execFile("bash", ["-c", cmd], { timeout: 20000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
        });
    });
}
async function serverTest(status, body, expectCode, expectInStderr, expectReady, label) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => { res.writeHead(status, { "Content-Type": "audio/mpeg" }); res.end(body); });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const cmd = OpenaiSpeech.buildCommand({
        text: "Hello there.", endpoint: "http://127.0.0.1:" + port + "/v1", model: "m", voice: "alloy", format: "mp3", apiKey: ""
    });
    const res = await runBash(String(cmd.synthesizeCmd));
    server.close();
    eq(res.code, expectCode, label + ": exit code");
    ok(expectInStderr === "" ? true : res.stderr.indexOf(expectInStderr) >= 0, label + ": message (" + res.stderr.trim().slice(0, 80) + ")");
    eq(res.stdout.indexOf("TTS_READY") >= 0, expectReady, label + ": ready signal");
    // and the adapter turns it into a failure the chain can act on
    const parsed = OpenaiSpeech.parseResult(res.stdout, res.stderr, res.code);
    eq(!!parsed.err, expectCode !== 0, label + ": parseResult agrees");
    // leftovers are cleaned up on failure
    if (expectCode !== 0) {
        const m = /(\/tmp\/[^' ]+\.json)/.exec(String(cmd.synthesizeCmd));
        if (m) ok(!fs.existsSync(m[1]), label + ": temporary request file removed");
    }
}
await serverTest(200, "", 1, "The speech server returned no audio.", false, "200 with no audio");
await serverTest(500, '{"error":{"message":"boom"}}', 1, "boom", false, "HTTP 500");
await serverTest(200, Buffer.from("ID3audio-bytes-here"), 0, "", true, "200 with audio");

if (failed) {
    console.error(failed + " failing check(s) in the speech-output part");
    process.exit(1);
}

// ---------------------------------------------------------------------
// Speech input: the same recording goes to the next backend
// ---------------------------------------------------------------------
const OpenaiTranscriptions = loadModule(ui + "sttAdapters/openai_transcriptions.js", { Utils, i18n });
const WhisperCli = loadModule(ui + "sttAdapters/whisper_cli.js", { i18n });
const WhisperCpp = loadModule(ui + "sttAdapters/whisper_cpp.js", { i18n });
const SttAdapters = loadModule(ui + "sttAdapters/index.js", { OpenaiTranscriptions, WhisperCli, WhisperCpp });
const WhisperSetup = loadModule(ui + "sttAdapters/whisperSetup.js", { i18n, WhisperCpp, WhisperCli });
const Stt = loadModule(ui + "stt.js", { SttAdapters, WhisperSetup, Fallbacks: F, i18n });

const sttCfg = (extra) => Object.assign({
    sttEnabled: true, sttBackend: "openai_transcriptions", sttProviderName: "Groq", sttApiEndpoint: "https://api.groq.com/openai/v1",
    sttModelName: "whisper-large-v3", sttLanguage: "", sttCppBinary: "whisper-cli", sttCliBinary: "whisper",
    sttFallbacks: '["whisper_cpp"]', sttBackendModels: '{"whisper_cpp":"/models/ggml-base.bin","whisper_cli":"small"}'
}, extra || {});

{
    const cfg = sttCfg();
    eq(Stt.parseBackendModels('{"a":"b","c":3}'), { a: "b" }, "backend models: only text values");
    eq(Stt.parseBackendModels("nope"), {}, "backend models: unreadable is empty");
    eq(Stt.parseBackendModels("[1]"), {}, "backend models: a list is not a map");
    eq(Stt.configForBackend(cfg, "whisper_cpp", "openai_transcriptions").sttModelName, "/models/ggml-base.bin", "a fallback takes the model chosen for it");
    eq(Stt.configForBackend(cfg, "whisper_cpp", "openai_transcriptions").sttBackend, "whisper_cpp", "and runs as that backend");
    eq(Stt.configForBackend(cfg, "openai_transcriptions", "openai_transcriptions").sttModelName, "whisper-large-v3", "the main backend keeps sttModelName");
    eq(Stt.configForBackend(sttCfg({ sttBackendModels: "{}" }), "whisper_cpp", "openai_transcriptions").sttModelName, "", "no model chosen for it: blank");
    eq(cfg.sttBackend, "openai_transcriptions", "the saved config is not changed");

    eq(Stt.fallbackRows(cfg, {}).map(r => [r.id, r.setUp]), [["whisper_cpp", true]], "rows: whisper.cpp with a model is set up");
    eq(Stt.fallbackRows(sttCfg({ sttBackendModels: "{}" }), {}).map(r => r.setUp), [false], "rows: no model chosen is not set up");
    eq(Stt.fallbackRows(sttCfg({ sttFallbacks: '["openai_transcriptions"]', sttBackend: "whisper_cpp", sttModelName: "/m.bin" }), {}).map(r => r.setUp), [false], "rows: a hosted endpoint without a key is not set up");
    eq(Stt.fallbackRows(sttCfg({ sttFallbacks: '["openai_transcriptions"]', sttBackend: "whisper_cpp", sttModelName: "/m.bin", sttBackendModels: '{"openai_transcriptions":"whisper-large-v3"}' }), { openai_transcriptions: "gsk" }).map(r => r.setUp), [true], "rows: with a key it is");
    eq(Stt.fallbackRows(sttCfg({ sttFallbacks: '["openai_transcriptions"]', sttBackend: "whisper_cpp", sttModelName: "/m.bin", sttApiEndpoint: "" }), { openai_transcriptions: "gsk" }).map(r => r.setUp), [false], "rows: a blank URL is not set up");
    eq(Stt.fallbackRows(sttCfg({ sttFallbacks: '["openai_transcriptions"]', sttBackend: "whisper_cpp", sttModelName: "/m.bin", sttApiEndpoint: "http://localhost:8000/v1", sttBackendModels: '{"openai_transcriptions":"w"}' }), {}).map(r => r.setUp), [true], "rows: a local server needs no key");
    eq(Stt.fallbackChoices(cfg).map(c => c.id), ["whisper_cli"], "choices: not the main one, not already listed");
    ok(Stt.usesBackend(cfg, "openai_transcriptions") && Stt.usesBackend(cfg, "whisper_cpp") && !Stt.usesBackend(cfg, "whisper_cli"), "usesBackend");
    eq(Stt.fallbackRows(cfg, {})[0].name, "whisper.cpp — C++ (local, faster on CPU)", "rows: local backends use their own names");
    eq(Stt.fallbackRows(sttCfg({ sttBackend: "whisper_cpp", sttFallbacks: '["openai_transcriptions"]' }), {})[0].name, "Groq", "rows: the endpoint backend is named by its provider");

    ok(Stt.chainNeedsBase64(cfg, { openai_transcriptions: "k" }), "the recording is read as base64 when the endpoint is in the chain");
    ok(!Stt.chainNeedsBase64(sttCfg({ sttBackend: "whisper_cpp", sttFallbacks: '["whisper_cli"]' }), {}), "not needed for program backends only");
    ok(Stt.chainNeedsBase64(sttCfg({ sttBackend: "whisper_cpp", sttModelName: "/m.bin", sttFallbacks: '["openai_transcriptions"]', sttBackendModels: '{"openai_transcriptions":"w"}' }), { openai_transcriptions: "k" }), "needed when only a fallback is the endpoint");
    ok(!Stt.chainNeedsBase64(sttCfg({ sttBackend: "whisper_cpp", sttModelName: "/m.bin", sttFallbacks: '["openai_transcriptions"]', sttBackendModels: '{"openai_transcriptions":"w"}' }), {}), "not needed when that fallback has no key and is skipped");
    ok(Stt.chainNeedsFile(cfg, {}), "the file is needed when a program backend is in the chain");
    ok(!Stt.chainNeedsFile(sttCfg({ sttFallbacks: "[]" }), { openai_transcriptions: "k" }), "not needed for the endpoint alone");
}

// the chain
function sttRun(config, opts) {
    opts = opts || {};
    const calls = [];
    const origTranscribe = OpenaiTranscriptions.transcribe;
    OpenaiTranscriptions.transcribe = function(o) {
        calls.push({ who: "openai_transcriptions", model: o.model, key: o.apiKey, hasAudio: !!o.audioBase64 });
        const r = (opts.endpoint || (() => ({ text: "hello world" })))(o);
        if (r.err) o.callback(r.err, null); else o.callback(null, r);
    };
    const origBuild = WhisperCpp.buildCommand;
    const origParse = WhisperCpp.parseResult;
    const cmds = [];
    let results = null, answers = 0;
    let out = null, n = 0;
    Stt.transcribeChain({
        config, apiKey: opts.apiKey === undefined ? "gsk" : opts.apiKey, apiKeys: opts.apiKeys, audioBase64: opts.audioBase64 === undefined ? "QUJD" : opts.audioBase64,
        format: "wav", filePath: "/tmp/rec.wav",
        isCancelled: opts.isCancelled,
        runCommand: (cmd, cb) => {
            cmds.push(String(cmd));
            calls.push({ who: "program", cmd: String(cmd) });
            const r = (opts.program || (() => ({ stdout: "from the program\n", stderr: "", exitCode: 0 })))(String(cmd));
            cb(null, r);
        },
        callback: (err, res, meta) => { n++; out = { err, res, meta }; }
    });
    OpenaiTranscriptions.transcribe = origTranscribe;
    return { calls, out, n, cmds };
}
{
    let r = sttRun(sttCfg(), {});
    eq(r.calls.map(c => c.who), ["openai_transcriptions"], "main works: only the main backend runs");
    eq(r.out.res.text, "hello world", "main works: the text");
    eq(r.out.meta.note, "", "main works: no note");
    eq(r.n, 1, "one answer");
    eq(r.calls[0].model, "whisper-large-v3", "the main backend uses sttModelName");
    eq(r.calls[0].key, "gsk", "and the main key");

    r = sttRun(sttCfg(), { endpoint: () => ({ err: "HTTP 401: bad key" }) });
    eq(r.calls.map(c => c.who), ["openai_transcriptions", "program"], "main fails: the same recording goes to the next backend");
    ok(r.cmds[0].indexOf("/tmp/rec.wav") >= 0, "the program reads the same recording file");
    ok(r.cmds[0].indexOf("ggml-base.bin") >= 0, "with the model chosen for it");
    eq(r.out.err, null, "fallback worked");
    eq(r.out.res.text, "from the program", "its text");
    eq(r.out.meta.note, "Transcribed with whisper.cpp — C++ (local, faster on CPU) (Groq failed: HTTP 401: bad key)", "note says which and why");
    eq(r.n, 1, "one answer, after the whole chain");

    // an empty transcript is a failure too
    r = sttRun(sttCfg(), { endpoint: () => ({ text: "   " }) });
    eq(r.calls.map(c => c.who), ["openai_transcriptions", "program"], "an empty transcript moves on");
    ok(r.out.meta.note.indexOf("No speech detected.") > 0, "and the note says why");

    // both fail
    r = sttRun(sttCfg(), { endpoint: () => ({ err: "HTTP 429: slow down" }), program: () => ({ stdout: "", stderr: "model missing", exitCode: 2 }) });
    eq(r.out.res, null, "all failed: no result");
    eq(r.out.err, "HTTP 429: slow down\nFallback whisper.cpp — C++ (local, faster on CPU): whisper.cpp failed (exit 2): model missing", "all failed: the main error plus a line for the fallback");
    eq(r.n, 1, "all failed: still one answer");

    // everything gives nothing
    r = sttRun(sttCfg(), { endpoint: () => ({ text: "" }), program: () => ({ stdout: "\n", stderr: "", exitCode: 0 }) });
    eq(r.out.err, "No speech detected.\nFallback whisper.cpp — C++ (local, faster on CPU): No speech detected.", "no speech anywhere");

    // not set up: skipped, and said so
    r = sttRun(sttCfg({ sttBackendModels: "{}" }), { endpoint: () => ({ err: "down" }) });
    eq(r.calls.map(c => c.who), ["openai_transcriptions"], "a fallback with no model is not run");
    eq(r.out.err, "down\nFallback whisper.cpp — C++ (local, faster on CPU): not set up, skipped", "and is named as skipped");

    // no fallbacks: exactly the old behaviour
    r = sttRun(sttCfg({ sttFallbacks: "[]" }), { endpoint: () => ({ err: "HTTP 500" }) });
    eq(r.out.err, "HTTP 500", "no fallbacks: the plain error");
    r = sttRun(sttCfg({ sttFallbacks: "[]" }), { endpoint: () => ({ text: "" }) });
    eq(r.out.err, "No speech detected.", "no fallbacks: an empty transcript is the usual message");

    // main is a program, the fallback the endpoint (key comes from apiKeys)
    const cfg2 = sttCfg({ sttBackend: "whisper_cpp", sttModelName: "/models/main.bin", sttFallbacks: '["openai_transcriptions"]', sttBackendModels: '{"openai_transcriptions":"whisper-large-v3"}' });
    r = sttRun(cfg2, { apiKey: "", apiKeys: { openai_transcriptions: "gsk-fallback" }, program: () => ({ stdout: "", stderr: "boom", exitCode: 1 }) });
    eq(r.calls.map(c => c.who), ["program", "openai_transcriptions"], "program first, endpoint after");
    eq(r.calls[1].key, "gsk-fallback", "the endpoint gets its own key");
    eq(r.calls[1].model, "whisper-large-v3", "and its own model");
    ok(r.calls[1].hasAudio, "and the base64 audio");
    eq(r.out.res.text, "hello world", "its text");
    ok(/^Transcribed with Groq \(whisper\.cpp/.test(r.out.meta.note), "note names the provider");

    // the endpoint without audio data cannot run
    r = sttRun(sttCfg(), { audioBase64: "", program: () => ({ stdout: "ok text", stderr: "", exitCode: 0 }) });
    eq(r.calls.map(c => c.who), ["program"], "the endpoint is not called without audio");
    eq(r.out.res.text, "ok text", "the next backend still gets the file");

    // main backend not configured
    r = sttRun(sttCfg({ sttEnabled: false }), {});
    eq(r.calls.length, 0, "voice input off: nothing runs");
    eq(r.out.err, "Speech-to-text is not configured", "the usual message");

    // cancelled: reported, and no further backend is tried
    r = sttRun(sttCfg(), { endpoint: () => ({ err: "x" }), isCancelled: () => true });
    eq(r.calls.map(c => c.who), ["openai_transcriptions"], "cancelled: no fallback");
    eq(r.out.meta.cancelled, true, "cancelled: the caller still hears back so it can delete the recording");
    eq(r.n, 1, "cancelled: once");
}

if (failed) {
    console.error(failed + " failing check(s)");
    process.exit(1);
}
console.log("fallbacks: all checks passed");
