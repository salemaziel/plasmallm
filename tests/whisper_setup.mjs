#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local Whisper setup: probe parsing, recommendations, install scripts, and
// the whisper-ctranslate2 command line.
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
const S = loadModule("../package/contents/ui/sttAdapters/whisperSetup.js", { i18n, WhisperCpp: Cpp, WhisperCli: Cli });

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-setup-test-"));
function bashSyntaxOk(script, name) {
    const f = path.join(tmp, name + ".sh");
    fs.writeFileSync(f, script);
    try {
        execFileSync("bash", ["-n", f], { stdio: "pipe" });
        return true;
    } catch (e) {
        console.error(String(e.stderr || e));
        return false;
    }
}
const ids = (offers) => offers.map((o) => o.id);

const H = "/home/u";
const TOOLS_ALL = ["cmake", "c++", "g++", "make", "git", "glslc", "pipx", "python3", "vulkan-headers"]
    .map((t) => "HAVE=" + t).join("\n");

// ---- canned probe outputs

// Owner's machine: MX230 2 GB beside Intel UHD, Vulkan tools, no nvcc,
// voicemode's CPU-only whisper.cpp, pipx openai-whisper with CUDA PyTorch.
const OWNER = `PROBE=1
NV_GPU=NVIDIA GeForce MX230, 2048
VK_GPU=INTEGRATED_GPU|25013019648|Intel(R) UHD Graphics (CML GT2)
VK_GPU=DISCRETE_GPU|2147483648|NVIDIA GeForce MX230
VK_GPU=CPU|33350692864|llvmpipe (LLVM 20.1.8, 256 bits)
DRM_GPU=0x8086|0|1
DRM_GPU=0x10de|0|
${TOOLS_ALL}
PKG_MGR=apt-get
HOME_DIR=${H}
CPP_BIN=${H}/.voicemode/services/whisper/build/bin/whisper-cli
CLI_BIN=${H}/.local/bin/whisper
CLI_PIPX=1
CPP_MODEL_BYTES=147951465
WHISPER_PY=1
TORCH_VERSION=2.10.0+cu128
TORCH_CUDA=12.8
TORCH_CUDA_AVAILABLE=1
PROBE_END=1
`;

const NO_GPU = `PROBE=1
VK_GPU=CPU|8000000000|llvmpipe (LLVM 20.1.8, 256 bits)
${TOOLS_ALL}
PKG_MGR=dnf
HOME_DIR=${H}
CPP_BIN=/usr/local/bin/whisper-cli
CPP_GPU=vulkan
CLI_BIN=${H}/.local/bin/whisper
CLI_PIPX=1
WHISPER_PY=1
TORCH_VERSION=2.10.0+cu128
TORCH_CUDA=12.8
TORCH_CUDA_AVAILABLE=0
PROBE_END=1
`;

const NVIDIA_8GB = `PROBE=1
NV_GPU=NVIDIA GeForce RTX 3070, 8192
VK_GPU=DISCRETE_GPU|8589934592|NVIDIA GeForce RTX 3070
${TOOLS_ALL}
HAVE=nvcc
PKG_MGR=pacman
HOME_DIR=${H}
CPP_BIN=${H}/.voicemode/services/whisper/build/bin/whisper-cli
CLI_BIN=${H}/.local/bin/whisper
CLI_PIPX=1
WHISPER_PY=1
TORCH_VERSION=2.10.0+cpu
TORCH_CUDA=
TORCH_CUDA_AVAILABLE=0
PROBE_END=1
`;

const INTEL_ONLY = `PROBE=1
VK_GPU=INTEGRATED_GPU|16000000000|Intel(R) Iris(R) Xe Graphics
VK_GPU=CPU|16000000000|llvmpipe (LLVM 19, 256 bits)
${TOOLS_ALL}
PKG_MGR=zypper
HOME_DIR=${H}
CPP_BIN=${H}/.local/bin/whisper-cli
PROBE_END=1
`;

const AMD_8GB = `PROBE=1
VK_GPU=DISCRETE_GPU|8573157376|AMD Radeon RX 6600 (RADV NAVI23)
HAVE=cmake
HAVE=g++
HAVE=make
HAVE=git
HAVE=pipx
PKG_MGR=apt-get
HOME_DIR=${H}
CPP_BIN=${H}/.local/bin/whisper-cli
CLI_BIN=${H}/.local/bin/whisper
CLI_PIPX=1
WHISPER_PY=1
TORCH_VERSION=2.10.0+cu128
TORCH_CUDA=12.8
TORCH_CUDA_AVAILABLE=0
PROBE_END=1
`;

const NOTHING = `PROBE=1
HOME_DIR=${H}
PROBE_END=1
`;

// ---- parseProbe

const owner = S.parseProbe(OWNER);
ok(owner.complete, "probe end marker seen");
eq(owner.nvidia, [{ name: "NVIDIA GeForce MX230", memMiB: 2048, computeCap: 0, capMissing: false }], "nvidia-smi line parsed");
eq(owner.vulkan.length, 3, "three vulkan devices parsed");
eq(owner.vulkan[1], { type: "DISCRETE_GPU", memMiB: 2048, name: "NVIDIA GeForce MX230" }, "vulkan heap bytes become MiB");
eq(owner.pkgMgr, "apt", "apt-get reported as apt");
ok(owner.have.glslc && owner.have["vulkan-headers"] && !owner.have.nvcc, "tool flags");
eq(owner.cpp.gpu, [], "voicemode build has no GPU libraries");
eq(owner.cli.torchCuda, "12.8", "torch CUDA version");
ok(owner.cli.torchCudaAvailable, "torch sees the GPU");
ok(!S.parseProbe("PROBE=1\n").complete, "truncated output is not complete");

eq(S.gpuList(owner).map((g) => g.vendor + ":" + g.integrated), ["nvidia:false", "intel:true"],
    "llvmpipe dropped, NVIDIA not listed twice");
// /sys/class/drm is used only when vulkaninfo printed nothing
const drmOnly = S.parseProbe("DRM_GPU=0x1002|8589934592|1\nDRM_GPU=0x8086|0|0\n");
eq(S.gpuList(drmOnly).map((g) => g.vendor + ":" + g.memMiB + ":" + g.integrated),
    ["amd:8192:false", "intel:0:true"], "DRM fallback");
ok(S.SMALL_GPU_MIB === 4096, "4 GB threshold is the named constant");

// ---- recommend: owner's machine

let r = S.recommend(owner, { cliBinary: "whisper", cliDevice: "", cliModel: "large-v3-turbo" });
eq(r.whisper_cpp.status, "ok", "owner: CPU-only whisper.cpp is the right build (2 GB GPU)");
eq(r.whisper_cpp.ideal, "cpu", "owner: whisper.cpp ideal is CPU");
ok(/CPU-only build/.test(r.whisper_cpp.message) && r.whisper_cpp.message.indexOf("~/.voicemode/") >= 0,
    "owner: message names the CPU-only build with ~ path");
