#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The settings page's Kokoro check against a server that is still loading.
// Runs the real check function from the probe (kk) with curl, under both
// /bin/sh and bash, against real local servers:
//   - accepts the connection and never answers   -> KOKORO_SLOW (starting)
//   - accepts and answers after 5 s              -> SLOW at first, then found
//   - nothing listening (connection refused)     -> nothing printed (not running)
//   - answers at once                            -> KOKORO_AT (running)
//   - an address that never accepts (TEST-NET)   -> nothing printed
// and feeds each result through recommend() to see what the page would say.
// Fails (naming the tool) when curl or awk is missing; it is never skipped.
import fs from "fs";
import os from "os";
import net from "net";
import http from "http";
import vm from "vm";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function ok(cond, msg) {
    if (!cond) { failed++; console.error("FAIL", msg); }
}
function eq(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { failed++; console.error("FAIL", msg, "\n  expected:", e, "\n  actual:  ", a); }
}

function loadModule(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}
function i18n(fmt, ...args) {
    return String(fmt).replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1]));
}
const Cpp = loadModule("../package/contents/ui/sttAdapters/whisper_cpp.js", { i18n });
const Cli = loadModule("../package/contents/ui/sttAdapters/whisper_cli.js", { i18n });
const W = loadModule("../package/contents/ui/sttAdapters/whisperSetup.js", { i18n, WhisperCpp: Cpp, WhisperCli: Cli });
const K = loadModule("../package/contents/ui/ttsAdapters/kokoroSetup.js", { i18n, WhisperSetup: W });

// The check function needs both. Without them this test cannot test anything,
// and a skipped test would let `make test` pass without checking the
// cold-start detection, so a missing tool is a failure that names the tool.
const missingTools = ["curl", "awk"].filter((tool) => spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", tool]).status !== 0);
if (missingTools.length) {
    console.error("FAIL kokoro_starting needs " + missingTools.join(" and ") + " on PATH, which " + (missingTools.length > 1 ? "are" : "is") + " missing");
    process.exit(1);
}

function run(shell, script, env) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(shell, ["-c", script], { stdio: ["ignore", "pipe", "pipe"], env: env || process.env });
        let out = "", err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
    });
}
// The probe's own check function, run on one URL the way the probe runs it.
const kk = (shell, url) => run(shell, K.CHECK_FN + "; kk cfg " + W.shellQuote(url));
const urlOf = (port) => "http://127.0.0.1:" + port + "/v1";
// What the page says about a one-line result, with a stopped unit known, as on Salem's machine.
function pageSays(line, url, over) {
    const text = ["PROBE=1", "HAVE=curl", "KOKORO_UNIT=voicemode-kokoro.service|inactive|/x", line, "PROBE_END=1"].join("\n");
    return K.recommend(K.parseProbe(text), Object.assign({ url }, over));
}

function listen(server, port) {
    return new Promise((resolve) => server.listen(port || 0, "127.0.0.1", () => resolve(server.address().port)));
}
function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

const sockets = new Set();
// Accepts every connection and says nothing: a server that is still loading.
const silent = net.createServer((s) => { sockets.add(s); s.on("error", () => {}); s.on("close", () => sockets.delete(s)); });
const silentPort = await listen(silent);

// Accepts at once, answers every request after `delayMs`.
function delayedServer(delayMs) {
    const state = { answering: false };
    const srv = http.createServer((req, res) => {
        req.resume();
        setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(req.url.endsWith("/audio/voices")
                ? JSON.stringify({ voices: ["af_heart", "af_bella", "am_adam"] })
                : JSON.stringify({ data: [{ id: "kokoro", owned_by: "kokoro" }] }));
        }, state.answering ? 0 : delayMs);
    });
    return { srv, state };
}

