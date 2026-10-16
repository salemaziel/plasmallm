/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

// Finds a local Kokoro text-to-speech server (kokoro-fastapi), says what to
// do about it, and writes the install script the Text to Speech settings
// page runs in a visible terminal.
//
// The probe is read-only. The install happens in the generated script, in
// front of the user, and package installs ask first. The GPU detection,
// script header and terminal launch are the Whisper setup's.

.pragma library

.import "../sttAdapters/whisperSetup.js" as WhisperSetup

var REPO = "https://github.com/remsky/Kokoro-FastAPI";
var OWN_DIR = "~/.local/share/plasmallm/kokoro-fastapi";
var UNIT_NAME = "plasmallm-kokoro.service";
// The same directory as OWN_DIR, in systemd's own notation (%h = home).
var UNIT_SRC = "%h/.local/share/plasmallm/kokoro-fastapi";
// Restart the server after this many requests (a memory-leak guard). Every
// restart means a few seconds of refused connections, so it is high; the
// plasmoid's synthesize call also retries through one.
var UVICORN_MAX_REQUESTS = 500;
var MODEL_FILE = "api/src/models/v1_0/kokoro-v1_0.pth";
// Where kokoro-fastapi listens by default, and the next port, which this
// page's install takes when 8880 is in use.
var DEFAULT_URLS = ["http://127.0.0.1:8880/v1", "http://127.0.0.1:8881/v1"];
var PLACEHOLDER_URL = "http://localhost:8880/v1";
var REQUIRED_TOOLS = ["git", "curl"];

function trimStr(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
}

/** Server URL as typed → "http://host:port/v1" form, no trailing slash. */
function normalizeUrl(url) {
    var u = trimStr(url).replace(/\/+$/, "");
    if (!u.length)
        return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u))
        u = "http://" + u;
    return u;
}

/**
 * Whether leaving the Server URL field should start another probe: only when
 * the text differs from the URL the latest probe was started with. Clicking
 * into the field and away again with nothing changed must not re-probe.
 */
function urlNeedsProbe(typed, lastProbedUrl) {
    return trimStr(typed) !== trimStr(lastProbedUrl);
}

// ---------------------------------------------------------------- probe

// kk <source> <url>: prints KOKORO_AT=<source>|<url>|<voice count> when a
// Kokoro server answers there (an owned_by "kokoro" model in /models).
// A connection that was accepted but gets no answer within the 3 seconds
// (curl exit 28 with a connect time) prints KOKORO_SLOW=<source>|<url>
// instead: that is a server that is still loading, for example one that
// systemd starts on the first connection, and not a server that is missing.
// A refused connection (exit 7) prints nothing.
var CHECK_FN = "kk() { command -v curl >/dev/null 2>&1 || return 0; "
    + "m=$(curl -s -m 3 -w '\\nKOKORO_TC=%{time_connect}' \"$2/models\" 2>/dev/null); rc=$?; "
    + "if [ \"$rc\" -eq 28 ]; then "
    + "awk -v t=\"${m##*KOKORO_TC=}\" 'BEGIN { exit !(t + 0 > 0) }' && echo \"KOKORO_SLOW=$1|$2\"; return 0; fi; "
    + "[ \"$rc\" -eq 0 ] || return 0; "
    + "printf '%s' \"$m\" | grep -q '\"owned_by\" *: *\"kokoro\"' || return 0; "
    + "n=$(curl -s -m 3 \"$2/audio/voices\" 2>/dev/null | grep -o '\"[a-z][a-z]_[A-Za-z0-9_]*\"' | wc -l); "
    + "echo \"KOKORO_AT=$1|$2|$n\"; }";

// Sets $op to the port in this page's own unit file, if there is one.
var OWN_PORT_LINE = "uf=\"${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/" + UNIT_NAME + "\"; op=; "
    + "[ -f \"$uf\" ] && op=$(sed -n 's/.*--port \\([0-9][0-9]*\\).*/\\1/p' \"$uf\" | head -n 1)";

// Prints KOKORO_UNIT=<name>|<state>|<working directory> for every systemd
// user service named *kokoro*, loaded or only installed. Needs $to10.
var UNIT_LINE = "if command -v systemctl >/dev/null 2>&1; then for u in $({ $to10 systemctl --user list-units --all --plain --no-legend --type=service '*kokoro*'; "
    + "$to10 systemctl --user list-unit-files --no-legend --type=service '*kokoro*'; } 2>/dev/null | awk '{print $1}' | sort -u); do "
    + "echo \"KOKORO_UNIT=$u|$(systemctl --user show -p ActiveState --value -- \"$u\" 2>/dev/null)|$(systemctl --user show -p WorkingDirectory --value -- \"$u\" 2>/dev/null)\"; done; fi";

