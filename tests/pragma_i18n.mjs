// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// kokoroSetup.js and whisperSetup.js are .pragma library files, which in Plasma
// have no QML context and so no i18n(). The other tests hand them an i18n, which
// hid a "ReferenceError: i18n is not defined" that only showed up in Plasma.
// These checks load both files WITHOUT one, the way Plasma does.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function eq(got, want, label) {
    if (got !== want) {
        failed++;
        console.error("FAIL " + label + "\n  got:  " + JSON.stringify(got) + "\n  want: " + JSON.stringify(want));
    }
}

function loadBare(relPath, extraScope = {}) {
    let code = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

const Cpp = loadBare("../package/contents/ui/sttAdapters/whisper_cpp.js");
const Cli = loadBare("../package/contents/ui/sttAdapters/whisper_cli.js");
const W = loadBare("../package/contents/ui/sttAdapters/whisperSetup.js", { WhisperCpp: Cpp, WhisperCli: Cli });
const K = loadBare("../package/contents/ui/ttsAdapters/kokoroSetup.js", { WhisperSetup: W });

eq(W.describeGpu({ name: "RTX 3060", memMiB: 12288 }), "RTX 3060 (12 GB)", "whisperSetup: GPU text without a provided i18n");
eq(W.describeGpu({ name: "Iris", integrated: true }), "Iris (built-in)", "whisperSetup: built-in GPU text");

const probe = K.parseProbe("KOKORO_AT=cfg|http://localhost:8880/v1|67");
const rec = K.recommend(probe, { url: "http://localhost:8880/v1" });
eq(rec.message, "Kokoro is running at http://localhost:8880/v1 (voices: 67).", "kokoroSetup: running message without a provided i18n");

eq(K.i18n("%1 and %2", "a", "b"), "a and b", "stand-in fills %1 and %2");
eq(K.i18n("no args"), "no args", "stand-in with no arguments");

if (failed) {
    console.error("pragma_i18n: " + failed + " check(s) failed");
    process.exit(1);
}
console.log("pragma_i18n: all checks passed");