eq(ids(r.whisper_cpp.offers), ["whisper_cpp:vulkan"], "owner: Vulkan build only as an option");
ok(r.whisper_cpp.offers[0].optional && /2 GB/.test(r.whisper_cpp.offers[0].reason), "owner: Vulkan offer is optional with a reason");
eq(r.whisper_cpp.offers[0].label, "Build whisper.cpp (Vulkan)", "owner: voicemode's copy is not 'rebuilt'");
eq(r.whisper_cpp.offers[0].packages, [], "owner: Vulkan tools already there");
eq(r.whisper_cli.status, "ok", "owner: Python Whisper with CUDA PyTorch is OK");
ok(r.whisper_cli.warnings.some((w) => /Device “Default” will use NVIDIA GeForce MX230/.test(w) && /cpu/.test(w)),
    "owner: warns that Default uses the 2 GB GPU");
ok(r.whisper_cli.warnings.some((w) => /large-v3-turbo model needs about 6 GB/.test(w)),
    "owner: warns large-v3-turbo does not fit in 2 GB");
eq(ids(r.whisper_cli.offers), ["whisper_cli:ct2-cpu", "whisper_cli:ct2-cuda"], "owner: faster-whisper CPU recommended, CUDA optional");
ok(!r.whisper_cli.offers[0].optional && r.whisper_cli.offers[1].optional, "owner: ct2 CPU is the main offer");
// Device cpu silences both GPU warnings
r = S.recommend(owner, { cliBinary: "whisper", cliDevice: "cpu", cliModel: "large-v3-turbo" });
eq(r.whisper_cli.warnings, [], "owner: no GPU warnings with Device cpu");

// ---- no GPU

r = S.recommend(S.parseProbe(NO_GPU), { cliBinary: "whisper", cliModel: "base" });
eq(r.gpus, [], "no GPU: software renderer ignored");
eq(r.whisper_cpp.status, "gpu_no_gpu", "no GPU: Vulkan build flagged");
eq(ids(r.whisper_cpp.offers), ["whisper_cpp:cpu"], "no GPU: CPU build offered");
eq(r.whisper_cli.status, "gpu_no_gpu", "no GPU: CUDA PyTorch flagged");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:openai-cpu") >= 0, "no GPU: CPU PyTorch suggested");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:ct2-cpu") >= 0, "no GPU: faster-whisper CPU offered");
ok(ids(r.whisper_cli.offers).every((id) => !/cuda/.test(id)), "no GPU: no CUDA offers");

// ---- 8 GB NVIDIA with nvcc

r = S.recommend(S.parseProbe(NVIDIA_8GB), { cliBinary: "whisper", cliModel: "medium" });
eq(r.whisper_cpp.ideal, "cuda", "8 GB NVIDIA + nvcc: CUDA build");
eq(r.whisper_cpp.status, "cpu_on_gpu", "8 GB NVIDIA: CPU build flagged");
eq(ids(r.whisper_cpp.offers), ["whisper_cpp:cuda"], "8 GB NVIDIA: CUDA build offered");
eq(r.whisper_cli.status, "cpu_on_gpu", "8 GB NVIDIA: CPU PyTorch flagged");
eq(ids(r.whisper_cli.offers), ["whisper_cli:openai-cuda", "whisper_cli:ct2-cuda"], "8 GB NVIDIA: CUDA PyTorch and ct2 CUDA");
// the same GPU without nvcc gets Vulkan and a note about the toolkit
const noNvcc = S.parseProbe(NVIDIA_8GB.replace("HAVE=nvcc\n", ""));
r = S.recommend(noNvcc, {});
eq(r.whisper_cpp.ideal, "vulkan", "8 GB NVIDIA without nvcc: Vulkan");
ok(/CUDA toolkit/.test(r.whisper_cpp.message), "without nvcc: mentions the CUDA toolkit");

// ---- Intel integrated only

r = S.recommend(S.parseProbe(INTEL_ONLY), {});
eq(r.whisper_cpp.ideal, "cpu", "Intel integrated: CPU build");
eq(r.whisper_cpp.status, "ok", "Intel integrated: existing CPU build is right");
eq(ids(r.whisper_cpp.offers), ["whisper_cpp:vulkan"], "Intel integrated: Vulkan optional");
ok(r.whisper_cpp.offers[0].optional && /built-in/.test(r.whisper_cpp.offers[0].reason), "Intel: reason says built-in");
eq(r.whisper_cli.status, "missing", "Intel: no Python Whisper");
eq(ids(r.whisper_cli.offers), ["whisper_cli:ct2-cpu", "whisper_cli:openai-cpu"], "Intel: ct2 CPU first, openai CPU secondary");
ok(r.whisper_cli.offers[1].optional, "openai-whisper is the secondary option");

// ---- 8 GB AMD discrete

const amd = S.parseProbe(AMD_8GB);
r = S.recommend(amd, { cliBinary: "whisper" });
eq(r.whisper_cpp.ideal, "vulkan", "8 GB AMD: Vulkan build");
eq(r.whisper_cpp.status, "cpu_on_gpu", "8 GB AMD: CPU build flagged");
eq(r.whisper_cpp.offers[0].packages, ["libvulkan-dev", "glslc"], "8 GB AMD: missing Vulkan packages listed (apt)");
eq(r.whisper_cpp.offers[0].packageCommand, "sudo apt install libvulkan-dev glslc", "8 GB AMD: exact apt command");
eq(r.whisper_cli.status, "gpu_no_gpu", "8 GB AMD: CUDA PyTorch cannot use it");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:openai-cpu") >= 0, "8 GB AMD: CPU PyTorch suggested");

// ---- nothing installed, each package manager

const nothing = S.parseProbe(NOTHING);
r = S.recommend(nothing, {});
eq(r.whisper_cpp.status, "missing", "nothing: whisper.cpp missing");
eq(ids(r.whisper_cpp.offers), ["whisper_cpp:cpu"], "nothing: CPU build offered");
eq(r.whisper_cli.status, "missing", "nothing: Python Whisper missing");
eq(ids(r.whisper_cli.offers), ["whisper_cli:ct2-cpu", "whisper_cli:openai-cpu"], "nothing: ct2 then openai");
eq(r.whisper_cpp.offers[0].missing, ["compiler", "make", "cmake", "git"], "nothing: build tools missing");
eq(r.whisper_cpp.offers[0].packageCommand, "", "nothing, unknown package manager: no command");

const expectPk = {
    "apt-get": ["sudo apt install build-essential cmake git libvulkan-dev glslc", "sudo apt install pipx"],
    dnf: ["sudo dnf install gcc-c++ make cmake git vulkan-headers vulkan-loader-devel glslc", "sudo dnf install pipx"],
    pacman: ["sudo pacman -S --needed base-devel cmake git vulkan-headers vulkan-icd-loader shaderc", "sudo pacman -S --needed python-pipx"],
    zypper: ["sudo zypper install gcc-c++ make cmake git vulkan-devel shaderc", "sudo zypper install python3-pipx"]
};
for (const pm of Object.keys(expectPk)) {
    const p = S.parseProbe(NOTHING + "PKG_MGR=" + pm + "\n");
    eq(S.missingPackages(p, "whisper_cpp", "vulkan").command, expectPk[pm][0], pm + ": Vulkan build packages");
    eq(S.missingPackages(p, "whisper_cli", "cpu").command, expectPk[pm][1], pm + ": pipx package");
    eq(S.missingPackages(p, "whisper_cpp", "cpu").packages.indexOf("glslc"), -1, pm + ": CPU build needs no shader compiler");
}

// ---- declined offers

