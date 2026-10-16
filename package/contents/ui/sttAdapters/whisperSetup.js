/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Detects the local Whisper programs and the graphics hardware, says whether
// the installed build suits this computer, and writes the install/build
// script the Speech settings page runs in a visible terminal.
//
// The probe is read-only. Anything that changes the system happens in the
// generated script, in front of the user, and package installs ask first.

.pragma library

.import "whisper_cpp.js" as WhisperCpp
.import "whisper_cli.js" as WhisperCli

// A .pragma library has no QML context, so Plasma's i18n() doesn't exist here.
// This stand-in fills in %1..%9 so messages read correctly; the calls stay
// literal i18n("...") so xgettext still extracts them.
function i18n(str) {
    var res = String(str);
    for (var i = 1; i < arguments.length && i < 10; i++)
        res = res.split("%" + i).join(String(arguments[i]));
    return res;
}

// Below this much graphics memory (or on a built-in GPU) Whisper is usually
// no faster on the GPU than on the CPU, so the CPU build is recommended.
var SMALL_GPU_MIB = 4096;

var OWN_SOURCE_DIR = "~/.local/share/plasmallm/whisper.cpp";
var CT2_WRAPPER = "~/.local/share/plasmallm/bin/whisper-ctranslate2";
var WHISPER_CPP_REPO = "https://github.com/ggml-org/whisper.cpp";
// PyTorch's CUDA builds cover different GPU generations:
// - cu128 has no kernels for Maxwell and Pascal (sm_50 to sm_61) since
//   PyTorch 2.8, and none for Volta (sm_70) since 2.11. The 2.8.0 and 2.11.0
//   release notes both say to use the CUDA 12.6 builds for those cards:
//   https://github.com/pytorch/pytorch/releases/tag/v2.8.0
//   https://github.com/pytorch/pytorch/releases/tag/v2.11.0
// - cu126 still has sm_50 to sm_90. pytorch/pytorch#190385 proposes
//   dropping it in 2.15; the index keeps the wheels already published.
// - Below compute capability 5.0 no current CUDA build works at all.
var TORCH_INDEX = {
    cpu: "https://download.pytorch.org/whl/cpu",
    cuda: "https://download.pytorch.org/whl/cu128",
    "cuda-legacy": "https://download.pytorch.org/whl/cu126"
};
var TORCH_CU128_MIN_CC = 7.5;
var CUDA_MIN_CC = 5.0;
// CTranslate2 runs float16 only from compute capability 7.0; below that
// it uses float32 (int8_float32 on 6.1), so a model takes about as much
// memory as in openai-whisper.
var CT2_FLOAT16_MIN_CC = 7.0;

// Approximate GPU memory in GB. openai-whisper: OpenAI's published table.
// whisper-ctranslate2 in float16: roughly half of that.
var OPENAI_GPU_GB = {
    "tiny": 1, "tiny.en": 1, "base": 1, "base.en": 1,
    "small": 2, "small.en": 2, "medium": 5, "medium.en": 5,
    "large": 10, "large-v1": 10, "large-v2": 10, "large-v3": 10,
    "turbo": 6, "large-v3-turbo": 6
};
var CT2_GPU_GB = {
    "tiny": 1, "tiny.en": 1, "base": 1, "base.en": 1,
    "small": 1.5, "small.en": 1.5, "medium": 3, "medium.en": 3,
    "large": 4.5, "large-v1": 4.5, "large-v2": 4.5, "large-v3": 4.5,
    "turbo": 2.5, "large-v3-turbo": 2.5
};
var CPP_OVERHEAD_GB = 0.3;

// Build requirement → distro packages that provide it.
var PACKAGES = {
    apt: { compiler: ["build-essential"], "make": ["build-essential"], cmake: ["cmake"], git: ["git"],
           "vulkan-headers": ["libvulkan-dev"], glslc: ["glslc"], pipx: ["pipx"] },
    dnf: { compiler: ["gcc-c++"], "make": ["make"], cmake: ["cmake"], git: ["git"],
           "vulkan-headers": ["vulkan-headers", "vulkan-loader-devel"], glslc: ["glslc"], pipx: ["pipx"] },
    pacman: { compiler: ["base-devel"], "make": ["base-devel"], cmake: ["cmake"], git: ["git"],
              "vulkan-headers": ["vulkan-headers", "vulkan-icd-loader"], glslc: ["shaderc"], pipx: ["python-pipx"] },
    zypper: { compiler: ["gcc-c++"], "make": ["make"], cmake: ["cmake"], git: ["git"],
              "vulkan-headers": ["vulkan-devel"], glslc: ["shaderc"], pipx: ["python3-pipx"] }
};
var INSTALL_COMMAND = {
    apt: "sudo apt install",
    dnf: "sudo dnf install",
    pacman: "sudo pacman -S --needed",
    zypper: "sudo zypper install"
};

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function safeMarker(marker) {
    return String(marker === undefined ? "" : marker).replace(/[^A-Za-z0-9_-]/g, "");
}

// ---------------------------------------------------------------- probe

var VULKAN_AWK = "/^GPU[0-9]+:/ { if (n != \"\") printf \"VK_GPU=%s|%.0f|%s\\n\", t, m, n; t = \"\"; n = \"\"; m = 0; s = 0; next } "
    + "/^[ \\t]*deviceType[ \\t]*=/ { sub(/.*PHYSICAL_DEVICE_TYPE_/, \"\"); t = $0; next } "
    + "/^[ \\t]*deviceName[ \\t]*=/ { sub(/^[^=]*=[ \\t]*/, \"\"); n = $0; next } "
    + "/^[ \\t]*size[ \\t]*=/ { s = $3 + 0; next } "
    + "/MEMORY_HEAP_DEVICE_LOCAL_BIT/ { if (s > m) m = s; next } "
    + "END { if (n != \"\") printf \"VK_GPU=%s|%.0f|%s\\n\", t, m, n }";

var TORCH_PY = "import importlib.util as u; "
    + "print(\"WHISPER_PY=\" + (\"1\" if u.find_spec(\"whisper\") else \"0\")); "
    + "import torch; "
    + "print(\"TORCH_VERSION=\" + torch.__version__); "
    + "print(\"TORCH_CUDA=\" + (torch.version.cuda or \"\")); "
    + "print(\"TORCH_CUDA_AVAILABLE=\" + (\"1\" if torch.cuda.is_available() else \"0\")); "
    + "print(\"TORCH_ARCHS=\" + \" \".join(torch.cuda.get_arch_list() if torch.version.cuda else []))";

var CT2_PY = "import importlib.util as u; "
    + "print(\"CT2_CUDA_LIBS=\" + (\"1\" if u.find_spec(\"nvidia\") and u.find_spec(\"nvidia.cublas\") and u.find_spec(\"nvidia.cudnn\") else \"0\")); "
    + "import ctranslate2 as c; "
    + "print(\"CT2_VERSION=\" + c.__version__); "
    + "print(\"CT2_CUDA_DEVICES=\" + str(c.get_cuda_device_count()))";

// Shell lines that make the positional parameters the interpreter named in
// the #! line of the script in $<scriptVar> when that is a Python, which
// finds a pipx venv's own python where a bare python3 would not have the
// package.
function shebangPython(scriptVar) {
    return "if [ -f \"$" + scriptVar + "\" ] && [ \"$(head -c 2 -- \"$" + scriptVar + "\" 2>/dev/null)\" = \"#!\" ]; then "
        + "sb=$(head -n 1 -- \"$" + scriptVar + "\" | sed \"s/^#![[:space:]]*//\"); "
        + "case \"$sb\" in *python*) set -- $sb;; esac; fi";
}

// Runs python code with the interpreter in "$@" and prints only the KEY=
// lines it produced; if <okKey> is missing, prints <errKey>= with the last
// line of the error. It runs from / so a whisper/ or torch.py in the
// current folder (plasmashell's is usually $HOME) cannot shadow a package.
function pythonReport(code, okKey, errKey, keyPattern) {
    return "out=$(cd / && $to \"$@\" -c " + shellQuote(code) + " 2>&1); "
        + "printf \"%s\\n\" \"$out\" | grep -E \"^(" + keyPattern + ")\"; "
        + "printf \"%s\\n\" \"$out\" | grep -q \"^" + okKey + "=\" || "
        + "echo \"" + errKey + "=$(printf \"%s\\n\" \"$out\" | grep -vE \"^(" + keyPattern + ")\" | tail -n 1)\"";
}

