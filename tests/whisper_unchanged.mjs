#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Whisper setup's generated commands and scripts must stay byte-for-byte
// what they were before the Kokoro setup began sharing its code.
// tests/fixtures/whisper_setup_output.json holds that output. To regenerate
// it from another copy of the file (e.g. an older revision):
//   node tests/whisper_unchanged.mjs --generate /path/to/whisperSetup.js
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "whisper_setup_output.json");

function loadFile(file, extraScope = {}) {
    let code = fs.readFileSync(file, "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

function i18n(fmt, ...args) {
    return String(fmt).replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1]));
}

const ui = path.join(__dirname, "../package/contents/ui/sttAdapters");
const Cpp = loadFile(path.join(ui, "whisper_cpp.js"), { i18n });
const Cli = loadFile(path.join(ui, "whisper_cli.js"), { i18n });

const NVIDIA = [
    "PROBE=1",
    "NV_GPU=NVIDIA GeForce RTX 3070, 8192, 8.6",
    "HAVE=git", "HAVE=cmake", "HAVE=pipx", "HAVE=curl",
    "PKG_MGR=apt-get",
    "HOME_DIR=/home/u",
    "PROBE_END=1"
].join("\n");
const NOTHING = ["PROBE=1", "HAVE=git", "PKG_MGR=dnf", "HOME_DIR=/home/u", "PROBE_END=1"].join("\n");

function outputs(S) {
    const out = {};
    out["probe default"] = S.buildProbeCommand("whisper-cli", "whisper", "~/m/ggml-base.bin", 7);
    out["probe blank"] = S.buildProbeCommand("", "", "", 1);
    out["probe toolbox"] = S.buildProbeCommand("", "toolbox run whisper", "", 1);
    out["scriptHeader"] = S.scriptHeader("x").join("\n");
    out["launch"] = S.buildLaunchCommand("echo hi", 3);
    out["launch undefined marker"] = S.buildLaunchCommand("echo hi");
    const nv = S.parseProbe(NVIDIA);
    const none = S.parseProbe(NOTHING);
    out["install cpp cuda"] = S.buildInstallScript("whisper_cpp", "cuda", nv, { cppModelDirs: "~/.cache/whisper.cpp" });
    out["install cpp cpu"] = S.buildInstallScript("whisper_cpp", "cpu", none, {});
    out["install cli cpu"] = S.buildInstallScript("whisper_cli", "cpu", none, {});
    out["install cli ct2-cuda"] = S.buildInstallScript("whisper_cli", "ct2-cuda", nv, {});
    return out;
}

function load(file) {
    return loadFile(file, { i18n, WhisperCpp: Cpp, WhisperCli: Cli });
}

if (process.argv[2] === "--generate") {
    const src = process.argv[3];
    if (!src) {
        console.error("usage: whisper_unchanged.mjs --generate <whisperSetup.js>");
        process.exit(2);
    }
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(outputs(load(src)), null, 1) + "\n");
    console.log("wrote " + FIXTURE);
    process.exit(0);
}

const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const actual = outputs(load(path.join(ui, "whisperSetup.js")));
let failed = 0;
for (const name of Object.keys(expected)) {
    if (actual[name] !== expected[name]) {
        failed++;
        console.error("FAIL Whisper output changed:", name);
    }
}
for (const name of Object.keys(actual)) {
    if (!(name in expected)) {
        failed++;
        console.error("FAIL no fixture for", name);
    }
}
if (failed) {
    console.error(failed + " failure(s)");
    process.exit(1);
}
console.log("whisper_unchanged: all " + Object.keys(expected).length + " outputs identical to the fixture");