r = S.recommend(owner, { declined: "whisper_cpp:vulkan, whisper_cli:ct2-cpu" });
ok(r.whisper_cpp.offers[0].declined, "declined Vulkan offer is marked");
ok(r.whisper_cli.offers[0].declined && !r.whisper_cli.offers[1].declined, "only the declined Python offer is marked");
r = S.recommend(S.parseProbe(NVIDIA_8GB), { declined: ["whisper_cpp:vulkan"] });
ok(!r.whisper_cpp.offers[0].declined, "a different recommended id comes back as a full offer");
eq(S.updateDeclined("a,b", ["c", "a"], []), "a,b,c", "updateDeclined adds once");
eq(S.updateDeclined("a, b,c", [], ["b"]), "a,c", "updateDeclined removes");

// ---- own build and ct2 detection

const ownBuilt = S.parseProbe(OWNER + "CPP_OWN=1\n");
r = S.recommend(ownBuilt, {});
ok(r.whisper_cpp.useBinary && r.whisper_cpp.useBinary.path === Cpp.OWN_BUILD_BINARY,
    "own build present but not used: offers to switch Binary");
const ownUsed = S.parseProbe(OWNER.replace(H + "/.voicemode/services/whisper/build/bin/whisper-cli",
    H + "/.local/share/plasmallm/whisper.cpp/build/bin/whisper-cli") + "CPP_OWN=1\nCPP_GPU=vulkan\n");
r = S.recommend(ownUsed, {});
eq(r.whisper_cpp.useBinary, null, "own build in use: nothing to switch");
eq(r.whisper_cpp.status, "gpu_no_gpu", "own Vulkan build on a 2 GB GPU: CPU recommended");
eq(r.whisper_cpp.offers[0].label, "Rebuild for CPU only", "own build gets 'Rebuild'");

const withCt2 = S.parseProbe(OWNER + `CT2_BIN=${H}/.local/bin/whisper-ctranslate2
CT2_CUDA_LIBS=0
CT2_VERSION=4.6.0
CT2_CUDA_DEVICES=1
`);
r = S.recommend(withCt2, { cliBinary: "whisper" });
ok(r.whisper_cli.useBinary && r.whisper_cli.useBinary.path === "whisper-ctranslate2" && r.whisper_cli.useBinary.device === "cpu",
    "ct2 installed, Command still whisper: offers to switch, with Device cpu on a small GPU");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:ct2-cpu") < 0, "ct2 installed: not offered again");
r = S.recommend(withCt2, { cliBinary: "whisper-ctranslate2", cliDevice: "" });
eq(r.whisper_cli.active, "ct2", "Command whisper-ctranslate2 is the ct2 program");
eq(r.whisper_cli.status, "ok", "ct2 on a small GPU: OK");
ok(r.whisper_cli.warnings.some((w) => /CUDA libraries are not installed/.test(w)),
    "ct2 without CUDA libraries on an NVIDIA machine: warns Default will fail");

// ---- install scripts

const cppFlags = {
    cpu: ["-DGGML_CUDA=0", "-DGGML_VULKAN=0"],
    vulkan: ["-DGGML_CUDA=0", "-DGGML_VULKAN=1"],
    cuda: ["-DGGML_CUDA=1", "-DGGML_VULKAN=0"]
};
for (const flavor of Object.keys(cppFlags)) {
    const script = S.buildInstallScript("whisper_cpp", flavor, amd, { cppModelDirs: "~/.cache/whisper.cpp" });
    ok(bashSyntaxOk(script, "cpp-" + flavor), "whisper_cpp " + flavor + " script passes bash -n");
    ok(cppFlags[flavor].every((f) => script.indexOf(f) >= 0), flavor + ": cmake flags");
    ok(script.indexOf("cmake -B build -DCMAKE_BUILD_TYPE=Release") >= 0, flavor + ": release configure");
    ok(script.indexOf("cmake --build build -j\"$JOBS\" --config Release") >= 0, flavor + ": build step");
    ok(script.indexOf("git clone --depth 1 https://github.com/ggml-org/whisper.cpp") >= 0, flavor + ": clone URL");
    ok(script.indexOf("\"$HOME\"/'.local/share/plasmallm/whisper.cpp'") >= 0, flavor + ": source folder");
    ok(script.indexOf("whisper-setup.status") >= 0 && script.indexOf("Press Enter to close") >= 0, flavor + ": status file and close prompt");
    ok(script.indexOf("set -e") >= 0, flavor + ": set -e");
    ok(script.indexOf("download-ggml-model.sh base") >= 0, flavor + ": offers the base model");
}
const vk = S.buildInstallScript("whisper_cpp", "vulkan", amd, {});
ok(vk.indexOf("echo '  sudo apt install libvulkan-dev glslc'") >= 0 && vk.indexOf("if ask ") >= 0
    && vk.indexOf("step sudo apt install libvulkan-dev glslc") > vk.indexOf("if ask "),
    "package install is printed, then asked y/N before running");
const cu = S.buildInstallScript("whisper_cpp", "cuda", S.parseProbe(NVIDIA_8GB), {});
ok(cu.indexOf("/usr/local/cuda/bin/nvcc") >= 0 && !/apt install .*cuda|dnf install .*cuda|pacman -S .*cuda/.test(cu),
    "CUDA script looks for nvcc and never installs the toolkit");
ok(S.buildInstallScript("whisper_cpp", "cpu", owner, {}).indexOf("sudo ") < 0, "nothing missing: no sudo");
const noPm = S.buildInstallScript("whisper_cpp", "cpu", nothing, {});
ok(bashSyntaxOk(noPm, "cpp-nopm") && noPm.indexOf("compiler, make, cmake, git") >= 0 && noPm.indexOf("sudo ") < 0,
    "unknown package manager: names what is missing and stops");

const pyIndex = {
    "openai-cpu": "https://download.pytorch.org/whl/cpu",
    "openai-cuda": "https://download.pytorch.org/whl/cu128"
};
for (const flavor of ["openai-cpu", "openai-cuda", "ct2-cpu", "ct2-cuda"]) {
    const script = S.buildInstallScript("whisper_cli", flavor, S.parseProbe(NOTHING + "PKG_MGR=dnf\n"), {});
    ok(bashSyntaxOk(script, "cli-" + flavor), "whisper_cli " + flavor + " script passes bash -n");
    ok(script.indexOf("step sudo dnf install pipx") >= 0, flavor + ": installs pipx after asking");
    if (pyIndex[flavor]) {
        ok(script.indexOf("pipx install openai-whisper") >= 0, flavor + ": pipx install");
        ok(script.indexOf("pipx runpip openai-whisper install --force-reinstall torch --index-url " + pyIndex[flavor]) >= 0,
            flavor + ": torch index URL");
    } else {
        ok(script.indexOf("pipx install whisper-ctranslate2") >= 0, flavor + ": pipx install whisper-ctranslate2");
        ok(script.indexOf("download.pytorch.org") < 0, flavor + ": no PyTorch");
    }
}
const ct2cuda = S.buildInstallScript("whisper_cli", "ct2-cuda", owner, {});
ok(ct2cuda.indexOf("pipx inject whisper-ctranslate2 nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'") >= 0,
    "ct2 CUDA: injects cuBLAS and cuDNN 9");