/**
 * One read-only shell command that prints KEY=value lines: Kokoro servers
 * that answer, systemd user units and containers named *kokoro*, this
 * page's own install, the tools the install needs, and the GPUs.
 * @param {string} url  the Server URL setting (checked first)
 * @param {string|number} [marker] makes the command string unique
 */
function buildProbeCommand(url, marker) {
    var cfgUrl = normalizeUrl(url);
    var lines = [
        ": plasmallm-kokoro-probe-" + WhisperSetup.safeMarker(marker),
        "echo PROBE=1"
    ].concat(WhisperSetup.gpuProbeLines(), [
        "for t in git uv pipx curl espeak-ng docker podman; do command -v \"$t\" >/dev/null 2>&1 && echo \"HAVE=$t\"; done",
        // The server checks below all use curl.
        "command -v curl >/dev/null 2>&1 || echo KOKORO_NO_CURL=1",
        // A fresh uv install lands in ~/.local/bin, which Plasma's PATH may lack.
        "[ -x \"$HOME/.local/bin/uv\" ] && echo HAVE=uv-local",
        "command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; print(\"PY_VERSION=%d.%d\" % sys.version_info[:2])' 2>/dev/null",
        "for p in apt-get dnf pacman zypper; do command -v \"$p\" >/dev/null 2>&1 && { echo \"PKG_MGR=$p\"; break; }; done",
        "echo \"HOME_DIR=$HOME\"",
        // This page's own install.
        "d=\"$HOME/.local/share/plasmallm/kokoro-fastapi\"; [ -d \"$d/.git\" ] && echo KOKORO_OWN_SRC=1; "
            + "[ -x \"$d/.venv/bin/uvicorn\" ] && echo KOKORO_OWN_VENV=1; "
            + "[ -f \"$d/" + MODEL_FILE + "\" ] && echo KOKORO_OWN_MODEL=1",
        OWN_PORT_LINE,
        "[ -n \"$op\" ] && echo \"KOKORO_OWN_PORT=$op\"",
        CHECK_FN
    ]);
    if (cfgUrl.length)
        lines.push("kk cfg " + WhisperSetup.shellQuote(cfgUrl));
    // The usual addresses, except one that is the Server URL again: a server
    // that is still loading would make the second check wait out its timeout too.
    DEFAULT_URLS.forEach(function(u) {
        if (!(cfgUrl.length && sameServer(u, cfgUrl)))
            lines.push("kk port " + u);
    });
    // This page's own install answers at 127.0.0.1:$op, which is only known to
    // the shell. When the Server URL is that same address, it was checked above.
    var cfgPort = localV1Port(cfgUrl);
    lines.push("[ -n \"$op\" ]" + (cfgPort ? " && [ \"$op\" != " + WhisperSetup.shellQuote(cfgPort) + " ]" : "")
        + " && kk own \"http://127.0.0.1:$op/v1\"");
    lines.push(
        UNIT_LINE,
        // Containers, only where docker or podman exists.
        "for e in docker podman; do command -v \"$e\" >/dev/null 2>&1 || continue; "
            + "$to10 \"$e\" ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}' 2>/dev/null | grep -i kokoro | sed \"s/^/KOKORO_CTR=$e|/\"; done",
        "echo PROBE_END=1");
    return lines.join("; ");
}

/**
 * The follow-up check while a server is still loading: only the addresses the
 * last probe found slow, and nothing else (no GPU, Python, systemd or container
 * lookups, which cannot change in a few seconds). Each address is asked once,
 * and keeps the source label it had, so the result can replace the old one.
 * @param {Array<{source: string, url: string}>} slow  the last probe's .kokoro.slow
 * @param {string|number} [marker]  makes the command string unique
 * @returns {string} "" when there is nothing to check
 */
function buildRecheckCommand(slow, marker) {
    var asked = [];
    (slow || []).forEach(function(s) {
        if (s && s.url && !asked.some(function(a) { return sameServer(a.url, s.url); }))
            asked.push(s);
    });
    if (!asked.length)
        return "";
    var lines = [": plasmallm-kokoro-recheck-" + WhisperSetup.safeMarker(marker), CHECK_FN];
    asked.forEach(function(s) {
        lines.push("kk " + WhisperSetup.shellQuote(s.source) + " " + WhisperSetup.shellQuote(s.url));
    });
    return lines.join("; ");
}

/**
 * The last probe with the answers of a follow-up check put in: whatever was
 * slow is replaced by what the check found (answering, still slow, or neither);
 * everything else in the probe is kept as it was.
 * @param {object} probe   parseProbe() output of the last probe
 * @param {string} stdout  output of buildRecheckCommand()
 * @returns {object} a new probe object; the one passed in is not changed
 */
