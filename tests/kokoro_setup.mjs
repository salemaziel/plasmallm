#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local Kokoro setup: probe parsing, recommendations, and the install,
// launch and start commands.
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { execFileSync } from "child_process";
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

function i18n(fmt, ...args) {
    return String(fmt).replace(/%(\d)/g, (_, n) => String(args[Number(n) - 1]));
}

const Cpp = loadModule("../package/contents/ui/sttAdapters/whisper_cpp.js", { i18n });
const Cli = loadModule("../package/contents/ui/sttAdapters/whisper_cli.js", { i18n });
const W = loadModule("../package/contents/ui/sttAdapters/whisperSetup.js", { i18n, WhisperCpp: Cpp, WhisperCli: Cli });
const K = loadModule("../package/contents/ui/ttsAdapters/kokoroSetup.js", { i18n, WhisperSetup: W });

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-setup-test-"));
function syntaxOk(shell, script, name) {
    const f = path.join(tmp, name + ".sh");
    fs.writeFileSync(f, script);
    try {
        execFileSync(shell, ["-n", f], { stdio: "pipe" });
        return true;
    } catch (e) {
        console.error(String(e.stderr || e));
        return false;
    }
}
const ids = (rec) => rec.offers.map(o => o.id);

// ---------------------------------------------------------------- probe command