ok(ct2cuda.indexOf("LD_LIBRARY_PATH") >= 0 && ct2cuda.indexOf("'.local/share/plasmallm/bin/whisper-ctranslate2'") >= 0,
    "ct2 CUDA: writes the library-path wrapper");
// The wrapper the script writes must itself be valid sh.
{
    const m = /^printf '%s\\n' (.*) > "\$WRAP"$/m.exec(ct2cuda);
    ok(!!m, "ct2 CUDA: wrapper printf found");
    if (m) {
        const wrapper = execFileSync("bash", ["-c", "LIBS=/x/cublas/lib:/x/cudnn/lib; REAL=/v/bin/whisper-ctranslate2; printf '%s\\n' " + m[1]],
            { encoding: "utf8" });
        ok(wrapper.indexOf("export LD_LIBRARY_PATH=\"/x/cublas/lib:/x/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\"") >= 0
            && wrapper.indexOf("exec \"/v/bin/whisper-ctranslate2\" \"$@\"") >= 0, "ct2 CUDA: wrapper content");
        ok(bashSyntaxOk(wrapper, "ct2-wrapper"), "ct2 CUDA: wrapper passes bash -n");
    }
}

// ---- probe and launch commands

const probeCmd = S.buildProbeCommand("whisper-cli", "whisper", "~/m/ggml-base.bin", 7);
ok(probeCmd.indexOf(": plasmallm-whisper-probe-7;") === 0, "probe starts with its marker");
ok(probeCmd !== S.buildProbeCommand("whisper-cli", "whisper", "~/m/ggml-base.bin", 8), "markers keep probe commands distinct");
ok(probeCmd.indexOf(Cpp.binaryWord("whisper-cli")) >= 0, "probe reuses binaryWord()");
ok(probeCmd.indexOf("\"$HOME\"/'m/ggml-base.bin'") >= 0, "probe sizes the model");
ok(probeCmd.indexOf("set -- 'python3'") >= 0 && probeCmd.indexOf("case \"$sb\" in *python*) set -- $sb;;") >= 0,
    "probe uses the launcher, then the script's own python");
ok(S.buildProbeCommand("", "toolbox run whisper", "", 1).indexOf("set -- 'toolbox' 'run' 'python3'") >= 0,
    "probe follows pythonLauncherFromPrefix()");
ok(bashSyntaxOk(probeCmd, "probe"), "probe passes bash -n");
ok(!/\b(rm|mv|install|pip|apt|dnf|pacman|zypper)\s/.test(probeCmd.replace(/command -v [a-z-]+|for p in apt-get dnf pacman zypper|CT2_|PKG_MGR/g, "")),
    "probe runs nothing that changes the system");

const sample = "#!/usr/bin/env bash\necho 'héllo — 4×'\n";
eq(S.base64Utf8(sample), Buffer.from(sample, "utf8").toString("base64"), "base64 of UTF-8");
eq(S.base64Utf8("ab"), "YWI=", "base64 padding");
const launch = S.buildLaunchCommand(sample, 3);
ok(launch.indexOf(": plasmallm-whisper-setup-3;") === 0, "launch command has its marker");
ok(launch.indexOf("printf %s '" + Buffer.from(sample).toString("base64") + "' | base64 -d") >= 0, "launch writes the script");
ok(launch.indexOf("term=${TERMINAL:-$(kreadconfig6 --file kdeglobals --group General --key TerminalApplication 2>/dev/null)}; term=${term:-konsole};") >= 0,
    "terminal chosen like runInTerminal()");
ok(launch.indexOf("\"$term\" -e bash \"$f\" || { rc=$?; rm -f -- \"$f\"; echo \"terminal: $term\" >&2; exit $rc; }") >= 0,
    "script runs in the terminal; a failed terminal removes the file and says which terminal");
ok(bashSyntaxOk(launch, "launch"), "launch command passes bash -n");

// ---- binary lookup order

eq(Cpp.FALLBACK_BINARIES[0], "~/.local/share/plasmallm/whisper.cpp/build/bin/whisper-cli", "own build is the first fallback");
eq(Cpp.OWN_BUILD_BINARY, Cpp.FALLBACK_BINARIES[0], "OWN_BUILD_BINARY constant");
ok(Cpp.binaryWord("").indexOf("command -v whisper-cli") < Cpp.binaryWord("").indexOf(".local/share/plasmallm"),
    "PATH still comes before the fallbacks");

// ---- whisper-ctranslate2 through the Python backend

ok(Cli.isCt2Binary("whisper-ctranslate2") && Cli.isCt2Binary("/home/u/.local/bin/whisper-ctranslate2")
    && Cli.isCt2Binary("toolbox run whisper-ctranslate2") && !Cli.isCt2Binary("whisper") && !Cli.isCt2Binary(""),
    "isCt2Binary");
eq(Cli.buildCommand({ filePath: "/tmp/r.wav", model: "large", cliBinary: "whisper-ctranslate2", cliDevice: "cpu", cliFp16: true }),
    "whisper-ctranslate2 '/tmp/r.wav' --model large-v3 --output_format txt --output_dir '/tmp' --verbose False --device cpu --compute_type int8 1>/dev/null"
        + " && { [ -f '/tmp/r.txt' ] || { echo 'whisper-ctranslate2 wrote no transcript; its error is above.' >&2; exit 1; }; cat '/tmp/r.txt'; }",
    "ct2 cpu: int8, no --fp16, large → large-v3, missing transcript is an error");
const ct2Cuda = Cli.buildCommand({ filePath: "/tmp/r.wav", model: "large-v3-turbo", cliBinary: "whisper-ctranslate2", cliDevice: "cuda", cliThreads: 4, language: "en", cliTask: "translate" });
// M5: an explicit float16 is refused below compute capability 7.0; ct2's auto picks it where it works.
ok(ct2Cuda.indexOf("--device cuda") >= 0 && ct2Cuda.indexOf("--compute_type") < 0 && ct2Cuda.indexOf("--fp16") < 0,
    "ct2 cuda: no forced float16");
ok(ct2Cuda.indexOf("--model large-v3-turbo") >= 0 && ct2Cuda.indexOf("--language en") >= 0
    && ct2Cuda.indexOf("--task translate") >= 0 && ct2Cuda.indexOf("--threads 4") >= 0, "ct2 shares the OpenAI flags");
const ct2Default = Cli.buildCommand({ filePath: "/tmp/r.wav", model: "base", cliBinary: "whisper-ctranslate2" });
ok(ct2Default.indexOf("--compute_type") < 0 && ct2Default.indexOf("--device") < 0 && ct2Default.indexOf("--fp16") < 0,
    "ct2 Default device: ct2 picks its own");
ok(Cli.buildCommand({ filePath: "/a.wav", model: "base", cliBinary: "whisper", cliFp16: false }).indexOf("--fp16 False") >= 0,
    "openai-whisper keeps --fp16");
ok(Cli.buildCommand({ filePath: "/a.wav", model: "large", cliBinary: "whisper" }).indexOf("--model large ") >= 0,
    "openai-whisper keeps 'large'");