/**
 * Read-only shell lines that print NV_GPU / NV_GPU_NOCAP / VK_GPU / DRM_GPU
 * lines for parseProbe(). They set $to and $to10 (timeouts) first.
 * Also used by the Kokoro setup (ttsAdapters/kokoroSetup.js).
 */
function gpuProbeLines() {
    var nvQuery = " --format=csv,noheader,nounits 2>/dev/null";
    return [
        // nvidia-smi and vulkaninfo can hang on a wedged driver.
        "to=; to10=; command -v timeout >/dev/null 2>&1 && { to='timeout 30'; to10='timeout -k 5 10'; }",
        // GPUs. Drivers older than about R510 reject compute_cap; the second
        // query marks their GPUs so the cap is known to be missing.
        "if nv=$($to10 nvidia-smi --query-gpu=name,memory.total,compute_cap" + nvQuery + "); then "
            + "printf '%s\\n' \"$nv\" | sed 's/^/NV_GPU=/'; "
            + "elif [ $? -lt 124 ]; then $to10 nvidia-smi --query-gpu=name,memory.total" + nvQuery + " | sed 's/^/NV_GPU_NOCAP=/'; fi",
        "$to10 vulkaninfo 2>/dev/null | awk " + shellQuote(VULKAN_AWK),
        "for c in /sys/class/drm/card[0-9]*; do case \"$c\" in *-*) continue;; esac; "
            + "[ -r \"$c/device/vendor\" ] || continue; "
            + "echo \"DRM_GPU=$(cat \"$c/device/vendor\")|$(cat \"$c/device/mem_info_vram_total\" 2>/dev/null || echo 0)|$(cat \"$c/device/boot_vga\" 2>/dev/null)\"; done"
    ];
}

/**
 * One read-only shell command that prints KEY=value lines describing the
 * GPUs, build tools, package manager and both Whisper programs.
 * @param {string} cppBinary  whisper.cpp binary setting
 * @param {string} cliBinary  Python Whisper command prefix setting
 * @param {string} [cppModel] whisper.cpp model path, for its size
 * @param {string|number} [marker] makes the command string unique
 */
function buildProbeCommand(cppBinary, cliBinary, cppModel, marker) {
    var prefix = trimStr(cliBinary) || WhisperCli.defaultPrefix();
    // The OpenAI program is probed even while Command points at ct2.
    var openaiPrefix = WhisperCli.isCt2Binary(prefix) ? WhisperCli.defaultPrefix() : prefix;
    var openaiWords = openaiPrefix.split(/\s+/);
    // Each word is quoted (a leading ~/ still expands), so a Command value
    // cannot run anything extra when the page opens.
    var launcherWords = WhisperCli.pythonLauncherFromPrefix(openaiPrefix).split(/\s+/)
        .map(WhisperCpp.shellPath).join(" ");
    var ownBuild = WhisperCpp.shellPath(WhisperCpp.OWN_BUILD_BINARY);
    var wrapper = WhisperCpp.shellPath(CT2_WRAPPER);
    var lines = [
        ": plasmallm-whisper-probe-" + safeMarker(marker),
        "echo PROBE=1"
    ].concat(gpuProbeLines(), [
        // Tools and package manager
        "for t in nvcc cmake c++ g++ clang++ make git glslc pipx python3; do command -v \"$t\" >/dev/null 2>&1 && echo \"HAVE=$t\"; done",
        "[ -x /usr/local/cuda/bin/nvcc ] && echo HAVE=nvcc",
        "{ pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; } && echo HAVE=vulkan-headers",
        "{ ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libcublas\\.so\\.12' && "
            + "{ ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libcudnn\\.so\\.9' && echo CUDA_SYS_LIBS=1",
        "for p in apt-get dnf pacman zypper; do command -v \"$p\" >/dev/null 2>&1 && { echo \"PKG_MGR=$p\"; break; }; done",
        "echo \"HOME_DIR=$HOME\"",
        // whisper.cpp: the binary the transcription would run, and which
        // GPU libraries it links. A build that links libggml-cpu links its
        // GPU backend too, so ldd is the whole answer and leftover files
        // from an older build don't count. Otherwise (GGML_BACKEND_DL) the
        // backends are loaded at run time from the binary's own folder or
        // the folder of the libggml it links, and its ggml/ subfolder.
        "c=" + WhisperCpp.binaryWord(cppBinary),
        "case \"$c\" in */*) ;; *) c=$(command -v -- \"$c\" 2>/dev/null);; esac",
        "if [ -n \"$c\" ] && [ -x \"$c\" ]; then c=$(readlink -f -- \"$c\"); d=$(dirname -- \"$c\"); echo \"CPP_BIN=$c\"; l=$(ldd \"$c\" 2>/dev/null); "
            + "{ printf '%s\\n' \"$l\"; printf '%s\\n' \"$l\" | grep -q 'libggml-cpu' || { "
            + "g=$(printf '%s\\n' \"$l\" | sed -n 's|.*=> \\(/.*\\)/libggml[-a-z]*\\.so.*|\\1|p' | head -n 1); "
            + "ls \"$d\"; [ -z \"$g\" ] || ls \"$g\" \"$g/ggml\"; }; } 2>/dev/null "
            + "| grep -oE 'libggml-(cuda|vulkan|hip|sycl|opencl)' | sed 's/^libggml-/CPP_GPU=/' | sort -u; fi",
        // The own build's real path, so a symlinked home still matches CPP_BIN.
        "[ -x " + ownBuild + " ] && { echo CPP_OWN=1; echo \"CPP_OWN_PATH=$(readlink -f -- " + ownBuild + ")\"; }",
        // OpenAI Whisper: the command, and PyTorch in its environment. A
        // fresh pipx install can land in ~/.local/bin while Plasma's PATH
        // (set at login) does not have that folder yet.
        "w=$(command -v -- " + WhisperCpp.shellPath(openaiWords[0]) + " 2>/dev/null)"
    ]);
    if (openaiPrefix === WhisperCli.defaultPrefix())
        lines.push("if [ -z \"$w\" ] && [ -x \"$HOME/.local/bin/whisper\" ]; then w=\"$HOME/.local/bin/whisper\"; echo CLI_OFF_PATH=1; fi");
    lines.push("[ -n \"$w\" ] && echo \"CLI_BIN=$w\"");
    // Whether that program is the venv `pipx runpip openai-whisper` changes,
    // the only kind of install the setup script touches. pipx's own home
    // is $PIPX_HOME, else ~/.local/pipx when it exists (older pipx), else
    // ~/.local/share/pipx. Running pipx to ask would create folders.
    lines.push("if [ -n \"$w\" ]; then wr=$(readlink -f -- \"$w\"); vd=$(dirname -- \"$(dirname -- \"$wr\")\"); "
        + "ph=${PIPX_HOME:-}; if [ -z \"$ph\" ]; then if [ -d \"$HOME/.local/pipx\" ]; then ph=\"$HOME/.local/pipx\"; else ph=\"$HOME/.local/share/pipx\"; fi; fi; "
        + "if [ -f \"$vd/pipx_metadata.json\" ] && [ \"$(readlink -f -- \"$ph/venvs/openai-whisper\")\" = \"$vd\" ]; then echo CLI_PIPX=1; fi; fi");
    lines.push("set -- " + launcherWords);
    var model = trimStr(cppModel);
    if (model.length && WhisperCpp.isAbsoluteOrHome(model))
        lines.push("m=" + WhisperCpp.shellPath(model) + "; [ -f \"$m\" ] && echo \"CPP_MODEL_BYTES=$(stat -c %s -- \"$m\")\"");
    if (launcherWords === "'python3'" && openaiWords.length === 1)
        lines.push(shebangPython("w"));
    lines.push("if [ -n \"$w\" ]; then echo \"CLI_PY=$*\"; " + pythonReport(TORCH_PY, "TORCH_VERSION", "TORCH_ERR", "TORCH_|WHISPER_PY") + "; fi");
    // whisper-ctranslate2 (faster-whisper): the pipx entry point, its venv
    // python, and whether CUDA libraries are there for it.
    lines.push("w2=$(command -v whisper-ctranslate2 2>/dev/null); "
        + "if [ -z \"$w2\" ] && [ -x \"$HOME/.local/bin/whisper-ctranslate2\" ]; then w2=\"$HOME/.local/bin/whisper-ctranslate2\"; echo CT2_OFF_PATH=1; fi");
    lines.push("[ -x " + wrapper + " ] && echo CT2_WRAPPER=1");
    lines.push("if [ -n \"$w2\" ]; then echo \"CT2_BIN=$w2\"; set -- python3; r=$(readlink -f -- \"$w2\"); "
        + shebangPython("r") + "; " + pythonReport(CT2_PY, "CT2_VERSION", "CT2_ERR", "CT2_") + "; fi");
    lines.push("echo PROBE_END=1");
    return lines.join("; ");
}