function mergeRecheck(probe, stdout) {
    var base = probe || parseProbe("");
    var fresh = parseProbe(stdout).kokoro;
    var merged = {};
    Object.keys(base).forEach(function(key) { merged[key] = base[key]; });
    var old = base.kokoro || parseProbe("").kokoro;
    var k = {};
    Object.keys(old).forEach(function(key) { k[key] = old[key]; });
    k.at = old.at.concat(fresh.at);
    k.slow = fresh.slow;
    merged.kokoro = k;
    return merged;
}

/** Probe output → the Whisper probe's object (GPUs, tools) plus .kokoro. */
function parseProbe(stdout) {
    var p = WhisperSetup.parseProbe(stdout);
    var k = { at: [], slow: [], units: [], containers: [], own: { src: false, venv: false, model: false, port: 0 }, pyVersion: "", noCurl: false };
    p.kokoro = k;
    String(stdout || "").split("\n").forEach(function(raw) {
        var line = raw.replace(/\r$/, "");
        var eq = line.indexOf("=");
        if (eq <= 0)
            return;
        var key = line.substring(0, eq);
        var val = trimStr(line.substring(eq + 1));
        var parts = val.split("|");
        switch (key) {
        case "KOKORO_AT":
            if (parts.length >= 3)
                k.at.push({ source: parts[0], url: parts[1], voices: parseInt(parts[2], 10) || 0 });
            break;
        case "KOKORO_SLOW":
            if (parts.length >= 2)
                k.slow.push({ source: parts[0], url: parts[1] });
            break;
        case "KOKORO_UNIT":
            // Template units (name@.service) cannot be started as they are.
            if (!/\.service$/.test(parts[0]) || /@\.service$/.test(parts[0]))
                break;
            if (k.units.some(function(u) { return u.name === parts[0]; }))
                break;
            k.units.push({ name: parts[0], state: parts[1] || "", dir: parts.slice(2).join("|") });
            break;
        case "KOKORO_CTR":
            if (parts.length >= 4)
                k.containers.push({ engine: parts[0], name: parts[1], image: parts[2], state: parts[3], ports: parts.slice(4).join("|") });
            break;
        case "KOKORO_OWN_SRC": k.own.src = val === "1"; break;
        case "KOKORO_OWN_VENV": k.own.venv = val === "1"; break;
        case "KOKORO_OWN_MODEL": k.own.model = val === "1"; break;
        case "KOKORO_OWN_PORT": k.own.port = parseInt(val, 10) || 0; break;
        case "KOKORO_NO_CURL": k.noCurl = val === "1"; break;
        case "PY_VERSION": k.pyVersion = val; break;
        }
    });
    return p;
}

// ---------------------------------------------------------------- recommend

function hasTool(probe, tool) {
    var have = probe.have || {};
    if (tool === "uv")
        return !!(have.uv || have["uv-local"]);
    return !!have[tool];
}

// Kokoro-FastAPI pins Python 3.10 (.python-version, and its Dockerfile's
// "uv venv --python 3.10"); uv downloads it when the system has another.
var PYTHON_VERSION = "3.10";

/** Missing required tools, and the command that installs them (or ""). */
function missingPackages(probe, tools) {
    var missing = (tools || REQUIRED_TOOLS).filter(function(t) { return !hasTool(probe, t); });
    var install = WhisperSetup.INSTALL_COMMAND[probe.pkgMgr];
    return {
        missing: missing,
        packages: install ? missing.slice() : [],
        command: missing.length && install ? install + " " + missing.join(" ") : ""
    };
}

function offerId(kind, value) {
    // Commas would split the declined list.
    return "kokoro:" + kind + (value ? ":" + String(value).replace(/,/g, "%2C") : "");
}

function makeOffer(fields, declined) {
    fields.declined = declined.indexOf(fields.id) >= 0;
    fields.optional = !!fields.optional;
    fields.missing = fields.missing || [];
    fields.packages = fields.packages || [];
    fields.packageCommand = fields.packageCommand || "";
    fields.url = fields.url || "";
    fields.unit = fields.unit || "";
    fields.flavor = fields.flavor || "";
    return fields;
}

function installLabel(flavor) {
    return flavor === "gpu" ? i18n("Install Kokoro (GPU)") : i18n("Install Kokoro (CPU)");
}

function installOffer(probe, flavor, reason, optional, declined) {
    var pk = missingPackages(probe);
    return makeOffer({
        id: offerId("install-" + flavor), kind: "install", flavor: flavor,
        label: installLabel(flavor), reason: reason, optional: optional,
        missing: pk.missing, packages: pk.packages, packageCommand: pk.command
    }, declined);
}