eq(Cli.buildCacheCheckCommand("base", "whisper-ctranslate2"), "", "no ~/.cache/whisper check for ct2");
ok(Cli.buildCacheCheckCommand("base", "whisper").indexOf("whisper/base.pt") >= 0, "cache check still works for openai-whisper");
ok(Cli.buildCudaCheckCommand("whisper-ctranslate2").indexOf("ctranslate2") >= 0, "ct2 CUDA check uses ctranslate2");
eq(Cli.pythonLauncherFromPrefix("toolbox run whisper-ctranslate2"), "toolbox run python3", "launcher for a ct2 prefix");

// ======================================================== review fixes
// (finding ids from .omc/reports/whisper-setup-review.md)

const scriptLines = (script, from, to) => {
    const lines = script.split("\n");
    const a = lines.findIndex((l) => l.indexOf(from) === 0);
    const b = lines.findIndex((l, i) => i > a && l.indexOf(to) === 0);
    return a >= 0 && b > a ? lines.slice(a, b + 1).join("\n") : "";
};

// ---- H1: GPU generations and PyTorch's CUDA indexes

const capProbe = S.parseProbe("NV_GPU=NVIDIA GeForce GTX 1070, 8192, 6.1\nNV_GPU_NOCAP=Quadro K4000, 3072\nNV_GPU=NVIDIA A100, 81920, [N/A]\n");
eq(capProbe.nvidia.map((g) => [g.name, g.memMiB, g.computeCap, g.capMissing]),
    [["NVIDIA GeForce GTX 1070", 8192, 6.1, false], ["Quadro K4000", 3072, 0, true], ["NVIDIA A100", 81920, 0, false]],
    "H1: compute_cap parsed; the old-driver query is marked; [N/A] cap is unknown");
const CU128_ARCHS = ["sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"];
ok(!S.torchArchsSupport(CU128_ARCHS, 6.1), "H1: torch 2.10+cu128 has no kernels for sm_61 (seen on the MX230)");
ok(S.torchArchsSupport(["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"], 6.1), "H1: cu126 runs sm_61 through sm_60");
ok(S.torchArchsSupport(["sm_75", "compute_75"], 8.6), "H1: PTX for an older capability counts");
ok(!S.torchArchsSupport(["sm_86"], 8.0), "H1: a cubin for a newer minor does not run on an older card");
ok(S.torchArchsSupport([], 6.1) && S.torchArchsSupport(CU128_ARCHS, 0), "H1: unknown arch list or capability counts as supported");

const PASCAL_8GB = NVIDIA_8GB.replace("NV_GPU=NVIDIA GeForce RTX 3070, 8192", "NV_GPU=NVIDIA GeForce GTX 1070, 8192, 6.1")
    .replace("VK_GPU=DISCRETE_GPU|8589934592|NVIDIA GeForce RTX 3070", "VK_GPU=DISCRETE_GPU|8589934592|NVIDIA GeForce GTX 1070");
const pascal = S.parseProbe(PASCAL_8GB);
r = S.recommend(pascal, { cliBinary: "whisper", cliModel: "base" });
eq(r.whisper_cli.ideal, "cuda", "H1: 8 GB Pascal still gets CUDA");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:openai-cuda") >= 0 && /CUDA 12\.6/.test(r.whisper_cli.message),
    "H1: CPU PyTorch on Pascal: switch to CUDA, naming the 12.6 build");
eq(S.torchCudaIndex(pascal), "https://download.pytorch.org/whl/cu126", "H1: Pascal uses the cu126 index");
eq(S.torchCudaIndex(S.parseProbe(NVIDIA_8GB.replace("RTX 3070, 8192", "RTX 3070, 8192, 8.6"))),
    "https://download.pytorch.org/whl/cu128", "H1: Ampere keeps cu128");
eq(S.torchCudaIndex(S.parseProbe(NVIDIA_8GB.replace("RTX 3070, 8192", "Tesla V100, 16384, 7.0"))),
    "https://download.pytorch.org/whl/cu126", "H1: Volta (7.0) uses cu126 too (dropped from cu128 in 2.11)");
{
    const sw = S.buildInstallScript("whisper_cli", "openai-cuda", pascal, {});
    ok(bashSyntaxOk(sw, "openai-cuda-pascal"), "H1: Pascal openai-cuda script passes bash -n");
    ok(sw.indexOf("pipx runpip openai-whisper install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu126") >= 0
        && sw.indexOf("cu128") < 0, "H1: the Pascal script installs cu126, never cu128");
}
// A cu128 PyTorch already installed on Pascal: is_available() is true, kernels are missing.
const pascalCu128 = S.parseProbe(PASCAL_8GB.replace("TORCH_VERSION=2.10.0+cpu\nTORCH_CUDA=\nTORCH_CUDA_AVAILABLE=0",
    "TORCH_VERSION=2.10.0+cu128\nTORCH_CUDA=12.8\nTORCH_CUDA_AVAILABLE=1\nTORCH_ARCHS=" + CU128_ARCHS.join(" ")));
r = S.recommend(pascalCu128, { cliBinary: "whisper", cliDevice: "cuda", cliModel: "base" });
eq(r.whisper_cli.status, "cpu_on_gpu", "H1: cu128 PyTorch on Pascal is not OK");
ok(/no CUDA kernels for NVIDIA GeForce GTX 1070/.test(r.whisper_cli.message), "H1: says the kernels are missing");
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:openai-cuda") >= 0, "H1: offers the cu126 switch");
ok(r.whisper_cli.warnings.some((w) => /Set Device to cpu until PyTorch is switched/.test(w)), "H1: tells to use cpu meanwhile");
ok(r.whisper_cli.cudaKnown && !r.whisper_cli.cudaUsable, "H1/M9: CUDA status says not usable even though is_available() is true");
// This machine (MX230, sm_61, cu128 PyTorch): CPU PyTorch is the fix.
const OWNER_REAL = OWNER.replace("NV_GPU=NVIDIA GeForce MX230, 2048", "NV_GPU=NVIDIA GeForce MX230, 2048, 6.1")
    + "TORCH_ARCHS=" + CU128_ARCHS.join(" ") + "\n";
r = S.recommend(S.parseProbe(OWNER_REAL), { cliBinary: "whisper", cliDevice: "", cliModel: "base" });
eq(r.whisper_cli.status, "gpu_no_gpu", "H1: owner's CUDA PyTorch cannot run on the MX230");
eq(ids(r.whisper_cli.offers)[0], "whisper_cli:openai-cpu", "H1: owner: switch PyTorch to CPU first");
ok(!r.whisper_cli.warnings.some((w) => /Default” will use/.test(w)), "H1: no 'Default will use the GPU' when it cannot");
// Kepler and too-old drivers: no CUDA at all.
const KEPLER = NVIDIA_8GB.replace("NV_GPU=NVIDIA GeForce RTX 3070, 8192", "NV_GPU=Tesla K40m, 11441, 3.5");
r = S.recommend(S.parseProbe(KEPLER), { cliBinary: "whisper" });
eq(r.whisper_cli.ideal, "cpu", "H1: Kepler (3.5) gets CPU");
ok(/older than any current CUDA build/.test(r.whisper_cli.offers[0].reason), "H1: Kepler: plain reason");
ok(ids(r.whisper_cli.offers).every((id) => !/cuda/.test(id)), "H1: Kepler: no CUDA offers");
eq(r.whisper_cpp.ideal, "vulkan", "H1: Kepler + nvcc: whisper.cpp uses Vulkan, not CUDA");
const OLD_DRIVER = NVIDIA_8GB.replace("NV_GPU=NVIDIA GeForce RTX 3070, 8192", "NV_GPU_NOCAP=NVIDIA GeForce GTX 980, 4096");
r = S.recommend(S.parseProbe(OLD_DRIVER), { cliBinary: "whisper" });
ok(r.whisper_cli.ideal === "cpu" && /driver for NVIDIA GeForce GTX 980 \(4 GB\) is too old/.test(r.whisper_cli.offers[0].reason),
    "H1: driver without compute_cap: CPU with a plain reason");