/** Probe output → plain object. Unknown lines are ignored. */
function parseProbe(stdout) {
    var p = {
        complete: false,
        nvidia: [], vulkan: [], drm: [], have: {},
        pkgMgr: "", home: "", cudaSysLibs: false,
        cpp: { bin: "", gpu: [], own: false, ownPath: "", modelBytes: 0 },
        cli: { bin: "", onPath: true, pipx: false, python: "", whisperPy: "", torchVersion: "", torchCuda: "",
               torchCudaAvailable: false, torchArchs: [], torchErr: "" },
        ct2: { bin: "", onPath: true, wrapper: false, version: "", cudaDevices: 0, cudaLibs: false, err: "" }
    };
    String(stdout || "").split("\n").forEach(function(raw) {
        var line = raw.replace(/\r$/, "");
        var eq = line.indexOf("=");
        if (eq <= 0)
            return;
        var key = line.substring(0, eq);
        var val = trimStr(line.substring(eq + 1));
        var parts, cap;
        switch (key) {
        case "PROBE_END": p.complete = true; break;
        case "NV_GPU":
        case "NV_GPU_NOCAP":
            // "name, memory[, compute_cap]"; memory or cap may be [N/A].
            parts = val.split(",").map(trimStr);
            cap = 0;
            if (key === "NV_GPU" && parts.length >= 3) {
                cap = /^\d+\.\d+$/.test(parts[parts.length - 1]) ? parseFloat(parts[parts.length - 1]) : 0;
                parts.pop();
            }
            if (parts.length >= 2)
                p.nvidia.push({ name: parts.slice(0, parts.length - 1).join(","),
                                memMiB: parseInt(parts[parts.length - 1], 10) || 0,
                                computeCap: cap, capMissing: key === "NV_GPU_NOCAP" });
            break;
        case "VK_GPU":
            parts = val.split("|");
            if (parts.length >= 3)
                p.vulkan.push({ type: parts[0], memMiB: Math.round((parseFloat(parts[1]) || 0) / 1048576), name: parts.slice(2).join("|") });
            break;
        case "DRM_GPU":
            parts = val.split("|");
            p.drm.push({ vendor: (parts[0] || "").toLowerCase(), memMiB: Math.round((parseFloat(parts[1]) || 0) / 1048576), bootVga: parts[2] === "1" });
            break;
        case "HAVE": p.have[val] = true; break;
        case "PKG_MGR": p.pkgMgr = val === "apt-get" ? "apt" : val; break;
        case "HOME_DIR": p.home = val; break;
        case "CUDA_SYS_LIBS": p.cudaSysLibs = val === "1"; break;
        case "CPP_BIN": p.cpp.bin = val; break;
        case "CPP_GPU": if (p.cpp.gpu.indexOf(val) < 0) p.cpp.gpu.push(val); break;
        case "CPP_OWN": p.cpp.own = val === "1"; break;
        case "CPP_OWN_PATH": p.cpp.ownPath = val; break;
        case "CPP_MODEL_BYTES": p.cpp.modelBytes = parseFloat(val) || 0; break;
        case "CLI_BIN": p.cli.bin = val; break;
        case "CLI_OFF_PATH": p.cli.onPath = val !== "1"; break;
        case "CLI_PIPX": p.cli.pipx = val === "1"; break;
        case "CLI_PY": p.cli.python = val; break;
        case "TORCH_ARCHS": p.cli.torchArchs = val.split(/\s+/).filter(function(s) { return s.length > 0; }); break;
        case "CT2_OFF_PATH": p.ct2.onPath = val !== "1"; break;
        case "WHISPER_PY": p.cli.whisperPy = val; break;
        case "TORCH_VERSION": p.cli.torchVersion = val; break;
        case "TORCH_CUDA": p.cli.torchCuda = val; break;
        case "TORCH_CUDA_AVAILABLE": p.cli.torchCudaAvailable = val === "1"; break;
        case "TORCH_ERR": p.cli.torchErr = val; break;
        case "CT2_BIN": p.ct2.bin = val; break;
        case "CT2_WRAPPER": p.ct2.wrapper = val === "1"; break;
        case "CT2_VERSION": p.ct2.version = val; break;
        case "CT2_CUDA_DEVICES": p.ct2.cudaDevices = parseInt(val, 10) || 0; break;
        case "CT2_CUDA_LIBS": p.ct2.cudaLibs = val === "1"; break;
        case "CT2_ERR": p.ct2.err = val; break;
        }
    });
    return p;
}

// ---------------------------------------------------------------- GPUs

function vendorFromName(name) {
    var n = String(name || "");
    if (/nvidia|geforce|quadro|tesla|rtx/i.test(n)) return "nvidia";
    if (/amd|radeon|ati /i.test(n)) return "amd";
    if (/intel/i.test(n)) return "intel";
    return "other";
}

var DRM_VENDORS = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

function vendorLabel(vendor) {
    switch (vendor) {
    case "nvidia": return i18n("NVIDIA GPU");
    case "amd": return i18n("AMD GPU");
    case "intel": return i18n("Intel GPU");
    }
    return i18n("GPU");
}

function isSoftwareVulkan(v) {
    return v.type === "CPU" || /llvmpipe|lavapipe|swiftshader/i.test(v.name);
}

/**
 * Real GPUs, merged from nvidia-smi, vulkaninfo and (when vulkaninfo
 * listed no real GPU) /sys/class/drm. Software renderers are dropped.
 * NVIDIA entries carry computeCap (0 when unknown) and capMissing (the
 * driver is too old to report it).
 */
function gpuList(probe) {
    var out = [];
    var realVulkan = (probe.vulkan || []).filter(function(v) { return !isSoftwareVulkan(v); });
    var vulkanNvidia = realVulkan.filter(function(v) { return vendorFromName(v.name) === "nvidia"; });
    (probe.nvidia || []).forEach(function(g, i) {
        // nvidia-smi says [N/A] for memory on unified-memory parts; Vulkan
        // still reports a heap size for the same card.
        var mem = g.memMiB;
        if (!mem && vulkanNvidia[i])
            mem = vulkanNvidia[i].memMiB;
        out.push({ vendor: "nvidia", name: g.name, memMiB: mem, integrated: false,
                   computeCap: g.computeCap || 0, capMissing: !!g.capMissing });
    });
    var hasNvidiaSmi = out.length > 0;
    realVulkan.forEach(function(v) {
        var vendor = vendorFromName(v.name);
        if (vendor === "nvidia" && hasNvidiaSmi)
            return;
        out.push({ vendor: vendor, name: v.name, memMiB: v.memMiB, computeCap: 0, capMissing: false,
                   integrated: v.type === "INTEGRATED_GPU" || v.type === "VIRTUAL_GPU" });
    });
    if (!realVulkan.length) {
        // vulkaninfo ran but saw only the software renderer: the card has
        // no Vulkan driver, which a Vulkan build needs.
        var vulkanRan = (probe.vulkan || []).length > 0;
        (probe.drm || []).forEach(function(d) {
            var vendor = DRM_VENDORS[d.vendor] || "other";
            if (vendor === "nvidia" && hasNvidiaSmi)
                return;
            out.push({ vendor: vendor, name: vendorLabel(vendor), memMiB: d.memMiB, computeCap: 0, capMissing: false,
                       integrated: vendor === "intel", noVulkanDriver: vulkanRan });
        });
    }
    return out;
}

/**
 * Whether current CUDA builds (CUDA 12 and later: PyTorch, CTranslate2,
 * whisper.cpp) can use an NVIDIA GPU: "ok", "old-driver" or "too-old".
 */
function cudaSupport(g) {
    if (!g || g.vendor !== "nvidia")
        return "none";
    if (g.capMissing)
        return "old-driver";
    if (g.computeCap > 0 && g.computeCap < CUDA_MIN_CC)
        return "too-old";
    return "ok";
}

function cudaUnsupportedReason(g) {
    if (cudaSupport(g) === "old-driver")
        return i18n("The NVIDIA driver for %1 is too old for current CUDA programs (it does not report the GPU's compute capability). A newer driver would let Whisper use it.", describeGpu(g));
    return i18n("%1 (compute capability %2) is older than any current CUDA build supports.", describeGpu(g), g.computeCap);
}