// "localhost" and "127.0.0.1" are the same server.
function sameServer(a, b) {
    function key(u) { return normalizeUrl(u).replace(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:\/]|$)/i, "local:"); }
    return key(a) === key(b);
}

/** "8880" when the URL is http://localhost|127.0.0.1|[::1]:8880/v1 (what an own install listens on), else "". */
function localV1Port(url) {
    var m = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\/v1$/i.exec(normalizeUrl(url));
    return m ? String(parseInt(m[1], 10)) : "";
}

// Host port that a running container maps to Kokoro's 8880, as a URL.
function containerUrl(c) {
    var m = /(?:^|[\s,])(?:[0-9.]+|\[::\]|::):(\d+)->8880\/tcp/.exec(c.ports || "");
    return m ? "http://127.0.0.1:" + m[1] + "/v1" : "";
}

/** Units that are not running, this page's own install first. */
function stoppedUnits(units) {
    var stopped = (units || []).filter(function(u) { return u.state !== "active" && u.state !== "activating" && u.state !== "reloading"; });
    var own = null;
    stopped.forEach(function(u) { if (u.name === UNIT_NAME) own = u; });
    if (own && stopped.indexOf(own) > 0) {
        stopped.splice(stopped.indexOf(own), 1);
        stopped.unshift(own);
    }
    return stopped;
}

/**
 * @param {object} probe  parseProbe() output
 * @param {object} [opts]
 * @param {string} [opts.url]       the Server URL setting
 * @param {boolean} [opts.gaveUp]   the page waited long enough for a server that
 *                                  was still loading; treat it as not running
 * @param {string|string[]} [opts.declined]  declined offer ids (comma-separated)
 * @returns {{status: string, message: string, warnings: string[], offers: Array,
 *            ownUrl: string, gpus: Array}}
 *   status: running (answers at the Server URL) | starting (accepts connections,
 *           no answer yet) | found | stopped | missing
 *   ownUrl: where this page's own install answers, "" when it doesn't
 */
