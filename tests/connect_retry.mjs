#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Kokoro synthesize command retries only when the connection fails
// (curl exit 7). These tests run the real generated command with curl
// against real local servers, under both /bin/sh and bash:
//   - nothing listening: retried, then fails with exit 7
//   - server comes up during the retries: succeeds
//   - server answers 500 / 400: tried exactly once, error shown at once
//   - no `retries` option: a refused connection is not retried
// Skipped (with a note) when curl or bash is missing.
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import vm from "vm";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let runShell = "bash";
function ok(cond, msg) {
    if (!cond) { failed++; console.error("FAIL", "[" + runShell + "]", msg); }
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
const KokoroLocal = loadModule("../package/contents/ui/ttsAdapters/kokoro_local.js", { OpenaiSpeech });

for (const tool of ["bash", "curl"]) {
    if (spawnSync("sh", ["-c", "command -v " + tool]).status !== 0) {
        console.log("connect_retry: skipped (" + tool + " not found)");
        process.exit(0);
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "connect-retry-"));

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

// Runs the synthesize half of a command (the part before playback) with runShell.
function runSynth(cmdObj) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(runShell, ["-c", String(cmdObj.synthesizeCmd)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    });
}

function serve(port, status, body, hits) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            hits.n++;
            req.resume();
            req.on("end", () => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(body);
            });
        });
        srv.listen(port, "127.0.0.1", () => resolve(srv));
    });
}

function kokoroCmd(port, extra) {
    return KokoroLocal.buildCommand(Object.assign({
        text: "Hello.", endpoint: "http://127.0.0.1:" + port + "/v1", tempDir: tmp
    }, extra));
}
function plainCmd(port, retries) {
    const opts = { text: "Hello.", endpoint: "http://127.0.0.1:" + port + "/v1", model: "kokoro", voice: "af_heart", tempDir: tmp };
    if (retries !== undefined)
        opts.retries = retries;
    return OpenaiSpeech.buildCommand(opts);
}

// Plasma runs the command with /bin/sh (dash on many systems), so every case
// runs under both /bin/sh and bash.
for (const shell of ["/bin/sh", "bash"]) {
    runShell = shell;
    // 1. Nothing listening: kokoro retries for its whole window, then exits 7.
    {
        const port = await freePort();
        // Shorten the window for the test: 2 retries is 2 seconds of sleeping.
        const r = await runSynth(plainCmd(port, 2));
        ok(r.code === 7, "connection refused after retries: exit 7, got " + r.code);
        ok(r.ms >= 1800, "two retries wait about two seconds, took " + r.ms + " ms");
        ok(r.ms < 6000, "and not much longer, took " + r.ms + " ms");
    }

    // 2. Nothing listening, no `retries`: fails at once, exit 7.
    {
        const port = await freePort();
        const r = await runSynth(plainCmd(port));
        ok(r.code === 7, "no retries option: exit 7, got " + r.code);
        ok(r.ms < 1500, "no retries option: fails at once, took " + r.ms + " ms");
    }

    // 3. Server starts during the retries: the request goes through.
    {
        const port = await freePort();
        const hits = { n: 0 };
        const pending = runSynth(plainCmd(port, 8));
        await new Promise((r) => setTimeout(r, 1500));
        const srv = await serve(port, 200, "RIFFfakeaudio", hits);
        const r = await pending;
        srv.close();
        ok(r.code === 0 && r.out.includes("TTS_READY"), "server up on a later try: success, code " + r.code + " " + r.err);
        ok(hits.n === 1, "the request reached the server once, got " + hits.n);
        ok(r.ms >= 1400 && r.ms < 6000, "it waited for the server, took " + r.ms + " ms");
    }

    // 4. Server answers with HTTP errors: one request, error at once.
    for (const [status, body, expect] of [
        [500, '{"error":{"message":"synthesis blew up"}}', "synthesis blew up"],
        [503, '{"message":"busy"}', "busy"],
        [429, '{"message":"slow down"}', "slow down"],
        [400, '{"message":"bad voice"}', "bad voice"]
    ]) {
        const port = await freePort();
        const hits = { n: 0 };
        const srv = await serve(port, status, body, hits);
        const r = await runSynth(kokoroCmd(port));
        srv.close();
        ok(r.code === 1, "HTTP " + status + ": exit 1, got " + r.code);
        ok(hits.n === 1, "HTTP " + status + ": exactly one request, got " + hits.n);
        ok(r.ms < 1500, "HTTP " + status + ": error shows at once, took " + r.ms + " ms");
        ok(r.err.includes(expect), "HTTP " + status + ": server's message reaches stderr");
        const parsed = KokoroLocal.parseResult(r.out, r.err, r.code);
        ok(parsed.err && parsed.err.includes(expect), "HTTP " + status + ": parseResult shows the message");
    }

    // 5. A normal 200 through the kokoro command (no retry needed).
    {
        const port = await freePort();
        const hits = { n: 0 };
        const srv = await serve(port, 200, "RIFFfakeaudio", hits);
        const r = await runSynth(kokoroCmd(port));
        srv.close();
        ok(r.code === 0 && r.out.includes("TTS_READY") && hits.n === 1, "200 reply: success after one request");
    }

    // 6. Quoting: a voice and text with quotes still run as written.
    {
        const port = await freePort();
        const hits = { n: 0 };
        const srv = await serve(port, 200, "x", hits);
        const r = await runSynth(kokoroCmd(port, { text: "It's \"quoted\" $(touch " + tmp + "/pwned) `id`", voice: "af_heart'; touch " + tmp + "/pwned2; '" }));
        srv.close();
        ok(r.code === 0, "quotes in text and voice: still runs, code " + r.code + " " + r.err);
        ok(!fs.existsSync(path.join(tmp, "pwned")) && !fs.existsSync(path.join(tmp, "pwned2")), "quotes in text and voice are not run as commands");
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
    console.error("connect_retry: " + failed + " check(s) failed");
    process.exit(1);
}
console.log("connect_retry: all checks passed");