/** TORCH_INDEX key for CUDA PyTorch on this GPU: cu128 or the older cu126. */
function torchCudaIndexKey(g) {
    var cc = g ? g.computeCap || 0 : 0;
    return cc > 0 && cc < TORCH_CU128_MIN_CC ? "cuda-legacy" : "cuda";
}

/**
 * Whether a PyTorch built for the given arch list (torch.cuda.get_arch_list())
 * has kernels for compute capability <cc>: a cubin of the same major version
 * and no newer minor, or PTX for an older capability. Unknown counts as yes.
 */
function torchArchsSupport(archs, cc) {
    if (!archs || !archs.length || !(cc > 0))
        return true;
    var want = Math.round(cc * 10);
    var major = Math.floor(want / 10);
    return archs.some(function(a) {
        var m = /^(sm|compute)_(\d+)$/.exec(a);
        if (!m)
            return false;
        var v = parseInt(m[2], 10);
        if (m[1] === "sm")
            return Math.floor(v / 10) === major && v <= want;
        return v <= want;
    });
}

/** The NVIDIA GPU CUDA programs would use: the largest one they support. */
function cudaGpu(gpus) {
    return bestOf(gpus.filter(function(g) { return cudaSupport(g) === "ok" && isUsableGpu(g); }));
}

/** TORCH_INDEX URL for a CUDA PyTorch on this computer. */
function torchCudaIndex(probe) {
    var gpus = gpuList(probe || parseProbe(""));
    var g = cudaGpu(gpus) || bestOf(gpus.filter(function(x) { return cudaSupport(x) === "ok"; }));
    return TORCH_INDEX[torchCudaIndexKey(g)];
}

function isUsableGpu(g) {
    return !!g && !g.integrated && g.memMiB >= SMALL_GPU_MIB;
}

function bestOf(list) {
    var best = null;
    list.forEach(function(g) {
        if (!best || (best.integrated && !g.integrated)
                || (best.integrated === g.integrated && g.memMiB > best.memMiB))
            best = g;
    });
    return best;
}

function formatGb(value) {
    var r = Math.round(value * 10) / 10;
    return String(r);
}

function describeGpu(g) {
    if (!g)
        return "";
    if (g.integrated)
        return i18n("%1 (built-in)", g.name);
    if (g.memMiB > 0)
        return i18n("%1 (%2 GB)", g.name, formatGb(g.memMiB / 1024));
    return g.name;
}

function contractHome(path, home) {
    var p = String(path || "");
    if (home && home.length > 1 && p.indexOf(home + "/") === 0)
        return "~" + p.substring(home.length);
    return p;
}

// ---------------------------------------------------------------- packages

function hasRequirement(probe, req) {
    var have = probe.have || {};
    if (req === "compiler")
        return !!(have["c++"] || have["g++"] || have["clang++"]);
    return !!have[req];
}

function requirementsFor(kind, flavor) {
    if (kind === "whisper_cpp") {
        // make: cmake's default generator writes Makefiles, and Fedora's and
        // openSUSE's compiler packages don't pull make in.
        var reqs = ["compiler", "make", "cmake", "git"];
        if (flavor === "vulkan")
            reqs.push("vulkan-headers", "glslc");
        return reqs;
    }
    return ["pipx"];
}

/**
 * What the offer still needs: requirement ids, the distro packages that
 * provide them, and the exact install command (empty when the package
 * manager is unknown or nothing is missing).
 */
function missingPackages(probe, kind, flavor) {
    var missing = requirementsFor(kind, flavor).filter(function(r) { return !hasRequirement(probe, r); });
    var table = PACKAGES[probe.pkgMgr];
    var packages = [];
    if (table) {
        missing.forEach(function(r) {
            (table[r] || []).forEach(function(pkg) {
                if (packages.indexOf(pkg) < 0)
                    packages.push(pkg);
            });
        });
    }
    return {
        missing: missing,
        packages: packages,
        command: packages.length ? INSTALL_COMMAND[probe.pkgMgr] + " " + packages.join(" ") : ""
    };
}

// ---------------------------------------------------------------- recommend

function declinedList(declined) {
    if (Array.isArray(declined))
        return declined.map(trimStr).filter(function(s) { return s.length > 0; });
    return String(declined || "").split(",").map(trimStr).filter(function(s) { return s.length > 0; });
}

function cppFlavorLabel(flavor) {
    switch (flavor) {
    case "cpu": return i18n("CPU-only");
    case "cuda": return i18n("CUDA");
    case "vulkan": return i18n("Vulkan");
    case "hip": return i18n("ROCm (HIP)");
    case "sycl": return i18n("SYCL");
    case "opencl": return i18n("OpenCL");
    }
    return flavor;
}

function cppBuildLabel(flavor, rebuild) {
    if (rebuild) {
        if (flavor === "cuda") return i18n("Rebuild with CUDA");
        if (flavor === "vulkan") return i18n("Rebuild with Vulkan");
        return i18n("Rebuild for CPU only");
    }
    if (flavor === "cuda") return i18n("Build whisper.cpp (CUDA)");
    if (flavor === "vulkan") return i18n("Build whisper.cpp (Vulkan)");
    return i18n("Build whisper.cpp (CPU)");
}

function cliOfferLabel(flavor) {
    switch (flavor) {
    case "ct2-cpu": return i18n("Install faster-whisper (CPU)");
    case "ct2-cuda": return i18n("Install faster-whisper (CUDA)");
    case "openai-cpu": return i18n("Install OpenAI Whisper (CPU)");
    case "openai-cuda": return i18n("Install OpenAI Whisper (CUDA)");
    }
    return flavor;
}

function makeOffer(probe, kind, flavor, label, reason, optional, declined) {
    var id = kind + ":" + flavor;
    var pk = missingPackages(probe, kind, flavor.replace(/^(ct2|openai)-/, ""));
    return {
        id: id, kind: kind, flavor: flavor, label: label, reason: reason,
        optional: !!optional, declined: declined.indexOf(id) >= 0,
        missing: pk.missing, packages: pk.packages, packageCommand: pk.command
    };
}

// A "Use it" suggestion (set Command/Binary, maybe Device). It has a
// decline id like the offers; commas would split the declined list.
function useChoice(kind, path, device, message, declined) {
    var id = "use:" + kind + ":" + String(path).replace(/,/g, "%2C");
    return { id: id, path: path, device: device, message: message, declined: declined.indexOf(id) >= 0 };
}

// The first suggestion not declined, else the first one (marked declined).
function pickChoice(choices) {
    var open = choices.filter(function(c) { return !c.declined; });
    return open.length ? open[0] : (choices[0] || null);
}

function smallGpuReason(g) {
    if (g.integrated)
        return i18n("%1 is a built-in GPU, which is usually no faster than the CPU for Whisper.", describeGpu(g));
    if (g.memMiB > 0)
        return i18n("%1 has under %2 GB of memory, which only fits the small models and is usually no faster than the CPU.", describeGpu(g), formatGb(SMALL_GPU_MIB / 1024));
    return i18n("The memory of %1 is unknown, so the CPU is the safe choice.", describeGpu(g));
}

function noVulkanDriverReason(g) {
    return i18n("%1 was found, but it has no Vulkan driver (vulkaninfo lists only the software renderer). Install your distribution's Vulkan driver to use it; until then the CPU build is the right one.", describeGpu(g));
}

