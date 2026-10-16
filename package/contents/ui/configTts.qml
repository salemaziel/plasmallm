/*
    SPDX-FileCopyrightText: 2026 Joshua Roman
    SPDX-License-Identifier: GPL-2.0-or-later
*/

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami
import org.kde.kcmutils
import org.kde.kquickcontrols
import org.kde.plasma.workspace.dbus as DBus
import org.kde.plasma.plasma5support as P5Support

import "api.js" as Api
import "wallet.js" as Wallet
import "walletCore.js" as WalletCore
import "tts.js" as Tts
import "voiceProfiles.js" as VoiceProfiles
import "profiles.js" as Profiles
import "usage.js" as Usage
import "ttsAdapters/kokoroSetup.js" as KokoroSetup
import "ttsAdapters/kokoroMix.js" as KokoroMix
import "ttsAdapters/speechRules.js" as SpeechRules

BaseConfigPage {
    id: configPage

    title: i18n("Text to Speech")

    property var availableModels: []
    property bool fetchInProgress: false
    property string walletApiKey: ""
    property bool walletKeyLoaded: false
    property bool walletAvailable: false
    property bool walletKeyDirty: false
    property string lastKeySlot: ""
    property int _ttsKeyGen: 0
    property bool testInProgress: false
    property string testStatusText: ""

    readonly property var ttsPresets: Tts.providerPresets()
    readonly property var ttsBackends: Tts.backendChoices()
    readonly property bool isSpdBackend: (cfg_ttsBackend || "spd_say") === "spd_say"
    readonly property bool isEndpointBackend: (cfg_ttsBackend || "") === "openai_speech"
    readonly property bool isKokoroBackend: (cfg_ttsBackend || "") === "kokoro_local"
    readonly property bool isCustomBackend: (cfg_ttsBackend || "") === "custom_cli"
    // The Custom preset starts blank and never falls back to the built-in
    // model and voice lists; everything comes from its own endpoint.
    readonly property bool isCustomPreset: (cfg_ttsProviderName || "") === "Custom"
    // How the voice box shows the choice that sends no voice at all.
    readonly property string modelDefaultLabel: i18n("Model default")
    // Only models known to send 24 kHz PCM can be asked for pcm; the rest get
    // mp3, except under the Custom preset, where the format is the user's choice.
    readonly property bool modelSendsPcm: SpeechRules.sendsPcm24k(cfg_ttsModelName)
    readonly property bool formatChoosable: SpeechRules.formatIsChoosable(cfg_ttsModelName, cfg_ttsProviderName)
    property bool voiceOffersModelDefault: false

    // Kokoro (local): probe result, server voices, and setup running in a terminal.
    property var kokoroProbe: null
    property bool kokoroProbeInProgress: false
    property int _kokoroGen: 0
    property int _kokoroRunGen: 0
    property bool kokoroRunning: false
    property double _kokoroRunStarted: 0
    property string kokoroRunStatus: ""
    property bool _kokoroAfterSetup: false
    property var kokoroVoices: []
    property bool kokoroVoicesLoading: false
    // The last voice load found no server answering at the Server URL.
    property bool kokoroVoicesFailed: false
    property int _kokoroVoicesGen: 0
    property bool _syncingKokoroVoice: false
    // True only while the voice combo writes cfg_ttsKokoroVoice itself.
    property bool _kokoroVoiceFromCombo: false
    // The Server URL the running probe was started with, and the one the
    // finished result was taken with. The recommendation is judged against
    // the latter, so typing in the field doesn't re-judge an older result.
    property string _kokoroProbeUrl: ""
    property string kokoroProbedUrl: ""
    // A server that accepts connections but has not answered yet is still
    // loading. When it was first seen so (ms, 0 = not seen), and whether the
    // page waited long enough and now calls it not running.
    property double _kokoroStartingSince: 0
    property bool kokoroStartingGaveUp: false
    // Voice mixes: the dropdown's entries, the editor's rows and name.
    property var kokoroVoiceEntries: []
    property bool kokoroMixOpen: false
    property var mixRows: []
    property string mixName: ""
    property string mixStatus: ""
    property string mixTestText: ""
    property bool _testFromMix: false
    readonly property var kokoroMixes: KokoroMix.parseMixes(cfg_ttsKokoroMixes)
    readonly property string mixResult: KokoroMix.formatVoiceString(mixRows)
    // What a preset switch overwrites (endpoint, model, voice, audio format),
    // as it was when each preset was last left, keyed by preset name. Going
    // back to a preset restores it. Kept only while this settings window is
    // open; nothing here is saved to the config.
    property var _presetMemo: ({})
    readonly property var kokoroRec: kokoroProbe ? KokoroSetup.recommend(kokoroProbe, {
        url: kokoroProbedUrl,
        declined: cfg_ttsSetupDeclined,
        gaveUp: kokoroStartingGaveUp
    }) : null
    // Accepting connections but not answering yet (kokoroSetup.js decides).
    readonly property bool kokoroStarting: isKokoroBackend && !!kokoroRec && kokoroRec.status === "starting"
    readonly property var kokoroOpenOffers: kokoroRec ? kokoroRec.offers.filter(function(o) { return !o.declined; }) : []
    readonly property var kokoroDeclinedIds: kokoroRec ? kokoroRec.offers.filter(function(o) { return o.declined; })
        .map(function(o) { return o.id; }) : []
    readonly property string kokoroUrl: (cfg_ttsKokoroUrl || "").replace(/^\s+|\s+$/g, "")
    // Nothing answers at the Server URL (kokoroSetup.js decides).
    readonly property bool kokoroNotAnswering: isKokoroBackend && KokoroSetup.notAnswering({
        url: kokoroUrl,
        probe: kokoroProbe,
        rec: kokoroRec,
        probedUrl: kokoroProbedUrl,
        busy: kokoroProbeInProgress || kokoroVoicesLoading || kokoroRunning,
        voiceCount: kokoroVoices.length,
        voicesFailed: kokoroVoicesFailed
    })
    readonly property var kokoroNotRunningOffers: KokoroSetup.notRunningOffers(kokoroRec)
    // The block under the Voice box shows its offers (and its Start button
    // is then the only one on the page; see startShownByVoiceBox).
    readonly property bool kokoroVoiceBoxOffers: isKokoroBackend && (kokoroNotAnswering || kokoroRunning)
    readonly property var kokoroLanguages: [
        { value: "", text: i18n("From voice name") },
        { value: "a", text: i18n("American English") },
        { value: "b", text: i18n("British English") },
        { value: "e", text: i18n("Spanish") },
        { value: "f", text: i18n("French") },
        { value: "h", text: i18n("Hindi") },
        { value: "i", text: i18n("Italian") },
        { value: "j", text: i18n("Japanese") },
        { value: "p", text: i18n("Brazilian Portuguese") },
        { value: "z", text: i18n("Mandarin Chinese") }
    ]

    // Runs the commands Tts.speak hands it and returns each result to the
    // callback it came with. Endpoint backends run in two steps (synthesize,
    // then play); the second only starts when the first one's result comes
    // back, so the callback must be invoked or nothing is ever heard.
    property var _testCallbacks: ({})

    P5Support.DataSource {
        id: ttsTestRunner
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            var cb = configPage._testCallbacks[source];
            delete configPage._testCallbacks[source];
            if (typeof cb === "function")
                cb(null, { stdout: data.stdout || "", stderr: data.stderr || "", exitCode: exitCode });
        }
    }

    // The probe command starts with ": plasmallm-kokoro-probe-<time>-<gen>", so a
    // result is matched to its own run, not to whichever started last. The
    // time keeps the command unique across settings windows. The short check
    // of a server that is still loading starts ": plasmallm-kokoro-recheck-"
    // instead and only updates the last probe's answers.
    P5Support.DataSource {
        id: kokoroProbeSource
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            var m = /^: plasmallm-kokoro-(probe|recheck)-\d+-(\d+)/.exec(source);
            if (!m || parseInt(m[2], 10) !== configPage._kokoroGen)
                return;
            kokoroProbeWatchdog.stop();
            kokoroProbeInProgress = false;
            kokoroProbedUrl = _kokoroProbeUrl;
            if (m[1] === "recheck" && kokoroProbe)
                kokoroProbe = KokoroSetup.mergeRecheck(kokoroProbe, data.stdout || "");
            else
                kokoroProbe = KokoroSetup.parseProbe(data.stdout || "");
            applyKokoroProbe();
            stepKokoroStarting();
        }
    }

    // A server that is still loading is checked again every few seconds,
    // until it answers or about a minute has passed.
    Timer {
        id: kokoroRecheckTimer
        interval: KokoroSetup.STARTING_RECHECK_MS
        onTriggered: {
            if (kokoroStarting && !kokoroProbeInProgress)
                runKokoroProbe(true);
        }
    }

    // A probe that never returns would otherwise keep the setup buttons disabled.
    Timer {
        id: kokoroProbeWatchdog
        interval: 120000
        onTriggered: {
            if (!kokoroProbeInProgress)
                return;
            ++_kokoroGen;
            kokoroProbeSource.connectedSources.slice().forEach(function(s) { kokoroProbeSource.disconnectSource(s); });
            kokoroProbeInProgress = false;
            kokoroRunStatus = i18n("Checking took too long and was stopped. Press Check again to retry.");
        }
    }

    // Runs the install (in a terminal) and "Start it" (systemctl --user start).
    P5Support.DataSource {
        id: kokoroRunner
        engine: "executable"
        connectedSources: []
        onNewData: function(source, data) {
            var exitCode = data["exit code"];
            if (exitCode === undefined)
                return;
            disconnectSource(source);
            kokoroRunning = false;
            var failed = exitCode !== 0 && exitCode !== "0";
            var stderr = String(data.stderr || "").replace(/^\s+|\s+$/g, "");
            if (/^: plasmallm-kokoro-start-/.test(source)) {
                kokoroRunStatus = failed
                    ? i18n("Kokoro could not be started: %1", stderr || i18n("exit %1", exitCode))
                    : "";
                // Started: load its voices now rather than wait for the check.
                if (!failed)
                    loadKokoroVoices();
            } else {
                var quick = Date.now() - _kokoroRunStarted < 5000;
                // A quick failure is the terminal not starting; after a real
                // run the script's own window showed the result.
                if (quick && failed)
                    kokoroRunStatus = i18n("The setup terminal could not be started: %1", stderr || i18n("exit %1", exitCode));
                else if (quick)
                    kokoroRunStatus = i18n("If the setup terminal is still open, press Check again when it has finished.");
                else
                    kokoroRunStatus = "";
                _kokoroAfterSetup = true;
            }
            runKokoroProbe();
        }
    }

    Timer {
        id: kokoroUrlDebounce
        interval: 800
        onTriggered: {
            runKokoroProbe();
            loadKokoroVoices();
        }
    }

    // isRecheck: the timer above checking on a server that is still loading;
    // it asks only the addresses the last probe found slow. Any other check is
    // the full probe and starts the wait over.
    function runKokoroProbe(isRecheck) {
        if (!isKokoroBackend)
            return;
        if (isRecheck !== true) {
            kokoroRecheckTimer.stop();
            _kokoroStartingSince = 0;
            kokoroStartingGaveUp = false;
        }
        var myGen = ++_kokoroGen;
        var recheckCmd = "";
        if (isRecheck === true && kokoroProbe && kokoroProbe.kokoro)
            recheckCmd = KokoroSetup.buildRecheckCommand(kokoroProbe.kokoro.slow, Date.now() + "-" + myGen);
        kokoroProbeInProgress = true;
        kokoroProbeWatchdog.restart();
        if (recheckCmd.length) {
            kokoroProbeSource.connectSource(recheckCmd);
            return;
        }
        _kokoroProbeUrl = cfg_ttsKokoroUrl || "";
        kokoroProbeSource.connectSource(KokoroSetup.buildProbeCommand(_kokoroProbeUrl, Date.now() + "-" + myGen));
    }

    // After a check: if the server accepted the connection but did not
    // answer, check again soon; after about a minute call it not running.
    function stepKokoroStarting() {
        var step = KokoroSetup.startingStep(kokoroRec ? kokoroRec.status : "", _kokoroStartingSince, Date.now());
        _kokoroStartingSince = step.since;
        if (step.action === "recheck") {
            kokoroRecheckTimer.restart();
        } else {
            kokoroRecheckTimer.stop();
            if (step.action === "giveup")
                kokoroStartingGaveUp = true;
        }
    }

    // After this page's install finished, fill in its address when the
    // Server URL is still blank. The wish stays until a probe finds that
    // server (the terminal may return before the install is done), or the
    // URL gets set another way, the offer is declined, or the backend changes.
    function applyKokoroProbe() {
        if (!kokoroRec)
            return;
        if (_kokoroAfterSetup) {
            if ((cfg_ttsKokoroUrl || "").length) {
                _kokoroAfterSetup = false;
            } else if (kokoroRec.ownUrl.length) {
                _kokoroAfterSetup = false;
                cfg_ttsKokoroUrl = kokoroRec.ownUrl;
                kokoroUrlField.text = cfg_ttsKokoroUrl;
                runKokoroProbe();
                loadKokoroVoices();
                return;
            }
        }
        if (kokoroRec.status === "running" && kokoroVoices.length === 0 && !kokoroVoicesLoading)
            loadKokoroVoices();
    }

    function runKokoroOffer(offer) {
        if (!offer || kokoroRunning)
            return;
        if (offer.kind === "use") {
            _kokoroAfterSetup = false;
            cfg_ttsKokoroUrl = offer.url;
            kokoroUrlField.text = offer.url;
            runKokoroProbe();
            loadKokoroVoices();
            return;
        }
        // The time keeps the command unique across settings dialogs; a
        // repeated command string would attach to a still-running source.
        var marker = Date.now() + "-" + (++_kokoroRunGen);
        kokoroRunning = true;
        _kokoroRunStarted = Date.now();
        if (offer.kind === "start") {
            kokoroRunStatus = i18n("Starting %1…", offer.unit);
            kokoroRunner.connectSource(KokoroSetup.buildStartCommand(offer.unit, marker));
            return;
        }
        if (!kokoroProbe) {
            kokoroRunning = false;
            return;
        }
        kokoroRunStatus = i18n("Setup is running in a terminal window.");
        kokoroRunner.connectSource(KokoroSetup.buildLaunchCommand(
            KokoroSetup.buildInstallScript(offer.flavor, kokoroProbe), marker));
    }

    // Declines are saved straight away, so closing Settings with Cancel
    // doesn't bring a declined offer back. "Show options" undoes it the same way.
    function saveSetupDeclined(value) {
        cfg_ttsSetupDeclined = value;
        try {
            if (typeof plasmoid !== "undefined" && plasmoid && plasmoid.configuration) {
                plasmoid.configuration.ttsSetupDeclined = value;
                plasmoid.configuration.writeConfig();
            }
        } catch (e) {
            console.warn("PlasmaLLM: could not save ttsSetupDeclined: " + e);
        }
    }

    function declineKokoroOffer(offerId) {
        _kokoroAfterSetup = false;
        saveSetupDeclined(KokoroSetup.updateDeclined(cfg_ttsSetupDeclined, [offerId], []));
    }

    function showKokoroOptions() {
        saveSetupDeclined(KokoroSetup.updateDeclined(cfg_ttsSetupDeclined, [], kokoroDeclinedIds));
    }

    function loadKokoroVoices() {
        var url = (cfg_ttsKokoroUrl || "").replace(/^\s+|\s+$/g, "");
        var myGen = ++_kokoroVoicesGen;
        kokoroVoicesFailed = false;
        if (!url.length) {
            kokoroVoices = [];
            kokoroVoicesLoading = false;
            kokoroVoiceStatus.text = "";
            syncKokoroVoiceCombo();
            return;
        }
        kokoroVoicesLoading = true;
        kokoroVoiceStatus.text = i18n("Loading voices…");
        Tts.fetchModels(url, "", "kokoro_local", function(err, models, voices) {
            if (myGen !== _kokoroVoicesGen)
                return;
            kokoroVoicesLoading = false;
            if (err) {
                kokoroVoices = [];
                kokoroVoicesFailed = true;
                kokoroVoiceStatus.text = i18n("Could not load voices: %1", err);
            } else {
                kokoroVoices = (voices && voices["*"]) || [];
                kokoroVoiceStatus.text = i18n("Voices loaded: %1", kokoroVoices.length);
            }
            syncKokoroVoiceCombo(true);
        });
    }

    // The saved mixes come first, under a heading, then the server's voices.
    // A voice not in the server's list (typed, or a mix like af_heart+af_bella
    // that isn't saved) is kept and shown after the mixes. A saved mix is
    // shown by its name while its voice string is what gets stored.
    // With keepTypedText (the voice list arriving), a box the user is
    // editing keeps what it shows: only its list is refreshed, so an
    // emptied box isn't snapped back to af_heart under the cursor.
    function syncKokoroVoiceCombo(keepTypedText) {
        if (!kokoroVoiceCombo)
            return;
        var editing = keepTypedText === true
            && (kokoroVoiceCombo.activeFocus
                || (kokoroVoiceCombo.contentItem && kokoroVoiceCombo.contentItem.activeFocus));
        var typed = kokoroVoiceCombo.editText;
        var cursor = editing && kokoroVoiceCombo.contentItem
            ? kokoroVoiceCombo.contentItem.cursorPosition : 0;
        var cur = cfg_ttsKokoroVoice || "af_heart";
        var entries = KokoroMix.comboEntries(kokoroMixes, kokoroVoices, cur, i18n("Saved mixes"));
        kokoroVoiceEntries = entries;
        _syncingKokoroVoice = true;
        kokoroVoiceCombo.model = entries;
        kokoroVoiceCombo.currentIndex = KokoroMix.entryIndex(entries, cur);
        if (editing) {
            kokoroVoiceCombo.editText = typed;
            if (kokoroVoiceCombo.contentItem)
                kokoroVoiceCombo.contentItem.cursorPosition = cursor;
        }
        _syncingKokoroVoice = false;
    }

    // ---- Voice mixes (kokoroMix.js does the parsing and the list handling)

    // A voice for a new row: the first loaded voice the rows don't use yet,
    // or an empty row when there is none (never a copy of a voice in the mix).
    function nextMixVoice() {
        return KokoroMix.nextVoice(mixRows, kokoroVoices);
    }

    // Opens the editor on the voice now chosen: a saved mix loads under its
    // name, a typed mix or a single voice loads as rows too. A voice that
    // can't be read as rows starts a fresh mix. Always at least two rows.
    function openKokoroMix() {
        var cur = cfg_ttsKokoroVoice || "";
        var saved = KokoroMix.findMixByVoice(kokoroMixes, cur);
        var rows = KokoroMix.rowsFromVoice(cur);
        mixStatus = "";
        mixTestText = "";
        mixName = saved ? saved.name : "";
        mixRows = rows || [];
        if (!rows && cur.length)
            mixStatus = i18n("The voice \"%1\" can't be shown as rows, so this starts a new mix.", cur);
        while (mixRows.length < 2)
            mixRows = KokoroMix.addRow(mixRows, nextMixVoice());
        kokoroMixOpen = true;
    }

    function mixErrorText(res) {
        switch (res.error) {
        case "name-empty": return i18n("Type a name for the mix first.");
        case "name-long": return i18n("The name can be at most %1 characters.", KokoroMix.MAX_NAME);
        case "name-is-voice": return i18n("That name is already a voice, or looks like one. Pick another name.");
        case "voice-saved-as": return i18n("This mix is already saved as \"%1\".", res.existing);
        case "needs-two": return i18n("A mix needs at least two voices.");
        case "same-voice": return i18n("A mix can't use the same voice twice. Change one of the rows.");
        default: return i18n("Pick a voice in every row.");
        }
    }

    function saveKokoroMix() {
        var res = KokoroMix.saveMix(kokoroMixes, mixName, mixResult, kokoroVoices);
        if (!res.ok) {
            mixStatus = mixErrorText(res);
            return;
        }
        cfg_ttsKokoroMixes = KokoroMix.serializeMixes(res.list);
        var name = KokoroMix.cleanName(mixName);
        var saved = KokoroMix.findMix(res.list, name);
        mixName = saved.name;
        // Choose it, so the Voice box shows what was just saved.
        _kokoroVoiceFromCombo = true;
        cfg_ttsKokoroVoice = saved.voice;
        _kokoroVoiceFromCombo = false;
        syncKokoroVoiceCombo();
        mixStatus = res.replaced ? i18n("Replaced \"%1\".", saved.name) : i18n("Saved \"%1\".", saved.name);
    }

    function deleteKokoroMix() {
        var res = KokoroMix.deleteMix(kokoroMixes, mixName);
        if (!res.ok) {
            mixStatus = KokoroMix.cleanName(mixName).length
                ? i18n("There is no saved mix named \"%1\".", KokoroMix.cleanName(mixName))
                : i18n("Type the name of the saved mix to delete.");
            return;
        }
        var gone = KokoroMix.findMix(kokoroMixes, mixName);
        cfg_ttsKokoroMixes = KokoroMix.serializeMixes(res.list);
        mixStatus = i18n("Deleted \"%1\".", gone.name);
        mixName = "";
    }

    function testKokoroMix() {
        if (!mixResult.length) {
            mixStatus = i18n("Pick a voice in every row.");
            return;
        }
        mixStatus = "";
        runVoiceTest(mixResult);
    }

    function kokoroLangIndex(code) {
        for (var i = 0; i < kokoroLanguages.length; i++) {
            if (kokoroLanguages[i].value === (code || ""))
                return i;
        }
        return 0;
    }

    function finishVoiceTest(err) {
        testInProgress = false;
        testStatusLabel.text = err
            ? i18n("TTS test failed: %1", String(err).substring(0, 240))
            : i18n("Text-to-speech test completed successfully.");
        testStatusLabel.visible = true;
        if (_testFromMix)
            mixTestText = testStatusLabel.text;
        _testFromMix = false;
    }

    function currentTtsSlot() {
        return Api.ttsKeySlot(cfg_ttsProviderName, cfg_ttsApiEndpoint);
    }

    function readFallbackMap() {
        return WalletCore.parseFallbackMap(cfg_apiKeysFallback);
    }

    function fallbackKeyFor(slot) {
        return WalletCore.lookupFallback(readFallbackMap(),
            [slot].concat(Api.ttsLegacyKeySlots(cfg_ttsProviderName, cfg_ttsApiEndpoint)), "");
    }

    function writeFallbackKey(slot, key) {
        cfg_apiKeysFallback = WalletCore.stringifyFallbackMap(
            WalletCore.putFallback(readFallbackMap(), slot, key));
    }

    function loadWalletKey() {
        var myGen = ++_ttsKeyGen;
        var slot = currentTtsSlot();
        lastKeySlot = slot;
        walletKeyLoaded = false;

        function applyKey(key, sourceMsg) {
            if (myGen !== _ttsKeyGen || slot !== currentTtsSlot())
                return;
            walletApiKey = key || "";
            walletKeyLoaded = true;
            if (apiKeyField)
                apiKeyField.text = walletApiKey;
            walletKeyDirty = false;
            if (sourceMsg) {
                keyStatusLabel.text = sourceMsg;
                keyStatusLabel.visible = true;
            }
        }

        Wallet.readKey(DBus, slot, Api.ttsLegacyKeySlots(cfg_ttsProviderName, cfg_ttsApiEndpoint),
            readFallbackMap(), "",
            function(res) {
                if (myGen !== _ttsKeyGen || slot !== currentTtsSlot())
                    return;
                walletAvailable = !!(res && res.available);
                var key = (res && res.key) ? res.key : fallbackKeyFor(slot);
                if (key && key.length > 0) {
                    applyKey(key);
                    return;
                }

                // If no key saved for TTS, automatically reuse existing key from STT
                var sttSlot = Api.sttKeySlot(cfg_ttsProviderName, cfg_ttsApiEndpoint);
                Wallet.readKey(DBus, sttSlot, Api.sttLegacyKeySlots(cfg_ttsProviderName, cfg_ttsApiEndpoint),
                    readFallbackMap(), "",
                    function(sttRes) {
                        if (myGen !== _ttsKeyGen || slot !== currentTtsSlot())
                            return;
                        var sttKey = (sttRes && sttRes.key) ? sttRes.key : WalletCore.lookupFallback(readFallbackMap(), [sttSlot], "");
                        if (sttKey && sttKey.length > 0) {
                            applyKey(sttKey, i18n("Reused API key from Speech to Text."));
                            // Persist to TTS slot in wallet
                            Wallet.writeKey(DBus, slot, sttKey, function() {});
                            return;
                        }

                        // Check chat profiles for matching provider/endpoint
                        var profiles = Profiles.loadProfilesRaw(cfg_profiles);
                        var checkList = [];
                        var activeP = Profiles.getActive(profiles, cfg_activeProfileId);
                        if (activeP) checkList.push(activeP);
                        for (var i = 0; i < profiles.length; i++) {
                            if (!activeP || profiles[i].id !== activeP.id)
                                checkList.push(profiles[i]);
                        }

                        function checkNextProfile(idx) {
                            if (idx >= checkList.length) {
                                // Final check: single-slot fallback cfg_apiKey
                                if (cfg_apiKey && cfg_apiKey.length > 0 && cfg_ttsProviderName === "OpenRouter") {
                                    applyKey(cfg_apiKey, i18n("Reused API key from General settings."));
                                    Wallet.writeKey(DBus, slot, cfg_apiKey, function() {});
                                } else {
                                    applyKey("");
                                }
                                return;
                            }
                            var p = checkList[idx];
                            var matches = (p.providerName && p.providerName.toLowerCase() === (cfg_ttsProviderName || "").toLowerCase())
                                || (p.apiEndpoint && WalletCore.normalizeEndpoint(p.apiEndpoint) === WalletCore.normalizeEndpoint(cfg_ttsApiEndpoint));
                            if (matches) {
                                var cSlot = Api.chatKeySlot(p.id, p.apiType || "openai", p.providerName || "", p.apiEndpoint || "", null);
                                Wallet.readKey(DBus, cSlot, Api.legacyKeySlots(p.id, p.apiType || "openai", p.providerName || "", p.apiEndpoint || "", null),
                                    readFallbackMap(), "",
                                    function(chatRes) {
                                        if (myGen !== _ttsKeyGen || slot !== currentTtsSlot())
                                            return;
                                        var cKey = (chatRes && chatRes.key) ? chatRes.key : WalletCore.lookupFallback(readFallbackMap(), [cSlot], "");
                                        if (cKey && cKey.length > 0) {
                                            applyKey(cKey, i18n("Reused API key from Chat profile (%1).", p.name || p.providerName));
                                            Wallet.writeKey(DBus, slot, cKey, function() {});
                                        } else {
                                            checkNextProfile(idx + 1);
                                        }
                                    }
                                );
                            } else {
                                checkNextProfile(idx + 1);
                            }
                        }
                        checkNextProfile(0);
                    }
                );
            }
        );
    }

    function saveWalletKey() {
        var slot = currentTtsSlot();
        var key = apiKeyField ? apiKeyField.text.replace(/^\s+|\s+$/g, "") : "";
        walletApiKey = key;
        walletKeyDirty = false;

        Wallet.writeKey(DBus, slot, key, function(res) {
            if (res && res.available)
                walletAvailable = true;
            if (res && res.success) {
                cfg_apiKeysFallback = WalletCore.stringifyFallbackMap(
                    WalletCore.removeFallback(readFallbackMap(), slot));
                keyStatusLabel.text = i18n("API key saved to KWallet.");
            } else {
                writeFallbackKey(slot, key);
                keyStatusLabel.text = i18n("API key saved to local fallback.");
            }
            keyStatusLabel.visible = true;
            // A key can be what the endpoint needed to list its models. A
            // voice that is already set is left alone: saving a key says
            // nothing about which voice is wanted.
            if (isEndpointBackend && cacheEndpoint().length > 0)
                fetchModels(true);
        });
    }

    function syncProviderCombo() {
        var idx = 0;
        for (var i = 0; i < ttsPresets.length; i++) {
            if (ttsPresets[i].name === cfg_ttsProviderName) {
                idx = i;
                break;
            }
        }
        if (!cfg_ttsProviderName || cfg_ttsProviderName.length === 0) {
            for (var j = 0; j < ttsPresets.length; j++) {
                if (ttsPresets[j].url && ttsPresets[j].url === cfg_ttsApiEndpoint) {
                    idx = j;
                    cfg_ttsProviderName = ttsPresets[j].name;
                    break;
                }
            }
        }
        if (providerCombo && providerCombo.currentIndex !== idx)
            providerCombo.currentIndex = idx;
    }

    function syncModelCombo() {
        if (modelPicker)
            modelPicker.syncIndex();
    }

    function loadModelCache() {
        availableModels = [];
        if (voiceCacheMatchesEndpoint() && cfg_ttsAvailableModels && cfg_ttsAvailableModels.length > 0) {
            try {
                var arr = JSON.parse(cfg_ttsAvailableModels);
                if (Array.isArray(arr))
                    availableModels = arr;
            } catch (e) {}
        }
        if ((!availableModels || availableModels.length === 0) && !isCustomPreset) {
            availableModels = Tts.defaultKnownModels();
        }
        syncModelCombo();
    }

    // Endpoint as stored with the fetched model/voice/price cache.
    function cacheEndpoint() {
        return (cfg_ttsApiEndpoint || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    }

    function readVoiceCache() {
        try {
            return JSON.parse(cfg_ttsAvailableVoices || "{}") || {};
        } catch (e) {
            return {};
        }
    }

    // The model, voice and price caches all come from one fetch; they only
    // apply while the endpoint is the one they were fetched from.
    function voiceCacheMatchesEndpoint() {
        return readVoiceCache()._endpoint === cacheEndpoint();
    }

    // { modelId: {label, free} } for ModelPicker, from OpenRouter pricing.
    readonly property var modelPrices: {
        var out = {};
        var cache = cfg_ttsAvailableVoices ? readVoiceCache() : {};
        if (cache._endpoint !== cacheEndpoint() || !cache._prices)
            return out;
        for (var id in cache._prices) {
            var l = Usage.speechPriceLabel(cache._prices[id], "tts");
            if (l) out[id] = l;
        }
        return out;
    }

    // After a fetch, a model the endpoint doesn't list is replaced: prefer a
    // listed id that names the same model ("kokoro" for "hexgrad/kokoro-82m"),
    // else the first one.
    function pickListedModel(current, list) {
        var cur = (current || "").toLowerCase();
        for (var i = 0; i < list.length; i++) {
            var m = String(list[i]).toLowerCase();
            if (cur.length && (cur.indexOf(m) >= 0 || m.indexOf(cur) >= 0))
                return list[i];
        }
        return list.length > 0 ? list[0] : "";
    }

    // keepVoice: leave a voice the fetched list doesn't contain as it is
    // (after saving an API key), instead of replacing it with a listed one.
    function fetchModels(keepVoice) {
        if (fetchInProgress)
            return;
        var endpoint = (cfg_ttsApiEndpoint || "").replace(/\/+$/, "");
        if (!endpoint) {
            modelStatusLabel.text = i18n("Set an API endpoint first.");
            modelStatusLabel.visible = true;
            return;
        }
        fetchInProgress = true;
        modelStatusLabel.text = i18n("Fetching TTS models…");
        modelStatusLabel.visible = true;
        var key = walletApiKey || (apiKeyField ? apiKeyField.text : "") || "";
        var startedGen = _voiceGen;
        Tts.fetchModels(endpoint, key, cfg_ttsBackend || "openai_speech", function(err, models, voices, prices, reported) {
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
            // Custom lists only what its endpoint reports, never the built-ins.
            if (!reported && isCustomPreset)
                availableModels = [];
            cfg_ttsAvailableModels = JSON.stringify(availableModels);
            var voiceCache = voices || {};
            voiceCache._endpoint = cacheEndpoint();
            voiceCache._prices = prices || {};
            cfg_ttsAvailableVoices = JSON.stringify(voiceCache);
            if (cfg_ttsModelName && availableModels.indexOf(cfg_ttsModelName) === -1) {
                // The endpoint's own list is authoritative; the built-in
                // fallback list is not, so a typed model is kept then.
                if (reported)
                    cfg_ttsModelName = pickListedModel(cfg_ttsModelName, availableModels);
            } else if ((!cfg_ttsModelName || cfg_ttsModelName.length === 0) && availableModels.length > 0) {
                cfg_ttsModelName = availableModels[0];
            }
            syncModelCombo();
            syncVoiceCombo(!keepVoice);
            modelStatusLabel.text = availableModels.length > 0
                ? i18n("TTS models loaded: %1", availableModels.length)
                : i18n("The endpoint did not list any speech models. Type the model id.");
            modelStatusLabel.visible = true;
        });
    }

    function applyProviderPreset(index) {
        if (index < 0 || index >= ttsPresets.length) return;
        var p = ttsPresets[index];
        // Leaving a preset remembers what was entered; coming back to it gets
        // that back. A preset not visited yet, or Custom with nothing entered,
        // starts from its built-in values. Picking the preset already shown
        // changes nothing for Custom and resets the others to their built-in values.
        var plan = SpeechRules.planPresetSwitch(_presetMemo, cfg_ttsProviderName || "", p.name, {
            endpoint: cfg_ttsApiEndpoint,
            model: cfg_ttsModelName,
            voice: cfg_ttsVoice,
            responseFormat: cfg_ttsResponseFormat
        }, ttsPresets.map(function(x) { return x.name; }));
        _presetMemo = plan.memos;
        var same = plan.same;
        var memo = plan.restore;
        var restored = !!memo;
        cfg_ttsProviderName = p.name;
        if (restored) {
            cfg_ttsApiEndpoint = memo.endpoint;
            // Keep the voice after the model: setting the model runs
            // onCfg_ttsModelNameChanged, which re-syncs the voice and may
            // overwrite it, so the saved voice has to be written last.
            cfg_ttsModelName = memo.model;
            if (memo.responseFormat.length > 0)
                cfg_ttsResponseFormat = memo.responseFormat;
            cfg_ttsVoice = memo.voice;
            availableModels = [];
        } else {
            if (p.name === "Custom") {
                // Starts blank unless the Custom page is already showing.
                if (!same) {
                    cfg_ttsApiEndpoint = "";
                    cfg_ttsModelName = "";
                    cfg_ttsVoice = "";
                    availableModels = [];
                }
            } else if (p.url && p.url.length > 0)
                cfg_ttsApiEndpoint = p.url;
            if (p.model && p.model.length > 0)
                cfg_ttsModelName = p.model;
            if (p.voice && p.voice.length > 0)
                cfg_ttsVoice = p.voice;
            if (p.responseFormat && p.responseFormat.length > 0)
                cfg_ttsResponseFormat = p.responseFormat;
        }
        loadWalletKey();
        loadModelCache();
        syncModelCombo();
        // A restored Custom voice may not be in a list that isn't fetched yet.
        syncVoiceCombo(!restored);
        if (isEndpointBackend && cacheEndpoint().length > 0 && !voiceCacheMatchesEndpoint())
            fetchModels(restored);
    }

    function syncBackendCombo() {
        var b = cfg_ttsBackend || "spd_say";
        for (var i = 0; i < ttsBackends.length; i++) {
            if (ttsBackends[i].id === b) {
                if (backendCombo && backendCombo.currentIndex !== i)
                    backendCombo.currentIndex = i;
                return;
            }
        }
        if (backendCombo)
            backendCombo.currentIndex = 0;
    }

    function applyBackend(index) {
        if (index < 0 || index >= ttsBackends.length) return;
        cfg_ttsBackend = ttsBackends[index].id;
        if (cfg_ttsBackend === "openai_speech") {
            loadWalletKey();
            syncProviderCombo();
            syncVoiceCombo();
        } else if (cfg_ttsBackend === "kokoro_local") {
            runKokoroProbe();
            loadKokoroVoices();
        }
    }

    // Voices for the current model: the list the endpoint reported for this
    // model, else the server-wide list ("*"), else the built-in names.
    function voicesForModel(model) {
        var map = {};
        try {
            map = JSON.parse(cfg_ttsAvailableVoices || "{}") || {};
        } catch (e) {}
        // The cache belongs to the endpoint it was fetched from.
        if (map._endpoint !== cacheEndpoint())
            map = {};
        if (Array.isArray(map[model]) && map[model].length > 0)
            return { list: map[model].slice(), reported: true };
        if (Array.isArray(map["*"]) && map["*"].length > 0)
            return { list: map["*"].slice(), reported: true };
        if (isCustomPreset)
            return { list: [], reported: false };
        var lower = (model || "").toLowerCase();
        if (lower.indexOf("gemini") >= 0)
            return { list: Tts.knownGeminiVoices(), reported: false };
        if (lower.indexOf("kokoro") >= 0)
            return { list: ["af_heart"], reported: false };
        // OpenAI's six voices belong to OpenAI's models and the OpenAI
        // preset. A model that published none (OpenRouter lists null for the
        // fish-audio ones) is offered only "Model default", which sends no
        // voice at all; a voice id can still be typed.
        if ((cfg_ttsProviderName || "") === "OpenAI")
            return { list: Tts.knownOpenAiVoices(), reported: false };
        return { list: SpeechRules.unreportedVoices(model, Tts.knownOpenAiVoices()), reported: false };
    }

    // modelChanged: the saved voice may belong to the previous model, so
    // replace it with a valid default when the new model doesn't list it.
    // Otherwise a voice missing from the list was typed by hand; keep it.
    function syncVoiceCombo(modelChanged) {
        if (!voiceCombo) return;
        var res = voicesForModel(cfg_ttsModelName || "");
        var list = res.list;
        var cur = cfg_ttsVoice || "";
        if (cur && list.indexOf(cur) === -1) {
            if (modelChanged) {
                var hasHeart = list.indexOf("af_heart") >= 0;
                cur = hasHeart ? "af_heart" : (list[0] || "");
            } else {
                list.unshift(cur);
            }
        } else if (!cur) {
            cur = list[0] || "";
        }
        voiceOffersModelDefault = list.indexOf(SpeechRules.MODEL_DEFAULT_VOICE) >= 0;
        voiceCombo.model = list.map(function(v) { return SpeechRules.voiceToText(v, modelDefaultLabel); });
        voiceCombo.currentIndex = list.indexOf(cur);
        if (_initialized && cur !== cfg_ttsVoice)
            cfg_ttsVoice = cur;
    }

    // kokoroVoice: speak the sample with this Kokoro voice string (the mix
    // being edited) instead of the saved voice.
    function runVoiceTest(kokoroVoice) {
        testStatusLabel.visible = false;
        mixTestText = "";
        _testFromMix = typeof kokoroVoice === "string";
        testInProgress = true;
        var sample = i18n("Hello! Text to speech is working in PlasmaLLM.");
        var prepared = Tts.prepareTextForSpeech(sample, cfg_ttsStyleHint);

        var configObj = {
            ttsEnabled: true,
            ttsBackend: cfg_ttsBackend || "spd_say",
            ttsProviderName: cfg_ttsProviderName || "",
            ttsApiEndpoint: cfg_ttsApiEndpoint || "",
            ttsModelName: cfg_ttsModelName || "",
            ttsVoice: cfg_ttsVoice || "",
            ttsResponseFormat: cfg_ttsResponseFormat || "pcm",
            ttsSpeedPercent: cfg_ttsSpeedPercent || 100,
            ttsInstructions: cfg_ttsInstructions || "",
            ttsKokoroUrl: cfg_ttsKokoroUrl || "",
            ttsKokoroVoice: typeof kokoroVoice === "string" ? kokoroVoice : (cfg_ttsKokoroVoice || ""),
            ttsKokoroMixes: cfg_ttsKokoroMixes || "",
            ttsKokoroFormat: cfg_ttsKokoroFormat || "pcm",
            ttsKokoroVolumePercent: cfg_ttsKokoroVolumePercent || 100,
            ttsKokoroLangCode: cfg_ttsKokoroLangCode || "",
            ttsRate: cfg_ttsRate || 0,
            ttsPitch: cfg_ttsPitch || 0,
            ttsLanguage: cfg_ttsLanguage || "",
            ttsCliBinary: cfg_ttsCliBinary || "spd-say",
            ttsCliTemplate: cfg_ttsCliTemplate || "",
            ttsCliExtraArgs: cfg_ttsCliExtraArgs || "",
            ttsStyleHint: cfg_ttsStyleHint || ""
        };

        var key = apiKeyField ? apiKeyField.text : walletApiKey;

        Tts.speak({
            config: configObj,
            text: sample,
            apiKey: key,
            runCommand: function(cmd, cb) {
                configPage._testCallbacks[String(cmd)] = cb;
                ttsTestRunner.connectSource(String(cmd));
            },
            callback: function(err, res) {
                finishVoiceTest(err);
            }
        });
    }

    // Bumped each time a voice profile is put on the page. A model-list fetch
    // that started before the switch compares against it and drops its result,
    // so the old profile's models and model name never land on the new one.
    property int _voiceGen: 0

    // The voice profile bar replaced the settings on this page: refresh the
    // boxes the way opening the page does.
    function afterVoiceProfileApplied() {
        _voiceGen++;
        // A fetch still running was for the old profile and will be ignored;
        // clearing the flag lets the new profile's own fetch start.
        fetchInProgress = false;
        loadModelCache();
        syncBackendCombo();
        syncProviderCombo();
        syncModelCombo();
        syncVoiceCombo();
        loadWalletKey();
        syncKokoroVoiceCombo();
        if (!isKokoroBackend) {
            _kokoroAfterSetup = false;
            kokoroRecheckTimer.stop();
            kokoroMixOpen = false;
        }
        if (isKokoroBackend) {
            runKokoroProbe();
            loadKokoroVoices();
        }
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

    property bool _initialized: false
    Component.onCompleted: {
        loadModelCache();
        syncBackendCombo();
        syncProviderCombo();
        syncModelCombo();
        syncVoiceCombo();
        loadWalletKey();
        syncKokoroVoiceCombo();
        _initialized = true;
        if (isKokoroBackend) {
            runKokoroProbe();
            loadKokoroVoices();
        }
    }

    // While a voice profile is being put on the page these wait; the page
    // refreshes once afterwards (afterVoiceProfileApplied).
    onCfg_ttsBackendChanged: {
        if (!_initialized || _applyingVoiceProfile) return;
        syncBackendCombo();
        if (!isKokoroBackend) {
            _kokoroAfterSetup = false;
            kokoroRecheckTimer.stop();
            kokoroMixOpen = false;
        }
    }
    // Follows changes made outside the combo, such as the dialog's Defaults.
    // Skipped while the combo already shows the value, so typing a voice
    // isn't interrupted by its own change coming back.
    // Also skipped for a change the combo itself just wrote: backspacing the
    // field to empty writes "", which differs from the shown text only
    // because blank means af_heart, and re-syncing would snap it back.
    // The box may show a saved mix's name for the voice string it stores.
    onCfg_ttsKokoroVoiceChanged: {
        if (_initialized && !_applyingVoiceProfile && kokoroVoiceCombo && !_kokoroVoiceFromCombo
                && KokoroMix.textToVoice(kokoroVoiceCombo.editText, kokoroMixes) !== (cfg_ttsKokoroVoice || "af_heart"))
            syncKokoroVoiceCombo();
    }
    onCfg_ttsKokoroMixesChanged: if (_initialized) syncKokoroVoiceCombo()
    onCfg_ttsProviderNameChanged: if (_initialized && !_applyingVoiceProfile) syncProviderCombo()
    onCfg_ttsApiEndpointChanged: {
        if (!_initialized || _applyingVoiceProfile) return;
        var slot = currentTtsSlot();
        if (slot !== lastKeySlot)
            loadWalletKey();
    }
    onCfg_ttsModelNameChanged: {
        if (_initialized && !_applyingVoiceProfile) {
            syncModelCombo();
            syncVoiceCombo(true);
        }
    }
    onCfg_ttsAvailableModelsChanged: if (_initialized && !_applyingVoiceProfile) loadModelCache()

    Kirigami.FormLayout {
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
            Kirigami.FormData.label: i18n("Text to Speech:")
            text: i18n("Enable text-to-speech output")
            checked: cfg_ttsEnabled
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsEnabled = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.75
            text: i18n("Enables speech synthesis. Messages can be read aloud using the speaker button on chat responses.")
        }

        QQC2.CheckBox {
            id: autoReadCheck
            Kirigami.FormData.label: i18n("Auto-read:")
            text: i18n("Automatically read new assistant responses aloud")
            checked: cfg_ttsAutoRead
            enabled: cfg_ttsEnabled
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsAutoRead = checked;
            }
        }

        QQC2.CheckBox {
            id: autoReadVoiceOnlyCheck
            text: i18n("Only auto-read when prompted with voice (STT)")
            checked: cfg_ttsAutoReadOnlyVoicePrompted
            enabled: cfg_ttsEnabled && cfg_ttsAutoRead
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsAutoReadOnlyVoicePrompted = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("When 'Only when prompted with voice' is checked, typed prompts won't trigger audio playback, but voice-dictated questions will speak the answer back.")
        }

        QQC2.CheckBox {
            id: waitReadyCheck
            text: i18n("Don't output text until TTS is ready")
            checked: cfg_ttsWaitUntilReady
            enabled: cfg_ttsEnabled && cfg_ttsAutoRead
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsWaitUntilReady = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Hides response text while generating and preparing audio, displaying the response only when speech is ready to play.")
        }

        QQC2.CheckBox {
            id: streamSpeechCheck
            text: i18n("Start speaking while the reply is still being written")
            checked: cfg_ttsStreamSpeech
            enabled: cfg_ttsEnabled && cfg_ttsAutoRead
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsStreamSpeech = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Each sentence is sent for speech as soon as it is complete and played in order. With the option above, text appears when the first sentence starts playing.")
        }

        QQC2.TextField {
            id: styleHintField
            Kirigami.FormData.label: i18n("Style / tone hint:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("e.g. <sarcastic>, [whispering], <excited>")
            text: cfg_ttsStyleHint || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsStyleHint = text;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Speech hint or tone directive (supported by Gemini and modern TTS endpoints). You can use tags like <sarcastic> or placeholders like [tone: sarcastic] {text}.")
        }

        QQC2.CheckBox {
            id: allowAgentStyleControlCheck
            text: i18n("Allow agent to set their own tone/style")
            checked: cfg_ttsAllowAgentStyleControl
            enabled: cfg_ttsEnabled
            onCheckedChanged: {
                if (!_initialized) return;
                cfg_ttsAllowAgentStyleControl = checked;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Exposes a tool allowing the assistant to dynamically adjust its speech style or emotion based on conversation context or user requests.")
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: i18n("Synthesizer")
            Layout.fillWidth: true
        }

        QQC2.ComboBox {
            id: backendCombo
            Kirigami.FormData.label: i18n("TTS backend:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: ttsBackends.map(function(b) { return b.name; })
            onActivated: function(index) {
                applyBackend(index);
            }
        }

        // --- SPEECH DISPATCHER (LOCAL CLI) SECTION ---
        RowLayout {
            Kirigami.FormData.label: i18n("Speech rate:")
            visible: isSpdBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22

            QQC2.Slider {
                id: rateSlider
                Layout.fillWidth: true
                from: -100
                to: 100
                stepSize: 5
                value: cfg_ttsRate || 0
                onMoved: {
                    if (!_initialized) return;
                    cfg_ttsRate = Math.round(value);
                }
            }

            QQC2.Label {
                text: (rateSlider.value > 0 ? "+" : "") + rateSlider.value + "%"
                font: Kirigami.Theme.smallFont
            }
        }

        RowLayout {
            Kirigami.FormData.label: i18n("Speech pitch:")
            visible: isSpdBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22

            QQC2.Slider {
                id: pitchSlider
                Layout.fillWidth: true
                from: -100
                to: 100
                stepSize: 5
                value: cfg_ttsPitch || 0
                onMoved: {
                    if (!_initialized) return;
                    cfg_ttsPitch = Math.round(value);
                }
            }

            QQC2.Label {
                text: (pitchSlider.value > 0 ? "+" : "") + pitchSlider.value + "%"
                font: Kirigami.Theme.smallFont
            }
        }

        QQC2.TextField {
            id: spdVoiceField
            Kirigami.FormData.label: i18n("Voice name:")
            visible: isSpdBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("Default or specific voice (spd-say -L)")
            // "Model default" belongs to the speech endpoint, not to spd-say.
            text: SpeechRules.isModelDefaultVoice(cfg_ttsVoice) ? "" : (cfg_ttsVoice || "")
            onTextChanged: {
                if (!_initialized) return;
                // The box shows the marker as empty; that is not an edit.
                if (text === "" && SpeechRules.isModelDefaultVoice(cfg_ttsVoice)) return;
                cfg_ttsVoice = text;
            }
        }

        QQC2.TextField {
            id: spdLangField
            Kirigami.FormData.label: i18n("Language hint:")
            visible: isSpdBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("Optional ISO code, e.g. en, de, fr")
            text: cfg_ttsLanguage || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsLanguage = text;
            }
        }

        // --- ENDPOINT (OPENROUTER / OPENAI) SECTION ---
        QQC2.ComboBox {
            id: providerCombo
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("Provider preset:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: ttsPresets.map(function(p) { return p.name; })
            onActivated: function(index) {
                applyProviderPreset(index);
            }
        }

        QQC2.TextField {
            id: endpointField
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("API Endpoint:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            text: cfg_ttsApiEndpoint || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsApiEndpoint = text;
            }
            // A new endpoint means a new model list; fetch it once editing ends.
            onEditingFinished: {
                if (!_initialized) return;
                loadModelCache();
                if (cacheEndpoint().length > 0 && !voiceCacheMatchesEndpoint())
                    fetchModels();
            }
        }

        RowLayout {
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("API key:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.TextField {
                id: apiKeyField
                Layout.fillWidth: true
                Layout.preferredWidth: 0
                Layout.minimumWidth: Kirigami.Units.gridUnit * 8
                echoMode: showKeyCheck.checked ? TextInput.Normal : TextInput.Password
                placeholderText: i18n("Provider API key")
                onTextChanged: {
                    if (!_initialized || !walletKeyLoaded) return;
                    walletKeyDirty = true;
                }
                onAccepted: saveWalletKey()
            }

            QQC2.ToolButton {
                id: showKeyCheck
                checkable: true
                icon.name: checked ? "password-show-on" : "password-show-off"
                QQC2.ToolTip.text: i18n("Show/hide key")
                QQC2.ToolTip.visible: hovered
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
            id: keyStatusLabel
            visible: false
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            textFormat: Text.PlainText
        }

        ModelPicker {
            id: modelPicker
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("Model:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            modelName: cfg_ttsModelName
            modelPrices: configPage.modelPrices
            availableModels: configPage.availableModels
            fetchInProgress: configPage.fetchInProgress
            fetchVisible: isEndpointBackend
            fetchEnabled: isEndpointBackend && !configPage.fetchInProgress && (cfg_ttsApiEndpoint || "").length > 0
            fetchTooltip: i18n("Fetch TTS models")
            placeholderText: isCustomPreset && !(cfg_ttsApiEndpoint || "").length
                ? i18n("Set the API endpoint to load models.")
                : i18n("Select or enter a model")
            onModelSelected: function(selected) {
                cfg_ttsModelName = selected;
                // Picking writes modelName directly, which drops the binding;
                // restore it so the combo always shows the model Test uses.
                modelPicker.modelName = Qt.binding(function() { return cfg_ttsModelName; });
                syncVoiceCombo(true);
                rootItem.triggerCapture();
            }
            onFetchRequested: fetchModels()
        }

        QQC2.Label {
            id: modelStatusLabel
            visible: false
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            textFormat: Text.PlainText
        }

        QQC2.ComboBox {
            id: voiceCombo
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("Voice:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            editable: true
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_ttsVoice = SpeechRules.textToVoice(currentText, modelDefaultLabel);
            }
            onEditTextChanged: {
                if (!_initialized) return;
                cfg_ttsVoice = SpeechRules.textToVoice(editText, modelDefaultLabel);
            }
        }

        QQC2.Label {
            visible: isEndpointBackend && voiceOffersModelDefault
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("\"Model default\" sends no voice, so the model uses its own. To use another voice, type its id.")
        }

        QQC2.ComboBox {
            id: formatCombo
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("Audio format:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: ["pcm", "mp3"]
            // Models not known to send 24 kHz PCM are always asked for mp3,
            // whatever is saved here, unless the preset is Custom (see speechRules.js).
            enabled: formatChoosable
            currentIndex: SpeechRules.resolveFormat(cfg_ttsModelName, cfg_ttsResponseFormat || "pcm", "pcm", cfg_ttsProviderName) === "mp3" ? 1 : 0
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_ttsResponseFormat = index === 1 ? "mp3" : "pcm";
            }
        }

        QQC2.Label {
            visible: isEndpointBackend && !modelSendsPcm && (cfg_ttsModelName || "").length > 0
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: isCustomPreset
                ? i18n("PCM is played as 24 kHz audio. If this model sends another rate it sounds slow and deep; choose mp3 then.")
                : i18n("PlasmaLLM can't tell what sample rate this model's raw audio uses, so it asks for MP3, which carries its own. The Custom preset lets you choose PCM.")
        }

        QQC2.Label {
            visible: isEndpointBackend && (cfg_ttsModelName || "").indexOf("gemini") >= 0
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Note: Gemini TTS requires 'pcm'. PlasmaLLM automatically converts the raw 24kHz stream into playable WAV audio.")
        }

        // Speed: the endpoint and Kokoro backends both send it as "speed".
        RowLayout {
            Kirigami.FormData.label: i18n("Speed:")
            visible: isEndpointBackend || isKokoroBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22

            QQC2.Slider {
                id: speedSlider
                Layout.fillWidth: true
                from: 25
                to: 400
                stepSize: 5
                value: cfg_ttsSpeedPercent || 100
                onMoved: {
                    if (!_initialized) return;
                    cfg_ttsSpeedPercent = Math.round(value);
                }
            }

            QQC2.Label {
                text: i18n("%1×", (speedSlider.value / 100).toFixed(2))
                font: Kirigami.Theme.smallFont
            }

            QQC2.ToolButton {
                icon.name: "edit-undo"
                enabled: (cfg_ttsSpeedPercent || 100) !== 100
                onClicked: cfg_ttsSpeedPercent = 100
                QQC2.ToolTip.text: i18n("Normal speed")
                QQC2.ToolTip.visible: hovered
            }
        }

        QQC2.Label {
            visible: isEndpointBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Some models ignore speed, and some only accept 1×.")
        }

        QQC2.TextField {
            id: instructionsField
            visible: isEndpointBackend
            Kirigami.FormData.label: i18n("Instructions:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("e.g. Speak calmly, with a warm tone")
            text: cfg_ttsInstructions || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsInstructions = text;
            }
        }

        QQC2.Label {
            visible: isEndpointBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("How the voice should sound. Used by gpt-4o-mini-tts, Gemini TTS and Fish Audio; tts-1 ignores it.")
        }

        // --- KOKORO (LOCAL) SECTION ---
        // What is installed or running, and offers to use, start or install
        // Kokoro (kokoroSetup.js decides; this only shows it). Every offer
        // can be declined and stays declined.
        ColumnLayout {
            id: kokoroSetupBlock
            visible: isKokoroBackend
            Kirigami.FormData.label: i18n("Setup:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                text: kokoroRec ? kokoroRec.message
                    : (kokoroProbeInProgress ? i18n("Checking for Kokoro…") : "")
                // While Kokoro is starting, the block under the Voice box says so.
                visible: text.length > 0 && !kokoroStarting
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.neutralTextColor
                text: kokoroRec ? kokoroRec.warnings.join("\n") : ""
                visible: text.length > 0
            }

            Repeater {
                model: kokoroOpenOffers

                delegate: ColumnLayout {
                    id: kokoroOfferDelegate
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    QQC2.Label {
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        textFormat: Text.PlainText
                        font: Kirigami.Theme.smallFont
                        opacity: 0.85
                        text: kokoroOfferDelegate.modelData.reason
                    }

                    QQC2.Label {
                        Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                        textFormat: Text.PlainText
                        font: Kirigami.Theme.smallFont
                        opacity: 0.85
                        visible: kokoroOfferDelegate.modelData.missing.length > 0
                        text: kokoroOfferDelegate.modelData.packageCommand.length > 0
                            ? i18n("Needs packages; the terminal shows this command and asks before running it: %1", kokoroOfferDelegate.modelData.packageCommand)
                            : i18n("Needs %1. Install it with your package manager first.", kokoroOfferDelegate.modelData.missing.join(", "))
                    }

                    RowLayout {
                        spacing: Kirigami.Units.smallSpacing

                        QQC2.Button {
                            text: kokoroOfferDelegate.modelData.label
                            icon.name: kokoroOfferDelegate.modelData.kind === "use" ? "dialog-ok-apply"
                                : (kokoroOfferDelegate.modelData.kind === "start" ? "media-playback-start" : "download")
                            // The block under the Voice box already has this Start button.
                            visible: !KokoroSetup.startShownByVoiceBox(kokoroOfferDelegate.modelData, kokoroVoiceBoxOffers, kokoroNotRunningOffers)
                            enabled: !kokoroRunning && !kokoroProbeInProgress
                            onClicked: runKokoroOffer(kokoroOfferDelegate.modelData)
                        }

                        QQC2.Button {
                            text: i18n("Keep current setup")
                            icon.name: "dialog-cancel"
                            onClicked: declineKokoroOffer(kokoroOfferDelegate.modelData.id)
                        }
                    }
                }
            }

            RowLayout {
                visible: kokoroDeclinedIds.length > 0
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
                    onClicked: showKokoroOptions()
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    text: i18n("Check again")
                    icon.name: "view-refresh"
                    enabled: !kokoroProbeInProgress
                    onClicked: {
                        kokoroRunStatus = "";
                        runKokoroProbe();
                        loadKokoroVoices();
                    }
                }

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    textFormat: Text.PlainText
                    font: Kirigami.Theme.smallFont
                    // Not while it re-checks a server that is starting: that would flicker.
                    text: (kokoroProbeInProgress && !kokoroStarting) ? i18n("Checking…") : kokoroRunStatus
                    visible: text.length > 0
                }
            }
        }

        QQC2.TextField {
            id: kokoroUrlField
            visible: isKokoroBackend
            Kirigami.FormData.label: i18n("Server URL:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: KokoroSetup.PLACEHOLDER_URL
            text: cfg_ttsKokoroUrl || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsKokoroUrl = text;
                if (text.length > 0)
                    _kokoroAfterSetup = false;
            }
            // Losing focus with the URL unchanged since the last probe
            // started must not run another one.
            onEditingFinished: {
                if (!_initialized) return;
                if (KokoroSetup.urlNeedsProbe(text, _kokoroProbeUrl))
                    kokoroUrlDebounce.restart();
            }
        }

        QQC2.Label {
            visible: isKokoroBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("If you already run Kokoro, put its address here.")
        }

        RowLayout {
            visible: isKokoroBackend
            Kirigami.FormData.label: i18n("Voice:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.ComboBox {
                id: kokoroVoiceCombo
                Layout.fillWidth: true
                Layout.preferredWidth: 0
                textRole: "text"
                editable: true
                // "Saved mixes" is a heading and can't be chosen; the other
                // entries are drawn as the stock combo box draws them.
                delegate: QQC2.ItemDelegate {
                    required property var modelData
                    required property int index
                    width: kokoroVoiceCombo.width
                    text: modelData.text
                    enabled: modelData.kind !== "heading"
                    font.bold: modelData.kind === "heading"
                    highlighted: kokoroVoiceCombo.highlightedIndex === index
                }
                // The Up and Down keys, Enter on the highlighted heading and inline
                // completion can all land on the heading without the delegate being
                // clicked. Nothing that shows the heading's text may reach
                // cfg_ttsKokoroVoice (three guards below, kokoroMix.js decides).
                onActivated: function(index) {
                    if (!_initialized || _syncingKokoroVoice) return;
                    var entry = kokoroVoiceEntries[index];
                    if (!entry) return;
                    if (entry.kind === "heading") {
                        // Not a voice: show the stored one again.
                        syncKokoroVoiceCombo();
                        return;
                    }
                    // A saved mix stores its voice string; the box shows its name.
                    _kokoroVoiceFromCombo = true;
                    cfg_ttsKokoroVoice = entry.voice;
                    _kokoroVoiceFromCombo = false;
                }
                // Up or Down onto the heading: step past it to the next entry.
                onCurrentIndexChanged: {
                    if (!_initialized || _syncingKokoroVoice || !KokoroMix.isHeadingIndex(kokoroVoiceEntries, currentIndex)) return;
                    var target = KokoroMix.stepOverHeading(kokoroVoiceEntries, currentIndex);
                    if (target < 0) return;
                    _syncingKokoroVoice = true;
                    currentIndex = target;
                    _syncingKokoroVoice = false;
                    _kokoroVoiceFromCombo = true;
                    cfg_ttsKokoroVoice = kokoroVoiceEntries[target].voice;
                    _kokoroVoiceFromCombo = false;
                }
                onEditTextChanged: {
                    if (!_initialized || _syncingKokoroVoice) return;
                    if (KokoroMix.isHeadingText(kokoroVoiceEntries, editText)) return;
                    _kokoroVoiceFromCombo = true;
                    cfg_ttsKokoroVoice = KokoroMix.textToVoice(editText, kokoroMixes);
                    _kokoroVoiceFromCombo = false;
                }
            }

            QQC2.Button {
                id: kokoroMixButton
                text: i18n("Mix voices…")
                icon.name: "view-media-equalizer"
                onClicked: openKokoroMix()
            }
        }

        // Mix voices: rows of voice + weight, the string that will be sent,
        // a name, and Test / Save / Delete. Saved mixes join the Voice list.
        ColumnLayout {
            id: kokoroMixBlock
            visible: isKokoroBackend && kokoroMixOpen
            Kirigami.FormData.label: i18n("Mix:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            Repeater {
                // Only the number of rows is the model, so editing a row's
                // voice or weight doesn't rebuild the rows.
                model: mixRows.length

                delegate: RowLayout {
                    id: mixRowDelegate
                    required property int index
                    readonly property var rowVoice: mixRows[index] ? mixRows[index].voice : ""
                    readonly property var rowList: KokoroMix.rowVoices(kokoroVoices, rowVoice)
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    QQC2.ComboBox {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 0
                        model: mixRowDelegate.rowList
                        currentIndex: mixRowDelegate.rowList.indexOf(mixRowDelegate.rowVoice)
                        onActivated: function(i) {
                            mixRows = KokoroMix.setRow(mixRows, mixRowDelegate.index, { voice: mixRowDelegate.rowList[i] });
                        }
                    }

                    QQC2.Label {
                        text: i18n("Weight:")
                        font: Kirigami.Theme.smallFont
                    }

                    QQC2.SpinBox {
                        from: KokoroMix.MIN_WEIGHT
                        to: KokoroMix.MAX_WEIGHT
                        stepSize: 1
                        editable: true
                        value: mixRows[mixRowDelegate.index] ? mixRows[mixRowDelegate.index].weight : KokoroMix.MIN_WEIGHT
                        onValueModified: {
                            mixRows = KokoroMix.setRow(mixRows, mixRowDelegate.index, { weight: value });
                        }
                    }

                    QQC2.Button {
                        icon.name: "list-remove"
                        enabled: mixRows.length > 1
                        QQC2.ToolTip.text: i18n("Remove this voice")
                        QQC2.ToolTip.visible: hovered
                        QQC2.ToolTip.delay: Kirigami.Units.toolTipDelay
                        onClicked: mixRows = KokoroMix.removeRow(mixRows, mixRowDelegate.index)
                    }
                }
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                font: Kirigami.Theme.smallFont
                opacity: 0.7
                visible: kokoroVoices.length === 0
                text: i18n("The voice list comes from the server. Start Kokoro to choose other voices.")
            }

            QQC2.Button {
                text: i18n("+ Add voice")
                onClicked: mixRows = KokoroMix.addRow(mixRows, nextMixVoice())
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Label {
                    text: i18n("Result:")
                }

                QQC2.Label {
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    font.family: "monospace"
                    text: mixResult.length > 0 ? mixResult : "—"
                }
            }

            QQC2.TextField {
                Layout.fillWidth: true
                placeholderText: i18n("Name for this mix")
                text: mixName
                maximumLength: KokoroMix.MAX_NAME
                onTextEdited: mixName = text
            }

            Flow {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    text: i18n("Test")
                    icon.name: "audio-volume-high"
                    enabled: !testInProgress && mixResult.length > 0
                    onClicked: testKokoroMix()
                }

                QQC2.Button {
                    text: i18n("Save mix")
                    icon.name: "document-save"
                    onClicked: saveKokoroMix()
                }

                QQC2.Button {
                    text: i18n("Delete mix")
                    icon.name: "edit-delete"
                    enabled: KokoroMix.findMix(kokoroMixes, mixName) !== null
                    onClicked: deleteKokoroMix()
                }

                QQC2.Button {
                    text: i18n("Close")
                    flat: true
                    onClicked: kokoroMixOpen = false
                }
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                visible: text.length > 0
                text: testInProgress && _testFromMix ? i18n("Testing…") : (mixStatus.length > 0 ? mixStatus : mixTestText)
            }
        }

        // Nothing answers at the Server URL: say so here, next to the voice
        // list, which would otherwise just show af_heart. Start / Use it /
        // Install are the Setup block's own offers and run the same way.
        ColumnLayout {
            id: kokoroNotRunningBlock
            visible: isKokoroBackend && (kokoroNotAnswering || kokoroRunning || kokoroStarting)
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.neutralTextColor
                visible: kokoroNotAnswering
                text: i18n("Kokoro isn't running at %1.", kokoroUrl)
            }

            // The connection was accepted but nothing has answered yet, which
            // is a server still loading. The page checks again every few seconds.
            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                visible: kokoroStarting
                text: kokoroRec ? kokoroRec.message : ""
            }

            Flow {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing
                visible: kokoroVoiceBoxOffers

                Repeater {
                    model: kokoroNotRunningOffers

                    delegate: QQC2.Button {
                        required property var modelData
                        text: modelData.label
                        icon.name: modelData.kind === "use" ? "dialog-ok-apply"
                            : (modelData.kind === "start" ? "media-playback-start" : "download")
                        enabled: !kokoroRunning && !kokoroProbeInProgress
                        onClicked: runKokoroOffer(modelData)
                    }
                }
            }

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                text: kokoroRunStatus
                visible: text.length > 0
            }
        }

        QQC2.Label {
            id: kokoroVoiceStatus
            visible: isKokoroBackend && text.length > 0 && !kokoroNotAnswering && !kokoroStarting
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            font: Kirigami.Theme.smallFont
        }

        QQC2.Label {
            visible: isKokoroBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Voices can be mixed, like af_heart+af_bella. Put a whole-number weight in brackets to favour one: af_heart(2)+af_bella(1). Mix voices… builds one for you.")
        }

        QQC2.ComboBox {
            id: kokoroFormatCombo
            visible: isKokoroBackend
            Kirigami.FormData.label: i18n("Audio format:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            model: ["pcm", "mp3"]
            currentIndex: (cfg_ttsKokoroFormat || "pcm") === "mp3" ? 1 : 0
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_ttsKokoroFormat = index === 1 ? "mp3" : "pcm";
            }
        }

        RowLayout {
            Kirigami.FormData.label: i18n("Volume:")
            visible: isKokoroBackend
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22

            QQC2.Slider {
                id: kokoroVolumeSlider
                Layout.fillWidth: true
                from: 10
                to: 300
                stepSize: 5
                value: cfg_ttsKokoroVolumePercent || 100
                onMoved: {
                    if (!_initialized) return;
                    cfg_ttsKokoroVolumePercent = Math.round(value);
                }
            }

            QQC2.Label {
                text: i18n("%1%", Math.round(kokoroVolumeSlider.value))
                font: Kirigami.Theme.smallFont
            }
        }

        QQC2.ComboBox {
            id: kokoroLangCombo
            visible: isKokoroBackend
            Kirigami.FormData.label: i18n("Language:")
            Layout.fillWidth: true
            Layout.preferredWidth: 0
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            textRole: "text"
            model: kokoroLanguages
            currentIndex: kokoroLangIndex(cfg_ttsKokoroLangCode)
            onActivated: function(index) {
                if (!_initialized) return;
                cfg_ttsKokoroLangCode = kokoroLanguages[index].value;
            }
        }

        // --- CUSTOM CLI SECTION ---
        QQC2.TextField {
            id: customBinaryField
            visible: isCustomBackend
            Kirigami.FormData.label: i18n("Command / binary:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("e.g. espeak-ng, piper")
            text: cfg_ttsCliBinary || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsCliBinary = text;
            }
        }

        QQC2.TextField {
            id: customTemplateField
            visible: isCustomBackend
            Kirigami.FormData.label: i18n("Command template:")
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 22
            placeholderText: i18n("e.g. echo {text} | piper --model en.onnx --output_raw | pw-play -")
            text: cfg_ttsCliTemplate || ""
            onTextChanged: {
                if (!_initialized) return;
                cfg_ttsCliTemplate = text;
            }
        }

        QQC2.Label {
            visible: isCustomBackend
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            wrapMode: Text.WordWrap
            font: Kirigami.Theme.smallFont
            opacity: 0.7
            text: i18n("Placeholders: {text} (quoted text), {voice} (voice identifier), {rate} (speech rate). If omitted, text is appended.")
        }

        // --- TEST BUTTON & STATUS ---
        RowLayout {
            Kirigami.FormData.label: i18n("Test:")
            Layout.fillWidth: true
            Layout.maximumWidth: textMaxWidth
            spacing: Kirigami.Units.smallSpacing

            QQC2.Button {
                text: i18n("Test Voice")
                icon.name: "audio-volume-high"
                enabled: !testInProgress
                onClicked: runVoiceTest()
            }

            QQC2.BusyIndicator {
                running: testInProgress
                visible: testInProgress
                Layout.preferredWidth: Kirigami.Units.gridUnit
                Layout.preferredHeight: Kirigami.Units.gridUnit
            }

            QQC2.Label {
                id: testStatusLabel
                visible: false
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
            }
        }
    }
}