function recommend(probe, opts) {
    opts = opts || {};
    probe = probe || parseProbe("");
    var declined = WhisperSetup.declinedList(opts.declined);
    var k = probe.kokoro || parseProbe("").kokoro;
    var url = normalizeUrl(opts.url);
    var gpus = WhisperSetup.gpuList(probe);
    var ownHit = null;
    k.at.forEach(function(a) { if (a.source === "own" && !ownHit) ownHit = a; });
    var res = { status: "missing", message: "", warnings: [], offers: [], ownUrl: ownHit ? ownHit.url : "", gpus: gpus };

    var cfgHit = null;
    if (url.length)
        k.at.forEach(function(a) { if (a.source === "cfg" && !cfgHit) cfgHit = a; });
    if (cfgHit) {
        res.status = "running";
        res.message = i18n("Kokoro is running at %1 (voices: %2).", url, cfgHit.voices);
        return res;
    }
    // A connection that was accepted but not answered yet: still loading.
    // Not "not running" until the page has waited long enough (gaveUp).
    var slow = opts.gaveUp ? [] : (k.slow || []);
    var slowCfg = null;
    var slowOther = null;
    slow.forEach(function(a) {
        if (a.source === "cfg" || (url.length && sameServer(a.url, url)))
            slowCfg = slowCfg || a;
        else
            slowOther = slowOther || a;
    });
    if (slowCfg && url.length) {
        res.status = "starting";
        res.message = i18n("Kokoro is starting at %1…", url);
        return res;
    }
    if (k.noCurl)
        res.warnings.push(i18n("curl is needed to detect a running Kokoro server, so a server that is already running would not be seen. The install below asks to install it."));
    else if (url.length)
        res.warnings.push(i18n("Nothing answers as Kokoro at %1.", url));

    var ownUnit = null;
    k.units.forEach(function(u) { if (u.name === UNIT_NAME) ownUnit = u; });
    var stopped = stoppedUnits(k.units);
    var activeUnits = k.units.filter(function(u) { return stopped.indexOf(u) < 0; });

    // Running somewhere else: this page's own install first.
    var hits = [];
    (ownHit ? [ownHit] : []).concat(k.at).forEach(function(a) {
        if (a.source === "cfg" || (url.length && sameServer(a.url, url)))
            return;
        if (!hits.some(function(h) { return sameServer(h.url, a.url); }))
            hits.push(a);
    });
    if (hits.length) {
        res.status = "found";
        var otherUnits = activeUnits.filter(function(u) { return u.name !== UNIT_NAME; });
        var runUnit = hits[0].source === "own" ? ownUnit : (otherUnits[0] || null);
        res.message = runUnit
            ? i18n("Kokoro is running at %1 (voices: %2), as %3.", hits[0].url, hits[0].voices, runUnit.name)
            : i18n("Kokoro is running at %1 (voices: %2).", hits[0].url, hits[0].voices);
        res.offers.push(makeOffer({ id: offerId("use", hits[0].url), kind: "use", url: hits[0].url,
            label: i18n("Use it"), reason: i18n("Sets the Server URL to %1.", hits[0].url) }, declined));
        return res;
    }

    // Loading at one of the usual addresses, which is not the Server URL:
    // wait for it too rather than offer to install a second one.
    if (slowOther) {
        res.status = "starting";
        res.message = i18n("Kokoro is starting at %1…", slowOther.url);
        return res;
    }

    var runningCtr = k.containers.filter(function(c) { return /^running$/i.test(c.state) && containerUrl(c).length; });
    if (runningCtr.length) {
        var cu = containerUrl(runningCtr[0]);
        res.status = "found";
        res.message = i18n("A Kokoro container (%1) is running and publishes port %2.", runningCtr[0].name, cu);
        res.offers.push(makeOffer({ id: offerId("use", cu), kind: "use", url: cu,
            label: i18n("Use it"), reason: i18n("Sets the Server URL to %1.", cu) }, declined));
        return res;
    }

    var unitWarn = activeUnits.length
        ? i18n("%1 is running, but nothing answered at the usual addresses (ports 8880 and 8881). If it uses another port, put its address in Server URL.",
            activeUnits[0].name)
        : "";
    if (stopped.length) {
        if (unitWarn)
            res.warnings.push(unitWarn);
        res.status = "stopped";
        res.message = stopped[0].name === UNIT_NAME
            ? i18n("Kokoro installed from this page is not running.")
            : i18n("Kokoro is installed as %1, but it is not running.", stopped[0].name);
        res.offers.push(makeOffer({ id: offerId("start", stopped[0].name), kind: "start", unit: stopped[0].name,
            label: i18n("Start it"), reason: i18n("Runs: systemctl --user start %1", stopped[0].name) }, declined));
        return res;
    }

    var stoppedCtr = k.containers.filter(function(c) { return !/^running$/i.test(c.state); });
    if (stoppedCtr.length) {
        res.status = "stopped";
        res.message = i18n("A Kokoro container (%1) exists but is stopped. Start it with: %2",
            stoppedCtr[0].name, stoppedCtr[0].engine + " start " + stoppedCtr[0].name);
        return res;
    }
    if (unitWarn) {
        res.status = "found";
        res.message = unitWarn;
        return res;
    }

    // Nothing found: install, by the Whisper rule. NVIDIA with 4 GB or more
    // and a compute capability current CUDA builds support → GPU build.
    // kokoro-fastapi pins torch 2.6.0 (cu124), which still covers Pascal.
    var g = WhisperSetup.cudaGpu(gpus);
    var cudaNvidia = gpus.filter(function(x) { return WhisperSetup.cudaSupport(x) === "ok"; });
    var smallNvidia = g ? null : WhisperSetup.bestOf(cudaNvidia);
    var why;
    if (g)
        why = i18n("This computer has %1, so the GPU build will use it.", WhisperSetup.describeGpu(g));
    else if (smallNvidia)
        why = i18n("%1 has under %2 GB of memory or is built in, so the CPU build is the right one.",
            WhisperSetup.describeGpu(smallNvidia), WhisperSetup.formatGb(WhisperSetup.SMALL_GPU_MIB / 1024));
    else
        why = i18n("There is no NVIDIA GPU that the GPU build can use, so the CPU build is the right one (a much smaller download).");
    if (k.pyVersion !== PYTHON_VERSION)
        why += " " + i18n("uv also downloads Python %1, which Kokoro-FastAPI is built for.", PYTHON_VERSION);
    res.message = (k.own.src
        ? i18n("A Kokoro download from this page is at %1, but it is not set up as a service.", OWN_DIR)
        : (k.noCurl ? i18n("No Kokoro service or container was found.") : i18n("Kokoro was not found on this computer."))) + " " + why;
    var ideal = g ? "gpu" : "cpu";
    res.offers.push(installOffer(probe, ideal, why, false, declined));
    if (g)
        res.offers.push(installOffer(probe, "cpu", i18n("Optional: the CPU build, a much smaller download."), true, declined));
    else if (smallNvidia)
        res.offers.push(installOffer(probe, "gpu", i18n("Optional: use the GPU anyway."), true, declined));
    return res;
}

/**
 * Whether the page should say that nothing answers at the Server URL.
 * The last check must have been taken with that URL and not found Kokoro
 * there, and no voices may have come back. Without curl the check cannot see
 * a running server, so only a failed voice load counts then.
 *
 * @param {object} s
 * @param {string} s.url          the Server URL setting
 * @param {object|null} s.probe   parseProbe() output of the last check, or null
 * @param {object|null} s.rec     recommend() for that check, or null
 * @param {string} s.probedUrl    the URL that check was judged against
 * @param {boolean} s.busy        a check, a voice load, or a start/install is running
 * @param {number} s.voiceCount   voices loaded from the server
 * @param {boolean} s.voicesFailed  the last voice load found nothing
 */