function recommendCpp(probe, gpus, opts, declined) {
    var best = bestOf(gpus.filter(function(g) { return isUsableGpu(g) && !g.noVulkanDriver; }));
    var noDriver = bestOf(gpus.filter(function(g) { return isUsableGpu(g) && g.noVulkanDriver; }));
    var any = bestOf(gpus);
    var nvcc = !!(probe.have || {}).nvcc;
    var cudaNvidia = gpus.filter(function(g) { return cudaSupport(g) === "ok"; });
    var usableNvidia = cudaNvidia.filter(isUsableGpu);

    var ideal = "cpu";
    var why;
    if (usableNvidia.length && nvcc) {
        ideal = "cuda";
        why = i18n("This computer has %1 and the CUDA compiler, so a CUDA build will use it.", describeGpu(bestOf(usableNvidia)));
    } else if (best) {
        ideal = "vulkan";
        if (best.vendor === "nvidia" && cudaSupport(best) === "ok")
            why = i18n("This computer has %1; a Vulkan build will use it. Installing NVIDIA's CUDA toolkit (nvcc) would make a faster CUDA build possible.", describeGpu(best));
        else
            why = i18n("This computer has %1; a Vulkan build will use it.", describeGpu(best));
    } else if (noDriver) {
        why = noVulkanDriverReason(noDriver);
    } else if (any) {
        why = smallGpuReason(any) + " " + i18n("The CPU build is the right one.");
    } else {
        why = i18n("No graphics card was found, so the CPU build is the right one.");
    }
    var optionalFlavor = "";
    if (!best && !noDriver && any)
        optionalFlavor = (cudaNvidia.length && nvcc) ? "cuda" : (any.noVulkanDriver ? "" : "vulkan");

    var bin = probe.cpp.bin;
    var installed = bin.length > 0;
    var homeOwnPath = probe.home ? probe.home + WhisperCpp.OWN_BUILD_BINARY.substring(1) : "";
    // The probe resolves symlinks in CPP_BIN, so compare with the own
    // build's real path when it has one (a symlinked home).
    var ownPath = probe.cpp.ownPath || homeOwnPath;
    // "Rebuild" only for the copy this page builds; any other install is left alone.
    var isOwn = installed && (bin === ownPath || bin === homeOwnPath);
    var have = "cpu";
    ["cuda", "vulkan", "hip", "sycl", "opencl"].forEach(function(f) {
        if (have === "cpu" && probe.cpp.gpu.indexOf(f) >= 0)
            have = f;
    });

    var status, verdict;
    var offers = [];
    if (!installed) {
        status = "missing";
        verdict = i18n("whisper.cpp was not found.") + " " + why;
        offers.push(makeOffer(probe, "whisper_cpp", ideal, cppBuildLabel(ideal, false), why, false, declined));
    } else if (have === ideal) {
        status = "ok";
        verdict = i18n("This is the right build for this computer.");
    } else if (ideal !== "cpu" && have === "cpu") {
        status = "cpu_on_gpu";
        verdict = why;
        offers.push(makeOffer(probe, "whisper_cpp", ideal, cppBuildLabel(ideal, isOwn), why, false, declined));
    } else if (ideal === "cpu") {
        status = "gpu_no_gpu";
        verdict = (noDriver ? noVulkanDriverReason(noDriver) : any ? smallGpuReason(any) : i18n("No graphics card was found.")) + " "
            + i18n("A CPU build is recommended; setting Device to cpu also works with this build.");
        offers.push(makeOffer(probe, "whisper_cpp", "cpu", cppBuildLabel("cpu", isOwn), verdict, false, declined));
    } else {
        status = "ok";
        verdict = i18n("This build can use the GPU.");
        if (ideal === "cuda")
            offers.push(makeOffer(probe, "whisper_cpp", "cuda", cppBuildLabel("cuda", isOwn),
                i18n("Optional: a CUDA build is usually faster on NVIDIA."), true, declined));
    }
    if (optionalFlavor && have !== optionalFlavor && have === "cpu")
        offers.push(makeOffer(probe, "whisper_cpp", optionalFlavor, cppBuildLabel(optionalFlavor, isOwn),
            i18n("Optional: build for the GPU anyway.") + " " + smallGpuReason(any), true, declined));

    var found = installed
        ? i18n("Found whisper.cpp at %1 — %2 build.", contractHome(bin, probe.home), cppFlavorLabel(have))
        : "";

    var warnings = [];
    var usesGpu = installed && have !== "cpu" && trimStr(opts.cppDevice) !== "cpu";
    var gpu = best || any;
    if (usesGpu && gpu && gpu.memMiB > 0 && probe.cpp.modelBytes > 0) {
        var needGb = probe.cpp.modelBytes / 1073741824 + CPP_OVERHEAD_GB;
        if (needGb > gpu.memMiB / 1024)
            warnings.push(i18n("This model needs about %1 GB of GPU memory; %2 has %3 GB. Set Device to cpu or pick a smaller model.",
                formatGb(needGb), gpu.name, formatGb(gpu.memMiB / 1024)));
    }

    var useBinary = null;
    if (probe.cpp.own && ownPath && !isOwn)
        useBinary = useChoice("whisper_cpp", WhisperCpp.OWN_BUILD_BINARY, "",
            i18n("A whisper.cpp built from this page is at %1, but %2 is used first.",
                WhisperCpp.OWN_BUILD_BINARY, contractHome(bin, probe.home) || "whisper-cli"), declined);

    return {
        status: status, installed: installed, path: bin, build: have, ideal: ideal,
        message: (found ? found + " " : "") + verdict,
        warnings: warnings, offers: offers, useBinary: useBinary
    };
}