const cmd = K.buildProbeCommand("http://localhost:8880/v1", 7);
ok(cmd.startsWith(": plasmallm-kokoro-probe-7; "), "probe marker first");
ok(K.buildProbeCommand("", "1760000000000-4").startsWith(": plasmallm-kokoro-probe-1760000000000-4; "), "probe marker may carry a time and a number");
ok(cmd.includes("KOKORO_NO_CURL=1"), "probe reports a missing curl");
// Run the whole probe for real, with a PATH that has no curl and one that does
// (a stand-in curl that answers nothing). With curl missing the probe must
// say so and still finish; with curl there it must stay quiet about it.
// Other tools missing from that PATH only silence their own sections.
{
    const home = path.join(tmp, "probe-home");
    fs.mkdirSync(home, { recursive: true });
    const noCurlDir = path.join(tmp, "bin-without-curl");
    fs.mkdirSync(noCurlDir, { recursive: true });
    const withCurlDir = path.join(tmp, "bin-with-curl");
    fs.mkdirSync(withCurlDir, { recursive: true });
    fs.writeFileSync(path.join(withCurlDir, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
    for (const shell of ["/bin/sh", execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim()]) {
        const run = (dir) => execFileSync(shell, ["-c", K.buildProbeCommand("http://localhost:8880/v1", 3)],
            { env: { PATH: dir, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const missing = run(noCurlDir);
        ok(!/^HAVE=curl$/m.test(missing), shell + ": no curl on PATH: HAVE=curl is absent");
        ok(/^KOKORO_NO_CURL=1$/m.test(missing), shell + ": no curl on PATH: the probe prints KOKORO_NO_CURL=1");
        ok(/^PROBE_END=1$/m.test(missing), shell + ": the probe still finishes without curl");
        const pm = K.parseProbe(missing);
        ok(pm.complete && pm.kokoro.noCurl === true && pm.kokoro.at.length === 0, shell + ": parsed as complete, curl missing, no server");
        const present = run(withCurlDir);
        ok(/^HAVE=curl$/m.test(present) && !/KOKORO_NO_CURL/.test(present), shell + ": curl on PATH: not reported missing");
        ok(K.parseProbe(present).kokoro.noCurl === false, shell + ": curl on PATH: noCurl is false");
    }
}
ok(cmd.includes("kk cfg 'http://localhost:8880/v1'"), "configured URL is checked, quoted");
// localhost:8880 is the same server as the first usual address, so only 8881 is checked again.
ok(!cmd.includes("kk port http://127.0.0.1:8880/v1") && cmd.includes("kk port http://127.0.0.1:8881/v1"), "usual address that is the Server URL again is not checked twice");
{
    const other = K.buildProbeCommand("http://127.0.0.1:9999/v1", 1);
    ok(other.includes("kk port http://127.0.0.1:8880/v1") && other.includes("kk port http://127.0.0.1:8881/v1"), "default ports checked");
    const blank = K.buildProbeCommand("", 1);
    ok(!blank.includes("kk cfg") && blank.includes("kk port http://127.0.0.1:8880/v1") && blank.includes("kk port http://127.0.0.1:8881/v1"), "blank URL: both default ports checked");
}
ok(cmd.includes("nvidia-smi") && cmd.includes("vulkaninfo") && cmd.includes("/sys/class/drm"), "GPU probe lines reused");
ok(cmd.includes("plasmallm-kokoro.service"), "own unit file read for its port");
ok(cmd.trim().endsWith("echo PROBE_END=1"), "probe ends with PROBE_END");
ok(syntaxOk("bash", cmd, "probe-bash"), "probe passes bash -n");
ok(syntaxOk("sh", cmd, "probe-sh"), "probe passes sh -n (Plasma runs it with /bin/sh)");
const evil = K.buildProbeCommand("http://x/';touch /tmp/kokoro-pwned;'", 1);
ok(evil.includes("kk cfg 'http://x/'\\''"), "a quote in the URL is shell-escaped");
ok(syntaxOk("sh", evil, "probe-evil"), "quoted URL still parses");
ok(!K.buildProbeCommand("", 1).includes("kk cfg"), "blank URL: no configured check");
eq(K.normalizeUrl(" localhost:8880/v1/ "), "http://localhost:8880/v1", "normalizeUrl adds scheme, drops slash");

// ---------------------------------------------------------------- Salem's machine

// voicemode-kokoro on 8880, MX230 with 2 GB, uv present.
const SALEM = [
    "PROBE=1",
    "NV_GPU=NVIDIA GeForce MX230, 2048, 6.1",
    "VK_GPU=INTEGRATED_GPU|25013019648|Intel(R) UHD Graphics (CML GT2)",
    "VK_GPU=DISCRETE_GPU|2147483648|NVIDIA GeForce MX230",
    "VK_GPU=CPU|33350692864|llvmpipe (LLVM 20.1.8, 256 bits)",
    "DRM_GPU=0x8086|0|1",
    "DRM_GPU=0x10de|0|",
    "HAVE=git", "HAVE=uv", "HAVE=pipx", "HAVE=curl", "HAVE=docker", "HAVE=uv-local",
    "PY_VERSION=3.13",
    "PKG_MGR=apt-get",
    "HOME_DIR=/home/pc",
    "KOKORO_AT=port|http://127.0.0.1:8880/v1|67",
    "KOKORO_UNIT=voicemode-kokoro.service|active|/home/pc/.voicemode/services/kokoro",
    "PROBE_END=1"
].join("\n");
const sp = K.parseProbe(SALEM);
ok(sp.complete, "probe complete");
eq(sp.kokoro.at, [{ source: "port", url: "http://127.0.0.1:8880/v1", voices: 67 }], "server found on 8880");
eq(sp.kokoro.units, [{ name: "voicemode-kokoro.service", state: "active", dir: "/home/pc/.voicemode/services/kokoro" }], "unit parsed");
eq(sp.pkgMgr, "apt", "GPU/tool fields come from the Whisper parser");
let rec = K.recommend(sp, {});
eq(rec.status, "found", "Salem, no URL: found");
eq(ids(rec), ["kokoro:use:http://127.0.0.1:8880/v1"], "Salem, no URL: Use it");
ok(rec.message.includes("voicemode-kokoro.service") && rec.message.includes("(voices: 67)"), "message names the unit and voices");
eq(rec.message, "Kokoro is running at http://127.0.0.1:8880/v1 (voices: 67), as voicemode-kokoro.service.", "found message wording");
eq(rec.offers[0].url, "http://127.0.0.1:8880/v1", "Use it sets that URL");
// Once the URL is set, the probe's configured check answers.
rec = K.recommend(K.parseProbe(SALEM + "\nKOKORO_AT=cfg|http://localhost:8880/v1|67"), { url: "http://localhost:8880/v1" });
eq(rec.status, "running", "Salem, URL set: running");
eq(rec.offers.length, 0, "running: no offer");
eq(rec.warnings.length, 0, "running: no warning");
eq(rec.message, "Kokoro is running at http://localhost:8880/v1 (voices: 67).", "running message wording, no count noun");
// The count reads correctly for any number: no "voices" after a bare number.
for (const n of [0, 1, 2, 67]) {
    const r1 = K.recommend(K.parseProbe(SALEM.replace("|67", "|" + n) + "\nKOKORO_AT=cfg|http://localhost:8880/v1|" + n), { url: "http://localhost:8880/v1" });
    ok(r1.message.endsWith("(voices: " + n + ")."), "voice count " + n + " reads as 'voices: N'");
}
// URL set to the same server under another name, and the cfg check failed:
rec = K.recommend(sp, { url: "http://localhost:8880/v1" });
eq(rec.offers.length, 0, "the server at the configured URL is not offered as somewhere else");
ok(rec.warnings[0].includes("Nothing answers"), "configured URL not answering is warned");
// What the Server URL field does when it loses focus lives in configTts.qml,
// which can't run here. The decision itself is urlNeedsProbe(), which the QML
// calls: leaving the field with the text unchanged since the last probe
// started must not probe again.
ok(K.urlNeedsProbe("http://localhost:8880/v1", "http://localhost:8880/v1") === false, "same URL as the last probe: no new probe");
ok(K.urlNeedsProbe("  http://localhost:8880/v1 ", "http://localhost:8880/v1") === false, "only whitespace differs: no new probe");
ok(K.urlNeedsProbe("http://localhost:8881/v1", "http://localhost:8880/v1") === true, "a different URL: probe");
ok(K.urlNeedsProbe("http://localhost:8880/v1", "") === true, "URL typed after a probe with a blank URL: probe");
ok(K.urlNeedsProbe("", "http://localhost:8880/v1") === true, "URL cleared: probe");
ok(K.urlNeedsProbe("", "") === false && K.urlNeedsProbe(undefined, null) === false, "blank both times: no probe");
// recommend() judges the URL it is given. The page hands it the URL the probe
// ran with (kokoroProbedUrl), not what is typed now; this only checks that
// recommend() reports on exactly that URL and says nothing for a blank one.
{
    const probed = K.parseProbe(SALEM + "\nKOKORO_AT=cfg|http://localhost:8880/v1|67");
    const same = K.recommend(probed, { url: "http://localhost:8880/v1" });
    eq(same.status, "running", "probed URL: running");
    ok(same.message.includes("http://localhost:8880/v1"), "message names the probed URL");
    const blankProbe = K.recommend(sp, { url: "" });
    ok(blankProbe.status === "found" && blankProbe.warnings.length === 0, "probed with a blank URL: found, nothing said about a URL");
}
// Declined "Use it" stays declined.
rec = K.recommend(sp, { declined: "kokoro:use:http://127.0.0.1:8880/v1" });
ok(rec.offers[0].declined, "declined Use it is marked declined");

// ---------------------------------------------------------------- nothing installed, no GPU

const NOTHING = ["PROBE=1", "HAVE=git", "PKG_MGR=apt-get", "PY_VERSION=3.12", "HOME_DIR=/home/u", "PROBE_END=1"].join("\n");
const np = K.parseProbe(NOTHING);
rec = K.recommend(np, {});
eq(rec.status, "missing", "nothing: missing");
eq(ids(rec), ["kokoro:install-cpu"], "nothing, no GPU: CPU install only");
eq(rec.offers[0].missing, ["curl"], "curl missing");
eq(rec.offers[0].packageCommand, "sudo apt install curl", "package command for curl");
ok(rec.message.includes("not found"), "nothing: says not found");
rec = K.recommend(np, { declined: "kokoro:install-cpu" });
ok(rec.offers[0].declined, "declined install stays declined");
eq(K.updateDeclined("kokoro:install-cpu", [], ["kokoro:install-cpu"]), "", "Show options removes the id");
eq(K.updateDeclined("", ["kokoro:install-cpu"], []), "kokoro:install-cpu", "decline adds the id");
ok(K.recommend(np, {}).offers[0].reason.includes("uv also downloads Python 3.10"), "python3 is not 3.10: uv fetches it");
rec = K.recommend(K.parseProbe(NOTHING.replace("PY_VERSION=3.12", "PY_VERSION=3.10")), {});
ok(!rec.offers[0].reason.includes("uv also downloads"), "python3 3.10: no download note");
rec = K.recommend(K.parseProbe(NOTHING.replace("PKG_MGR=apt-get\n", "")), {});
eq(rec.offers[0].packageCommand, "", "unknown package manager: no command");

// curl missing: the probe cannot see a running server, and says so.
{
    const NO_CURL = NOTHING.replace("PROBE_END=1", "KOKORO_NO_CURL=1\nPROBE_END=1");
    const p0 = K.parseProbe(NO_CURL);
    ok(p0.kokoro.noCurl === true, "KOKORO_NO_CURL=1 is parsed");
    ok(np.kokoro.noCurl === false, "no KOKORO_NO_CURL line: curl is there");
    let r0 = K.recommend(p0, {});
    eq(r0.status, "missing", "no curl: still offers an install");
    eq(ids(r0), ["kokoro:install-cpu"], "no curl: install offered");
    eq(r0.offers[0].missing, ["curl"], "no curl: the install brings curl");
    ok(r0.warnings.length === 1 && r0.warnings[0].includes("curl is needed to detect a running Kokoro server"), "no curl: the page says curl is needed");
    ok(!r0.message.includes("was not found on this computer"), "no curl: does not claim nothing is on the computer");
    // With a Server URL set, the usual 'nothing answers' warning would be wrong.
    r0 = K.recommend(p0, { url: "http://localhost:8880/v1" });
    ok(r0.warnings.length === 1 && r0.warnings[0].includes("curl is needed"), "no curl, URL set: curl warning replaces 'nothing answers'");
}

// ---------------------------------------------------------------- NVIDIA 8 GB

const BIG = ["PROBE=1", "NV_GPU=NVIDIA GeForce RTX 3070, 8192, 8.6", "VK_GPU=DISCRETE_GPU|8589934592|NVIDIA GeForce RTX 3070",
    "HAVE=git", "HAVE=curl", "PKG_MGR=dnf", "PY_VERSION=3.12", "PROBE_END=1"].join("\n");
rec = K.recommend(K.parseProbe(BIG), {});
eq(ids(rec), ["kokoro:install-gpu", "kokoro:install-cpu"], "8 GB NVIDIA: GPU, CPU optional");
ok(!rec.offers[0].optional && rec.offers[1].optional, "the CPU build is the optional one");
eq(rec.offers[0].missing, [], "nothing missing");
ok(rec.offers[0].reason.includes("RTX 3070"), "reason names the GPU");
// Salem's MX230 with nothing running: CPU, GPU optional.
rec = K.recommend(K.parseProbe(SALEM.replace(/KOKORO_\w+=.*\n/g, "")), {});
eq(ids(rec), ["kokoro:install-cpu", "kokoro:install-gpu"], "2 GB NVIDIA: CPU, GPU optional");
ok(rec.offers[1].optional, "GPU is optional on a small card");
// Too old for CUDA (compute capability 3.5): CPU only.
rec = K.recommend(K.parseProbe(["PROBE=1", "NV_GPU=Tesla K40, 12288, 3.5", "HAVE=git", "HAVE=curl", "PROBE_END=1"].join("\n")), {});
eq(ids(rec), ["kokoro:install-cpu"], "Kepler: CPU only");

// ---------------------------------------------------------------- stopped unit

const STOPPED = ["PROBE=1", "HAVE=git", "HAVE=curl", "HAVE=uv",
    "KOKORO_UNIT=voicemode-kokoro.service|inactive|/home/pc/.voicemode/services/kokoro",
    "KOKORO_UNIT=kokoro@.service||", "PROBE_END=1"].join("\n");
const stp = K.parseProbe(STOPPED);
eq(stp.kokoro.units.length, 1, "template units are skipped");
rec = K.recommend(stp, {});
eq(rec.status, "stopped", "stopped unit: stopped");
eq(ids(rec), ["kokoro:start:voicemode-kokoro.service"], "stopped unit: Start it");
eq(rec.offers[0].unit, "voicemode-kokoro.service", "start offer carries the unit");
ok(rec.message.includes("voicemode-kokoro.service"), "message names the unit");

// ---------------------------------------------------------------- own install, stopped

const OWN = ["PROBE=1", "HAVE=git", "HAVE=curl", "HAVE=uv",
    "KOKORO_OWN_SRC=1", "KOKORO_OWN_VENV=1", "KOKORO_OWN_MODEL=1", "KOKORO_OWN_PORT=8881",
    "KOKORO_UNIT=other-kokoro.service|failed|/opt/k",
    "KOKORO_UNIT=plasmallm-kokoro.service|failed|/home/u/.local/share/plasmallm/kokoro-fastapi", "PROBE_END=1"].join("\n");
const op = K.parseProbe(OWN);
eq(op.kokoro.own, { src: true, venv: true, model: true, port: 8881 }, "own install parsed");
rec = K.recommend(op, {});
eq(ids(rec), ["kokoro:start:plasmallm-kokoro.service"], "own unit is started first");
ok(rec.message.includes("this page"), "message says it is this page's install");
// Own install answering: ownUrl filled for the after-setup auto-fill.
rec = K.recommend(K.parseProbe(OWN.replace("|failed|/home/u", "|active|/home/u")
    + "\nKOKORO_AT=port|http://127.0.0.1:8881/v1|54\nKOKORO_AT=own|http://127.0.0.1:8881/v1|54"), {});
eq(rec.ownUrl, "http://127.0.0.1:8881/v1", "ownUrl set when own install answers");
eq(ids(rec), ["kokoro:use:http://127.0.0.1:8881/v1"], "own install: one Use it (ports deduped)");
ok(rec.message.includes("plasmallm-kokoro.service"), "own install message names its unit");
// Own source but no unit: install again.
rec = K.recommend(K.parseProbe(["PROBE=1", "HAVE=git", "HAVE=curl", "KOKORO_OWN_SRC=1", "PROBE_END=1"].join("\n")), {});
eq(ids(rec), ["kokoro:install-cpu"], "own source without a service: install");
ok(rec.message.includes("not set up as a service"), "says the download is not a service yet");

// ---------------------------------------------------------------- containers, running unit elsewhere

rec = K.recommend(K.parseProbe(["PROBE=1", "KOKORO_CTR=docker|kokoro|ghcr.io/remsky/kokoro-fastapi-cpu:latest|running|0.0.0.0:8890->8880/tcp, [::]:8890->8880/tcp", "PROBE_END=1"].join("\n")), {});
eq(ids(rec), ["kokoro:use:http://127.0.0.1:8890/v1"], "running container: Use it with its published port");
rec = K.recommend(K.parseProbe(["PROBE=1", "KOKORO_CTR=podman|kk|kokoro-fastapi|exited|", "PROBE_END=1"].join("\n")), {});
eq(rec.status, "stopped", "stopped container: stopped");
ok(rec.message.includes("podman start kk"), "stopped container: how to start it");
eq(rec.offers.length, 0, "stopped container: no button");
rec = K.recommend(K.parseProbe(["PROBE=1", "KOKORO_UNIT=my-kokoro.service|active|/x", "PROBE_END=1"].join("\n")), {});
eq(rec.status, "found", "running unit on another port: found");
ok(rec.message.includes("Server URL"), "running unit elsewhere: asks for its address");
eq(rec.offers.length, 0, "running unit elsewhere: no install offer");

// ---------------------------------------------------------------- install scripts

for (const flavor of ["cpu", "gpu"]) {
    const s = K.buildInstallScript(flavor, K.parseProbe(NOTHING));
    ok(syntaxOk("bash", s, "install-" + flavor), flavor + " install script passes bash -n");
    ok(s.startsWith("#!/usr/bin/env bash\n# PlasmaLLM Kokoro setup: kokoro:install-" + flavor), flavor + ": header");
    ok(s.includes("kokoro-setup.status"), flavor + ": own status file");
    ok(s.includes("-e \".[" + flavor + "]\""), flavor + ": the ." + flavor + " extra");
    ok(s.includes("--host 127.0.0.1 --port $PORT"), flavor + ": binds localhost");
    ok(s.includes("Restart=always"), flavor + ": Restart=always");
    ok(s.includes("MemoryMax=4G") && !s.includes("MemoryLimit"), flavor + ": MemoryMax");
    ok(s.includes("UVICORN_LIMIT_MAX_REQUESTS=500"), flavor + ": request limit 500");
    ok(!s.includes("MAX_REQUESTS=25"), flavor + ": old limit gone");
    ok(s.includes("USE_GPU=" + (flavor === "gpu" ? "true" : "false")), flavor + ": USE_GPU");
    ok(!/voicemode/i.test(s), flavor + ": no voicemode");
    ok(s.includes("https://github.com/remsky/Kokoro-FastAPI"), flavor + ": clones kokoro-fastapi");
    ok(s.includes("download_model.py --output api/src/models/v1_0"), flavor + ": downloads the model");
    ok(s.includes("plasmallm-kokoro.service") && s.includes("systemctl --user enable"), flavor + ": user service");
    ok(s.includes("sudo apt install curl") && s.includes("if ask "), flavor + ": asks before installing curl");
    ok(s.includes("espeak-ng is optional"), flavor + ": offers espeak-ng");
    ok(s.includes("/.venv/bin/uvicorn\" api.src.main:app"), flavor + ": runs uvicorn from the venv");
    ok(s.includes("venv --python 3.10;") && s.includes("pip install --python .venv/bin/python -e"), flavor + ": Python 3.10 venv of its own");
}
const withUv = K.buildInstallScript("cpu", K.parseProbe(SALEM));
ok(syntaxOk("bash", withUv, "install-salem"), "Salem's install script passes bash -n");
ok(!withUv.includes("sudo apt install curl"), "nothing to install when git and curl exist");
ok(withUv.includes("astral.sh/uv/install.sh"), "uv installer kept as a fallback line");

// The unit file the script writes, run for real into a temp folder.
{
    const s = K.buildInstallScript("cpu", K.parseProbe(SALEM));
    const lines = s.split("\n");
    const from = lines.findIndex(l => l.startsWith("UNIT_DIR="));
    const to = lines.indexOf("EOF", lines.indexOf("cat > \"$UNIT\" <<EOF"));
    ok(from > 0 && to > from, "unit section found");
    const part = ["set -e", "SRC='/opt/kokoro src'", "step() { \"$@\"; }"].concat(lines.slice(from, to + 1)
        .map(l => l.startsWith("port_busy()") ? "port_busy() { false; }" : l)
        .filter(l => !l.startsWith("printf"))).join("\n");
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    execFileSync("bash", ["-c", part], { env: { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(home, ".config") } });
    const unit = fs.readFileSync(path.join(home, ".config/systemd/user/plasmallm-kokoro.service"), "utf8");
    const H = "%h/.local/share/plasmallm/kokoro-fastapi";
    ok(unit.includes("ExecStart=\"" + H + "/.venv/bin/uvicorn\" api.src.main:app --host 127.0.0.1 --port 8880"), "unit ExecStart: %h path, quoted, first free port");
    ok(unit.includes("WorkingDirectory=" + H + "\n"), "unit WorkingDirectory uses %h");
    ok(unit.includes("Environment=\"PYTHONPATH=" + H + ":" + H + "/api\""), "unit PYTHONPATH uses %h");
    ok(unit.includes("Environment=\"WEB_PLAYER_PATH=" + H + "/web\""), "unit WEB_PLAYER_PATH uses %h");
    ok(!unit.includes("/opt/kokoro") && !unit.includes(home), "no expanded home or source path in the unit");
    ok(unit.includes("Environment=\"UVICORN_LIMIT_MAX_REQUESTS=500\"\n"), "unit restarts the server after 500 requests");
    ok(!unit.includes("UVICORN_LIMIT_MAX_REQUESTS=25"), "the old limit of 25 is gone");
    ok(unit.includes("\nRestart=always\n"), "unit keeps Restart=always");
    ok(K.UVICORN_MAX_REQUESTS === 500, "limit constant");
    ok(unit.includes("[Install]\nWantedBy=default.target"), "unit install section");
}

// ---------------------------------------------------------------- launch and start

const launch = K.buildLaunchCommand("#!/usr/bin/env bash\necho hi\n", "1-2");
ok(launch.startsWith(": plasmallm-kokoro-setup-1-2; "), "launch marker");
ok(launch.includes("plasmallm-kokoro-setup.XXXXXX"), "launch temp file name");
ok(syntaxOk("bash", launch, "launch"), "launch passes bash -n");
ok(W.buildLaunchCommand("x", "1").startsWith(": plasmallm-whisper-setup-1; "), "Whisper launch unchanged");

const start = K.buildStartCommand("voicemode-kokoro.service", "3-4");
ok(start.startsWith(": plasmallm-kokoro-start-3-4; systemctl --user start -- 'voicemode-kokoro.service'"), "start command");
ok(syntaxOk("sh", start, "start"), "start passes sh -n");
ok(K.buildStartCommand("a';b", 1).includes("-- 'a'\\'';b' ||"), "unit name quoted");

// ---------------------------------------------------------------- "not running" message next to the voice list

{
    const URL8880 = "http://127.0.0.1:8880/v1";
    const state = (probe, over) => {
        const url = (over && over.url !== undefined) ? over.url : URL8880;
        const probedUrl = (over && over.probedUrl !== undefined) ? over.probedUrl : URL8880;
        const rec = probe ? K.recommend(probe, { url: probedUrl, declined: (over && over.declined) || "" }) : null;
        return Object.assign({ url, probe, rec, probedUrl, busy: false, voiceCount: 0, voicesFailed: false }, over || {});
    };
    // Voicemode's unit stopped, nothing answering: message, with Start for that unit.
    let st = state(stp);
    eq(K.notAnswering(st), true, "stopped unit, no voices: nothing answers");
    eq(K.notRunningOffers(st.rec).map(o => [o.kind, o.unit]), [["start", "voicemode-kokoro.service"]], "offer is Start for the stopped unit");
    // A declined Start is still offered next to the message
    st = state(stp, { declined: "kokoro:start:voicemode-kokoro.service" });
    eq(K.notRunningOffers(st.rec).map(o => o.kind), ["start"], "declined Start still offered here");
    eq(K.notAnswering(st), true, "declining the setup offer does not hide the message");
    // The own unit is preferred
    eq(K.notRunningOffers(K.recommend(op, { url: URL8880 })).map(o => o.unit), ["plasmallm-kokoro.service"], "own unit started first");
    // Nothing known: the install offers, not Start
    st = state(np);
    eq(K.notAnswering(st), true, "nothing installed: nothing answers");
    eq(K.notRunningOffers(st.rec).map(o => o.kind), ["install"], "no unit known: install offer instead of Start");
    st = state(np, { declined: "kokoro:install-cpu" });
    eq(K.notRunningOffers(st.rec), [], "declined install offers are not shown");
    // Running somewhere else: Use it
    const ELSEWHERE = STOPPED.replace("PROBE_END=1", "KOKORO_AT=port|http://127.0.0.1:8881/v1|54\nPROBE_END=1");
    st = state(K.parseProbe(ELSEWHERE));
    eq(K.notAnswering(st), true, "running at another address: nothing answers at this one");
    eq(K.notRunningOffers(st.rec).map(o => [o.kind, o.url]), [["use", "http://127.0.0.1:8881/v1"]], "Use it for the other address");
    // Answering: no message
    st = state(K.parseProbe(STOPPED.replace("PROBE_END=1", "KOKORO_AT=cfg|" + URL8880 + "|54\nPROBE_END=1")));
    eq(K.notAnswering(st), false, "Kokoro answers at the Server URL: no message");
    // Not while something is still going on, or when voices came back
    eq(K.notAnswering(Object.assign(state(stp), { busy: true })), false, "no message while a check or start is running");
    eq(K.notAnswering(Object.assign(state(stp), { voiceCount: 54 })), false, "no message when voices were loaded");
    eq(K.notAnswering(state(stp, { url: "" })), false, "no message without a Server URL");
    eq(K.notAnswering(state(stp, { url: "http://127.0.0.1:9999/v1" })), false, "no message while the URL differs from the checked one");
    eq(K.notAnswering(state(stp, { url: " " + URL8880 + " " })), true, "spaces around the URL do not matter");
    // No curl: the check cannot see a running server, so only a failed voice load counts
    const NOCURL = STOPPED.replace("PROBE_END=1", "KOKORO_NO_CURL=1\nPROBE_END=1");
    eq(K.notAnswering(state(K.parseProbe(NOCURL))), false, "no curl, voices not tried: no message");
    eq(K.notAnswering(state(K.parseProbe(NOCURL), { voicesFailed: true })), true, "no curl, voice load failed: message");
    // No check yet
    eq(K.notAnswering(state(null)), false, "no check and no failure: no message");
    eq(K.notAnswering(state(null, { voicesFailed: true })), true, "voice load failed before any check finished: message");
    eq(K.notRunningOffers(null), [], "no check: no offers");
}

// ---------------------------------------------------------------- a server that is still loading

{
    const URL8880 = "http://127.0.0.1:8880/v1";
    const SLOW_CFG = STOPPED.replace("PROBE_END=1", "KOKORO_SLOW=cfg|" + URL8880 + "\nPROBE_END=1");
    const sp = K.parseProbe(SLOW_CFG);
    eq(sp.kokoro.slow, [{ source: "cfg", url: URL8880 }], "KOKORO_SLOW line is parsed");
    eq(K.parseProbe(STOPPED).kokoro.slow, [], "no slow lines: none");
    eq(K.parseProbe("KOKORO_SLOW=cfg\nPROBE_END=1").kokoro.slow, [], "a slow line without a URL is ignored");

    // Accepted but not answered: starting, with no offers (a stopped unit is listed too, as with socket activation).
    let rec = K.recommend(sp, { url: URL8880 });
    eq(rec.status, "starting", "slow at the Server URL: starting");
    eq(rec.message, "Kokoro is starting at " + URL8880 + "…", "message names the URL");
    eq(rec.offers, [], "no Start or Install offers while it is starting");
    eq(rec.warnings, [], "no \"nothing answers\" warning while it is starting");
    rec = K.recommend(sp, { url: " " + URL8880 + "/ " });
    eq(rec.status, "starting", "URL with spaces and a trailing slash still matches");
    rec = K.recommend(sp, { url: "http://localhost:8880/v1" });
    eq(rec.status, "starting", "localhost is the same server as 127.0.0.1");
    // Slow at the usual port while the Server URL is blank or points elsewhere
    const SLOW_PORT = STOPPED.replace("PROBE_END=1", "KOKORO_SLOW=port|" + URL8880 + "\nPROBE_END=1");
    rec = K.recommend(K.parseProbe(SLOW_PORT), { url: "" });
    eq([rec.status, rec.offers.length], ["starting", 0], "slow at a usual address, blank URL: starting, no offers");
    eq(rec.message, "Kokoro is starting at " + URL8880 + "…", "message names that address");
    rec = K.recommend(K.parseProbe(SLOW_PORT), { url: "http://127.0.0.1:9999/v1" });
    eq(rec.status, "starting", "slow at a usual address, Server URL elsewhere: starting");
    // Answering at the same time elsewhere wins over a slow one
    const BOTH = STOPPED.replace("PROBE_END=1", "KOKORO_SLOW=port|" + URL8880 + "\nKOKORO_AT=port|http://127.0.0.1:8881/v1|54\nPROBE_END=1");
    rec = K.recommend(K.parseProbe(BOTH), { url: "" });
    eq(rec.status, "found", "a server that answers elsewhere is offered as before");
    // Answering at the Server URL wins over everything
    const RUN = STOPPED.replace("PROBE_END=1", "KOKORO_AT=cfg|" + URL8880 + "|54\nKOKORO_SLOW=port|" + URL8880 + "\nPROBE_END=1");
    eq(K.recommend(K.parseProbe(RUN), { url: URL8880 }).status, "running", "answering at the Server URL: running");
    // Refused (nothing printed): the old behaviour
    rec = K.recommend(K.parseProbe(STOPPED), { url: URL8880 });
    eq([rec.status, ids(rec)], ["stopped", ["kokoro:start:voicemode-kokoro.service"]], "refused connection with a stopped unit: Start it, as before");
    rec = K.recommend(K.parseProbe("PROBE=1\nHAVE=git\nHAVE=curl\nPROBE_END=1"), { url: URL8880 });
    eq(rec.status, "missing", "refused connection and nothing installed: missing, Install offered");
    ok(rec.offers.some(o => o.kind === "install"), "install offered");
    // Gave up waiting: slow lines are ignored, it counts as not running
    rec = K.recommend(sp, { url: URL8880, gaveUp: true });
    eq([rec.status, ids(rec)], ["stopped", ["kokoro:start:voicemode-kokoro.service"]], "gave up: not running, Start offered for the stopped unit");
    ok(rec.warnings.some(w => w.includes("Nothing answers")), "gave up: the nothing-answers warning is back");
    rec = K.recommend(K.parseProbe(SLOW_CFG.replace(/KOKORO_UNIT=voicemode[^\n]*\n/, "")), { url: URL8880, gaveUp: true });
    eq(rec.status, "missing", "gave up with no unit: missing");

    // The "isn't running" message must not show while it is starting, and does after giving up
    const st = (probe, over) => {
        const rec2 = K.recommend(probe, Object.assign({ url: URL8880 }, over && over.recOpts));
        return Object.assign({ url: URL8880, probe, rec: rec2, probedUrl: URL8880, busy: false, voiceCount: 0, voicesFailed: false }, over || {});
    };
    eq(K.notAnswering(st(sp)), false, "starting: not \"isn't running\"");
    eq(K.notAnswering(st(sp, { voicesFailed: true })), false, "starting, voice load timed out: still not \"isn't running\"");
    eq(K.notAnswering(st(sp, { recOpts: { gaveUp: true } })), true, "gave up: \"isn't running\"");
    eq(K.notRunningOffers(st(sp, { recOpts: { gaveUp: true } }).rec).map(o => o.kind), ["start"], "gave up: Start offered next to the voice box");

    // Timing: the first sighting starts the clock, a check every few seconds, give up after the limit
    eq(K.STARTING_LIMIT_MS, 60000, "limit is 60 s");
    ok(K.STARTING_RECHECK_MS >= 2000 && K.STARTING_RECHECK_MS <= 5000, "re-check every few seconds");
    eq(K.startingStep("running", 0, 1000), { action: "none", since: 0 }, "running: nothing to do");
    eq(K.startingStep("stopped", 5000, 9000), { action: "none", since: 0 }, "stopped: nothing to do, clock reset");
    eq(K.startingStep("starting", 0, 1000), { action: "recheck", since: 1000 }, "first sighting: clock starts, check again");
    eq(K.startingStep("starting", 1000, 20000), { action: "recheck", since: 1000 }, "after 19 s: keep waiting");
    eq(K.startingStep("starting", 1000, 60999), { action: "recheck", since: 1000 }, "just under 60 s: keep waiting");
    eq(K.startingStep("starting", 1000, 61000), { action: "giveup", since: 1000 }, "at 60 s: give up");
    eq(K.startingStep("starting", 1000, 500000), { action: "giveup", since: 1000 }, "long after: give up");
    // Walk a whole cold start: starting for ~20 s, then it answers
    let since = 0;
    let t = 100000;
    let steps = 0;
    for (; ; t += K.STARTING_RECHECK_MS + 6000) {
        const status = (t - 100000) < 20000 ? "starting" : "running";
        const s = K.startingStep(status, since, t);
        since = s.since;
        steps++;
        if (s.action !== "recheck")
            break;
    }
    ok(steps >= 2 && since === 0, "a 20 s start: rechecked until it answered, then the clock reset (steps " + steps + ")");
    // And one that never answers
    since = 0;
    let last = "";
    for (t = 100000; t < 400000; t += K.STARTING_RECHECK_MS + 6000) {
        const s = K.startingStep("starting", since, t);
        since = s.since;
        last = s.action;
        if (last === "giveup")
            break;
    }
    eq(last, "giveup", "never answers: gives up");
    ok(t - 100000 >= 60000 && t - 100000 < 60000 + K.STARTING_RECHECK_MS + 6000, "and does so about 60 s in (" + (t - 100000) + " ms)");
}

// ---------------------------------------------------------------- unit lookup and notification throttle

{
    const lookup = K.buildUnitLookupCommand("12-3");
    ok(lookup.startsWith(": plasmallm-kokoro-units-12-3; "), "lookup marker first");
    ok(lookup.includes("systemctl --user list-units") && lookup.includes("KOKORO_UNIT="), "lookup lists the units");
    ok(!/start|stop|enable|restart|kill/.test(lookup.replace(/--no-legend|list-unit-files|ActiveState/g, "")), "lookup only reads");
    ok(syntaxOk("sh", lookup, "lookup-sh") && syntaxOk("bash", lookup, "lookup-bash"), "lookup passes sh -n and bash -n");
    eq(K.pickStartUnit("KOKORO_UNIT=voicemode-kokoro.service|inactive|/x\n"), "voicemode-kokoro.service", "a stopped unit is picked");
    eq(K.pickStartUnit("KOKORO_UNIT=voicemode-kokoro.service|active|/x\n"), "", "a running unit is not");
    eq(K.pickStartUnit("KOKORO_UNIT=a-kokoro.service|inactive|\nKOKORO_UNIT=plasmallm-kokoro.service|failed|/y\n"), "plasmallm-kokoro.service", "this plasmoid's own unit first");
    eq(K.pickStartUnit("KOKORO_UNIT=kokoro@.service||\n"), "", "template units are not picked");
    eq(K.pickStartUnit(""), "", "no output: no unit");
    eq(K.pickStartUnit(undefined), "", "undefined: no unit");

    eq(K.notifyAllowed(0, 1000), true, "first failure: notify");
    eq(K.notifyAllowed(1000, 30000), false, "29 s later: no second notification");
    eq(K.notifyAllowed(1000, 60999), false, "just under 60 s: no");
    eq(K.notifyAllowed(1000, 61000), true, "60 s later: notify again");
    eq(K.notifyAllowed(5000, 1000), true, "clock went back: notify");
    eq(K.notifyAllowed(1000, 3000, 1500), true, "custom window");
    eq(K.notifyAllowed(undefined, 3000), true, "never notified");
    // A burst: ten failures a few seconds apart, then one a minute after the first
    let lastAt = 0;
    let sent = 0;
    for (let i = 0; i < 10; i++) {
        const now = 1000000 + i * 3000;
        if (K.notifyAllowed(lastAt, now)) { lastAt = now; sent++; }
    }
    eq(sent, 1, "a burst of ten failures sends one notification");
    ok(K.notifyAllowed(lastAt, 1000000 + 60000), "and the next burst a minute later sends another");
}

// ---------------------------------------------------------------- one Start button

{
    const start = { kind: "start", id: "kokoro:start:voicemode-kokoro.service", unit: "voicemode-kokoro.service" };
    const install = { kind: "install", id: "kokoro:install-cpu" };
    const use = { kind: "use", id: "kokoro:use:http://127.0.0.1:8881/v1" };
    eq(K.startShownByVoiceBox(start, true, [start]), true, "both blocks would show Start: the Setup one is left out");
    eq(K.startShownByVoiceBox(start, false, [start]), false, "voice-box block not showing: Setup keeps its Start");
    eq(K.startShownByVoiceBox(start, true, []), false, "voice box shows no Start: Setup keeps its");
    eq(K.startShownByVoiceBox(start, true, [{ kind: "start", id: "kokoro:start:other.service" }]), false, "a different unit's Start is not the same button");
    eq(K.startShownByVoiceBox(install, true, [install]), false, "Install is not touched");
    eq(K.startShownByVoiceBox(use, true, [use]), false, "Use it is not touched");
    eq(K.startShownByVoiceBox(null, true, [start]), false, "no offer");
    // With the real recommendation for a stopped unit
    const rec = K.recommend(K.parseProbe(STOPPED), { url: "http://127.0.0.1:8880/v1" });
    const box = K.notRunningOffers(rec);
    eq(rec.offers.filter(o => !K.startShownByVoiceBox(o, true, box)).length, 0, "stopped unit: Start is left out of Setup, shown once");
    eq(rec.offers.filter(o => !K.startShownByVoiceBox(o, false, box)).length, 1, "when the voice-box block is not showing, Setup shows it");
}

// ---------------------------------------------------------------- recheck while starting

{
    const url = "http://127.0.0.1:8880/v1";
    const slow = [{ source: "cfg", url }];
    const re = K.buildRecheckCommand(slow, "1760000000000-9");
    ok(re.startsWith(": plasmallm-kokoro-recheck-1760000000000-9; "), "recheck command carries its own marker (the page tells it from a full probe)");
    ok(/kk 'cfg' 'http:\/\/127\.0\.0\.1:8880\/v1'$/.test(re), "recheck asks the slow address, with its source label, quoted");
    for (const heavy of ["nvidia-smi", "vulkaninfo", "docker", "podman", "systemctl", "python3", "/sys/class/drm", "PROBE=", "HAVE=", "KOKORO_UNIT", "command -v git"])
        ok(!re.includes(heavy), "recheck does not run the full probe's " + heavy);
    ok(re.length < K.buildProbeCommand(url, 1).length / 4, "recheck is a fraction of the full probe");
    ok(syntaxOk("sh", re, "recheck-sh") && syntaxOk("bash", re, "recheck-bash"), "recheck passes sh -n and bash -n");
    eq(K.buildRecheckCommand([], 1), "", "nothing slow: no command");
    eq(K.buildRecheckCommand(null, 1), "", "no list: no command");
    // One address twice (localhost and 127.0.0.1 are the same server) is asked once
    const twice = K.buildRecheckCommand([{ source: "cfg", url: "http://localhost:8880/v1" }, { source: "port", url }], 1);
    eq(twice.split("\n").join(" ").match(/ kk '/g).length, 1, "the same server is asked once");
    ok(twice.includes("kk 'cfg' 'http://localhost:8880/v1'"), "and keeps the first one's label");
    // Two different servers: both
    const two = K.buildRecheckCommand([{ source: "cfg", url: "http://127.0.0.1:9999/v1" }, { source: "port", url }], 1);
    ok(two.includes("kk 'cfg' 'http://127.0.0.1:9999/v1'") && two.includes("kk 'port' '" + url + "'"), "different servers are both asked");
    const evil = K.buildRecheckCommand([{ source: "cfg", url: "http://x/';touch /tmp/kokoro-pwned;'" }], 1);
    ok(evil.includes("'http://x/'\\''") && syntaxOk("sh", evil, "recheck-evil"), "a quote in the URL is shell-escaped");
    ok(K.buildRecheckCommand(slow, "a b;c").startsWith(": plasmallm-kokoro-recheck-abc; "), "the marker is made safe");

    // mergeRecheck: whatever was slow is replaced; everything else is kept
    const full = ["PROBE=1", "HAVE=git", "HAVE=curl", "NV_GPU=NVIDIA RTX 3090|24576|8.6",
        "KOKORO_UNIT=voicemode-kokoro.service|inactive|/x", "KOKORO_SLOW=cfg|" + url, "PROBE_END=1"].join("\n");
    const base = K.parseProbe(full);
    const before = JSON.stringify(base);
    eq(K.recommend(base, { url }).status, "starting", "base: starting");
    let merged = K.mergeRecheck(base, "KOKORO_SLOW=cfg|" + url + "\n");
    eq(K.recommend(merged, { url }).status, "starting", "still slow: still starting");
    eq(merged.kokoro.units, base.kokoro.units, "units kept");
    eq(merged.nvidia, base.nvidia, "GPUs kept");
    eq(merged.have, base.have, "tools kept");
    merged = K.mergeRecheck(base, "KOKORO_AT=cfg|" + url + "|67\n");
    eq(K.recommend(merged, { url }).status, "running", "answers now: running");
    eq(merged.kokoro.slow, [], "answers now: no longer slow");
    eq(merged.kokoro.at.map(a => a.source + "|" + a.voices), ["cfg|67"], "answers now: the answer is recorded");
    merged = K.mergeRecheck(base, "");
    eq(merged.kokoro.slow, [], "gone (refused): no longer slow");
    eq(K.recommend(merged, { url }).status, "stopped", "gone: not starting any more; the unit seen at the first probe is offered");
    eq(JSON.stringify(base), before, "the probe passed in is not changed");
    // An answer found by the full probe elsewhere is kept next to the new one
    const withOther = K.parseProbe(full + "\nKOKORO_AT=port|http://127.0.0.1:8881/v1|3");
    eq(K.mergeRecheck(withOther, "KOKORO_AT=cfg|" + url + "|5").kokoro.at.map(a => a.source), ["port", "cfg"], "earlier answers are kept");
    // No earlier probe: still works
    eq(K.recommend(K.mergeRecheck(null, "KOKORO_AT=cfg|" + url + "|5"), { url }).status, "running", "no earlier probe: still merges");
    eq(K.recommend(K.mergeRecheck(null, ""), { url }).status !== "starting", true, "no earlier probe, nothing found");
}

// ---------------------------------------------------------------- own install = Server URL

{
    const guard = (u) => /\[ -n "\$op" \] && \[ "\$op" != '(\d+)' \] && kk own /.exec(K.buildProbeCommand(u, 1));
    eq(guard("http://127.0.0.1:8880/v1")[1], "8880", "Server URL on 127.0.0.1: the own install is skipped when it has that port");
    eq(guard("localhost:8880/v1")[1], "8880", "localhost, no scheme: same");
    eq(guard("http://[::1]:9000/v1/")[1], "9000", "[::1] and a trailing slash: same");
    for (const u of ["", "https://127.0.0.1:8880/v1", "http://192.168.1.5:8880/v1", "http://127.0.0.1/v1", "http://example.com:8880/v1", "http://127.0.0.1:8880/other"]) {
        const c = K.buildProbeCommand(u, 1);
        ok(c.includes("[ -n \"$op\" ] && kk own \"http://127.0.0.1:$op/v1\"") && !/\$op" != /.test(c), "no skip for " + JSON.stringify(u));
    }
    ok(syntaxOk("sh", K.buildProbeCommand("http://127.0.0.1:8880/v1", 1), "probe-own-sh")
        && syntaxOk("bash", K.buildProbeCommand("http://127.0.0.1:8880/v1", 1), "probe-own-bash"), "probe with the skip passes sh -n and bash -n");
    eq(K.localV1Port("http://localhost:08880/v1"), "8880", "leading zeros are dropped");
    eq(K.localV1Port("http://example.com:8880/v1"), "", "other hosts have no local port");
}

// ---------------------------------------------------------------- spacing nit

ok(!/=k\./.test(fs.readFileSync(path.join(__dirname, "../package/contents/ui/ttsAdapters/kokoroSetup.js"), "utf8")), "no 'var x =k.…' in kokoroSetup.js");

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) {
    console.error(failed + " failure(s)");
    process.exit(1);
}
console.log("kokoro_setup: all checks passed");