for (const shell of ["/bin/sh", "bash"]) {
    const tag = "[" + shell + "] ";

    // 1. Accepts and never answers: starting
    {
        const r = await kk(shell, urlOf(silentPort));
        eq(r.out, "KOKORO_SLOW=cfg|" + urlOf(silentPort), tag + "accepted, no answer: KOKORO_SLOW");
        ok(r.ms >= 2800 && r.ms < 5500, tag + "waits the short timeout (3 s), took " + r.ms + " ms");
        const rec = pageSays(r.out, urlOf(silentPort));
        eq(rec.status, "starting", tag + "page: starting");
        eq(rec.message, "Kokoro is starting at " + urlOf(silentPort) + "…", tag + "page: message");
        eq(rec.offers, [], tag + "page: no Start or Install while starting");
        ok(!rec.warnings.length, tag + "page: no warning");
        // After the page has waited long enough it is not running
        const gone = pageSays(r.out, urlOf(silentPort), { gaveUp: true });
        eq(gone.status, "stopped", tag + "page after giving up: not running");
        eq(gone.offers.map(o => o.kind), ["start"], tag + "page after giving up: Start offered");
    }

    // 2. Connection refused: not running at once
    {
        const port = await freePort();
        const r = await kk(shell, urlOf(port));
        eq(r.out, "", tag + "refused: nothing printed");
        ok(r.ms < 1500, tag + "refused: answered at once, took " + r.ms + " ms");
        const rec = pageSays(r.out, urlOf(port));
        eq(rec.status, "stopped", tag + "page: not starting, the stopped unit is offered");
        eq(rec.offers.map(o => o.kind), ["start"], tag + "page: Start offered");
    }

    // 3. Answers at once: running
    {
        const { srv, state } = delayedServer(0);
        state.answering = true;
        const port = await listen(srv);
        const r = await kk(shell, urlOf(port));
        eq(r.out, "KOKORO_AT=cfg|" + urlOf(port) + "|3", tag + "answers at once: found with 3 voices");
        eq(pageSays(r.out, urlOf(port)).status, "running", tag + "page: running");
        srv.closeAllConnections();
        srv.close();
    }

    // 4. A cold start: answers 5 s after the connection. The first check is
    //    slow, a later one (after it is up) finds it.
    {
        const { srv, state } = delayedServer(5500);
        const port = await listen(srv);
        const first = await kk(shell, urlOf(port));
        eq(first.out, "KOKORO_SLOW=cfg|" + urlOf(port), tag + "cold start, first check: slow");
        eq(pageSays(first.out, urlOf(port)).status, "starting", tag + "cold start, first check: page says starting");
        state.answering = true;
        const second = await kk(shell, urlOf(port));
        eq(second.out, "KOKORO_AT=cfg|" + urlOf(port) + "|3", tag + "cold start, later check: found");
        eq(pageSays(second.out, urlOf(port)).status, "running", tag + "cold start, later check: running");
        srv.closeAllConnections();
        srv.close();
    }

    // 5. An address that never accepts: curl also exits 28, but no connection was made
    {
        const r = await kk(shell, "http://203.0.113.1:8880/v1");
        eq(r.out, "", tag + "never connects: not reported as starting");
        ok(!/SLOW/.test(r.out), tag + "never connects: no SLOW");
    }

    // 6. Not Kokoro: an answer that is not Kokoro's is ignored, as before
    {
        const srv = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.end("{\"data\":[{\"id\":\"x\",\"owned_by\":\"other\"}]}"); });
        const port = await listen(srv);
        const r = await kk(shell, urlOf(port));
        eq(r.out, "", tag + "another server: nothing printed");
        srv.closeAllConnections();
        srv.close();
    }

    // 7. The follow-up check while a server is loading asks only the slow
    //    address, and its answer is merged into the last probe.
    {
        const { srv, state } = delayedServer(5500);
        const port = await listen(srv);
        const url = urlOf(port);
        const first = await run(shell, K.buildProbeCommand(url, 1));
        const firstProbe = K.parseProbe(first.out);
        // The full probe also asks the usual ports (8880/8881) on this machine, whose
        // state this test doesn't control (the real Kokoro may be loading there),
        // so only the entries for this test's own server are looked at.
        const slowHere = firstProbe.kokoro.slow.filter(s => s.url === url);
        eq(slowHere.map(s => s.source + "|" + s.url), ["cfg|" + url], tag + "full probe: the Server URL is slow");
        eq(K.recommend(firstProbe, { url }).status, "starting", tag + "full probe: page says starting");
        const cmd = K.buildRecheckCommand(slowHere, 2);
        const again = await run(shell, cmd);
        eq(again.out, "KOKORO_SLOW=cfg|" + url, tag + "recheck of a still-loading server: slow again, and nothing else is printed");
        eq(K.recommend(K.mergeRecheck(firstProbe, again.out), { url }).status, "starting", tag + "recheck: still starting");
        state.answering = true;
        const up = await run(shell, cmd);
        eq(up.out, "KOKORO_AT=cfg|" + url + "|3", tag + "recheck after it is up: found with its voices");
        const merged = K.mergeRecheck(firstProbe, up.out);
        eq(K.recommend(merged, { url }).status, "running", tag + "recheck: page says running");
        ok(up.ms < first.ms, tag + "recheck is quicker than the full probe (" + up.ms + " ms vs " + first.ms + " ms)");
        srv.closeAllConnections();
        srv.close();
    }

    // 8. The page's own install on the Server URL's address is asked once,
    //    not once as the Server URL and again as the own install. A fake home
    //    holds a unit file that names the silent server's port.
    {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-starting-home-"));
        fs.mkdirSync(path.join(home, ".config/systemd/user"), { recursive: true });
        fs.writeFileSync(path.join(home, ".config/systemd/user", K.UNIT_NAME),
            "[Service]\nExecStart=/x/uvicorn api.src.main:app --host 127.0.0.1 --port " + silentPort + "\n");
        const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
        // Only lines for the silent server's own address; the usual ports are not this test's.
        const count = (s) => s.split("\n").filter(l => l.startsWith("KOKORO_SLOW=") && l.endsWith("|" + urlOf(silentPort))).length;
        const same = await run(shell, K.buildProbeCommand(urlOf(silentPort), 3), env);
        eq(count(same.out), 1, tag + "own install at the Server URL's address: checked once");
        // Blank Server URL: the own install is the only one asking the port.
        const blank = await run(shell, K.buildProbeCommand("", 4), env);
        ok(/KOKORO_SLOW=own\|/.test(blank.out), tag + "blank Server URL: the own install is still checked");
        fs.rmSync(home, { recursive: true, force: true });
    }
}

// What curl itself returns, which the check relies on
{
    const a = spawnSync("curl", ["-s", "-m", "1", "-w", "\nTC=%{time_connect}", urlOf(silentPort) + "/models"], { encoding: "utf8" });
    // spawnSync blocks this process, but the silent server never needs to answer.
    eq(a.status, 28, "curl against a silent server exits 28");
    ok(/TC=0\.\d+/.test(a.stdout) && Number(a.stdout.split("TC=")[1]) > 0, "and reports a connect time: " + JSON.stringify(a.stdout));
    const port = await freePort();
    const b = spawnSync("curl", ["-s", "-m", "1", urlOf(port) + "/models"], { encoding: "utf8" });
    eq(b.status, 7, "curl against a refused port exits 7");
}

for (const s of sockets) s.destroy();
silent.close();
if (failed) {
    console.error("kokoro_starting: " + failed + " failed");
    process.exit(1);
}
console.log("kokoro_starting: all checks passed");