// Text for switching PyTorch in an install the setup script doesn't
// manage: the command for that environment's own pip, run by the user.
function manualTorchSwitch(cli, index) {
    var py = trimStr(cli.python);
    if (!py.length || /^\/usr\//.test(py))
        return i18n("Setup changes PyTorch only in a pipx install of openai-whisper, and this one is not. To switch it, reinstall torch from %1 with the tool you installed Whisper with.", index);
    return i18n("Setup changes PyTorch only in a pipx install of openai-whisper, and this one is not. To switch it, run: %1",
        py + " -m pip install --force-reinstall torch --index-url " + index);
}

function recommendCli(probe, gpus, opts, declined) {
    // NVIDIA GPUs that CUDA 12 builds support, then the ones big enough to use.
    var cudaNvidia = gpus.filter(function(g) { return cudaSupport(g) === "ok"; });
    var usableNvidia = bestOf(cudaNvidia.filter(isUsableGpu));
    var smallNvidia = usableNvidia ? null : bestOf(cudaNvidia);
    var anyNvidia = bestOf(gpus.filter(function(g) { return g.vendor === "nvidia"; }));
    var unsupportedNvidia = usableNvidia ? null
        : bestOf(gpus.filter(function(g) { return g.vendor === "nvidia" && isUsableGpu(g) && cudaSupport(g) !== "ok"; }));
    var ideal = usableNvidia ? "cuda" : "cpu";
    var device = trimStr(opts.cliDevice);
    var model = trimStr(opts.cliModel);
    var cliBinary = trimStr(opts.cliBinary);
    var active = WhisperCli.isCt2Binary(cliBinary) ? "ct2" : "openai";

    var cli = probe.cli;
    var openaiInstalled = cli.bin.length > 0 && cli.whisperPy !== "0";
    var torch = cli.torchVersion ? (cli.torchCuda ? "cuda" : "cpu") : "";
    // The GPU a CUDA PyTorch runs on, and whether that PyTorch has kernels for it.
    var torchGpu = usableNvidia || smallNvidia || anyNvidia;
    var torchNoKernels = torch === "cuda" && !!torchGpu && torchGpu.computeCap > 0
        && !torchArchsSupport(cli.torchArchs, torchGpu.computeCap);
    var cudaIndexKey = torchCudaIndexKey(usableNvidia || smallNvidia);
    var ct2 = probe.ct2;
    var ct2Installed = ct2.bin.length > 0 && ct2.version.length > 0;
    var ct2Where = contractHome(ct2.bin, probe.home);
    var commandIsWrapper = contractHome(cliBinary, probe.home) === CT2_WRAPPER;
    // pip's CUDA libraries reach whisper-ctranslate2 only through the
    // wrapper (it sets LD_LIBRARY_PATH); system libraries always do.
    var ct2LibsInstalled = ct2.cudaLibs || probe.cudaSysLibs;
    var ct2CudaReady = probe.cudaSysLibs || (ct2.cudaLibs && commandIsWrapper);
    var ct2CudaViaWrapper = probe.cudaSysLibs || (ct2.cudaLibs && ct2.wrapper);

    var why = usableNvidia
        ? i18n("This computer has %1, so the CUDA version will use it.", describeGpu(usableNvidia))
        : unsupportedNvidia
        ? cudaUnsupportedReason(unsupportedNvidia) + " " + i18n("The CPU version is the right one.")
        : anyNvidia
        ? smallGpuReason(anyNvidia) + " " + i18n("The CPU version is the right one.")
        : i18n("There is no NVIDIA GPU, so the CPU version is the right one (a much smaller download).");
    var legacyNote = usableNvidia && cudaIndexKey === "cuda-legacy"
        ? " " + i18n("%1 has compute capability %2, so it needs PyTorch's CUDA 12.6 build; the newer CUDA builds have no kernels for it.",
            describeGpu(usableNvidia), usableNvidia.computeCap)
        : "";

    var status, verdict;
    var offers = [];
    var warnings = [];
    var choices = [];
    var smallGpuDefault = anyNvidia && !usableNvidia && device !== "cpu";

    if (active === "ct2") {
        if (!ct2Installed) {
            status = "missing";
            verdict = ct2.bin && ct2.err
                ? i18n("Found whisper-ctranslate2 at %1, but it did not start: %2", ct2Where, ct2.err)
                : i18n("whisper-ctranslate2 was not found.");
        } else if (ideal === "cuda" && !ct2CudaReady) {
            status = "cpu_on_gpu";
            verdict = (ct2LibsInstalled
                ? i18n("Found whisper-ctranslate2 at %1. Its CUDA libraries are installed, but it finds them only when started through %2.", ct2Where, CT2_WRAPPER)
                : i18n("Found whisper-ctranslate2 at %1, without the CUDA libraries.", ct2Where)) + " " + why;
        } else {
            status = "ok";
            verdict = i18n("Found whisper-ctranslate2 at %1.", ct2Where) + " "
                + i18n("This is the right setup for this computer.");
        }
        // Any Device but cpu makes ct2 use CUDA when it sees a GPU.
        if (ct2Installed && ct2.cudaDevices > 0 && !ct2CudaReady && device !== "cpu")
            warnings.push(i18n("With Device “%1”, whisper-ctranslate2 tries the NVIDIA GPU, and its CUDA libraries are not installed or not on its library path, so it will fail. Set Device to cpu.",
                device || i18n("Default")));
        else if (smallGpuDefault && ct2Installed && ct2CudaReady)
            warnings.push(i18n("Device “Default” will use %1. Set Device to cpu.", describeGpu(anyNvidia)));
        if (ct2Installed && ideal === "cuda" && ct2.cudaLibs && ct2.wrapper && !commandIsWrapper && !probe.cudaSysLibs)
            choices.push(useChoice("whisper_cli", CT2_WRAPPER, "",
                i18n("The CUDA libraries for whisper-ctranslate2 are loaded through %1.", CT2_WRAPPER), declined));
        if (ct2Installed && !ct2.onPath && cliBinary === WhisperCli.CT2_NAME)
            choices.push(useChoice("whisper_cli", ct2Where, "",
                i18n("%1 is not on Plasma's PATH (it was probably installed after you logged in), so Command needs its full path.", ct2Where), declined));
    } else {
        if (!openaiInstalled) {
            status = "missing";
            verdict = i18n("OpenAI Whisper was not found.");
        } else if (!torch) {
            status = "missing";
            verdict = i18n("Found Whisper at %1, but PyTorch did not load: %2", contractHome(cli.bin, probe.home), cli.torchErr || "?");
        } else {
            var found = i18n("Found Whisper at %1 with %2 PyTorch.", contractHome(cli.bin, probe.home), torch === "cuda" ? "CUDA" : "CPU");
            var switchTo = "";
            var switchWhy = "";
            if (torchNoKernels) {
                // e.g. a cu128 PyTorch on a Pascal card: torch.cuda.is_available()
                // is still true, and the first transcription fails.
                status = ideal === "cuda" ? "cpu_on_gpu" : "gpu_no_gpu";
                verdict = found + " " + i18n("This PyTorch has no CUDA kernels for %1 (compute capability %2), so Whisper fails on the GPU with “no kernel image”.",
                    describeGpu(torchGpu), torchGpu.computeCap) + " " + why + legacyNote;
                switchTo = ideal === "cuda" ? "openai-cuda" : "openai-cpu";
                switchWhy = verdict;
                if (device !== "cpu")
                    warnings.push(i18n("Set Device to cpu until PyTorch is switched."));
            } else if (torch === ideal || (torch === "cuda" && anyNvidia)) {
                status = "ok";
                verdict = found + " " + i18n("This is the right build for this computer.");
                if (torch === "cuda" && !cli.torchCudaAvailable)
                    warnings.push(i18n("PyTorch is the CUDA build but cannot reach the GPU. Check the NVIDIA driver, or set Device to cpu."));
                if (torch === "cuda" && smallGpuDefault)
                    warnings.push(i18n("Device “Default” will use %1. Set Device to cpu.", describeGpu(anyNvidia)));
            } else if (ideal === "cuda") {
                status = "cpu_on_gpu";
                verdict = found + " " + why + legacyNote;
                switchTo = "openai-cuda";
                switchWhy = why + legacyNote;
            } else {
                status = "gpu_no_gpu";
                verdict = found + " " + i18n("There is no NVIDIA GPU for it to use; the CPU build is much smaller.");
                switchTo = "openai-cpu";
                switchWhy = verdict;
            }
            // The script swaps torch in pipx's openai-whisper venv; any other
            // install (pip --user, distro package, conda, a container) gets
            // instructions instead of a button that would change a second copy.
            if (switchTo && cli.pipx)
                offers.push(makeOffer(probe, "whisper_cli", switchTo,
                    switchTo === "openai-cuda" ? i18n("Switch PyTorch to CUDA") : i18n("Switch PyTorch to CPU"), switchWhy, false, declined));
            else if (switchTo)
                warnings.push(manualTorchSwitch(cli, TORCH_INDEX[switchTo === "openai-cuda" ? cudaIndexKey : "cpu"]));
        }
        if (openaiInstalled && !cli.onPath && (!cliBinary.length || cliBinary === WhisperCli.defaultPrefix()))
            choices.push(useChoice("whisper_cli", contractHome(cli.bin, probe.home), "",
                i18n("%1 is not on Plasma's PATH (it was probably installed after you logged in), so Command needs its full path.",
                    contractHome(cli.bin, probe.home)), declined));
        if (ct2Installed) {
            // A bare name only when Plasma's PATH finds it.
            var ct2Cuda = ideal === "cuda" && ct2CudaViaWrapper;
            var ct2Path = (ct2Cuda && !probe.cudaSysLibs) ? CT2_WRAPPER
                : ct2.onPath ? WhisperCli.CT2_NAME : ct2Where;
            choices.push(useChoice("whisper_cli", ct2Path, ct2Cuda ? "" : "cpu",
                i18n("faster-whisper (whisper-ctranslate2) is installed and runs the same models up to 4× faster."), declined));
        }
    }
    var useBinary = pickChoice(choices);

    // faster-whisper is the recommended Python install.
    var ct2Reason = i18n("Recommended: faster-whisper (whisper-ctranslate2) runs the same models up to 4× faster with less memory.");
    if (!ct2Installed)
        offers.push(makeOffer(probe, "whisper_cli", "ct2-" + ideal, cliOfferLabel("ct2-" + ideal),
            ct2Reason + " " + why, false, declined));
    else if (ideal === "cuda" && !ct2CudaViaWrapper)
        // Also when the libraries are there but the wrapper is not: the
        // script writes it.
        offers.push(makeOffer(probe, "whisper_cli", "ct2-cuda", i18n("Add CUDA to faster-whisper"), why, false, declined));
    if (smallNvidia && !(ct2Installed && ct2LibsInstalled))
        offers.push(makeOffer(probe, "whisper_cli", "ct2-cuda", cliOfferLabel("ct2-cuda"),
            i18n("Optional: use the GPU anyway.") + " " + smallGpuReason(smallNvidia), true, declined));
    if (!openaiInstalled && !ct2Installed)
        offers.push(makeOffer(probe, "whisper_cli", "openai-" + ideal, cliOfferLabel("openai-" + ideal),
            i18n("Optional: OpenAI's original Python program (slower, larger download)."), true, declined));

    // Memory: only when the GPU will run the model. Below compute
    // capability 7.0 ct2 runs float32, about openai-whisper's size.
    var gpu = usableNvidia || smallNvidia || anyNvidia;
    var ct2Fp32 = !!gpu && gpu.computeCap > 0 && gpu.computeCap < CT2_FLOAT16_MIN_CC;
    var memTable = active === "ct2" && !ct2Fp32 ? CT2_GPU_GB : OPENAI_GPU_GB;
    var onGpu = active === "ct2"
        ? (ct2Installed && ct2CudaReady && device !== "cpu")
        : (torch === "cuda" && !torchNoKernels && device !== "cpu");
    if (onGpu && gpu && gpu.memMiB > 0 && memTable[model] && memTable[model] > gpu.memMiB / 1024)
        warnings.push(i18n("The %1 model needs about %2 GB of GPU memory; %3 has %4 GB. Set Device to cpu or pick a smaller model.",
            model, formatGb(memTable[model]), gpu.name, formatGb(gpu.memMiB / 1024)));

    // Whether Device cuda works with the Command as it is now.
    var cudaUsable = active === "ct2"
        ? (ct2Installed && ct2CudaReady && ct2.cudaDevices > 0)
        : (cli.torchCudaAvailable && !torchNoKernels);

    return {
        status: status, active: active, installed: active === "ct2" ? ct2Installed : openaiInstalled,
        path: active === "ct2" ? ct2.bin : cli.bin, build: active === "ct2" ? (ct2CudaReady ? "cuda" : "cpu") : torch,
        ideal: ideal, message: verdict, warnings: warnings, offers: dedupeOffers(offers), useBinary: useBinary,
        cudaKnown: active === "ct2" ? ct2.version.length > 0 : cli.torchVersion.length > 0, cudaUsable: cudaUsable
    };
}

function dedupeOffers(offers) {
    var seen = {};
    return offers.filter(function(o) {
        if (seen[o.id])
            return false;
        seen[o.id] = true;
        return true;
    });
}

/**
 * @param {object} probe  parseProbe() output
 * @param {object} [opts]
 * @param {string|string[]} [opts.declined]  offer ids the user declined (comma-separated)
 * @param {string} [opts.cppDevice]   whisper.cpp Device setting
 * @param {string} [opts.cliBinary]   Python Whisper Command setting
 * @param {string} [opts.cliDevice]   Python Whisper Device setting
 * @param {string} [opts.cliModel]    Python Whisper model id
 * @returns {{gpus: Array, best: object, whisper_cpp: object, whisper_cli: object}}
 */
function recommend(probe, opts) {
    opts = opts || {};
    var declined = declinedList(opts.declined);
    var gpus = gpuList(probe);
    return {
        gpus: gpus,
        best: bestOf(gpus),
        whisper_cpp: recommendCpp(probe, gpus, opts, declined),
        whisper_cli: recommendCli(probe, gpus, opts, declined)
    };
}

/** cfg_sttSetupDeclined with ids added or removed. */
function updateDeclined(current, addIds, removeIds) {
    var list = declinedList(current);
    (removeIds || []).forEach(function(id) {
        var i = list.indexOf(id);
        if (i >= 0)
            list.splice(i, 1);
    });
    (addIds || []).forEach(function(id) {
        if (list.indexOf(id) < 0)
            list.push(id);
    });
    return list.join(",");
}

// ---------------------------------------------------------------- scripts

function say(text) {
    return "echo " + shellQuote(text);
}

/**
 * Start of a setup script: deletes its own file, writes ok/failed plus the
 * id to the status file on exit, and defines step() and ask().
 * @param {string} id
 * @param {object} [opts]  { title, statusName, doneText } for other setups
 *                         (Kokoro); the defaults are Whisper's.
 */
function scriptHeader(id, opts) {
    opts = opts || {};
    return [
        "#!/usr/bin/env bash",
        "# " + (opts.title || "PlasmaLLM Whisper setup") + ": " + id,
        "rm -f -- \"$0\"",
        "STATUS_FILE=\"${XDG_CACHE_HOME:-$HOME/.cache}/plasmallm/" + (opts.statusName || "whisper-setup.status") + "\"",
        "mkdir -p -- \"$(dirname -- \"$STATUS_FILE\")\"",
        "finish() {",
        "    code=$?",
        "    if [ \"$code\" -eq 0 ]; then",
        "        echo \"ok " + id + "\" > \"$STATUS_FILE\"",
        "        echo; " + say(opts.doneText || i18n("Setup finished. Go back to the Speech settings page and press Check again.")),
        "    else",
        "        echo \"failed " + id + "\" > \"$STATUS_FILE\"",
        "        echo; " + say(i18n("Setup failed. The error is above.")) + "; echo \"(exit $code)\"",
        "    fi",
        "    echo; read -r -p " + shellQuote(i18n("Press Enter to close")) + " _ || true",
        "}",
        "trap finish EXIT",
        "step() { printf '\\n+ %s\\n' \"$*\"; \"$@\"; }",
        "ask() { local a; read -r -p \"$1 [y/N] \" a || return 1; case \"$a\" in [yY]|[yY][eE][sS]) return 0;; esac; return 1; }",
        "set -e"
    ];
}

function packageLines(probe, kind, baseFlavor) {
    var pk = missingPackages(probe, kind, baseFlavor);
    if (!pk.missing.length)
        return [];
    if (!pk.command.length)
        return [
            say(i18n("These are needed and could not be found: %1. Install them with your package manager, then run setup again.", pk.missing.join(", "))),
            "exit 1"
        ];
    return [
        say(i18n("These packages are needed: %1", pk.packages.join(" "))),
        say(i18n("This command installs them:")),
        say("  " + pk.command),
        "if ask " + shellQuote(i18n("Run it now?")) + "; then step " + pk.command + "; else "
            + say(i18n("Skipped. Install them yourself, then run setup again.")) + "; exit 1; fi"
    ];
}

// Runs before the package step, so nobody installs packages for a CUDA
// build that then stops because nvcc is missing.
function nvccCheckLines() {
    return [
        "if ! command -v nvcc >/dev/null 2>&1; then",
        "    if [ -x /usr/local/cuda/bin/nvcc ]; then export PATH=\"/usr/local/cuda/bin:$PATH\"; else",
        "        " + say(i18n("The CUDA compiler (nvcc) was not found. Install NVIDIA's CUDA toolkit yourself (it is large, so setup does not install it), or choose the Vulkan build.")) + "; exit 1",
        "    fi",
        "fi"
    ];
}

function cppScriptLines(flavor, probe, opts) {
    var lines = [];
    var cuda = flavor === "cuda" ? "1" : "0";
    var vulkan = flavor === "vulkan" ? "1" : "0";
    var flags = "-DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=" + cuda + " -DGGML_VULKAN=" + vulkan;
    var scan = WhisperCpp.buildScanCommand(opts.cppModelDirs);
    lines.push(
        "SRC=" + WhisperCpp.shellPath(OWN_SOURCE_DIR),
        // The newest release tag (no -rc), so a broken commit on master
        // doesn't break the build; master only when the tag lookup fails.
        "TAG=$(git ls-remote --tags --refs --sort=-version:refname " + WHISPER_CPP_REPO + " 'v*' 2>/dev/null | sed 's|.*refs/tags/||' | grep -v -- - | head -n 1 || true)",
        "if [ -d \"$SRC/.git\" ]; then",
        "    if [ -n \"$TAG\" ]; then step git -C \"$SRC\" fetch --depth 1 origin tag \"$TAG\"; step git -C \"$SRC\" checkout -q \"$TAG\"",
        "    else " + say(i18n("Could not look up the latest whisper.cpp release; building the source already there.")) + "; fi",
        "else",
        "    step mkdir -p -- \"$(dirname -- \"$SRC\")\"",
        "    if [ -n \"$TAG\" ]; then step git clone --depth 1 --branch \"$TAG\" " + WHISPER_CPP_REPO + " \"$SRC\"",
        "    else step git clone --depth 1 " + WHISPER_CPP_REPO + " \"$SRC\"; fi",
        "fi",
        "cd -- \"$SRC\"",
        // Reconfiguring for another GPU backend leaves the old backend's
        // library in build/, so start clean when the backend changes.
        "if [ -f build/CMakeCache.txt ] && ! { grep -qx 'GGML_CUDA:BOOL=" + cuda + "' build/CMakeCache.txt && grep -qx 'GGML_VULKAN:BOOL=" + vulkan + "' build/CMakeCache.txt; }; then",
        "    step rm -rf -- build",
        "fi",
        // About 1.5 GB per compile job (ggml-cuda and the Vulkan shaders
        // need it), so a many-core machine doesn't run out of memory.
        "JOBS=$(nproc 2>/dev/null || echo 1)",
        "MEMJOBS=$(awk '/^MemAvailable:/ { print int($2 / 1500000) }' /proc/meminfo 2>/dev/null || true)",
        "case \"$MEMJOBS\" in ''|*[!0-9]*) MEMJOBS=1;; esac",
        "if [ \"$MEMJOBS\" -lt 1 ]; then MEMJOBS=1; fi",
        "if [ \"$MEMJOBS\" -lt \"$JOBS\" ]; then JOBS=$MEMJOBS; fi",
        "step cmake -B build " + flags,
        "step cmake --build build -j\"$JOBS\" --config Release",
        "printf '\\n+ %s\\n' 'build/bin/whisper-cli --help'",
        "build/bin/whisper-cli --help >/dev/null 2>&1 || { " + say(i18n("The new whisper-cli did not run.")) + "; exit 1; }",
        say(i18n("Built %1. With Binary left at whisper-cli, PlasmaLLM uses it unless another whisper-cli is on PATH.", WhisperCpp.OWN_BUILD_BINARY)),
        "MODELS=$(" + scan + ")",
        "if [ -z \"$MODELS\" ]; then",
        "    " + say(i18n("No ggml model was found in the model folders.")),
        "    if ask " + shellQuote(i18n("Download the base model (~142 MB) into ~/.cache/whisper.cpp?")) + "; then",
        "        step mkdir -p -- \"$HOME/.cache/whisper.cpp\"",
        "        step sh ./models/download-ggml-model.sh base \"$HOME/.cache/whisper.cpp\"",
        "    fi",
        "fi");
    return lines;
}

function pipxEnsure(pkg) {
    return "if pipx list --short 2>/dev/null | grep -q '^" + pkg + " '; then "
        + say(i18n("%1 is already installed with pipx.", pkg)) + "; else step pipx install " + pkg + "; fi";
}

function cliScriptLines(flavor, probe) {
    var lines = [];
    if (flavor === "ct2-cpu" || flavor === "ct2-cuda") {
        lines.push(pipxEnsure("whisper-ctranslate2"));
        lines.push("W=$(command -v whisper-ctranslate2 || echo \"$HOME/.local/bin/whisper-ctranslate2\")");
        lines.push("REAL=$(readlink -f -- \"$W\")");
        lines.push("PY=\"$(dirname -- \"$REAL\")/python\"");
        if (flavor === "ct2-cuda") {
            // pip's CUDA libraries are found only through LD_LIBRARY_PATH,
            // so a small wrapper sets it before starting the real program.
            lines.push(
                "step pipx inject whisper-ctranslate2 nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*'",
                "LIBS=$(\"$PY\" -c 'import os, nvidia.cublas, nvidia.cudnn; print(os.path.dirname(nvidia.cublas.__path__[0]) + \"/cublas/lib:\" + os.path.dirname(nvidia.cudnn.__path__[0]) + \"/cudnn/lib\")')",
                "WRAP=" + WhisperCpp.shellPath(CT2_WRAPPER),
                "step mkdir -p -- \"$(dirname -- \"$WRAP\")\"",
                "printf '%s\\n' '#!/bin/sh' '# Written by PlasmaLLM Whisper setup: puts the pip CUDA libraries on the library path.' "
                    + "\"export LD_LIBRARY_PATH=\\\"$LIBS\\${LD_LIBRARY_PATH:+:\\$LD_LIBRARY_PATH}\\\"\" "
                    + "\"exec \\\"$REAL\\\" \\\"\\$@\\\"\" > \"$WRAP\"",
                "chmod +x \"$WRAP\"",
                "W=\"$WRAP\"",
                "printf '\\n+ %s\\n' 'ctranslate2.get_cuda_device_count()'",
                "\"$PY\" -c 'import ctranslate2; print(\"CUDA devices:\", ctranslate2.get_cuda_device_count())'");
        }
        lines.push(
            "printf '\\n+ %s\\n' \"$W --help\"",
            "\"$W\" --help >/dev/null 2>&1 || { " + say(i18n("whisper-ctranslate2 did not run.")) + "; exit 1; }",
            "echo; " + say(i18n("Installed. On the Speech settings page, press Check again and then the button to use whisper-ctranslate2.")),
            "echo \"$W\"");
        return lines;
    }
    // CUDA: cu128, or cu126 for GPUs cu128 has no kernels for.
    var index = flavor === "openai-cuda" ? torchCudaIndex(probe) : TORCH_INDEX.cpu;
    var swap = "step pipx runpip openai-whisper install --force-reinstall torch --index-url " + index;
    // A fresh install resolves torch from the right index straight away,
    // instead of PyPI's CUDA build (~3 GB) first. pip takes the highest
    // version across all indexes, and the cu128 index stops at an older
    // torch than PyPI, so that one still installs from PyPI and swaps.
    var fresh = index === TORCH_INDEX.cuda
        ? ["    step pipx install openai-whisper", "    " + swap]
        : ["    step pipx install openai-whisper --pip-args=" + shellQuote("--index-url " + index + " --extra-index-url https://pypi.org/simple")];
    lines.push("if pipx list --short 2>/dev/null | grep -q '^openai-whisper '; then",
        "    " + say(i18n("%1 is already installed with pipx.", "openai-whisper")),
        "    " + swap,
        "else");
    lines = lines.concat(fresh);
    lines.push("fi",
        // Check the venv pipx just changed, not whichever whisper is first on PATH.
        "VENVS=$(pipx environment --value PIPX_LOCAL_VENVS 2>/dev/null || true)",
        "if [ -z \"$VENVS\" ]; then",
        "    VENVS=\"$HOME/.local/share/pipx/venvs\"",
        "    if [ -d \"$HOME/.local/pipx/venvs/openai-whisper\" ]; then VENVS=\"$HOME/.local/pipx/venvs\"; fi",
        "fi",
        "PY=\"$VENVS/openai-whisper/bin/python\"",
        "printf '\\n+ %s\\n' 'torch check'",
        "\"$PY\" -c 'import torch; print(\"torch\", torch.__version__, \"CUDA\", torch.version.cuda, \"GPU available:\", torch.cuda.is_available())'");
    return lines;
}

/**
 * Bash script that installs or builds one offer, echoing every step. Writes
 * ok/failed plus the offer id to ~/.cache/plasmallm/whisper-setup.status.
 * @param {string} kind    "whisper_cpp" | "whisper_cli"
 * @param {string} flavor  cpu | vulkan | cuda  /  ct2-cpu | ct2-cuda | openai-cpu | openai-cuda
 * @param {object} probe   parseProbe() output
 * @param {object} [opts]  { cppModelDirs }
 */
function buildInstallScript(kind, flavor, probe, opts) {
    opts = opts || {};
    probe = probe || parseProbe("");
    var id = kind + ":" + flavor;
    var lines = scriptHeader(id);
    if (kind === "whisper_cpp" && flavor === "cuda")
        lines = lines.concat(nvccCheckLines());
    lines = lines.concat(packageLines(probe, kind, String(flavor).replace(/^(ct2|openai)-/, "")));
    if (kind === "whisper_cpp")
        lines = lines.concat(cppScriptLines(flavor, probe, opts));
    else
        lines = lines.concat(cliScriptLines(flavor, probe));
    return lines.join("\n") + "\n";
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of the UTF-8 bytes of a string. */
function base64Utf8(str) {
    var s = String(str);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            var d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i++;
            }
        }
        if (c < 0x80)
            bytes.push(c);
        else if (c < 0x800)
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000)
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else
            bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    var out = "";
    for (var j = 0; j < bytes.length; j += 3) {
        var b0 = bytes[j];
        var b1 = j + 1 < bytes.length ? bytes[j + 1] : 0;
        var b2 = j + 2 < bytes.length ? bytes[j + 2] : 0;
        out += B64.charAt(b0 >> 2)
            + B64.charAt(((b0 & 3) << 4) | (b1 >> 4))
            + (j + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=")
            + (j + 2 < bytes.length ? B64.charAt(b2 & 63) : "=");
    }
    return out;
}