function notAnswering(s) {
    if (!trimStr(s.url).length || s.busy || s.voiceCount > 0)
        return false;
    if (s.probe && s.rec && !(s.probe.kokoro && s.probe.kokoro.noCurl))
        return !urlNeedsProbe(s.url, s.probedUrl) && s.rec.status !== "running" && s.rec.status !== "starting";
    return !!s.voicesFailed;
}

// A server that accepts connections but has not answered yet (Kokoro takes
// about 20 seconds to load when systemd starts it on the first connection).
// The page checks again every STARTING_RECHECK_MS and gives up, calling it
// not running, once STARTING_LIMIT_MS have passed since it first saw it.
var STARTING_RECHECK_MS = 4000;
var STARTING_LIMIT_MS = 60000;

/**
 * What the page does after a check.
 * @param {string} status  recommend().status of that check
 * @param {number} since   when "starting" was first seen (ms), 0 if it wasn't
 * @param {number} now     ms
 * @returns {{action: string, since: number}}
 *   action: "none" (not starting) | "recheck" (check again soon) | "giveup"
 */
function startingStep(status, since, now) {
    if (status !== "starting")
        return { action: "none", since: 0 };
    if (!(since > 0))
        return { action: "recheck", since: now };
    if (now - since >= STARTING_LIMIT_MS)
        return { action: "giveup", since: since };
    return { action: "recheck", since: since };
}

/**
 * What to offer next to the "not running" message: starting a Kokoro service
 * that was found stopped (even if the setup offers for it were declined),
 * else the setup offers still open, which are using a server that runs
 * elsewhere or installing one.
 */
function notRunningOffers(rec) {
    if (!rec)
        return [];
    var starts = rec.offers.filter(function(o) { return o.kind === "start"; });
    if (starts.length > 0)
        return [starts[0]];
    return rec.offers.filter(function(o) { return !o.declined; });
}

/**
 * Whether the Setup block should leave out the button of one of its offers
 * because the "isn't running" block next to the Voice box shows the same
 * Start: only one Start button is on the page then. Other offers keep theirs.
 * @param {object} offer
 * @param {boolean} notAnsweringNow  the "isn't running" block is showing
 * @param {Array} voiceBoxOffers     notRunningOffers() of that block
 */
function startShownByVoiceBox(offer, notAnsweringNow, voiceBoxOffers) {
    if (!offer || offer.kind !== "start" || !notAnsweringNow)
        return false;
    return (voiceBoxOffers || []).some(function(o) { return o.kind === "start" && o.id === offer.id; });
}

/** cfg_ttsSetupDeclined with ids added or removed. */
function updateDeclined(current, addIds, removeIds) {
    return WhisperSetup.updateDeclined(current, addIds, removeIds);
}

// ---------------------------------------------------------------- scripts

function say(text) {
    return WhisperSetup.say(text);
}

function packageLines(probe) {
    var lines = [];
    var pk = missingPackages(probe);
    if (pk.missing.length && !pk.command.length) {
        lines.push(say(i18n("These are needed and could not be found: %1. Install them with your package manager, then run setup again.", pk.missing.join(", "))),
            "exit 1");
    } else if (pk.missing.length) {
        lines.push(say(i18n("These packages are needed: %1", pk.packages.join(" "))),
            say(i18n("This command installs them:")),
            say("  " + pk.command),
            "if ask " + WhisperSetup.shellQuote(i18n("Run it now?")) + "; then step " + pk.command + "; else "
                + say(i18n("Skipped. Install them yourself, then run setup again.")) + "; exit 1; fi");
    }
    // Optional: kokoro-fastapi falls back to espeak-ng for unknown words.
    var es = missingPackages(probe, ["espeak-ng"]);
    if (es.missing.length) {
        lines.push(say(i18n("espeak-ng is optional. Kokoro uses it to pronounce words it does not know.")));
        if (es.command.length)
            lines.push(say("  " + es.command),
                "if ask " + WhisperSetup.shellQuote(i18n("Install it now?")) + "; then step " + es.command + " || "
                    + say(i18n("espeak-ng was not installed; continuing without it.")) + "; fi");
        else
            lines.push(say(i18n("Install it with your package manager if you want it.")));
    }
    return lines;
}

