#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The endpoint speech backend treats an HTTP 200 with no audio in it as a
// failure (otherwise the player runs on an empty file and the reply is lost
// silently). This runs the real generated command with curl against a real
// local server: no audio fails with a message and cleans up its temporary
// files, an error status shows the server's message, real audio succeeds.
import fs from "fs";
import http from "http";
import path from "path";
import vm from "vm";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function eq(actual, expected, msg) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failed++;
        console.error("FAIL", msg, "\n  expected:", JSON.stringify(expected), "\n  actual:  ", JSON.stringify(actual));
    }
}
function ok(cond, msg) {
    if (!cond) { failed++; console.error("FAIL", msg); }
}

function loadModule(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}
const Utils = loadModule("../package/contents/ui/utils.js");
const SpeechRules = loadModule("../package/contents/ui/ttsAdapters/speechRules.js");
const OpenaiSpeech = loadModule("../package/contents/ui/ttsAdapters/openai_speech.js", { Utils, SpeechRules });

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
        text: "Hello there.", endpoint: "http://127.0.0.1:" + port + "/v1", model: "m", voice: "alloy", responseFormat: "mp3", apiKey: ""
    });
    const res = await runBash(String(cmd.synthesizeCmd));
    server.close();
    eq(res.code, expectCode, label + ": exit code");
    ok(expectInStderr === "" || res.stderr.indexOf(expectInStderr) >= 0, label + ": message (" + res.stderr.trim().slice(0, 80) + ")");
    eq(res.stdout.indexOf("TTS_READY") >= 0, expectReady, label + ": ready signal");
    // the adapter reads the same outcome as a failure
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
    console.error(failed + " failing check(s)");
    process.exit(1);
}
console.log("tts_empty_audio: all checks passed");