/**
 * Command that writes the script to a temp file and runs it in the user's
 * terminal ($TERMINAL, then KDE's terminal setting, then konsole — the
 * same order as runInTerminal() in main.qml). Returns when the terminal
 * command does. The script deletes its own file; when the terminal fails
 * (not installed, or no -e option), this deletes it and exits non-zero
 * with the terminal's name on stderr. <name> (default "whisper") goes into
 * the marker and temp file name, e.g. "kokoro" for the Kokoro setup.
 */
function buildLaunchCommand(script, marker, name) {
    var tag = "plasmallm-" + (safeMarker(name) || "whisper") + "-setup";
    return ": " + tag + "-" + safeMarker(marker) + "; "
        + "f=$(mktemp \"${TMPDIR:-/tmp}/" + tag + ".XXXXXX\") || exit 1; "
        + "printf %s '" + base64Utf8(script) + "' | base64 -d > \"$f\" || { rm -f -- \"$f\"; exit 1; }; "
        + "term=${TERMINAL:-$(kreadconfig6 --file kdeglobals --group General --key TerminalApplication 2>/dev/null)}; "
        + "term=${term:-konsole}; "
        + "\"$term\" -e bash \"$f\" || { rc=$?; rm -f -- \"$f\"; echo \"terminal: $term\" >&2; exit $rc; }";
}