function uvLines() {
    return [
        "UV=$(command -v uv || true)",
        "if [ -z \"$UV\" ] && [ -x \"$HOME/.local/bin/uv\" ]; then UV=\"$HOME/.local/bin/uv\"; fi",
        "if [ -z \"$UV\" ]; then",
        "    if command -v pipx >/dev/null 2>&1; then step pipx install uv",
        "    else",
        "        " + say(i18n("uv runs Kokoro and is not installed. Its official installer is:")),
        "        " + say("  curl -LsSf https://astral.sh/uv/install.sh | sh"),
        "        if ask " + WhisperSetup.shellQuote(i18n("Run it now?")) + "; then step sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'; else "
            + say(i18n("Skipped. Install uv yourself, then run setup again.")) + "; exit 1; fi",
        "    fi",
        "    UV=$(command -v uv || echo \"$HOME/.local/bin/uv\")",
        "fi",
        "[ -x \"$UV\" ] || { " + say(i18n("uv was not found after installing it.")) + "; exit 1; }"
    ];
}

function sourceLines() {
    return [
        "SRC=\"$HOME/.local/share/plasmallm/kokoro-fastapi\"",
        // The newest release tag (no -rc); master only when the lookup fails.
        "TAG=$(git ls-remote --tags --refs --sort=-version:refname " + REPO + " 'v*' 2>/dev/null | sed 's|.*refs/tags/||' | grep -v -- - | head -n 1 || true)",
        "if [ -d \"$SRC/.git\" ]; then",
        "    if [ -n \"$TAG\" ]; then step git -C \"$SRC\" fetch --depth 1 origin tag \"$TAG\"; step git -C \"$SRC\" checkout -q \"$TAG\"",
        "    else " + say(i18n("Could not look up the latest Kokoro-FastAPI release; using the source already there.")) + "; fi",
        "else",
        "    step mkdir -p -- \"$(dirname -- \"$SRC\")\"",
        "    if [ -n \"$TAG\" ]; then step git clone --depth 1 --branch \"$TAG\" " + REPO + " \"$SRC\"",
        "    else step git clone --depth 1 " + REPO + " \"$SRC\"; fi",
        "fi",
        "cd -- \"$SRC\""
    ];
}

function unitLines(flavor) {
    return [
        "UNIT_DIR=\"${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user\"",
        "UNIT=\"$UNIT_DIR/" + UNIT_NAME + "\"",
        // A reinstall keeps its port; otherwise the first free one from 8880.
        "PORT=",
        "if [ -f \"$UNIT\" ]; then PORT=$(sed -n 's/.*--port \\([0-9][0-9]*\\).*/\\1/p' \"$UNIT\" | head -n 1); fi",
        "port_busy() { if command -v ss >/dev/null 2>&1; then ss -ltnH \"sport = :$1\" 2>/dev/null | grep -q .; else curl -s -m 1 -o /dev/null \"http://127.0.0.1:$1/\"; fi; }",
        "if [ -z \"$PORT\" ]; then",
        "    p=8880",
        "    while [ \"$p\" -lt 8900 ]; do if ! port_busy \"$p\"; then PORT=$p; break; fi; p=$((p + 1)); done",
        "fi",
        "[ -n \"$PORT\" ] || { " + say(i18n("No free port between 8880 and 8899.")) + "; exit 1; }",
        "step mkdir -p -- \"$UNIT_DIR\"",
        "printf '\\n+ %s\\n' \"write $UNIT\"",
        // Same environment as kokoro-fastapi's start-cpu.sh / start-gpu.sh.
        // uvicorn exits cleanly after UVICORN_LIMIT_MAX_REQUESTS (a memory
        // leak guard), so Restart=always brings it back. Paths use %h, the
        // user's home as systemd sees it, so a "%" in $HOME can't be read as
        // a specifier; the heredoc leaves %h alone.
        "cat > \"$UNIT\" <<EOF",
        "[Unit]",
        "Description=Kokoro text-to-speech for PlasmaLLM",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "WorkingDirectory=" + UNIT_SRC,
        "Environment=\"USE_GPU=" + (flavor === "gpu" ? "true" : "false") + "\"",
        "Environment=\"USE_ONNX=false\"",
        "Environment=\"PYTHONPATH=" + UNIT_SRC + ":" + UNIT_SRC + "/api\"",
        "Environment=\"MODEL_DIR=src/models\"",
        "Environment=\"VOICES_DIR=src/voices/v1_0\"",
        "Environment=\"WEB_PLAYER_PATH=" + UNIT_SRC + "/web\"",
        "Environment=\"UVICORN_LIMIT_MAX_REQUESTS=" + UVICORN_MAX_REQUESTS + "\"",
        "ExecStart=\"" + UNIT_SRC + "/.venv/bin/uvicorn\" api.src.main:app --host 127.0.0.1 --port $PORT",
        "Restart=always",
        "RestartSec=3",
        "MemoryMax=4G",
        "",
        "[Install]",
        "WantedBy=default.target",
        "EOF"
    ];
}