// faster-whisper's memory below 7.0 is float32, about openai-whisper's.
{
    const ct2Lines = "CT2_BIN=" + H + "/.local/bin/whisper-ctranslate2\nCT2_VERSION=4.6.0\nCT2_CUDA_DEVICES=1\nCUDA_SYS_LIBS=1\n";
    const p1060 = S.parseProbe(NVIDIA_8GB.replace("RTX 3070, 8192", "GTX 1060 6GB, 6144, 6.1") + ct2Lines);
    r = S.recommend(p1060, { cliBinary: "whisper-ctranslate2", cliDevice: "cuda", cliModel: "large-v3" });
    ok(r.whisper_cli.warnings.some((w) => /large-v3 model needs about 10 GB/.test(w)), "H1: ct2 on Pascal uses float32 sizes");
    const p2060 = S.parseProbe(NVIDIA_8GB.replace("RTX 3070, 8192", "RTX 2060, 6144, 7.5") + ct2Lines);
    r = S.recommend(p2060, { cliBinary: "whisper-ctranslate2", cliDevice: "cuda", cliModel: "large-v3" });
    ok(!r.whisper_cli.warnings.some((w) => /needs about/.test(w)), "H1: ct2 on Turing uses float16 sizes");
}

// ---- H2: "Use it" writes a command Plasma can run

const CT2_OFF = OWNER + `CT2_BIN=${H}/.local/bin/whisper-ctranslate2
CT2_OFF_PATH=1
CT2_CUDA_LIBS=0
CT2_VERSION=4.6.0
CT2_CUDA_DEVICES=1
`;
r = S.recommend(S.parseProbe(CT2_OFF), { cliBinary: "whisper" });
eq(r.whisper_cli.useBinary.path, "~/.local/bin/whisper-ctranslate2", "H2: ct2 found off PATH: Use it writes the full path");
r = S.recommend(S.parseProbe(CT2_OFF), { cliBinary: "whisper-ctranslate2" });
eq(r.whisper_cli.useBinary && r.whisper_cli.useBinary.path, "~/.local/bin/whisper-ctranslate2",
    "H2: Command already the bare name but not on PATH: offer the full path");
ok(Cli.buildCommand({ filePath: "/tmp/r.wav", model: "base", cliBinary: "~/.local/bin/whisper-ctranslate2" })
    .indexOf("~/.local/bin/whisper-ctranslate2 '/tmp/r.wav' --model base") === 0, "H2: the ~ path reaches the shell unquoted, so it expands");
r = S.recommend(S.parseProbe(NOTHING + `CLI_BIN=${H}/.local/bin/whisper\nCLI_OFF_PATH=1\nWHISPER_PY=1\nTORCH_VERSION=2.14.1+cpu\nTORCH_CUDA=\n`), { cliBinary: "whisper" });
eq(r.whisper_cli.useBinary && r.whisper_cli.useBinary.path, "~/.local/bin/whisper", "H2: openai whisper off PATH: full path");
ok(S.buildProbeCommand("", "whisper", "", 1).indexOf("w=\"$HOME/.local/bin/whisper\"; echo CLI_OFF_PATH=1") >= 0
    && S.buildProbeCommand("", "toolbox run whisper", "", 1).indexOf("CLI_OFF_PATH") < 0, "H2: ~/.local/bin fallback only for the default Command");

// ---- H3: the PyTorch switch only for the pipx venv

r = S.recommend(S.parseProbe(NO_GPU.replace("CLI_PIPX=1\n", "CLI_PY=/opt/venv/bin/python\n")), { cliBinary: "whisper" });
ok(ids(r.whisper_cli.offers).indexOf("whisper_cli:openai-cpu") < 0, "H3: not a pipx install: no automated switch");
ok(r.whisper_cli.warnings.some((w) => w.indexOf("/opt/venv/bin/python -m pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cpu") >= 0),
    "H3: instead, that environment's own pip command");
r = S.recommend(S.parseProbe(NO_GPU.replace("CLI_PIPX=1\n", "CLI_PY=/usr/bin/python3\n")), { cliBinary: "whisper" });
ok(r.whisper_cli.warnings.some((w) => /with the tool you installed Whisper with/.test(w) && w.indexOf("-m pip") < 0),
    "H3: system python: no pip command, plain instructions");
{
    const sw = S.buildInstallScript("whisper_cli", "openai-cpu", S.parseProbe(NO_GPU), {});
    ok(sw.indexOf("PY=\"$VENVS/openai-whisper/bin/python\"") >= 0 && sw.indexOf("command -v whisper") < 0,
        "H3: the torch check reads pipx's venv, not whichever whisper is on PATH");
    const probe = S.buildProbeCommand("", "whisper", "", 1);
    ok(probe.indexOf("pipx_metadata.json") >= 0 && probe.indexOf("$ph/venvs/openai-whisper") >= 0 && probe.indexOf("pipx environment") < 0,
        "H3: probe checks the pipx venv without running pipx");
}

// ---- M1: leftover GPU libraries

{
    const cpuScript = S.buildInstallScript("whisper_cpp", "cpu", owner, {});
    const block = scriptLines(cpuScript, "if [ -f build/CMakeCache.txt ]", "fi");
    ok(block.indexOf("GGML_VULKAN:BOOL=0") >= 0 && block.indexOf("step rm -rf -- build") >= 0, "M1: CPU rebuild checks the cache");
    const d = fs.mkdtempSync(path.join(tmp, "m1-"));
    fs.mkdirSync(path.join(d, "build"));
    const run = (cache) => {
        fs.writeFileSync(path.join(d, "build", "CMakeCache.txt"), cache);
        return execFileSync("bash", ["-c", "step() { echo \"$*\"; }; cd \"$1\" && " + block.replace(/\n/g, "\n"), "_", d], { encoding: "utf8" });
    };
    ok(/rm -rf -- build/.test(run("GGML_CUDA:BOOL=0\nGGML_VULKAN:BOOL=1\n")), "M1: Vulkan cache, CPU build: starts clean");
    eq(run("GGML_CUDA:BOOL=0\nGGML_VULKAN:BOOL=0\n"), "", "M1: same backend: keeps the build folder");
}

// ---- the probe itself, run by sh against stand-in tools (M1, M2, H1, H2, L1, L6)

