#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// kokoro_starting.mjs needs curl and awk. When one is missing it must FAIL
// and say which, never skip: a skipped test would let `make test` pass
// without checking the cold-start detection. This runs it with a PATH that
// has node and sh but lacks curl, awk, or both, and checks the exit code and
// the message.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function ok(cond, msg) {
    if (!cond) { failed++; console.error("FAIL", msg); }
}

function which(tool) {
    const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
}
// Only a missing real tool makes a case impossible to set up; say so as a failure too.
const real = { sh: which("sh"), curl: which("curl"), awk: which("awk") };
for (const t of Object.keys(real))
    ok(real[t], "this test needs " + t + " on PATH to build its fake PATH");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-tools-test-"));
function binDir(name, tools) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    fs.symlinkSync(process.execPath, path.join(dir, "node"));
    for (const t of tools)
        fs.symlinkSync(real[t], path.join(dir, t));
    return dir;
}
function runWith(dir) {
    return spawnSync(process.execPath, [path.join(__dirname, "kokoro_starting.mjs")], {
        encoding: "utf8", env: { PATH: dir }, timeout: 30000
    });
}

if (!failed) {
    const cases = [
        { name: "no-curl", tools: ["sh", "awk"], missing: ["curl"] },
        { name: "no-awk", tools: ["sh", "curl"], missing: ["awk"] },
        { name: "neither", tools: ["sh"], missing: ["curl", "awk"] }
    ];
    for (const c of cases) {
        const r = runWith(binDir(c.name, c.tools));
        ok(r.status === 1, c.name + ": exits 1, not 0 (got " + r.status + ")");
        ok(!/skipped/i.test(r.stdout + r.stderr), c.name + ": does not say it was skipped");
        ok(/^FAIL /m.test(r.stderr), c.name + ": prints a FAIL line: " + JSON.stringify(r.stderr));
        for (const t of c.missing)
            ok(new RegExp("\\b" + t + "\\b").test(r.stderr), c.name + ": names " + t);
        for (const t of ["curl", "awk"].filter((x) => !c.missing.includes(x)))
            ok(!new RegExp("needs [^\\n]*\\b" + t + "\\b").test(r.stderr), c.name + ": does not blame " + t);
    }
}

fs.rmSync(scratch, { recursive: true, force: true });
if (failed) {
    console.error("kokoro_starting_tools: " + failed + " failed");
    process.exit(1);
}
console.log("kokoro_starting_tools: all passed");