function startLines() {
    return [
        "step systemctl --user daemon-reload",
        "step systemctl --user enable " + UNIT_NAME,
        "step systemctl --user restart " + UNIT_NAME,
        "URL=\"http://127.0.0.1:$PORT/v1\"",
        "printf '\\n+ %s\\n' \"wait for $URL/models (up to 120 s)\"",
        "i=0",
        "until curl -s -m 2 \"$URL/models\" 2>/dev/null | grep -q kokoro; do",
        "    i=$((i + 1))",
        "    if [ \"$i\" -ge 60 ]; then",
        "        " + say(i18n("Kokoro did not answer within 120 seconds. Its log:")),
        "        journalctl --user -u " + UNIT_NAME + " -n 30 --no-pager || true",
        "        exit 1",
        "    fi",
        "    sleep 2",
        "done",
        "echo; " + say(i18n("Kokoro is running. Its address:")),
        "echo \"    $URL\""
    ];
}

/**
 * Bash script that installs kokoro-fastapi from git and runs it as the
 * systemd user service plasmallm-kokoro.service, echoing every step.
 * Writes ok/failed plus the id to ~/.cache/plasmallm/kokoro-setup.status.
 * @param {string} flavor  "cpu" | "gpu"
 * @param {object} probe   parseProbe() output
 */
function buildInstallScript(flavor, probe) {
    probe = probe || parseProbe("");
    flavor = flavor === "gpu" ? "gpu" : "cpu";
    var lines = WhisperSetup.scriptHeader("kokoro:install-" + flavor, {
        title: "PlasmaLLM Kokoro setup",
        statusName: "kokoro-setup.status",
        doneText: i18n("Setup finished. Go back to the Text to Speech settings page and press Check again.")
    });
    lines = lines.concat(packageLines(probe), uvLines(), sourceLines(), [
        // A reinstall: stop the running copy before its environment changes.
        "systemctl --user stop " + UNIT_NAME + " 2>/dev/null || true",
        "if [ ! -x .venv/bin/python ]; then step \"$UV\" venv --python " + PYTHON_VERSION + "; fi",
        "step \"$UV\" pip install --python .venv/bin/python -e \".[" + flavor + "]\"",
        "step \"$UV\" run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0"
    ], unitLines(flavor), startLines());
    return lines.join("\n") + "\n";
}

/** Runs the install script in a terminal; see WhisperSetup.buildLaunchCommand. */
function buildLaunchCommand(script, marker) {
    return WhisperSetup.buildLaunchCommand(script, marker, "kokoro");
}

// ---------------------------------------------------------------- the widget

/**
 * Read-only: lists the systemd user services named *kokoro* the way the
 * probe does (KOKORO_UNIT lines), so the widget can offer to start one.
 */
function buildUnitLookupCommand(marker) {
    return ": plasmallm-kokoro-units-" + WhisperSetup.safeMarker(marker) + "; "
        + "to10=; command -v timeout >/dev/null 2>&1 && to10='timeout -k 5 10'; "
        + UNIT_LINE;
}

/** The unit to start from buildUnitLookupCommand() output: a stopped one, this page's own first; "" if none. */
function pickStartUnit(stdout) {
    var stopped = stoppedUnits(parseProbe(stdout).kokoro.units);
    return stopped.length ? stopped[0].name : "";
}

var NOTIFY_WINDOW_MS = 60000;

/** One "Kokoro isn't running" notification per burst of failures: not again within the window. */
function notifyAllowed(lastMs, nowMs, windowMs) {
    var w = windowMs > 0 ? windowMs : NOTIFY_WINDOW_MS;
    if (!(lastMs > 0) || nowMs < lastMs)
        return true;
    return nowMs - lastMs >= w;
}

/**
 * Starts a systemd user unit, then waits (up to about 90 s) until Kokoro
 * answers at a usual address, so the probe that follows finds it.
 */
function buildStartCommand(unit, marker) {
    var urls = DEFAULT_URLS.join(" ");
    return ": plasmallm-kokoro-start-" + WhisperSetup.safeMarker(marker) + "; "
        + "systemctl --user start -- " + WhisperSetup.shellQuote(unit) + " || exit $?; "
        + OWN_PORT_LINE + "; "
        + "us=" + WhisperSetup.shellQuote(urls) + "; [ -n \"$op\" ] && us=\"$us http://127.0.0.1:$op/v1\"; "
        + "i=0; while [ \"$i\" -lt 45 ]; do for u in $us; do "
        + "curl -s -m 2 \"$u/models\" 2>/dev/null | grep -q kokoro && exit 0; done; sleep 2; i=$((i + 1)); done; exit 0";
}