{
    const sb = fs.mkdtempSync(path.join(tmp, "probe-"));
    const bin = path.join(sb, "bin");
    const home = path.join(sb, "home");
    const lib = path.join(sb, "syslib");
    for (const dir of [bin, home + "/.local/bin", lib, sb + "/nondl/build/bin", sb + "/nondl/build/ggml/src", sb + "/dl/bin"])
        fs.mkdirSync(dir, { recursive: true });
    const exe = (f, body) => { fs.writeFileSync(f, body); fs.chmodSync(f, 0o755); };
    // nvidia-smi from a driver that predates compute_cap
    exe(bin + "/nvidia-smi", "#!/bin/sh\ncase \"$*\" in *compute_cap*) echo 'Field \"compute_cap\" is not a valid field to query.' >&2; exit 2;; esac\necho 'Tesla K80, 11441'\n");
    exe(bin + "/vulkaninfo", "#!/bin/sh\nexit 1\n");
    exe(bin + "/ldd", "#!/bin/sh\ncase \"$1\" in */nondl/*) printf '\\tlibggml-cpu.so.0 => /x/libggml-cpu.so.0 (0x0)\\n';; "
        + "*) printf '\\tlibggml-base.so.0 => " + lib + "/libggml-base.so.0 (0x0)\\n';; esac\n");
    exe(bin + "/toolbox", "#!/bin/sh\nshift\nexec \"$@\"\n");
    exe(bin + "/python3", "#!/bin/sh\npwd > " + sb + "/pwd\necho WHISPER_PY=1; echo TORCH_VERSION=9.9+cpu; echo TORCH_CUDA=; echo TORCH_CUDA_AVAILABLE=0; echo TORCH_ARCHS=\n");
    // the venv python named in the entry point's #! line
    exe(sb + "/venv-python", "#!/bin/sh\necho CT2_CUDA_LIBS=0; echo CT2_VERSION=4.6.0; echo CT2_CUDA_DEVICES=0\n");
    exe(home + "/.local/bin/whisper-ctranslate2", "#!" + sb + "/venv-python\n");
    exe(sb + "/nondl/build/bin/whisper-cli", "#!/bin/sh\n");
    fs.writeFileSync(sb + "/nondl/build/ggml/src/libggml-vulkan.so", "");   // left over from an older build
    exe(sb + "/dl/bin/whisper-cli", "#!/bin/sh\n");
    fs.writeFileSync(sb + "/dl/bin/libggml-vulkan.so", "");
    fs.writeFileSync(lib + "/libggml-cuda.so", "");
    const runProbe = (cpp, cli) => execFileSync("sh", ["-c", S.buildProbeCommand(cpp, cli, "", 1)],
        { encoding: "utf8", cwd: sb, env: { PATH: bin + ":/usr/bin:/bin", HOME: home } });
    let out = runProbe(sb + "/nondl/build/bin/whisper-cli", "toolbox run whisper");
    let p = S.parseProbe(out);
    ok(p.complete, "probe runs to the end under sh");
    eq(p.nvidia, [{ name: "Tesla K80", memMiB: 11441, computeCap: 0, capMissing: true }], "H1: old nvidia-smi falls back and is marked");
    eq(p.cpp.gpu, [], "M1: a build that links libggml-cpu: leftover libggml-vulkan.so is ignored");
    ok(p.cli.torchVersion === "9.9+cpu" && p.cli.python === "'toolbox' 'run' 'python3'".replace(/'/g, ""),
        "M2: 'toolbox run whisper' runs python inside toolbox");
    eq(fs.readFileSync(sb + "/pwd", "utf8").trim(), "/", "L6: python checks run from /");
    ok(p.ct2.bin === home + "/.local/bin/whisper-ctranslate2" && !p.ct2.onPath && p.ct2.version === "4.6.0",
        "H2: ct2 found in ~/.local/bin and marked off PATH");
    out = runProbe(sb + "/dl/bin/whisper-cli", "~/.local/bin/whisper-ctranslate2");
    eq(S.parseProbe(out).cpp.gpu.sort(), ["cuda", "vulkan"], "M1: GGML_BACKEND_DL build: backends beside it and beside its libggml");
    out = runProbe("", "/opt/none/python -m whisper");
    ok(S.parseProbe(out).complete, "M2: a python path prefix does not break the probe");
    exe(home + "/.local/bin/mywhisper", "#!/bin/sh\n");
    ok(S.parseProbe(runProbe("", "~/.local/bin/mywhisper")).cli.bin === home + "/.local/bin/mywhisper", "M2: a ~/ Command is found");
    runProbe("", "whisper;touch${IFS}" + sb + "/pwned");
    runProbe("", "$(touch " + sb + "/pwned2)");
    ok(!fs.existsSync(sb + "/pwned") && !fs.existsSync(sb + "/pwned2"), "M2: a Command value cannot run extra commands in the probe");
}
eq(Cli.pythonLauncherFromPrefix("/opt/venv/bin/python -m whisper"), "/opt/venv/bin/python", "M2: keeps a full python path");
eq(Cli.pythonLauncherFromPrefix("python3.12 -m whisper"), "python3.12", "M2: keeps a versioned python");
eq(Cli.pythonLauncherFromPrefix("python3 -m whisper"), "python3", "M2: python3 -m whisper");

// ---- M3: GPU tools have a timeout

ok(/\$to10 nvidia-smi/.test(probeCmd) && /\$to10 vulkaninfo/.test(probeCmd) && probeCmd.indexOf("to10='timeout -k 5 10'") >= 0,
    "M3: nvidia-smi and vulkaninfo run under timeout");

// ---- M4: ct2 without CUDA libraries on a big NVIDIA card

{
    const big = NVIDIA_8GB.replace("RTX 3070, 8192", "RTX 3070, 8192, 8.6") + `CT2_BIN=${H}/.local/bin/whisper-ctranslate2
CT2_CUDA_LIBS=0
CT2_VERSION=4.6.0
CT2_CUDA_DEVICES=1
`;
    r = S.recommend(S.parseProbe(big), { cliBinary: "whisper-ctranslate2", cliDevice: "" });
    ok(r.whisper_cli.warnings.some((w) => /Device “Default”, whisper-ctranslate2 tries the NVIDIA GPU/.test(w)), "M4: big GPU, Default, no libraries: warns");
    r = S.recommend(S.parseProbe(big), { cliBinary: "whisper" });
    eq(r.whisper_cli.useBinary.device, "cpu", "M4: Use it sets Device cpu until ct2 has its CUDA libraries");
    r = S.recommend(S.parseProbe(big + "CUDA_SYS_LIBS=1\n"), { cliBinary: "whisper" });
    eq(r.whisper_cli.useBinary.device, "", "M4: with system CUDA libraries Device stays Default");
}

// ---- M6: make

{
    const noMake = S.parseProbe(NOTHING + "HAVE=g++\nHAVE=cmake\nHAVE=git\nPKG_MGR=dnf\n");
    eq(S.missingPackages(noMake, "whisper_cpp", "cpu").command, "sudo dnf install make", "M6: g++ without make: installs make (dnf)");
    eq(S.missingPackages(S.parseProbe(NOTHING + "HAVE=g++\nHAVE=cmake\nHAVE=git\nPKG_MGR=apt-get\n"), "whisper_cpp", "cpu").command,
        "sudo apt install build-essential", "M6: apt: build-essential");
    ok(probeCmd.indexOf("clang++ make git") >= 0, "M6: probe looks for make");
}

// ---- M7: fresh CPU install pulls CPU torch first

{
    const fresh = S.buildInstallScript("whisper_cli", "openai-cpu", nothing, {});
    ok(fresh.indexOf("step pipx install openai-whisper --pip-args='--index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple'") >= 0,
        "M7: fresh CPU install resolves torch from the CPU index");
    const freshCu = S.buildInstallScript("whisper_cli", "openai-cuda", S.parseProbe(NVIDIA_8GB.replace("RTX 3070, 8192", "RTX 3070, 8192, 8.6")), {});
    ok(freshCu.indexOf("    step pipx install openai-whisper\n    step pipx runpip openai-whisper install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu128") >= 0,
        "M7: cu128 (older than PyPI's torch) keeps install-then-swap");
    const freshLegacy = S.buildInstallScript("whisper_cli", "openai-cuda", pascal, {});
    ok(freshLegacy.indexOf("--pip-args='--index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple'") >= 0,
        "M7: cu126 fresh install uses the index directly");
}

// ---- M8: job count

{
    const s = S.buildInstallScript("whisper_cpp", "cuda", S.parseProbe(NVIDIA_8GB), {});
    const block = scriptLines(s, "JOBS=$(nproc", "if [ \"$MEMJOBS\" -lt \"$JOBS\" ]");
    const jobs = parseInt(execFileSync("bash", ["-c", block + "\necho \"$JOBS\""], { encoding: "utf8" }), 10);
    const cpus = parseInt(execFileSync("nproc", { encoding: "utf8" }), 10);
    ok(jobs >= 1 && jobs <= cpus, "M8: job count between 1 and nproc (" + jobs + ")");
}

// ---- lows

{
    // L1: symlinked home
    const real = "/data/u/.local/share/plasmallm/whisper.cpp/build/bin/whisper-cli";
    r = S.recommend(S.parseProbe(OWNER.replace(H + "/.voicemode/services/whisper/build/bin/whisper-cli", real)
        + "CPP_OWN=1\nCPP_OWN_PATH=" + real + "\nCPP_GPU=vulkan\n"), {});
    ok(r.whisper_cpp.useBinary === null && r.whisper_cpp.offers[0].label === "Rebuild for CPU only", "L1: own build behind a symlinked home");
    // L5: pip CUDA libraries only work through the wrapper
    const libs = NVIDIA_8GB.replace("RTX 3070, 8192", "RTX 3070, 8192, 8.6") + `CT2_BIN=${H}/.local/bin/whisper-ctranslate2
CT2_WRAPPER=1
CT2_CUDA_LIBS=1
CT2_VERSION=4.6.0
CT2_CUDA_DEVICES=1
`;
    r = S.recommend(S.parseProbe(libs), { cliBinary: "whisper-ctranslate2", cliDevice: "cuda" });
    ok(r.whisper_cli.status === "cpu_on_gpu" && r.whisper_cli.useBinary.path === S.CT2_WRAPPER && !r.whisper_cli.cudaUsable,
        "L5: bare ct2 with pip libraries: not ready, offers the wrapper");
    r = S.recommend(S.parseProbe(libs), { cliBinary: S.CT2_WRAPPER, cliDevice: "cuda" });
    ok(r.whisper_cli.status === "ok" && r.whisper_cli.useBinary === null && r.whisper_cli.cudaUsable, "L5: wrapper Command: OK");
    // L7: vulkaninfo sees only llvmpipe, DRM sees an AMD card
    const noVk = S.parseProbe("VK_GPU=CPU|8000000000|llvmpipe (LLVM 20)\nDRM_GPU=0x1002|8589934592|1\nHOME_DIR=" + H + "\n");
    r = S.recommend(noVk, {});
    ok(r.gpus.length === 1 && r.gpus[0].noVulkanDriver && r.whisper_cpp.ideal === "cpu" && /no Vulkan driver/.test(r.whisper_cpp.message)
        && ids(r.whisper_cpp.offers).join() === "whisper_cpp:cpu", "L7: card without a Vulkan driver is named, CPU build only");
    r = S.recommend(S.parseProbe("VK_GPU=CPU|8000000000|llvmpipe (LLVM 20)\nDRM_GPU=0x1002|8589934592|1\nHOME_DIR=" + H
        + "\nCPP_BIN=/usr/bin/whisper-cli\nCPP_GPU=vulkan\n"), {});
    ok(r.whisper_cpp.status === "gpu_no_gpu" && /no Vulkan driver/.test(r.whisper_cpp.message), "L7: a Vulkan build there is flagged");
    // L8: [N/A] memory from nvidia-smi
    r = S.recommend(S.parseProbe("NV_GPU=NVIDIA GB10, [N/A], 12.1\nVK_GPU=INTEGRATED_GPU|128000000000|NVIDIA GB10\n"), {});
    ok(r.gpus.length === 1 && r.gpus[0].memMiB > 100000, "L8: memory taken from Vulkan when nvidia-smi says [N/A]");
    // L12
    ok(Object.keys(S.CT2_GPU_GB).every((m) => Cli.KNOWN_MODELS.indexOf(m) >= 0 || m === "large-v3-turbo"), "L12: no unreachable model sizes");
    // L13
    const cuS = S.buildInstallScript("whisper_cpp", "cuda", S.parseProbe(NOTHING + "PKG_MGR=dnf\nNV_GPU=RTX 3070, 8192, 8.6\n"), {});
    ok(cuS.indexOf("command -v nvcc") >= 0 && cuS.indexOf("command -v nvcc") < cuS.indexOf("step sudo dnf install"), "L13: nvcc checked before sudo");
    // L14
    ok(cuS.indexOf("git ls-remote --tags --refs --sort=-version:refname https://github.com/ggml-org/whisper.cpp 'v*'") >= 0
        && cuS.indexOf("git clone --depth 1 --branch \"$TAG\"") >= 0, "L14: builds the latest release tag");
    // L15
    r = S.recommend(S.parseProbe(CT2_OFF), { cliBinary: "whisper" });
    const useId = r.whisper_cli.useBinary.id;
    ok(/^use:whisper_cli:/.test(useId), "L15: Use it has a decline id");
    r = S.recommend(S.parseProbe(CT2_OFF), { cliBinary: "whisper", declined: useId });
    ok(r.whisper_cli.useBinary.declined, "L15: a declined Use it stays declined");
}

for (const [name, cmd] of [["probe-default", S.buildProbeCommand("", "", "", 1)], ["probe-toolbox", S.buildProbeCommand("", "toolbox run whisper", "~/m.bin", 2)],
    ["probe-pyprefix", S.buildProbeCommand("/usr/bin/whisper-cli", "/opt/venv/bin/python -m whisper", "", 3)]]) {
    ok(bashSyntaxOk(cmd, name), name + " passes bash -n");
}
for (const [kind, flavor, pr] of [["whisper_cpp", "cpu", owner], ["whisper_cpp", "vulkan", amd], ["whisper_cpp", "cuda", pascal],
    ["whisper_cli", "openai-cpu", nothing], ["whisper_cli", "openai-cuda", pascal], ["whisper_cli", "openai-cuda", S.parseProbe(NVIDIA_8GB)],
    ["whisper_cli", "ct2-cpu", nothing], ["whisper_cli", "ct2-cuda", owner]]) {
    ok(bashSyntaxOk(S.buildInstallScript(kind, flavor, pr, {}), "all-" + kind + "-" + flavor), kind + " " + flavor + " passes bash -n");
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
    console.error(failed + " whisper_setup check(s) failed");
    process.exit(1);
}
console.log("whisper_setup: all checks passed");
