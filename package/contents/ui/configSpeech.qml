/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import QtQuick.Dialogs
import QtCore
import org.kde.kirigami as Kirigami
import org.kde.kcmutils
import org.kde.kquickcontrols
import org.kde.plasma.workspace.dbus as DBus
import org.kde.plasma.plasma5support as P5Support

import "api.js" as Api
import "wallet.js" as Wallet
import "walletCore.js" as WalletCore
import "stt.js" as Stt
import "voiceProfiles.js" as VoiceProfiles
import "utils.js" as Utils
import "profiles.js" as Profiles
import "usage.js" as Usage

BaseConfigPage {
    id: configPage

    title: i18n("Speech to Text")

    property var availableModels: []
    property bool fetchInProgress: false
    property string walletApiKey: ""
    property bool walletKeyLoaded: false
    property bool walletAvailable: false
    property bool walletKeyDirty: false
    property string lastKeySlot: ""
    property int _sttKeyGen: 0
    property bool cliTestInProgress: false
    property string cliTestStatus: ""
    property bool cliCacheCheckInProgress: false
    property string cliCacheStatus: ""
    property int _cacheGen: 0
    property string cliCudaStatus: ""
    property int _cudaGen: 0
    property bool cppScanInProgress: false
    property int _cppScanGen: 0
    // Bumped each time a voice profile is put on the page. A model-list fetch
    // that started before the switch compares against it and drops its result,
    // so the old profile's models and model name never land on the new one.
    property int _voiceGen: 0
    // Local Whisper setup: probe result, and the install running in a terminal.
    property var setupProbe: null
    property bool setupProbeInProgress: false
    property int _setupGen: 0
    property int _setupRunGen: 0
    property bool setupRunning: false
    property double _setupRunStarted: 0
    property string setupRunStatus: ""

    readonly property var sttPresets: Stt.providerPresets()
    readonly property var sttBackends: Stt.backendChoices()
    // isCliBackend is the Python openai-whisper CLI only; whisper.cpp has its
    // own flag and isLocalBackend covers both for the shared CLI fields.
    readonly property bool isCliBackend: (cfg_sttBackend || "") === "whisper_cli"
    readonly property bool isCppBackend: (cfg_sttBackend || "") === "whisper_cpp"
    readonly property bool isLocalBackend: isCliBackend || isCppBackend
    // whisper-ctranslate2 (faster-whisper) runs through the Python backend.
    readonly property bool isCt2Cli: isCliBackend && Stt.whisperIsCt2(cfg_sttCliBinary)
    readonly property var setupRec: setupProbe ? Stt.whisperRecommend(setupProbe, {
        declined: cfg_sttSetupDeclined,
        cppDevice: cfg_sttCliDevice,
        cliBinary: cfg_sttCliBinary,
        cliDevice: cfg_sttCliDevice,
        cliModel: cfg_sttModelName
    }) : null
    readonly property var setupCur: setupRec ? (isCppBackend ? setupRec.whisper_cpp : (isCliBackend ? setupRec.whisper_cli : null)) : null
    readonly property var setupOpenOffers: setupCur ? setupCur.offers.filter(function(o) { return !o.declined; }) : []
    readonly property var setupDeclinedOffers: setupCur ? setupCur.offers.filter(function(o) { return o.declined; }) : []
    // Offers and the "Use it" suggestion the user chose to keep away from.
    readonly property var setupDeclinedIds: setupDeclinedOffers.map(function(o) { return o.id; })
        .concat(setupCur && setupCur.useBinary && setupCur.useBinary.declined ? [setupCur.useBinary.id] : [])
    // OpenRouter attribution applies to STT only through the HTTP
    // transcriptions adapter; whisper_cli is local and never attributes.
    readonly property bool sttOpenRouterSelected: (cfg_sttBackend || "openai_transcriptions") === "openai_transcriptions" &&
        Utils.isOpenRouterProvider(cfg_sttProviderName, cfg_sttApiEndpoint)

    P5Support.DataSource {
        id: whisperCacheCheck
        engine: "executable"
        connectedSources: []
        property string pendingModel: ""
        property int pendingGen: 0
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            var model = pendingModel;
            var gen = pendingGen;
            if (gen !== configPage._cacheGen)
                return;
            cliCacheCheckInProgress = false;
            pendingModel = "";
            var stdout = ((data.stdout || "") + "").replace(/^\s+|\s+$/g, "");
            if (stdout.indexOf("DOWNLOADED") === 0) {
                cliCacheStatus = i18n("Model “%1” is on disk.", model);
            } else {
                var hint = Stt.whisperDownloadSizeHint(model);
                if (hint && hint.length)
                    cliCacheStatus = i18n("Model “%1” is not downloaded. The first transcription will fetch it (%2) into ~/.cache/whisper and can take a long time.", model, hint);
                else
                    cliCacheStatus = i18n("Model “%1” is not downloaded. The first transcription will fetch it into ~/.cache/whisper and can take a long time.", model);
            }
        }
    }

    P5Support.DataSource {
        id: whisperCudaCheck
        engine: "executable"
        connectedSources: []
        property int pendingGen: 0
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            if (pendingGen !== configPage._cudaGen)
                return;
            var stdout = ((data.stdout || "") + "").replace(/^\s+|\s+$/g, "");
            if (exitCode === 0 && stdout.indexOf("1") === 0)
                cliCudaStatus = i18n("CUDA is available to Whisper.");
            else
                cliCudaStatus = i18n("CUDA is not available in this Whisper environment. Use cpu or Default.");
        }
    }

    P5Support.DataSource {
        id: whisperCppScan
        engine: "executable"
        connectedSources: []
        property int pendingGen: 0
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            if (pendingGen !== configPage._cppScanGen)
                return;
            cppScanInProgress = false;
            availableModels = Stt.whisperCppParseScan(data.stdout || "");
            // A model id carried over from another backend (e.g. "base") is
            // not a file path; pick a found model instead.
            var cur = (cfg_sttModelName || "").replace(/^\s+|\s+$/g, "");
            if (cur.length === 0 || (cur.charAt(0) !== "/" && cur.indexOf("~/") !== 0)) {
                var pick = "";
                for (var i = 0; i < availableModels.length; i++) {
                    if (/\/ggml-base\.bin$/.test(availableModels[i])) {
                        pick = availableModels[i];
                        break;
                    }
                }
                if (!pick.length && availableModels.length > 0)
                    pick = availableModels[0];
                cfg_sttModelName = pick;
            }
            syncModelCombo();
            modelStatusLabel.text = i18n("whisper.cpp models found in the model folders: %1", availableModels.length);
            modelStatusLabel.visible = true;
        }
    }

    // The probe command starts with ": plasmallm-whisper-probe-<gen>", so a
    // result is matched to its own run, not to whichever started last.
    P5Support.DataSource {
        id: whisperProbe
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            var m = /^: plasmallm-whisper-probe-(\d+)/.exec(source);
            if (!m || parseInt(m[1], 10) !== configPage._setupGen)
                return;
            setupProbeWatchdog.stop();
            setupProbeInProgress = false;
            setupProbe = Stt.whisperParseProbe(data.stdout || "");
            applyProbeCudaStatus();
        }
    }

    // A probe that never returns (a hung GPU tool beyond its timeout)
    // would otherwise keep every setup button disabled.
    Timer {
        id: setupProbeWatchdog
        interval: 150000
        onTriggered: {
            if (!setupProbeInProgress)
                return;
            ++_setupGen;
            whisperProbe.connectedSources.slice().forEach(function(s) { whisperProbe.disconnectSource(s); });
            setupProbeInProgress = false;
            setupRunStatus = i18n("Checking took too long and was stopped. Press Check again to retry.");
        }
    }

    P5Support.DataSource {
        id: whisperSetupRunner
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            setupRunning = false;
            var quick = Date.now() - _setupRunStarted < 5000;
            var failed = exitCode !== 0 && exitCode !== "0";
            // A quick failure is the terminal not starting (missing, or no
            // -e option); after a real run the script's own window showed
            // the result.
            if (quick && failed)
                setupRunStatus = i18n("The setup terminal could not be started: %1",
                    String(data.stderr || "").replace(/^\s+|\s+$/g, "") || i18n("exit %1", exitCode));
            // Some terminals hand the window to a running instance and
            // return at once; the script is then still going.
            else if (quick)
                setupRunStatus = i18n("If the setup terminal is still open, press Check again when it has finished.");
            else
                setupRunStatus = "";
            runSetupProbe();
        }
    }

    Timer {
        id: setupProbeDebounce
        interval: 800
        onTriggered: runSetupProbe()
    }

    P5Support.DataSource {
        id: whisperTest
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            cliTestInProgress = false;
            var stderr = (data.stderr || "").replace(/^\s+|\s+$/g, "");
            var stdout = (data.stdout || "").replace(/^\s+|\s+$/g, "");
            var result;
            if (exitCode === 0) {
                result = i18n("Whisper CLI responded to --help.");
            } else {
                var detail = stderr || stdout || "";
                if (detail.length > 240)
                    detail = detail.substring(0, 240);
                if (detail.length)
                    result = i18n("Whisper CLI test failed (exit %1): %2", exitCode, detail);
                else
                    result = i18n("Whisper CLI test failed (exit %1). Check the command.", exitCode);
            }
            cliTestStatus = result;
        }
    }

    function currentSttSlot() {
        return Api.sttKeySlot(cfg_sttProviderName, cfg_sttApiEndpoint);
    }

    function readFallbackMap() {
        return WalletCore.parseFallbackMap(cfg_apiKeysFallback);
    }

    function fallbackKeyFor(slot) {
        return WalletCore.lookupFallback(readFallbackMap(),
            [slot].concat(Api.sttLegacyKeySlots(cfg_sttProviderName, cfg_sttApiEndpoint)), "");
    }

    function writeFallbackKey(slot, key) {
        cfg_apiKeysFallback = WalletCore.stringifyFallbackMap(
            WalletCore.putFallback(readFallbackMap(), slot, key));
    }

    function loadWalletKey() {
        var myGen = ++_sttKeyGen;
        var slot = currentSttSlot();
        lastKeySlot = slot;
        walletKeyLoaded = false;

        function applyKey(key) {
            if (myGen !== _sttKeyGen || slot !== currentSttSlot())
                return;
            walletApiKey = key || "";
            walletKeyLoaded = true;
            if (apiKeyField)
                apiKeyField.text = walletApiKey;
            walletKeyDirty = false;
        }

        Wallet.readKey(DBus, slot, Api.sttLegacyKeySlots(cfg_sttProviderName, cfg_sttApiEndpoint),
            readFallbackMap(), "",
            function(res) {
                if (myGen !== _sttKeyGen || slot !== currentSttSlot())
                    return;
                walletAvailable = !!(res && res.available);
                applyKey(res ? res.key : fallbackKeyFor(slot));
            }
        );
    }

    function saveWalletKey() {
        var slot = currentSttSlot();
        var key = apiKeyField ? apiKeyField.text.replace(/^\s+|\s+$/g, "") : "";
        walletApiKey = key;
        walletKeyDirty = false;

        // The plaintext config copy is written only when KWallet could not
        // store the key, and scrubbed when it could.
        Wallet.writeKey(DBus, slot, key, function(res) {
            if (res && res.available)
                walletAvailable = true;
            if (res && res.success) {
                cfg_apiKeysFallback = WalletCore.stringifyFallbackMap(
                    WalletCore.removeFallback(readFallbackMap(), slot));
                apiKeyStatusLabel.text = i18n("API key saved to KWallet.");
            } else {
                writeFallbackKey(slot, key);
                apiKeyStatusLabel.text = i18n("API key saved to local fallback.");
            }
            apiKeyStatusLabel.visible = true;
        });
    }

    function syncProviderCombo() {
        var idx = 0;
        for (var i = 0; i < sttPresets.length; i++) {
            if (sttPresets[i].name === cfg_sttProviderName) {
                idx = i;
                break;
            }
        }
        // If endpoint matches a preset URL, select it
        if (!cfg_sttProviderName || cfg_sttProviderName.length === 0) {
            for (var j = 0; j < sttPresets.length; j++) {
                if (sttPresets[j].url && sttPresets[j].url === cfg_sttApiEndpoint) {
                    idx = j;
                    cfg_sttProviderName = sttPresets[j].name;
                    break;
                }
            }
        }
        if (providerCombo.currentIndex !== idx)
            providerCombo.currentIndex = idx;
    }

    function syncModelCombo() {
        if (modelPicker)
            modelPicker.syncIndex();
    }

    function loadModelCache() {
        availableModels = [];
        if (cfg_sttAvailableModels && cfg_sttAvailableModels.length > 0) {
            try {
                var arr = JSON.parse(cfg_sttAvailableModels);
                if (Array.isArray(arr))
                    availableModels = arr;
            } catch (e) {}
        }
        syncModelCombo();
    }

    function syncBackendCombo() {
        var id = cfg_sttBackend || "openai_transcriptions";
        var idx = 0;
        for (var i = 0; i < sttBackends.length; i++) {
            if (sttBackends[i].id === id) {
                idx = i;
                break;
            }
        }
        if (backendCombo.currentIndex !== idx)
            backendCombo.currentIndex = idx;
    }

    function scanCppModels() {
        var cmd = Stt.whisperCppScanCommand(cfg_sttCppModelDirs);
        if (!cmd || cmd.length === 0) {
            availableModels = [];
            syncModelCombo();
            return;
        }
        var myGen = ++_cppScanGen;
        cppScanInProgress = true;
        whisperCppScan.pendingGen = myGen;
        whisperCppScan.connectSource(cmd);
    }

    function applyCliModelList() {
        var startedGen = _voiceGen;
        Stt.fetchModels("", "", "whisper_cli", function(err, models) {
            if (startedGen !== _voiceGen)
                return;
            availableModels = models || [];
            if (!cfg_sttModelName || cfg_sttModelName.length === 0
                    || availableModels.indexOf(cfg_sttModelName) === -1) {
                cfg_sttModelName = "base";
            }
            syncModelCombo();
            checkWhisperCache(cfg_sttModelName);
        });
    }

    function checkWhisperCache(model) {
        if (!isCliBackend) {
            cliCacheStatus = "";
            return;
        }
        var id = (model || cfg_sttModelName || "").replace(/^\s+|\s+$/g, "");
        if (!id.length) {
            cliCacheStatus = "";
            return;
        }
        if (Stt.whisperIsCt2(cfg_sttCliBinary)) {
            cliCacheStatus = i18n("whisper-ctranslate2 downloads the model into the Hugging Face cache (~/.cache/huggingface) the first time it is used.");
            return;
        }
        var cmd = Stt.whisperCacheCheckCommand(id, cfg_sttCliBinary);
        if (!cmd || cmd.length === 0) {
            cliCacheStatus = "";
            return;
        }
        var myGen = ++_cacheGen;
        cliCacheCheckInProgress = true;
        cliCacheStatus = i18n("Checking whether “%1” is downloaded…", id);
        whisperCacheCheck.pendingModel = id;
        whisperCacheCheck.pendingGen = myGen;
        whisperCacheCheck.connectSource(cmd);
    }

    function checkWhisperCuda() {
        if (!isCliBackend || (cfg_sttCliDevice || "") !== "cuda") {
            cliCudaStatus = "";
            return;
        }
        var cmd = Stt.whisperCudaCheckCommand(cfg_sttCliBinary || "whisper");
        if (!cmd || cmd.length === 0) {
            cliCudaStatus = "";
            return;
        }
        var myGen = ++_cudaGen;
        cliCudaStatus = i18n("Checking CUDA…");
        whisperCudaCheck.pendingGen = myGen;
        whisperCudaCheck.connectSource(cmd);
    }

    function runSetupProbe() {
        if (!isLocalBackend)
            return;
        var myGen = ++_setupGen;
        setupProbeInProgress = true;
        setupProbeWatchdog.restart();
        whisperProbe.connectSource(Stt.whisperProbeCommand(cfg_sttCppBinary, cfg_sttCliBinary,
            isCppBackend ? cfg_sttModelName : "", myGen));
    }

    // The probe runs PyTorch/CTranslate2 from the program's own environment
    // (and knows which GPUs a PyTorch has kernels for), so its answer
    // replaces the older CUDA check's when it has one. Returns whether it did.
    function applyProbeCudaStatus() {
        if (!setupRec || !isCliBackend || (cfg_sttCliDevice || "") !== "cuda")
            return false;
        var rec = setupRec.whisper_cli;
        if (!rec.cudaKnown)
            return false;
        ++_cudaGen;
        cliCudaStatus = rec.cudaUsable
            ? i18n("CUDA is available to Whisper.")
            : i18n("CUDA is not available in this Whisper environment. Use cpu or Default.");
        return true;
    }

    function runSetupOffer(offer) {
        if (!offer || !setupProbe || setupRunning)
            return;
        var script = Stt.whisperInstallScript(offer.kind, offer.flavor, setupProbe, { cppModelDirs: cfg_sttCppModelDirs });
        setupRunning = true;
        _setupRunStarted = Date.now();
        setupRunStatus = i18n("Setup is running in a terminal window.");
        // The time keeps the command unique across settings dialogs; a
        // repeated command string would attach to a still-running source.
        whisperSetupRunner.connectSource(Stt.whisperLaunchCommand(script, Date.now() + "-" + (++_setupRunGen)));
    }

    // Declines are saved straight away, so closing Settings with Cancel
    // doesn't bring a declined offer back. "Show options" undoes it the same way.
    function saveSetupDeclined(value) {
        cfg_sttSetupDeclined = value;
        try {
            if (typeof plasmoid !== "undefined" && plasmoid && plasmoid.configuration) {
                plasmoid.configuration.sttSetupDeclined = value;
                plasmoid.configuration.writeConfig();
            }
        } catch (e) {
            console.warn("PlasmaLLM: could not save sttSetupDeclined: " + e);
        }
    }

    function declineSetupOffer(offerId) {
        saveSetupDeclined(Stt.whisperUpdateDeclined(cfg_sttSetupDeclined, [offerId], []));
    }

    function showSetupOptions() {
        saveSetupDeclined(Stt.whisperUpdateDeclined(cfg_sttSetupDeclined, [], setupDeclinedIds));
    }

    function useSetupBinary(choice) {
        if (!choice)
            return;
        if (isCppBackend)
            cfg_sttCppBinary = choice.path;
        else
            cfg_sttCliBinary = choice.path;
        if (choice.device && choice.device.length)
            cfg_sttCliDevice = choice.device;
        runSetupProbe();
    }

    // The voice profile bar replaced the settings on this page: refresh the
    // boxes the way opening the page does.
    function afterVoiceProfileApplied() {
        _voiceGen++;
        // A fetch still running was for the old profile and will be ignored;
        // clearing the flag lets the new profile's own fetch start.
        fetchInProgress = false;
        cliCacheStatus = "";
        cliCudaStatus = "";
        if (isCliBackend) {
            applyCliModelList();
        } else if (isCppBackend) {
            scanCppModels();
        } else {
            loadModelCache();
        }
        syncProviderCombo();
        syncBackendCombo();
        loadWalletKey();
        syncModelCombo();
        if (isCliBackend)
            checkWhisperCuda();
        runSetupProbe();
    }

    // Keep the active voice profile's copy current. The desktop shell calls
    // saveConfig() before it copies the cfg_ values, so that alone would be
    // enough there; the viewer shell copies first and calls saveConfig()
    // afterwards, which would miss the save. This runs shortly after every
    // edit so both orders end up with the profile saved.
    function syncVoiceProfile() {
        if (!_initialized || _applyingVoiceProfile)
            return;
        if (voiceProfileBar)
            voiceProfileBar.saveActiveProfile();
    }

    readonly property string voiceValuesKey: VoiceProfiles.valuesKey(configPage)
    onVoiceValuesKeyChanged: {
        if (_initialized && !_applyingVoiceProfile)
            voiceProfileSyncTimer.restart();
    }

    Timer {
        id: voiceProfileSyncTimer
        interval: 250
        repeat: false
        onTriggered: configPage.syncVoiceProfile()
    }

    // Apply/OK: a last catch-up for an edit made in the final moments. On the
    // desktop shell this runs before the cfg_ values are copied, so it is the
    // save that counts there; on the viewer shell it runs after the copy and
    // is only a backstop.
    function saveConfig() {
        voiceProfileSyncTimer.stop();
        syncVoiceProfile();
    }

    function applyBackend(index) {
        if (!_initialized) return;
        var choice = sttBackends[index];
        if (!choice) return;
        cfg_sttBackend = choice.id;
        if (choice.id === "whisper_cli") {
            if (!cfg_sttCliBinary || cfg_sttCliBinary.length === 0)
                cfg_sttCliBinary = "whisper";
            applyCliModelList();
        } else if (choice.id === "whisper_cpp") {
            if (!cfg_sttCppBinary || cfg_sttCppBinary.length === 0)
                cfg_sttCppBinary = "whisper-cli";
            cliCacheStatus = "";
            cliCudaStatus = "";
            scanCppModels();
        } else {
            loadModelCache();
            cliCacheStatus = "";
        }
    }

    function testWhisperCli() {
        if (cliTestInProgress)
            return;
        var cmd;
        if (isCppBackend) {
            cmd = Stt.whisperCppHelpCommand(cfg_sttCppBinary);
        } else {
            var prefix = (cfg_sttCliBinary || "whisper").replace(/^\s+|\s+$/g, "") || "whisper";
            cmd = prefix + " --help";
        }
        cliTestInProgress = true;
        cliTestStatus = isCppBackend ? i18n("Testing whisper.cpp…") : i18n("Testing Whisper CLI…");
        whisperTest.connectSource(cmd);
    }

    function fetchModels() {
        if (fetchInProgress)
            return;
        if (isCppBackend) {
            scanCppModels();
            return;
        }
        if (isCliBackend) {
            applyCliModelList();
            modelStatusLabel.text = i18n("Speech-to-text models loaded: %1", availableModels.length);
            modelStatusLabel.visible = true;
            return;
        }
        var endpoint = (cfg_sttApiEndpoint || "").replace(/\/+$/, "");
        if (!endpoint) {
            modelStatusLabel.text = i18n("Set an API endpoint first.");
            modelStatusLabel.visible = true;
            return;
        }
        fetchInProgress = true;
        modelStatusLabel.text = i18n("Fetching STT models…");
        modelStatusLabel.visible = true;
        var key = walletApiKey || (apiKeyField ? apiKeyField.text : "") || "";
        var startedGen = _voiceGen;
        Stt.fetchModels(endpoint, key, cfg_sttBackend || "openai_transcriptions", function(err, models, status, prices) {
            // A voice profile was put on the page while this was loading: the
            // list is for the old profile's endpoint, so it is dropped.
            if (startedGen !== _voiceGen)
                return;
            fetchInProgress = false;
            if (err) {
                modelStatusLabel.text = err;
                modelStatusLabel.visible = true;
                return;
            }
            availableModels = models || [];
            cfg_sttAvailableModels = JSON.stringify(availableModels);
            cfg_sttModelPrices = JSON.stringify({ endpoint: priceEndpoint(), prices: prices || {} });
            if (cfg_sttModelName && availableModels.indexOf(cfg_sttModelName) === -1) {
                // keep selection; combo will prepend it
            } else if ((!cfg_sttModelName || cfg_sttModelName.length === 0) && availableModels.length > 0) {
                cfg_sttModelName = availableModels[0];
            }
            syncModelCombo();
            modelStatusLabel.text = i18n("Speech-to-text models loaded: %1", availableModels.length);
            modelStatusLabel.visible = true;
        });
    }

    function priceEndpoint() {
        return (cfg_sttApiEndpoint || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    }

    // { modelId: {label, free} } for ModelPicker. Only the HTTP backend has
    // prices, and only for the endpoint they were fetched from.
    readonly property var modelPrices: {
        var out = {};
        if (isLocalBackend || !cfg_sttModelPrices)
            return out;
        var cache = {};
        try {
            cache = JSON.parse(cfg_sttModelPrices) || {};
        } catch (e) {}
        if (cache.endpoint !== priceEndpoint() || !cache.prices)
            return out;
        for (var id in cache.prices) {
            var l = Usage.speechPriceLabel(cache.prices[id], "stt");
            if (l) out[id] = l;
        }
        return out;
    }

    function applyProvider(index) {
        if (!_initialized) return;
        var preset = sttPresets[index];
        if (!preset) return;
        cfg_sttProviderName = preset.name;
        if (preset.url && preset.url.length > 0)
            cfg_sttApiEndpoint = preset.url;
        loadWalletKey();
    }

    // One-time migration: old design pointed sttProfileId at a chat profile.
    function migrateFromChatProfileIfNeeded() {
        if (cfg_sttMigratedFromProfile)
            return;
        if (cfg_sttApiEndpoint && cfg_sttApiEndpoint.length > 0) {
            cfg_sttMigratedFromProfile = true;
            return;
        }
        if (!cfg_sttProfileId || cfg_sttProfileId.length === 0) {
            cfg_sttMigratedFromProfile = true;
            return;
        }
        var profiles = Profiles.loadProfilesRaw(cfg_profiles);
        var p = Profiles.getActive(profiles, cfg_sttProfileId);
        if (p) {
            cfg_sttProviderName = p.providerName || "";
            cfg_sttApiEndpoint = p.apiEndpoint || "";
            cfg_sttModelName = p.modelName || "";
            if (cfg_sttApiEndpoint && cfg_sttModelName)
                cfg_sttEnabled = true;
        }
        cfg_sttMigratedFromProfile = true;
    }

    Component.onCompleted: {
        migrateFromChatProfileIfNeeded();
        if (!cfg_sttBackend || cfg_sttBackend.length === 0)
            cfg_sttBackend = "openai_transcriptions";
        if (isCliBackend) {
            applyCliModelList();
        } else if (isCppBackend) {
            scanCppModels();
        } else {
            loadModelCache();
            cliCacheStatus = "";
        }
        syncProviderCombo();
        syncBackendCombo();
        loadWalletKey();
        Qt.callLater(function() {
            _initialized = true;
            if (isCliBackend)
                checkWhisperCuda();
            runSetupProbe();
        });
    }

    // While a voice profile is being put on the page these wait; the page
    // refreshes once afterwards (afterVoiceProfileApplied).
    onCfg_sttBackendChanged: {
        if (!_initialized || _applyingVoiceProfile) return;
        syncBackendCombo();
        if (isCliBackend) {
            applyCliModelList();
        } else if (isCppBackend) {
            cliCacheStatus = "";
            cliCudaStatus = "";
            scanCppModels();
        } else {
            loadModelCache();
            cliCacheStatus = "";
            cliCudaStatus = "";
        }
        runSetupProbe();
    }
    onCfg_sttCliBinaryChanged: {
        if (!_initialized || _applyingVoiceProfile || !isCliBackend) return;
        checkWhisperCuda();
        checkWhisperCache(cfg_sttModelName);
        setupProbeDebounce.restart();
    }
    onCfg_sttCppBinaryChanged: if (_initialized && !_applyingVoiceProfile && isCppBackend) setupProbeDebounce.restart()
    // The probe's answer knows the program's own environment; the older
    // check guesses the python, so it runs only without a probe result.
    onCfg_sttCliDeviceChanged: if (_initialized && !_applyingVoiceProfile && !applyProbeCudaStatus()) checkWhisperCuda()
    onCfg_sttProviderNameChanged: if (_initialized && !_applyingVoiceProfile) syncProviderCombo()
    onCfg_sttApiEndpointChanged: {
        if (!_initialized || _applyingVoiceProfile) return;
        // Reload key for new slot when endpoint identity changes
        loadWalletKey();
    }
    onCfg_sttModelNameChanged: {
        if (_initialized && !_applyingVoiceProfile) {
            syncModelCombo();
            if (isCliBackend)
                checkWhisperCache(cfg_sttModelName);
            // whisper.cpp's memory check needs the model file's size.
            if (isCppBackend)
                setupProbeDebounce.restart();
        }
    }
    onCfg_sttAvailableModelsChanged: if (_initialized && !_applyingVoiceProfile) loadModelCache()

    Kirigami.FormLayout {
        // Prefer shrink-to-fit inside the Plasma config dialog; long combo
        // model strings must not force the window wider than the shell allows.
        width: Math.min(parent.width, pageMaxWidth)
        Layout.maximumWidth: pageMaxWidth

        VoiceProfileBar {
            id: voiceProfileBar
            Kirigami.FormData.label: i18n("Voice profile:")
            Layout.fillWidth: true
            page: configPage
            onApplied: configPage.afterVoiceProfileApplied()
        }

        QQC2.CheckBox {
            id: enableCheck
            Kirigami.FormData.label: i18n("Voice input:")
            text: i18n("Enable microphone input")
            checked: cfg_sttEnabled
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_sttEnabled = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.75
            text: i18n("Configures the speech-to-text engine only. Transcripts use your active chat profile (General).")
        }

        QQC2.ComboBox {
            id: micModeCombo
            Kirigami.FormData.label: i18n("Mic button:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            // Short labels keep the FormLayout narrow; details live in help text.
            model: [
                i18n("Auto"),
                i18n("Hold to talk"),
                i18n("Toggle")
            ]
            readonly property var modeIds: ["auto", "hold", "toggle"]
            currentIndex: {
                var m = cfg_sttMicMode || "auto";
                var i = modeIds.indexOf(m);
                return i >= 0 ? i : 0;
            }
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_sttMicMode = modeIds[index] || "auto";
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Auto: click toggles recording; hold 250 ms+ for push-to-talk. Hold: press-and-hold only. Toggle: click to start/stop.")
        }

        KeySequenceItem {
            id: sttShortcutItem
            Kirigami.FormData.label: i18n("Voice shortcut:")
            // Require a modifier so the binding does not fight typing in the input field.
            patterns: ShortcutPattern.Modifier | ShortcutPattern.ModifierAndKey
            keySequence: cfg_sttPanelShortcut || ""
            onKeySequenceModified: {
                if (!_initialized) return;
                var seq = keySequence;
                cfg_sttPanelShortcut = (seq === undefined || seq === null) ? "" : ("" + seq);
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("While PlasmaLLM is open and focused, uses the same mic mode as the button (auto: short press toggles, hold 250 ms+ is push-to-talk). Does not open the panel—use Activate widget on the Shortcuts page. Default: Ctrl+M. Clear to disable.")
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Transcriber")
            Layout.fillWidth: true
        }

        QQC2.ComboBox {
            id: backendCombo
            Kirigami.FormData.label: i18n("STT backend:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: sttBackends.map(function(b) { return b.name; })
            onActivated: function(index) {
                applyBackend(index);
            }
        }

        // The two local entries run the same Whisper models through different
        // programs, so say which one to pick.
        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: isCppBackend
                ? i18n("Runs Whisper on this computer with whisper.cpp, a C++ rewrite. Usually several times faster than the Python version on a CPU and lighter on memory. Uses ggml-*.bin model files. The best local choice without a strong NVIDIA GPU.")
                : isCliBackend
                ? i18n("Runs Whisper on this computer with OpenAI's original Python program (pip install openai-whisper). Slow on a CPU and reloads the model every time; worth it mainly with a CUDA GPU. whisper.cpp runs the same models faster on most machines.")
                : i18n("Sends the recording to a speech-to-text service (Groq, OpenAI, OpenRouter, or a local server). Fastest option, but audio leaves this computer. For offline use, pick one of the local backends.")
        }

        // What is installed, whether it suits this computer, and offers to
        // install or build the right one (whisperSetup.js decides; this
        // only shows it). Every offer can be declined and stays declined.
        ColumnLayout {
            id: setupBlock
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Setup:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            // Plain text: these carry GPU names and Python error lines.
            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                text: setupCur ? setupCur.message
                    : (setupProbeInProgress ? i18n("Checking what is installed…") : "")
                visible: text.length > 0
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.neutralTextColor
                text: setupCur ? setupCur.warnings.join("\n") : ""
                visible: text.length > 0
            }

            RowLayout {
                visible: !!(setupCur && setupCur.useBinary && !setupCur.useBinary.declined)
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    textFormat: Text.PlainText
                    font: Kirigami.Theme.smallFont
                    text: setupCur && setupCur.useBinary ? setupCur.useBinary.message : ""
                }

                QQC2.Button {
                    text: i18n("Use it")
                    icon.name: "dialog-ok-apply"
                    onClicked: useSetupBinary(setupCur.useBinary)
                }

                QQC2.Button {
                    text: i18n("Keep current setup")
                    icon.name: "dialog-cancel"
                    onClicked: declineSetupOffer(setupCur.useBinary.id)
                }
            }

            Repeater {
                model: setupOpenOffers

                delegate: ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    QQC2.Label {
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        textFormat: Text.PlainText
                        font: Kirigami.Theme.smallFont
                        opacity: 0.85
                        text: modelData.reason
                    }

                    QQC2.Label {
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        font: Kirigami.Theme.smallFont
                        opacity: 0.85
                        visible: modelData.missing.length > 0
                        text: modelData.packageCommand.length > 0
                            ? i18n("Needs packages; the terminal shows this command and asks before running it: %1", modelData.packageCommand)
                            : i18n("Needs %1. Install it with your package manager first.", modelData.missing.join(", "))
                    }

                    RowLayout {
                        spacing: Kirigami.Units.smallSpacing

                        QQC2.Button {
                            text: modelData.label
                            icon.name: modelData.kind === "whisper_cpp" ? "run-build" : "download"
                            enabled: !setupRunning && !setupProbeInProgress
                            onClicked: runSetupOffer(modelData)
                        }

                        QQC2.Button {
                            text: i18n("Keep current setup")
                            icon.name: "dialog-cancel"
                            onClicked: declineSetupOffer(modelData.id)
                        }
                    }
                }
            }

            RowLayout {
                visible: setupDeclinedIds.length > 0
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    font: Kirigami.Theme.smallFont
                    opacity: 0.7
                    text: i18n("You chose to keep the current setup.")
                }

                QQC2.Button {
                    text: i18n("Show options")
                    flat: true
                    onClicked: showSetupOptions()
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    text: i18n("Check again")
                    icon.name: "view-refresh"
                    enabled: !setupProbeInProgress
                    onClicked: {
                        setupRunStatus = "";
                        runSetupProbe();
                    }
                }

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    textFormat: Text.PlainText
                    font: Kirigami.Theme.smallFont
                    text: setupProbeInProgress ? i18n("Checking…") : setupRunStatus
                    visible: text.length > 0
                }
            }
        }

        QQC2.ComboBox {
            id: providerCombo
            visible: !isLocalBackend
            Kirigami.FormData.label: i18n("Provider:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: sttPresets.map(function(p) { return p.name; })
            onActivated: function(index) {
                applyProvider(index);
            }
        }

        QQC2.TextField {
            id: endpointField
            visible: !isLocalBackend
            Kirigami.FormData.label: i18n("Endpoint:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: "https://openrouter.ai/api/v1"
            text: cfg_sttApiEndpoint
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttApiEndpoint = text;
            }
            onEditingFinished: {
                if (!_initialized) return;
                // Custom typing: mark provider Custom if URL no longer matches a preset
                var matched = false;
                for (var i = 0; i < sttPresets.length; i++) {
                    if (sttPresets[i].url && sttPresets[i].url === cfg_sttApiEndpoint) {
                        cfg_sttProviderName = sttPresets[i].name;
                        matched = true;
                        break;
                    }
                }
                if (!matched && cfg_sttApiEndpoint.length > 0)
                    cfg_sttProviderName = "Custom";
                syncProviderCombo();
                loadWalletKey();
            }
        }

        ModelPicker {
            id: modelPicker
            Kirigami.FormData.label: i18n("Model:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            modelName: cfg_sttModelName
            modelPrices: configPage.modelPrices
            availableModels: configPage.availableModels
            fetchInProgress: configPage.fetchInProgress
            fetchVisible: !isCliBackend
            fetchEnabled: isCppBackend ? !cppScanInProgress
                : (!isCliBackend && !configPage.fetchInProgress && (cfg_sttApiEndpoint || "").length > 0)
            fetchTooltip: isCppBackend ? i18n("Rescan model folders") : i18n("Fetch STT models")
            onModelSelected: function(selected) {
                cfg_sttModelName = selected;
                // Picking drops the binding; restore it so the combo always
                // shows the saved model.
                modelPicker.modelName = Qt.binding(function() { return cfg_sttModelName; });
                rootItem.triggerCapture();
            }
            onFetchRequested: fetchModels()
        }

        // Result of loading or scanning the model list, shown next to the picker.
        QQC2.Label {
            id: modelStatusLabel
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            visible: false
            opacity: 0.9
        }

        QQC2.Label {
            visible: isCliBackend && cliCacheStatus.length > 0
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.85
            text: cliCacheStatus
        }

        QQC2.Label {
            visible: !isLocalBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("OpenRouter lists STT models only via transcription modalities (this page does that).")
        }

        RowLayout {
            visible: !isLocalBackend
            Kirigami.FormData.label: i18n("API key:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.TextField {
                id: apiKeyField
                Layout.fillWidth: true
                Layout.preferredWidth: 0
                Layout.minimumWidth: Kirigami.Units.gridUnit * 8
                echoMode: TextInput.Password
                placeholderText: i18n("Provider API key")
                onTextChanged: {
                    if (!_initialized || !walletKeyLoaded) return;
                    walletKeyDirty = true;
                }
            }

            QQC2.Button {
                text: i18n("Save")
                icon.name: "document-save"
                display: QQC2.AbstractButton.TextBesideIcon
                onClicked: saveWalletKey()
                QQC2.ToolTip.text: i18n("Save API key")
                QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                QQC2.ToolTip.visible: hovered
            }
        }

        QQC2.Label {
            id: apiKeyStatusLabel
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            visible: false
            opacity: 0.9
        }

        QQC2.TextField {
            id: cliBinaryField
            visible: isCliBackend
            Kirigami.FormData.label: i18n("Command:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: "whisper"
            text: cfg_sttCliBinary
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttCliBinary = text;
            }
        }

        QQC2.Label {
            visible: isCliBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Command prefix, inserted as-is. Examples: whisper, python3 -m whisper, toolbox run whisper.")
        }

        RowLayout {
            visible: isCppBackend
            Kirigami.FormData.label: i18n("Binary:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.TextField {
                id: cppBinaryField
                Layout.fillWidth: true
                Layout.preferredWidth: 0
                placeholderText: "whisper-cli"
                text: cfg_sttCppBinary
                onTextChanged: {
                    if (!_initialized) return;
                    cfg_sttCppBinary = text;
                }
            }

            QQC2.Button {
                text: i18n("Browse…")
                icon.name: "document-open"
                onClicked: cppBinaryDialog.open()
            }
        }

        FileDialog {
            id: cppBinaryDialog
            title: i18n("Select whisper-cli binary")
            fileMode: FileDialog.OpenFile
            currentFolder: StandardPaths.writableLocation(StandardPaths.HomeLocation)
            onAccepted: {
                cfg_sttCppBinary = decodeURIComponent(selectedFile.toString().replace(/^file:\/\//, ""));
            }
        }

        QQC2.Label {
            visible: isCppBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("whisper.cpp whisper-cli: a name on PATH or a full path (a leading ~/ is expanded). The model is the full path to a ggml .bin file.")
        }

        QQC2.TextField {
            id: cppDirsField
            visible: isCppBackend
            Kirigami.FormData.label: i18n("Model folders:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: "~/.cache/whisper.cpp"
            text: cfg_sttCppModelDirs
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttCppModelDirs = text;
            }
            onEditingFinished: {
                if (!_initialized) return;
                scanCppModels();
            }
        }

        QQC2.Label {
            visible: isCppBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Colon-separated folders searched for ggml-*.bin files. Use the refresh button next to Model to rescan.")
        }

        RowLayout {
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Test:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.Button {
                text: i18n("Test CLI")
                icon.name: "dialog-ok-apply"
                enabled: !cliTestInProgress
                onClicked: testWhisperCli()
            }

            // The page-wide status line sits below the fold; show the
            // result where the button is.
            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                font: Kirigami.Theme.smallFont
                text: cliTestStatus
                visible: cliTestStatus.length > 0
            }
        }

        QQC2.ComboBox {
            id: cliTaskCombo
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Task:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: [i18n("Transcribe"), i18n("Translate")]
            readonly property var taskIds: ["transcribe", "translate"]
            currentIndex: {
                var t = cfg_sttCliTask || "transcribe";
                var i = taskIds.indexOf(t);
                return i >= 0 ? i : 0;
            }
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_sttCliTask = taskIds[index] || "transcribe";
            }
        }

        QQC2.ComboBox {
            id: cliDeviceCombo
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Device:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: isCppBackend ? [i18n("Default"), "cpu"] : [i18n("Default"), "cpu", "cuda"]
            readonly property var deviceIds: ["", "cpu", "cuda"]
            currentIndex: {
                var d = cfg_sttCliDevice || "";
                var i = deviceIds.indexOf(d);
                return i >= 0 ? i : 0;
            }
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_sttCliDevice = deviceIds[index] || "";
            }
        }

        QQC2.Label {
            visible: isCliBackend && cliCudaStatus.length > 0
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.85
            text: cliCudaStatus
        }

        QQC2.CheckBox {
            id: cliFp16Check
            visible: isCliBackend && !isCt2Cli
            Kirigami.FormData.label: i18n("FP16:")
            text: i18n("Use --fp16 True (GPU)")
            checked: cfg_sttCliFp16
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_sttCliFp16 = checked;
            }
        }

        // Shares cfg_openrouterAttribution with the General tab: OpenRouter
        // STT transcriptions carry the same app-attribution headers as chat.
        QQC2.CheckBox {
            id: sttAttributionCheck
            visible: sttOpenRouterSelected
            Kirigami.FormData.label: i18n("OpenRouter:")
            text: i18n("Enable OpenRouter attribution")
            checked: cfg_openrouterAttribution
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_openrouterAttribution = checked;
            }
            QQC2.ToolTip.text: i18n("OpenRouter usage is credited to PlasmaLLM in its public app rankings while requests include only the app name and URL. Uncheck to stop sending these headers.")
            QQC2.ToolTip.delay: 500
            QQC2.ToolTip.visible: hovered
        }

        QQC2.Label {
            visible: sttOpenRouterSelected
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            text: i18n("OpenRouter attribution lets OpenRouter see that you used PlasmaLLM to access their API. Nothing about your conversations is shared.")
            wrapMode: Text.WordWrap
            opacity: 0.7
            font: Kirigami.Theme.smallFont
        }

        QQC2.SpinBox {
            id: cliThreadsSpin
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Threads:")
            from: 0
            to: 64
            value: cfg_sttCliThreads >= 0 ? cfg_sttCliThreads : 0
            onValueModified: {
                if (!_initialized) return;
                cfg_sttCliThreads = value;
            }
        }

        QQC2.Label {
            visible: isLocalBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: isCppBackend
                ? i18n("0 omits -t (whisper.cpp default). Device cpu passes -ng to turn the GPU off.")
                : i18n("0 omits --threads (Whisper default). FP16 off is safer on CPU.")
        }

        QQC2.TextField {
            id: cliPromptField
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Initial prompt:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("Optional vocabulary / style hint")
            text: cfg_sttCliInitialPrompt
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttCliInitialPrompt = text;
            }
        }

        QQC2.TextField {
            id: cliExtraField
            visible: isLocalBackend
            Kirigami.FormData.label: i18n("Extra args:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("Optional, appended as-is")
            text: cfg_sttCliExtraArgs
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttCliExtraArgs = text;
            }
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Options")
            Layout.fillWidth: true
        }

        QQC2.TextField {
            id: languageField
            Kirigami.FormData.label: i18n("Language hint:")
            Layout.fillWidth: true
            placeholderText: i18n("Optional, e.g. en or ja (empty = auto)")
            text: cfg_sttLanguage
            onTextChanged: {
                if (!_initialized) return;
                cfg_sttLanguage = text;
            }
        }

        QQC2.SpinBox {
            id: maxSecondsSpin
            Kirigami.FormData.label: i18n("Max recording (seconds):")
            from: 5
            to: 300
            value: cfg_sttMaxSeconds > 0 ? cfg_sttMaxSeconds : 60
            onValueModified: {
                if (!_initialized) return;
                cfg_sttMaxSeconds = value;
            }
        }
    }
}
