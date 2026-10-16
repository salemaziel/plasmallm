#!/usr/bin/env node
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock QML .import environment
function loadModule(relPath, extraScope = {}) {
    const filePath = path.join(__dirname, relPath);
    let code = fs.readFileSync(filePath, "utf8");
    // Strip QML directives
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sandbox = { console, ...extraScope };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

// Load adapters
const SpdSay = loadModule("../package/contents/ui/ttsAdapters/spd_say.js");
const Utils = loadModule("../package/contents/ui/utils.js");
const SpeechRules = loadModule("../package/contents/ui/ttsAdapters/speechRules.js");
const OpenaiSpeech = loadModule("../package/contents/ui/ttsAdapters/openai_speech.js", { Utils, SpeechRules });
const CustomCli = loadModule("../package/contents/ui/ttsAdapters/custom_cli.js");
const KokoroLocal = loadModule("../package/contents/ui/ttsAdapters/kokoro_local.js", { OpenaiSpeech });

const TtsAdapters = {
    backends: {
        "spd_say": SpdSay,
        "openai_speech": OpenaiSpeech,
        "kokoro_local": KokoroLocal,
        "custom_cli": CustomCli
    },
    get: function(id) {
        return this.backends[id || "spd_say"] || this.backends["spd_say"];
    },
    list: function() {
        return [
            { id: SpdSay.id, name: SpdSay.displayName },
            { id: OpenaiSpeech.id, name: OpenaiSpeech.displayName },
            { id: KokoroLocal.id, name: KokoroLocal.displayName },
            { id: CustomCli.id, name: CustomCli.displayName }
        ];
    }
};

const Tts = loadModule("../package/contents/ui/tts.js", { TtsAdapters, SpeechRules });

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

// 1. Text Cleaner Tests
const thoughtInput = "<thought>Thinking about answer...</thought>Hello user!";
eq(Tts.cleanTextForSpeech(thoughtInput), "Hello user!", "strip thought tags");

const thinkInput = "<think>Inner reasoning</think>Response text";
eq(Tts.cleanTextForSpeech(thinkInput), "Response text", "strip think tags");

const linkInput = "Check [KDE Website](https://kde.org) for details.";
eq(Tts.cleanTextForSpeech(linkInput), "Check KDE Website for details.", "strip markdown link url");

const shortCodeInput = "Run this command:\n```bash\ngit status\n```";
eq(Tts.cleanTextForSpeech(shortCodeInput), "Run this command: git status", "keep short code snippet");

const longCodeInput = "Here is the implementation:\n```python\n" +
    "def hello():\n" +
    "    print('line 1')\n" +
    "    print('line 2')\n" +
    "    print('line 3')\n" +
    "    print('line 4')\n" +
    "```\nEnjoy!";
eq(Tts.cleanTextForSpeech(longCodeInput), "Here is the implementation: [code block] Enjoy!", "replace long code with [code block]");

const markdownInput = "# Title\n\nThis is **bold** and *italic* and `inline_code`.\n> quote";
eq(Tts.cleanTextForSpeech(markdownInput), "Title. This is bold and italic and inline_code. quote", "clean markdown formatting");

const htmlInput = "<div>Some text &amp; more &lt;code&gt;</div>";
eq(Tts.cleanTextForSpeech(htmlInput), "Some text & more <code>", "strip html tags and decode entities");

// 2. Style / Tone Hint Tests
eq(Tts.applyStyleHint("Hello world", ""), "Hello world", "empty style hint");
eq(Tts.applyStyleHint("Hello world", "<sarcastic>"), "<sarcastic>Hello world</sarcastic>", "tag wrap style hint");
eq(Tts.applyStyleHint("Hello world", "sarcastic"), "<sarcastic>Hello world</sarcastic>", "single word identifier style hint wrapped in tags");
eq(Tts.applyStyleHint("Hello world", "<whisper>"), "<whisper>Hello world</whisper>", "whisper tag wrap");
eq(Tts.applyStyleHint("Hello world", "[in a sarcastic tone: {text}]"), "[in a sarcastic tone: Hello world]", "placeholder replacement");
eq(Tts.applyStyleHint("Hello world", "[whispering]"), "[whispering] Hello world", "prefix style hint");
eq(Tts.applyStyleHint("Hello world", "<speak><prosody rate=\"fast\">{text}</prosody></speak>"),
    "<speak><prosody rate=\"fast\">Hello world</prosody></speak>", "ssml placeholder template");
eq(Tts.applyStyleHint("Hello world", "fake russian voice"), "Hello world", "natural language style hint not prepended to audio");

// Ensure cleaner does not corrupt user style hints when prepared together
const rawResp = "<thought>Pondering</thought># Header\nGreat job on that [bug](http://bug).";
const prepared = Tts.prepareTextForSpeech(rawResp, "<sarcastic>");
eq(prepared, "<sarcastic>Header. Great job on that bug.</sarcastic>", "full pipeline cleans markdown and preserves style tag");

// 3. Known Voices & Presets
const geminiVoices = Tts.knownGeminiVoices();
ok(geminiVoices.length === 30, "30 Gemini voices supported");
ok(geminiVoices.indexOf("Zephyr") >= 0, "Zephyr voice exists");
ok(geminiVoices.indexOf("Puck") >= 0, "Puck voice exists");

const openAiVoices = Tts.knownOpenAiVoices();
ok(openAiVoices.length === 6, "6 OpenAI voices supported");
ok(openAiVoices.indexOf("alloy") >= 0, "alloy voice exists");

const presets = Tts.providerPresets();
const openRouter = presets.find(p => p.name === "OpenRouter");
ok(openRouter, "OpenRouter preset exists");
eq(openRouter.model, "google/gemini-3.8-flash-lite-tts", "OpenRouter default model is Gemini TTS");
eq(openRouter.responseFormat, "pcm", "OpenRouter default response format is pcm");
eq(openRouter.voice, "Zephyr", "OpenRouter default voice is Zephyr");

// 4. Adapters buildCommand
// spd-say
const spdCmd = SpdSay.buildCommand({
    text: "Hello from PlasmaLLM",
    rate: 20,
    pitch: -10,
    voice: "female1",
    language: "en"
});
ok(spdCmd.includes("spd-say"), "spd-say binary in command");
ok(spdCmd.includes("-r 20"), "rate flag included");
ok(spdCmd.includes("-p -10"), "pitch flag included");
ok(spdCmd.includes("-y female1"), "voice flag included");
ok(spdCmd.includes("-l en"), "language flag included");
ok(spdCmd.includes("-e"), "pipe mode flag included");
ok(spdCmd.includes("echo TTS_READY"), "spd-say emits ready signal");

// spd-say stop
const spdStop = SpdSay.buildStopCommand();
ok(spdStop.includes("spd-say -S"), "spd-say stop command");

// openai_speech
const endpointCmd = OpenaiSpeech.buildCommand({
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "test-key-123",
    model: "google/gemini-3.8-flash-lite-tts",
    voice: "Zephyr",
    responseFormat: "pcm",
    text: "Testing endpoint speech"
});
ok(endpointCmd.includes("https://openrouter.ai/api/v1/audio/speech"), "endpoint audio speech url");
ok(endpointCmd.includes("Authorization: Bearer test-key-123"), "auth header included");
ok(endpointCmd.includes("google/gemini-3.8-flash-lite-tts"), "model in payload");
ok(endpointCmd.includes("python3 -c"), "pcm to wav converter present");
ok(endpointCmd.includes("pw-play"), "pw-play audio player included");
ok(endpointCmd.includes("echo TTS_READY"), "endpoint emits ready signal");

// custom_cli
const customCmd = CustomCli.buildCommand({
    cliTemplate: "piper --model en.onnx --output_raw | pw-play --rate 22050 -",
    text: "Testing piper speech"
});
ok(customCmd.includes("piper --model en.onnx"), "custom template respected");
ok(customCmd.includes("Testing piper speech"), "text appended");
ok(customCmd.includes("echo TTS_READY"), "custom cli emits ready signal");

const customTokenCmd = CustomCli.buildCommand({
    cliTemplate: "espeak-ng -v {voice} -s {rate} {text}",
    voice: "en-us",
    rate: 150,
    text: "Hello"
});
ok(customTokenCmd.includes("espeak-ng -v 'en-us' -s 150 'Hello'"), "tokens replaced properly");
ok(customTokenCmd.includes("echo TTS_READY"), "custom token cli emits ready signal");

// Tts.speak with onReady
let readyTriggered = false;
let callbackTriggered = false;
Tts.speak({
    config: {
        ttsEnabled: true,
        ttsBackend: "spd_say"
    },
    text: "Testing onReady signal",
    onReady: function() {
        readyTriggered = true;
    },
    runCommand: function(cmd, cb, notifyReady) {
        ok(typeof notifyReady === "function", "runCommand receives notifyReady");
        notifyReady();
        cb(null, { stdout: "TTS_READY\n", stderr: "", exitCode: 0 });
    },
    callback: function(err, res) {
        callbackTriggered = true;
        ok(!err, "speak succeeded");
    }
});
ok(readyTriggered, "onReady callback fired when TTS became ready");
ok(callbackTriggered, "completion callback fired");

// Tts.speak onReady fallback on error
let readyOnErrTriggered = false;
Tts.speak({
    config: { ttsEnabled: false },
    text: "Will fail",
    onReady: function() {
        readyOnErrTriggered = true;
    },
    callback: function(err) {
        ok(err, "error returned when TTS not configured");
    }
});
ok(readyOnErrTriggered, "onReady fired even when speak errored out");

// Tts.speak two-phase execution test (synthesize -> onReady -> playback)
let twoPhaseCommands = [];
let twoPhaseReadyFired = false;
let twoPhaseCompleteFired = false;
Tts.speak({
    config: {
        ttsEnabled: true,
        ttsBackend: "openai_speech",
        ttsApiEndpoint: "https://openrouter.ai/api/v1",
        ttsModelName: "google/gemini-3.8-flash-lite-tts",
        ttsVoice: "Zephyr",
        ttsResponseFormat: "pcm"
    },
    text: "Testing two-phase execution timing",
    apiKey: "test-key",
    onReady: function() {
        twoPhaseReadyFired = true;
    },
    runCommand: function(cmd, cb) {
        twoPhaseCommands.push(String(cmd));
        if (twoPhaseCommands.length === 1) {
            // First command: synthesis (curl)
            ok(cmd.includes("curl"), "first command is synthesis/curl");
            ok(!twoPhaseReadyFired, "onReady has NOT fired while synthesis is still downloading");
            // Simulate synthesis completing
            cb(null, { exitCode: 0, stdout: "TTS_READY\n", stderr: "" });
            ok(twoPhaseReadyFired, "onReady FIRED IMMEDIATELY upon synthesis completion before playback");
        } else if (twoPhaseCommands.length === 2) {
            // Second command: playback (pw-play)
            ok(cmd.includes("pw-play"), "second command is playback (pw-play)");
            ok(twoPhaseReadyFired, "onReady was already fired when playback started");
            // Simulate playback finishing
            cb(null, { exitCode: 0, stdout: "", stderr: "" });
        }
    },
    callback: function(err) {
        ok(!err, "two-phase speak completed without error");
        twoPhaseCompleteFired = true;
    }
});
ok(twoPhaseCommands.length === 2, "two distinct commands were executed in sequence");
ok(twoPhaseReadyFired, "onReady fired as soon as audio returned from endpoint");
ok(twoPhaseCompleteFired, "two-phase execution completed");

// 5. fetchModels Tests
// Mock XMLHttpRequest for OpenaiSpeech.fetchModels
function createMockXhr(status, responseData) {
    return function() {
        this.open = function(method, url) { this.url = url; };
        this.setRequestHeader = function(k, v) { this.headers = this.headers || {}; this.headers[k] = v; };
        this.send = function() {
            this.readyState = 4;
            this.status = status;
            this.responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
            if (typeof this.onreadystatechange === "function") {
                this.onreadystatechange();
            }
        };
    };
}

// Successful response with custom TTS models
const MockXhrSuccess = createMockXhr(200, {
    data: [
        { id: "google/gemini-3.8-flash-lite-tts" },
        { id: "openai/tts-1" },
        { id: "my-custom-speech-model" },
        { id: "text-only-model" }
    ]
});

const OpenaiSpeechWithXhr = loadModule("../package/contents/ui/ttsAdapters/openai_speech.js", {
    XMLHttpRequest: MockXhrSuccess, Utils
});
OpenaiSpeechWithXhr.fetchModels("https://openrouter.ai/api/v1", "key", function(err, models) {
    ok(!err, "fetchModels succeeded");
    ok(Array.isArray(models), "models is array");
    ok(models.indexOf("google/gemini-3.8-flash-lite-tts") >= 0, "gemini tts in models");
    ok(models.indexOf("my-custom-speech-model") >= 0, "custom speech model discovered");
    ok(models.indexOf("text-only-model") === -1, "text-only model excluded");
});

// Fallback on HTTP error
const MockXhrFail = createMockXhr(500, "Internal Server Error");
const OpenaiSpeechFail = loadModule("../package/contents/ui/ttsAdapters/openai_speech.js", {
    XMLHttpRequest: MockXhrFail, Utils
});
OpenaiSpeechFail.fetchModels("https://api.openai.com/v1", "", function(err, models) {
    ok(!err, "fetchModels fallback returns default models on error");
    ok(models.indexOf("google/gemini-3.8-flash-lite-tts") >= 0, "default gemini present");
    ok(models.indexOf("openai/tts-1") >= 0, "default tts-1 present");
});

// Tts coordinator fetchModels dispatch
const TtsWithXhr = loadModule("../package/contents/ui/tts.js", {
    TtsAdapters: {
        get: () => OpenaiSpeechWithXhr
    }
});
TtsWithXhr.fetchModels("https://openrouter.ai/api/v1", "key", "openai_speech", function(err, models) {
    ok(!err, "Tts.fetchModels dispatched successfully");
    ok(models.indexOf("my-custom-speech-model") >= 0, "custom speech model returned through Tts");
});

// 6. System Prompt & buildTtsSection Tests
const mockToolManager = { buildSystemPromptSection: () => "" };
const mockDriverManager = { getDrivingInstructions: () => "", getDefaultDrivingInstructions: () => "" };
const mockWalletCore = loadModule("../package/contents/ui/walletCore.js");
const mockSkills = { buildSystemPromptSection: () => "" };
const mockMemory = { renderSection: () => "" };
// The fork's api.js also imports memoryStore.js (remember/recall/forget memory).
const MemoryStore = loadModule("../package/contents/ui/memoryStore.js");
const mockAdapters = {};

const Api = loadModule("../package/contents/ui/api.js", {
    ToolManager: mockToolManager,
    DriverManager: mockDriverManager,
    WalletCore: mockWalletCore,
    Skills: mockSkills,
    Memory: mockMemory,
    MemoryStore,
    Adapters: mockAdapters
});

// buildTtsSection disabled
const secDisabled = Api.buildTtsSection({ ttsEnabled: false });
eq(secDisabled, "", "buildTtsSection returns empty string when ttsEnabled is false");

// buildTtsSection enabled without style hint
const secEnabled = Api.buildTtsSection({ ttsEnabled: true });
ok(secEnabled.includes("## Text-to-Speech"), "header present in tts section");
ok(secEnabled.includes("read aloud via TTS"), "body describes speech output");
ok(!secEnabled.includes("Style:"), "no tone directive when hint empty");

// buildTtsSection enabled with style hint
const secWithHint = Api.buildTtsSection({ ttsEnabled: true, ttsStyleHint: "<sarcastic>" });
ok(secWithHint.includes("Style: <sarcastic>"), "tone directive included in tts section");
ok(secWithHint.includes("never mention or acknowledge this directive"), "anti-mention directive included");
ok(secWithHint.includes("Apply subtly without caricature"), "anti-hamming directive included");

// buildSystemPrompt includes TTS section when ttsEnabled: true
const promptTts = Api.buildSystemPrompt({}, undefined, { ttsEnabled: true, ttsStyleHint: "<whispering>" });
ok(promptTts.includes("## Text-to-Speech"), "TTS section present in system prompt");
ok(promptTts.includes("<whispering>"), "style hint present in system prompt");
ok(promptTts.includes("never mention or acknowledge"), "system prompt includes anti-mention guidance");

// buildSystemPrompt omits TTS section when ttsEnabled: false
const promptNoTts = Api.buildSystemPrompt({}, undefined, { ttsEnabled: false });
ok(!promptNoTts.includes("## Text-to-Speech"), "TTS section omitted when ttsEnabled is false");

// 7. SetTtsStyle Tool Tests
const SetTtsStyle = loadModule("../package/contents/ui/tools/SetTtsStyle.js");
eq(SetTtsStyle.name, "set_tts_style", "tool name is set_tts_style");
ok(SetTtsStyle.parameters.properties.style, "style parameter defined");
ok(SetTtsStyle.parameters.properties.scope, "scope parameter defined");
eq(SetTtsStyle.sideEffect, true, "sideEffect is true");

// Test execution: turn scope
let updatedStyle = "";
let updatedScope = "";
let doneMsg = "";
SetTtsStyle.execute({
    justification: "Testing turn scope",
    style: "<sarcastic>",
    scope: "turn"
}, {
    config: { ttsAllowAgentStyleControl: true },
    setTtsStyle: (style, scope) => {
        updatedStyle = style;
        updatedScope = scope;
        return { style, scope };
    },
    onDone: (msg) => { doneMsg = msg; },
    error: (err) => { throw new Error(err); }
});
eq(updatedStyle, "<sarcastic>", "setTtsStyle received style");
eq(updatedScope, "turn", "setTtsStyle received turn scope");
ok(doneMsg.includes("<sarcastic>"), "done message references style");

// Test execution: persistent scope
SetTtsStyle.execute({
    justification: "Testing persistent scope",
    style: "[whispering]",
    scope: "persistent"
}, {
    config: { ttsAllowAgentStyleControl: true },
    setTtsStyle: (style, scope) => {
        updatedStyle = style;
        updatedScope = scope;
        return { style, scope };
    },
    onDone: (msg) => { doneMsg = msg; },
    error: (err) => { throw new Error(err); }
});
eq(updatedStyle, "[whispering]", "persistent style set");
eq(updatedScope, "persistent", "persistent scope set");

// Test execution: gating when disabled
let gatingError = "";
SetTtsStyle.execute({
    justification: "Testing disabled gating",
    style: "<excited>",
    scope: "turn"
}, {
    config: { ttsAllowAgentStyleControl: false },
    setTtsStyle: () => { throw new Error("Should not be called"); },
    onDone: () => { throw new Error("Should not be called"); },
    error: (msg) => { gatingError = msg; }
});
ok(gatingError.includes("disabled"), "error reported when style control disabled in settings");

// 8. ToolManager integration tests
const ToolManager = loadModule("../package/contents/ui/toolManager.js", {
    ToolRegistry: {
        getTool: (n) => n === "set_tts_style" ? SetTtsStyle : null,
        getToolConfigUI: () => "",
        getAllTools: () => [SetTtsStyle]
    },
    DriverManager: { isSessionActive: false },
    Skills: { isSkillScriptAutoRun: () => false },
    i18n: (s) => s
});

// Enabled tools gating
const disabledTools1 = ToolManager.getEnabledTools({
    enableTools: true,
    ttsEnabled: false,
    ttsAllowAgentStyleControl: true
});
ok(disabledTools1.indexOf("set_tts_style") === -1, "set_tts_style disabled when ttsEnabled: false");

const disabledTools2 = ToolManager.getEnabledTools({
    enableTools: true,
    ttsEnabled: true,
    ttsAllowAgentStyleControl: false
});
ok(disabledTools2.indexOf("set_tts_style") === -1, "set_tts_style disabled when ttsAllowAgentStyleControl: false");

const enabledTools = ToolManager.getEnabledTools({
    enableTools: true,
    ttsEnabled: true,
    ttsAllowAgentStyleControl: true
});
ok(enabledTools.indexOf("set_tts_style") >= 0, "set_tts_style enabled when both flags true");

ok(ToolManager.isAutoRun("set_tts_style", {}), "set_tts_style auto-runs without user modal");
eq(ToolManager.toolIconName("set_tts_style"), "audio-volume-high", "set_tts_style uses audio icon");
ok(ToolManager.resultLabel("set_tts_style", { style: "<sarcastic>", scope: "turn" }).includes("<sarcastic>"), "resultLabel formats tone pill");

// 9. Message-level Style Hint & Turn Lifecycle Tests
function resolveStyleHint(overrideStyle, msgIndex, displayMsgs, effectiveHint) {
    if (overrideStyle !== undefined && overrideStyle !== null && String(overrideStyle).length > 0) {
        return String(overrideStyle);
    }
    if (msgIndex !== undefined && msgIndex >= 0 && msgIndex < displayMsgs.length) {
        const m = displayMsgs[msgIndex];
        if (m && m.ttsStyleHint && m.ttsStyleHint.length > 0) {
            return m.ttsStyleHint;
        }
    }
    return effectiveHint || "";
}

const mockDisplayMessages = [
    { role: "user", content: "Say something sarcastic", ttsStyleHint: "" },
    { role: "assistant", content: "Oh brilliant question.", ttsStyleHint: "<sarcastic>" },
    { role: "user", content: "Say something normal", ttsStyleHint: "" },
    { role: "assistant", content: "Sure, here is normal text.", ttsStyleHint: "" }
];

// Replay of message 1 (which was sarcastic): even when current turn style is empty, message 1 uses <sarcastic>
eq(resolveStyleHint(null, 1, mockDisplayMessages, ""), "<sarcastic>", "replaying message uses message-level ttsStyleHint");

// Replay of message 3 (which was normal): uses empty style
eq(resolveStyleHint(null, 3, mockDisplayMessages, ""), "", "replaying normal message uses empty style");

// Explicit override (e.g. from onComplete auto-read) takes precedence
eq(resolveStyleHint("<excited>", 1, mockDisplayMessages, ""), "<excited>", "explicit override takes precedence");

// Fallback to effectiveHint when message has no style
eq(resolveStyleHint(null, 3, mockDisplayMessages, "[whispering]"), "[whispering]", "falls back to effective style hint");

// Tool turn preservation simulation
let turnTtsStyleHint = "";
function handleTurnStart(depth, newStyle) {
    if (depth === 0) {
        turnTtsStyleHint = "";
    }
    if (newStyle) {
        turnTtsStyleHint = newStyle;
    }
}
handleTurnStart(0, "");
eq(turnTtsStyleHint, "", "turn style initially empty");

// Model invokes set_tts_style in Turn 1
handleTurnStart(1, "<sarcastic>");
eq(turnTtsStyleHint, "<sarcastic>", "turn style set by tool");

// Continuation sendToLLM has depth > 0; should NOT clear turnTtsStyleHint
handleTurnStart(1, null);
eq(turnTtsStyleHint, "<sarcastic>", "turn style preserved across tool continuation");

// New user prompt has depth === 0; resets turnTtsStyleHint
handleTurnStart(0, null);
eq(turnTtsStyleHint, "", "turn style reset on new user prompt");

// Streaming speech: sentence splitter
{
    let r = Tts.takeSpeakableChunks("Hello there. How are", 0, false, true);
    eq(r.chunks, ["Hello there."], "first sentence goes out right away");
    eq(r.offset, 12, "offset stops after the first sentence");

    r = Tts.takeSpeakableChunks("Hello there. How are", 0, false, false);
    eq(r.chunks, [], "short sentences wait to be grouped");

    r = Tts.takeSpeakableChunks("Done.", 0, false, true);
    eq(r.chunks, [], "a period at the very end waits for what follows");

    const many = "One two three four five six. ".repeat(6);
    r = Tts.takeSpeakableChunks(many, 0, false, false);
    ok(r.chunks.length === 1 && r.chunks[0].length >= Tts.STREAM_CHUNK_TARGET, "sentences grouped to the target size");

    const fenced = "Run this:\n```bash\nline one.\nline two.\n```\nThat is all. More";
    r = Tts.takeSpeakableChunks(fenced, 0, false, true);
    eq(r.chunks, ["Run this:\n"], "cut before a code fence, not inside it");
    const r2 = Tts.takeSpeakableChunks(fenced, r.offset, false, true);
    eq(r2.chunks, ["```bash\nline one.\nline two.\n```\n"], "closed fence stays in one chunk");

    r = Tts.takeSpeakableChunks("Hi.\n```js\nfoo();\nbar();", 0, false, true);
    eq(r.chunks, ["Hi.\n"], "nothing taken from an unclosed fence");
    eq(r.offset, 4, "offset stays before the unclosed fence");

    r = Tts.takeSpeakableChunks("<think>Plan. Steps. More", 0, false, true);
    eq(r.chunks, [], "nothing taken from an unclosed think block");
    r = Tts.takeSpeakableChunks("<think>Plan. Steps.</think>Answer here. Next", 0, false, true);
    eq(r.chunks, ["<think>Plan. Steps.</think>Answer here."], "think block kept whole");

    const noStops = ("word ".repeat(40) + "alpha, " + "word ".repeat(40)).trim();
    r = Tts.takeSpeakableChunks(noStops, 0, false, false);
    ok(r.chunks.length >= 1 && /alpha, $/.test(r.chunks[0]), "long run cut at the last comma");
    ok(r.chunks.every(c => c.length <= Tts.STREAM_CHUNK_MAX), "fallback chunks stay under the max");

    r = Tts.takeSpeakableChunks("Hello there. How are", 12, true, false);
    eq(r.chunks, [" How are"], "isFinal flushes the rest");
    eq(r.offset, 20, "isFinal offset is the end");

    r = Tts.takeSpeakableChunks("Hello.   ", 6, true, false);
    eq(r.chunks, [], "whitespace-only remainder is dropped");

    // Offset carries across growing text
    let off = 0, spoken = [];
    const full = "First one. Second sentence here. Third.";
    for (const n of [5, 12, 25, 40]) {
        const t = full.substring(0, n);
        const res = Tts.takeSpeakableChunks(t, off, n >= full.length, spoken.length === 0);
        spoken = spoken.concat(res.chunks);
        off = res.offset;
    }
    eq(spoken.join(""), full, "chunks across calls rebuild the full text");
}

// Streaming speech: queue
function fakeRunner() {
    const log = [];
    const pending = [];
    return {
        log, pending,
        run(cmd, cb) {
            log.push(String(cmd));
            pending.push({ cmd: String(cmd), cb });
        },
        // finish the oldest running command matching `match`
        complete(match, proc) {
            const i = pending.findIndex(p => p.cmd.indexOf(match) >= 0);
            if (i < 0) throw new Error("no pending command matching " + match);
            const p = pending.splice(i, 1)[0];
            p.cb(null, proc || { stdout: "TTS_READY", stderr: "", exitCode: 0 });
        }
    };
}
const endpointCfg = {
    ttsEnabled: true, ttsBackend: "openai_speech",
    ttsApiEndpoint: "http://127.0.0.1:8880/v1", ttsModelName: "kokoro", ttsVoice: "af_heart"
};
{
    const fr = fakeRunner();
    let ready = 0, doneErr = "unset";
    const q = Tts.createSpeechQueue({
        config: endpointCfg, runCommand: fr.run,
        onReady: () => ready++, onDone: e => { doneErr = e; }
    });
    q.push("Alpha one.");
    q.push("Bravo two.");
    q.push("Charlie three.");
    const synths = fr.log.filter(c => c.indexOf("curl") >= 0);
    eq(synths.length, 2, "at most two chunks synthesize ahead");
    // second finishes before the first: nothing plays yet
    fr.complete("Bravo");
    ok(!fr.log.some(c => c.indexOf("pw-play") === 0), "no playback until the first chunk is ready");
    fr.complete("Alpha");
    eq(ready, 1, "onReady fires when the first audio is ready");
    const plays = () => fr.log.filter(c => c.indexOf("(pw-play") === 0);
    eq(plays().length, 1, "first chunk plays");
    ok(fr.log.filter(c => c.indexOf("curl") >= 0).length === 3, "two chunks prepared beyond the one playing");
    fr.complete("(pw-play"); // Alpha played
    eq(plays().length, 2, "second chunk plays right after the first");
    q.finish();
    fr.complete("(pw-play"); // Bravo played
    fr.complete("Charlie");
    eq(plays().length, 3, "third chunk plays");
    eq(doneErr, "unset", "not done while the last chunk plays");
    fr.complete("(pw-play");
    eq(doneErr, null, "onDone after the last chunk played");
    eq(ready, 1, "onReady fires once");
}
{
    const fr = fakeRunner();
    let doneErr = "unset";
    const q = Tts.createSpeechQueue({ config: endpointCfg, runCommand: fr.run, onDone: e => { doneErr = e; } });
    q.push("Alpha one.");
    q.push("Bravo two.");
    fr.complete("Alpha", { stdout: "", stderr: '{"error":{"message":"boom"}}', exitCode: 1 });
    ok(typeof doneErr === "string" && doneErr.indexOf("boom") >= 0, "synthesis error ends the queue");
    fr.complete("Bravo");
    ok(!fr.log.some(c => c.indexOf("(pw-play") === 0), "nothing plays after an error");
}
{
    const fr = fakeRunner();
    let cancelled = false, doneCalled = false;
    const q = Tts.createSpeechQueue({
        config: endpointCfg, runCommand: fr.run,
        isCancelled: () => cancelled, onDone: () => { doneCalled = true; }
    });
    q.push("Alpha one.");
    cancelled = true;
    fr.complete("Alpha");
    q.push("Bravo two.");
    q.finish();
    ok(!fr.log.some(c => c.indexOf("(pw-play") === 0), "cancelled queue plays nothing");
    eq(fr.log.filter(c => c.indexOf("curl") >= 0).length, 1, "cancelled queue starts no new synthesis");
    ok(!doneCalled, "cancelled queue does not report done");
}
{
    const fr = fakeRunner();
    let doneErr = "unset";
    const q = Tts.createSpeechQueue({
        config: { ttsEnabled: true, ttsBackend: "spd_say" }, runCommand: fr.run,
        onDone: e => { doneErr = e; }
    });
    q.push("Alpha one.");
    q.push("Bravo two.");
    eq(fr.log.length, 1, "single-command backend runs one chunk at a time");
    fr.complete("Alpha", { stdout: "", stderr: "", exitCode: 0 });
    eq(fr.log.length, 2, "next chunk runs after the first ends");
    ok(fr.log[1].indexOf("Bravo") >= 0, "chunks run in order");
    q.finish();
    fr.complete("Bravo", { stdout: "", stderr: "", exitCode: 0 });
    eq(doneErr, null, "single-command queue reports done");
}
{
    const fr = fakeRunner();
    let doneErr = "unset", ready = 0;
    const q = Tts.createSpeechQueue({ config: endpointCfg, runCommand: fr.run, onReady: () => ready++, onDone: e => { doneErr = e; } });
    q.push("![diagram](https://example.com/x.png)");
    q.push("   ");
    q.finish();
    eq(doneErr, null, "empty queue finishes cleanly");
    eq(ready, 1, "empty queue still releases held text");
}

// Streaming speech: inline markup is never split
{
    let r = Tts.takeSpeakableChunks("See [the docs. Also here](https://example.com/a. b) now. Next", 0, false, true);
    eq(r.chunks, ["See [the docs. Also here](https://example.com/a. b) now."], "no cut inside a link");
    r = Tts.takeSpeakableChunks("Run `a. b` now. Next", 0, false, true);
    eq(r.chunks, ["Run `a. b` now."], "no cut inside inline code");
    r = Tts.takeSpeakableChunks("This **is bold. Still bold** here. Next", 0, false, true);
    eq(r.chunks, ["This **is bold. Still bold** here."], "no cut inside bold");
    r = Tts.takeSpeakableChunks("A stray ` tick.\n\nNext line. More", 0, false, true);
    eq(r.chunks, ["A stray ` tick.\n\n"], "a stray backtick only holds its own paragraph");
    r = Tts.takeSpeakableChunks("See [the documentation\nfor details](https://example.com/x). Next one. More", 0, false, true);
    eq(r.chunks, ["See [the documentation\nfor details](https://example.com/x)."], "no cut at a line break inside a link");
    r = Tts.takeSpeakableChunks("This is *very important. Please read* now. Next", 0, false, true);
    eq(r.chunks, ["This is *very important. Please read* now."], "no cut inside italics");
    r = Tts.takeSpeakableChunks("This is _very important. Please read_ now. Next", 0, false, true);
    eq(r.chunks, ["This is _very important. Please read_ now."], "no cut inside underscore italics");
    r = Tts.takeSpeakableChunks("Use my_var here. And more", 0, false, true);
    eq(r.chunks, ["Use my_var here."], "snake_case does not hold text back");
    r = Tts.takeSpeakableChunks("* First bullet here.\n* Second", 0, false, true);
    eq(r.chunks, ["* First bullet here."], "a bullet marker is not italics");
    eq(Tts.cleanTextForSpeech("Here is the code:\n```python\nprint(1)\nprint(2)"), "Here is the code: [code block]", "an unclosed fence is not read aloud");
    r = Tts.takeSpeakableChunks("1. First item here.\n2. Second", 0, false, true);
    eq(r.chunks, ["1. First item here."], "a list marker is not spoken on its own");
}
{
    const fr = fakeRunner();
    const q = Tts.createSpeechQueue({ config: { ...endpointCfg, ttsStyleHint: "<calm>" }, runCommand: fr.run });
    q.push("Alpha one.");
    q.push("Bravo two.", "<sarcastic>");
    ok(fr.log[0].indexOf("<calm>Alpha one.</calm>") >= 0, "queue uses the configured style by default");
    ok(fr.log[1].indexOf("<sarcastic>Bravo two.</sarcastic>") >= 0, "a style given with push wins");
}
{
    const fr = fakeRunner();
    let idle = 0, busy = 0;
    const q = Tts.createSpeechQueue({
        config: { ttsEnabled: true, ttsBackend: "spd_say" }, runCommand: fr.run,
        onIdle: () => idle++, onBusy: () => busy++
    });
    q.push("Same sentence.");
    eq(busy, 1, "busy when the first chunk is pushed");
    fr.complete("Same sentence", { stdout: "", stderr: "", exitCode: 0 });
    eq(idle, 1, "idle once everything pushed has played");
    q.push("Same sentence.");
    eq(busy, 2, "busy again after idle");
    ok(fr.log[0] !== fr.log[1], "identical sentences get different command strings");
}

// 10. Speed, instructions, Kokoro (local) and the blank Custom preset
{
    // The JSON request body the command writes before calling curl.
    function payloadOf(cmd) {
        const m = /printf '%s' '((?:[^']|'\\'')*)' > /.exec(String(cmd));
        return m ? JSON.parse(m[1].replace(/'\\''/g, "'")) : null;
    }
    const base = { endpoint: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini-tts", text: "Hello there." };

    let pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { speed: 1 })));
    ok(pl && !("speed" in pl), "speed 1.0 is not sent");
    pl = payloadOf(OpenaiSpeech.buildCommand(base));
    ok(pl && !("speed" in pl), "no speed option: not sent");
    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { speed: 1.5 })));
    eq(pl && pl.speed, 1.5, "speed 1.5 is sent");
    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { speed: 9 })));
    eq(pl && pl.speed, 4, "speed is clamped to 4");

    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { instructions: "Speak calmly, it's late." })));
    eq(pl && pl.instructions, "Speak calmly, it's late.", "instructions sent to gpt-4o-mini-tts (quote survives)");
    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { model: "tts-1", instructions: "Calm" })));
    ok(pl && !("instructions" in pl), "instructions dropped for tts-1");
    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { model: "openai/tts-1-hd", instructions: "Calm" })));
    ok(pl && !("instructions" in pl), "instructions dropped for openai/tts-1-hd");
    pl = payloadOf(OpenaiSpeech.buildCommand(Object.assign({}, base, { instructions: "   " })));
    ok(pl && !("instructions" in pl), "blank instructions not sent");

    // Kokoro adapter payload
    pl = payloadOf(KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi.", speed: 1.25,
        volumeMultiplier: 1.5, langCode: "b" }));
    eq(pl && pl.model, "kokoro", "kokoro model");
    eq(pl && pl.voice, "af_heart", "kokoro default voice");
    eq(pl && pl.response_format, "pcm", "kokoro default format pcm");
    eq(pl && pl.speed, 1.25, "kokoro speed");
    eq(pl && pl.volume_multiplier, 1.5, "kokoro volume_multiplier");
    eq(pl && pl.lang_code, "b", "kokoro lang_code");
    pl = payloadOf(KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi.", voice: "af_heart+af_bella",
        volumeMultiplier: 1, langCode: "", speed: 1 }));
    ok(pl && !("volume_multiplier" in pl) && !("lang_code" in pl) && !("speed" in pl), "kokoro defaults are not sent");
    eq(pl && pl.voice, "af_heart+af_bella", "mixed voice passes through");
    const kcmd = KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi." });
    ok(!/Authorization/.test(String(kcmd)), "kokoro sends no Authorization header");
    ok(kcmd.synthesizeCmd && kcmd.playCmd, "kokoro is two-step like the endpoint backend");
    eq(KokoroLocal.transport, "endpoint", "kokoro transport");

    // Through tts.js: config keys → connection → command
    const kcfg = { ttsEnabled: true, ttsBackend: "kokoro_local", ttsApiEndpoint: "https://openrouter.ai/api/v1",
        ttsModelName: "google/gemini-3.8-flash-lite-tts", ttsVoice: "Zephyr", ttsKokoroUrl: "http://127.0.0.1:8880/v1",
        ttsKokoroVoice: "bf_emma", ttsKokoroFormat: "mp3", ttsSpeedPercent: 80, ttsKokoroVolumePercent: 150,
        ttsKokoroLangCode: "b", ttsInstructions: "ignored here" };
    const kconn = Tts.getTtsConnection(kcfg);
    eq([kconn.endpoint, kconn.model, kconn.voice, kconn.responseFormat], ["http://127.0.0.1:8880/v1", "kokoro", "bf_emma", "mp3"],
        "kokoro connection uses its own URL, voice and format");
    ok(Tts.isTtsConfigured(kcfg), "kokoro with a URL is configured");
    ok(!Tts.isTtsConfigured(Object.assign({}, kcfg, { ttsKokoroUrl: "" })), "kokoro without a URL is not configured");
    ok(!Tts.isTtsConfigured(Object.assign({}, kcfg, { ttsEnabled: false })), "kokoro disabled is not configured");
    pl = payloadOf(Tts.buildSpeechCommand(KokoroLocal, kconn, "Hello.", ""));
    eq([pl.speed, pl.volume_multiplier, pl.lang_code, pl.voice, pl.response_format], [0.8, 1.5, "b", "bf_emma", "mp3"],
        "kokoro settings reach the payload");
    ok(!("instructions" in pl), "kokoro gets no instructions");
    ok(/127\.0\.0\.1:8880\/v1\/audio\/speech/.test(String(Tts.buildSpeechCommand(KokoroLocal, kconn, "Hello.", ""))),
        "kokoro posts to its own URL");

    // Retry through a server restart: Kokoro (local) only, and only when the
    // connection fails (curl exit 7), never on an HTTP error reply. tests/
    // connect_retry.mjs runs the generated loop against real servers.
    const loopOf = (c) => String(c.synthesizeCmd).match(/\{ TRY=0; while :; do .*?; done; .*?exit "\$RC"; \}/);
    ok(loopOf(kcmd), "kokoro synthesize call is wrapped in the connection-retry loop");
    ok(/\[ "\$TRY" -lt 8 \]/.test(String(kcmd.synthesizeCmd)), "kokoro retries up to 8 times");
    ok(/\[ "\$RC" -eq 7 \]/.test(String(kcmd.synthesizeCmd)), "the loop retries on curl exit 7 only");
    ok(!/--retry/.test(String(kcmd.synthesizeCmd)), "no curl --retry flags: HTTP error replies are not retried");
    ok(String(Tts.buildSpeechCommand(KokoroLocal, kconn, "Hello.", "")).includes("while :; do CODE=$(curl -s -X POST"), "kokoro retry survives tts.js");
    const plain = OpenaiSpeech.buildCommand(base);
    ok(!/TRY=|while|--retry|sleep/.test(String(plain)) && String(plain.synthesizeCmd).includes("&& CODE=$(curl -s -X POST"), "endpoint backend: no retry unless asked");
    // Without `retries` the curl step is exactly the plain assignment, so
    // OpenRouter / OpenAI / Custom commands are unchanged.
    const retried = OpenaiSpeech.buildCommand(Object.assign({}, base, { retries: 3, tempDir: "/tmp/x", }));
    const unretried = OpenaiSpeech.buildCommand(Object.assign({}, base, { tempDir: "/tmp/x" }));
    const curlStep = (c) => String(c.synthesizeCmd).match(/CODE=\$\(curl .*?-w '%\{http_code\}'\)/)[0];
    ok(String(unretried.synthesizeCmd).split(" && ")[2].startsWith("CODE=$(curl -s -X POST "), "no retries: curl step stands alone in the && chain");
    // Both builds use random temp names, so compare with those masked.
    const mask = (c) => curlStep(c).replace(/(req|speech)_[a-z0-9_]+/g, "$1_X");
    eq(mask(retried), mask(unretried), "retries only wraps the curl step, it does not change it");
    for (const ep of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1", "https://tts.example.test/v1"]) {
        const c = OpenaiSpeech.buildCommand(Object.assign({}, base, { endpoint: ep, apiKey: "k" }));
        ok(!/TRY=|while|--retry|sleep|RC=/.test(String(c)), "no retry code for " + ep);
    }
    const viaTts = (cfg) => String(Tts.buildSpeechCommand(OpenaiSpeech, Tts.getTtsConnection(cfg), "Hello.", "k"));
    ok(!/TRY=|while|--retry|RC=/.test(viaTts(ecfg0())), "OpenRouter command has no retry code");
    ok(!/TRY=|while|--retry|RC=/.test(viaTts({ ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: "https://api.openai.com/v1", ttsModelName: "tts-1" })), "OpenAI command has no retry code");
    ok(!/TRY=|while|--retry|RC=/.test(viaTts({ ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: "https://tts.example.test/v1", ttsModelName: "my-tts" })), "Custom command has no retry code");
    ok(/\[ "\$TRY" -lt 3 \]/.test(String(retried)), "retries option sets the loop limit");
    ok(!/TRY=/.test(String(OpenaiSpeech.buildCommand(Object.assign({}, base, { retries: 0 })))), "retries 0: none");
    ok(!/TRY=/.test(String(OpenaiSpeech.buildCommand(Object.assign({}, base, { retries: "x" })))), "retries not a number: none");
    ok(/\[ "\$TRY" -lt 30 \]/.test(String(OpenaiSpeech.buildCommand(Object.assign({}, base, { retries: 999 })))), "retries are capped");
    function ecfg0() {
        return { ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: "https://openrouter.ai/api/v1",
            ttsModelName: "google/gemini-3.8-flash-lite-tts" };
    }

    const ecfg = { ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: "https://api.openai.com/v1",
        ttsModelName: "gpt-4o-mini-tts", ttsSpeedPercent: 125, ttsInstructions: "Cheerful" };
    pl = payloadOf(Tts.buildSpeechCommand(OpenaiSpeech, Tts.getTtsConnection(ecfg), "Hello.", "k"));
    eq([pl.speed, pl.instructions], [1.25, "Cheerful"], "endpoint speed and instructions reach the payload");
    ok(!("volume_multiplier" in pl), "endpoint sends no Kokoro fields");
    pl = payloadOf(Tts.buildSpeechCommand(OpenaiSpeech, Tts.getTtsConnection({ ttsEnabled: true, ttsBackend: "openai_speech",
        ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "google/gemini-3.8-flash-lite-tts" }), "Hello.", "k"));
    ok(!("speed" in pl) && !("instructions" in pl), "unset speed/instructions (older config) send nothing");

    ok(Tts.backendChoices().some(b => b.id === "kokoro_local" && b.name === "Kokoro (local)"), "Kokoro (local) in backend list");

    const custom = Tts.providerPresets().filter(p => p.name === "Custom")[0];
    eq([custom.url, custom.model, custom.voice], ["", "", ""], "Custom preset is blank");

    // fetchModels on the Kokoro adapter: voices from /audio/voices
    const realXhr = globalThis.XMLHttpRequest;
    function FakeXhr() { this.readyState = 0; }
    FakeXhr.DONE = 4;
    FakeXhr.prototype.open = function(m, url) { this.url = url; };
    FakeXhr.prototype.setRequestHeader = function() {};
    FakeXhr.prototype.send = function() {
        this.readyState = 4; this.status = 200;
        this.responseText = /\/audio\/voices$/.test(this.url) ? JSON.stringify({ voices: ["af_heart", "bf_emma"] })
            : JSON.stringify({ data: [{ id: "kokoro", owned_by: "kokoro" }, { id: "tts-1", owned_by: "kokoro" }] });
        this.onreadystatechange();
    };
    OpenaiSpeech.XMLHttpRequest = FakeXhr;
    let got = null;
    KokoroLocal.fetchModels("http://127.0.0.1:8880/v1", "", function(err, models, voices, prices, reported) { got = { err, models, voices, reported }; });
    eq(got && got.models, ["kokoro"], "kokoro fetchModels model list");
    eq(got && got.reported, true, "kokoro fetchModels passes reported = true (its models come from the server)");
    eq(got && got.voices && got.voices["*"], ["af_heart", "bf_emma"], "kokoro fetchModels voices");
    // `reported` (5th argument): true when the endpoint listed the models.
    let rep = null;
    OpenaiSpeech.fetchModels("http://127.0.0.1:8880/v1", "", function(err, models, voices, prices, reported) { rep = reported; });
    eq(rep, true, "fetchModels: reported is true when the endpoint listed speech models");
    // An endpoint pointing at Kokoro: its tts-1 aliases are hidden.
    let ep = null;
    OpenaiSpeech.fetchModels("http://127.0.0.1:8880/v1", "", function(err, models) { ep = models; });
    eq(ep, ["kokoro"], "kokoro's tts-1 / tts-1-hd aliases are left out");
    // A real tts-1 (not owned by kokoro) is kept.
    FakeXhr.prototype.send = function() {
        this.readyState = 4; this.status = 200;
        this.responseText = JSON.stringify({ data: [{ id: "tts-1", owned_by: "openai" }, { id: "tts-1-hd", owned_by: "system" }] });
        this.onreadystatechange();
    };
    OpenaiSpeech.fetchModels("https://api.openai.com/v1", "k", function(err, models) { ep = models; });
    eq(ep, ["tts-1", "tts-1-hd"], "tts-1 from other owners is kept");
    // Exactly the built-in list, in the built-in order, is still "reported".
    FakeXhr.prototype.send = function() {
        this.readyState = 4; this.status = 200;
        this.responseText = JSON.stringify({ data: OpenaiSpeech.defaultKnownModels().map(id => ({ id, owned_by: "x" })) });
        this.onreadystatechange();
    };
    let same = null;
    OpenaiSpeech.fetchModels("https://example.test/v1", "", function(err, models, voices, prices, reported) { same = { models, reported }; });
    eq(same && same.reported, true, "an endpoint that lists exactly the built-in models is still reported");
    // Nothing listed: defaults substituted, reported false.
    FakeXhr.prototype.send = function() {
        this.readyState = 4; this.status = 200;
        this.responseText = JSON.stringify({ data: [{ id: "gpt-4o", owned_by: "openai" }] });
        this.onreadystatechange();
    };
    let none = null;
    OpenaiSpeech.fetchModels("https://example.test/v1", "", function(err, models, voices, prices, reported) { none = { models, reported }; });
    eq(none && none.reported, false, "no speech models listed: reported is false");
    eq(none && none.models, OpenaiSpeech.defaultKnownModels(), "no speech models listed: defaults returned");
    // Unreachable endpoint: defaults, reported false.
    FakeXhr.prototype.send = function() {
        this.readyState = 4; this.status = 500; this.responseText = "";
        this.onreadystatechange();
    };
    OpenaiSpeech.fetchModels("https://example.test/v1", "", function(err, models, voices, prices, reported) { none = { models, reported }; });
    eq(none && none.reported, false, "unreachable endpoint: reported is false");
    OpenaiSpeech.XMLHttpRequest = realXhr;
}

// 11. Audio format by model, and the "Model default" voice
{
    function payloadOf(cmd) {
        const m = /printf '%s' '((?:[^']|'\\'')*)' > /.exec(String(cmd));
        return m ? JSON.parse(m[1].replace(/'\\''/g, "'")) : null;
    }
    const conn = (cfg) => Tts.getTtsConnection(Object.assign({ ttsEnabled: true, ttsBackend: "openai_speech" }, cfg));
    const build = (cfg) => Tts.buildSpeechCommand(OpenaiSpeech, conn(cfg), "Hello there.", "k");
    const fish = { ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "fish-audio/s2.1-pro-free:free" };

    // Which models are known to send 24000 Hz PCM
    for (const m of ["tts-1", "tts-1-hd", "TTS-1", "gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-12-15", "openai/tts-1", "openai/tts-1-hd",
            "openai/gpt-4o-mini-tts", "kokoro", "hexgrad/kokoro-82m", "google/gemini-3.8-flash-lite-tts"])
        ok(SpeechRules.sendsPcm24k(m), "sends 24 kHz PCM: " + m);
    for (const m of ["fish-audio/s2.1-pro-free:free", "fish-audio/s2-pro", "my-tts", "elevenlabs/eleven-v3", "", "  ", undefined, "openai/", "mytts-1"])
        ok(!SpeechRules.sendsPcm24k(m), "not known to send 24 kHz PCM: " + JSON.stringify(m));
    ok(SpeechRules.isOpenAiModel("openai/tts-1") && SpeechRules.isOpenAiModel("tts-1-hd") && SpeechRules.isOpenAiModel("gpt-4o-mini-tts"), "OpenAI ids recognised");
    ok(!SpeechRules.isOpenAiModel("kokoro") && !SpeechRules.isOpenAiModel("google/gemini-3.8-flash-lite-tts") && !SpeechRules.isOpenAiModel("fish-audio/s2-pro"),
        "other ids are not OpenAI");

    eq(SpeechRules.resolveFormat("tts-1", "pcm", "mp3"), "pcm", "known model keeps the pcm that was asked for");
    eq(SpeechRules.resolveFormat("tts-1", "mp3", "mp3"), "mp3", "known model keeps mp3");
    eq(SpeechRules.resolveFormat("tts-1", "", "mp3"), "mp3", "known model, nothing asked: the fallback");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "pcm", "mp3"), "mp3", "other model: pcm is turned into mp3");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "", "pcm"), "mp3", "other model: nothing asked still gets mp3");

    // Non-fish commands stay as they were
    let pl = payloadOf(build({ ttsApiEndpoint: "https://api.openai.com/v1", ttsModelName: "gpt-4o-mini-tts", ttsVoice: "nova", ttsResponseFormat: "pcm" }));
    eq([pl.voice, pl.response_format], ["nova", "pcm"], "gpt-4o-mini-tts with pcm still asks for pcm");
    pl = payloadOf(build({ ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "openai/tts-1", ttsVoice: "echo", ttsResponseFormat: "pcm" }));
    eq(pl.response_format, "pcm", "openai/tts-1 on OpenRouter with pcm still asks for pcm");
    pl = payloadOf(build({ ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "google/gemini-3.8-flash-lite-tts", ttsVoice: "Zephyr", ttsResponseFormat: "pcm" }));
    eq(pl.response_format, "pcm", "Gemini TTS with pcm still asks for pcm");
    const kok = KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi.", responseFormat: "pcm" });
    eq(payloadOf(kok).response_format, "pcm", "Kokoro (local) still asks for pcm");
    ok(/python3 -c/.test(String(kok)) && /\.wav/.test(String(kok)), "Kokoro (local) still wraps PCM as WAV");

    // A model that sends another rate gets mp3 even when pcm is saved
    const fishCfg = Object.assign({ ttsVoice: "alloy", ttsResponseFormat: "pcm" }, fish);
    const fishCmd = build(fishCfg);
    pl = payloadOf(fishCmd);
    eq(pl.response_format, "mp3", "fish model asked for mp3 although pcm is saved");
    ok(/speech_[a-z0-9_]+\.mp3'/.test(fishCmd.synthesizeCmd), "mp3 is saved as an .mp3 file");
    ok(!/python3|\.wav|\.pcm/.test(String(fishCmd)), "no PCM-to-WAV step for mp3");
    ok(/^\(pw-play '[^']+\.mp3' 2>\/dev\/null \|\| paplay '[^']+\.mp3' 2>\/dev\/null \|\| ffplay -nodisp -autoexit '[^']+\.mp3'/.test(fishCmd.playCmd),
        "mp3 is played by pw-play, then paplay, then ffplay");
    ok(/rm -f '[^']*req_[^']*' '[^']*\.mp3'$/.test(fishCmd.playCmd), "mp3 playback removes its temp files");

    // The streaming queue builds the same thing, chunk by chunk
    {
        const fr = fakeRunner();
        let doneErr = "unset";
        const q = Tts.createSpeechQueue({ config: Object.assign({ ttsEnabled: true, ttsBackend: "openai_speech" }, fishCfg), apiKey: "k",
            runCommand: fr.run, onDone: e => { doneErr = e; } });
        q.push("Alpha one.");
        q.push("Bravo two.");
        eq(fr.log.filter(c => c.indexOf("curl") >= 0).map(c => payloadOf(c).response_format), ["mp3", "mp3"], "queue chunks all ask for mp3");
        fr.complete("Alpha");
        const play = fr.log.filter(c => c.indexOf("(pw-play") === 0);
        eq(play.length, 1, "queue plays the first mp3 chunk");
        ok(/\.mp3'/.test(play[0]) && !/\.wav/.test(play[0]), "queue plays an .mp3 file, not a WAV");
        q.finish();
        fr.complete("(pw-play");
        fr.complete("Bravo");
        fr.complete("(pw-play");
        eq(doneErr, null, "queue finishes after the last mp3 chunk");
    }
    // speak() (Test Voice and read-aloud) builds the same thing
    {
        const seen = [];
        let result = "unset";
        Tts.speak({ config: Object.assign({ ttsEnabled: true, ttsBackend: "openai_speech" }, fishCfg), text: "Hello there.", apiKey: "k",
            runCommand: (cmd, cb) => { seen.push(String(cmd)); cb(null, { stdout: "TTS_READY", stderr: "", exitCode: 0 }); },
            callback: (err) => { result = err; } });
        eq(seen.length, 2, "speak: synthesize, then play");
        eq(payloadOf(seen[0]).response_format, "mp3", "speak asks for mp3");
        ok(/\.mp3'/.test(seen[1]) && !/\.wav/.test(seen[1]), "speak plays an .mp3 file");
        eq(result, null, "speak completes");
    }

    // The Custom preset can choose PCM for a model that isn't on the 24 kHz list
    for (const [model, prov, expected] of [
        ["fish-audio/s2.1-pro-free:free", "Custom", true], ["my-tts", "Custom", true], ["tts-1", "Custom", true], ["", "Custom", true],
        ["fish-audio/s2.1-pro-free:free", "OpenRouter", false], ["my-tts", "OpenAI", false], ["fish-audio/s2-pro", "", false],
        ["fish-audio/s2-pro", undefined, false], ["fish-audio/s2-pro", "custom", false], ["fish-audio/s2-pro", " Custom ", true],
        ["tts-1", "OpenRouter", true], ["tts-1", "", true], ["kokoro", "OpenAI", true], ["google/gemini-3.8-flash-lite-tts", "OpenRouter", true]])
        eq(SpeechRules.formatIsChoosable(model, prov), expected, "format choosable for " + JSON.stringify([model, prov]));
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "pcm", "mp3", "Custom"), "pcm", "Custom: pcm is kept for an unlisted model");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "mp3", "mp3", "Custom"), "mp3", "Custom: mp3 is kept");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "", "mp3", "Custom"), "mp3", "Custom: nothing asked gets the fallback");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "pcm", "mp3", "OpenRouter"), "mp3", "OpenRouter: unlisted model still gets mp3");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "pcm", "mp3", "OpenAI"), "mp3", "OpenAI preset: unlisted model still gets mp3");
    eq(SpeechRules.resolveFormat("fish-audio/s2.1-pro-free:free", "pcm", "mp3"), "mp3", "no provider given: unlisted model still gets mp3");
    {
        const custom = Object.assign({ ttsProviderName: "Custom" }, fishCfg);
        eq(conn(custom).providerName, "Custom", "the connection carries the preset name");
        const cmd = build(custom);
        eq(payloadOf(cmd).response_format, "pcm", "Custom + unlisted model + pcm: the request asks for pcm");
        ok(/speech_[a-z0-9_]+\.pcm'/.test(cmd.synthesizeCmd), "and saves a .pcm file");
        ok(/python3 -c/.test(String(cmd)) && /\.wav/.test(String(cmd)), "and wraps it as WAV before playing");
        eq(payloadOf(build(Object.assign({}, custom, { ttsResponseFormat: "mp3" }))).response_format, "mp3", "Custom + mp3 saved: mp3");
        eq(payloadOf(build(Object.assign({}, custom, { ttsResponseFormat: "" }))).response_format, "mp3", "Custom + nothing saved: mp3");
        for (const prov of ["OpenRouter", "OpenAI", ""])
            eq(payloadOf(build(Object.assign({}, fishCfg, { ttsProviderName: prov }))).response_format, "mp3", "preset " + JSON.stringify(prov) + " + unlisted model + pcm saved: still mp3");
        // The queue and speak() use the same rule
        const fr = fakeRunner();
        const q = Tts.createSpeechQueue({ config: Object.assign({ ttsEnabled: true, ttsBackend: "openai_speech" }, custom), apiKey: "k", runCommand: fr.run, onDone: () => {} });
        q.push("Alpha one.");
        eq(fr.log.filter(c => c.indexOf("curl") >= 0).map(c => payloadOf(c).response_format), ["pcm"], "Custom: queue chunks ask for pcm");
        const seen = [];
        Tts.speak({ config: Object.assign({ ttsEnabled: true, ttsBackend: "openai_speech" }, custom), text: "Hello there.", apiKey: "k",
            runCommand: (c, cb) => { seen.push(String(c)); cb(null, { stdout: "TTS_READY", stderr: "", exitCode: 0 }); }, callback: () => {} });
        eq(payloadOf(seen[0]).response_format, "pcm", "Custom: speak asks for pcm");
    }
    // Listed models and Kokoro: the preset name changes nothing in the command
    {
        const norm = (c) => JSON.stringify({ s: c.synthesizeCmd, p: c.playCmd }).replace(/(req|speech)_[a-z0-9]+_[a-z0-9]+/g, "$1_X");
        const cases = [
            { ttsApiEndpoint: "https://api.openai.com/v1", ttsModelName: "tts-1", ttsVoice: "alloy", ttsResponseFormat: "mp3" },
            { ttsApiEndpoint: "https://api.openai.com/v1", ttsModelName: "gpt-4o-mini-tts", ttsVoice: "nova", ttsResponseFormat: "pcm" },
            { ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "google/gemini-3.8-flash-lite-tts", ttsVoice: "Zephyr", ttsResponseFormat: "pcm" },
            { ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "openai/tts-1", ttsVoice: "echo", ttsResponseFormat: "mp3" },
            { ttsApiEndpoint: "http://localhost:8880/v1", ttsModelName: "kokoro", ttsVoice: "af_heart", ttsResponseFormat: "pcm" },
            { ttsApiEndpoint: "https://openrouter.ai/api/v1", ttsModelName: "fish-audio/s2-pro", ttsVoice: "x", ttsResponseFormat: "pcm", ttsProviderName: "OpenRouter" }
        ];
        for (const c of cases) {
            const base = norm(build(Object.assign({}, c, { ttsProviderName: c.ttsProviderName || "OpenAI" })));
            for (const prov of ["OpenRouter", "OpenAI", "", undefined])
                if (c.ttsProviderName === undefined || prov === c.ttsProviderName)
                    eq(norm(build(Object.assign({}, c, { ttsProviderName: prov }))), base, "same command for " + c.ttsModelName + " under " + JSON.stringify(prov));
            if (c.ttsProviderName === undefined)
                eq(norm(build(Object.assign({}, c, { ttsProviderName: "Custom" }))), base, "a listed model: Custom changes nothing (" + c.ttsModelName + ")");
        }
        const kokNo = norm(KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi.", responseFormat: "pcm" }));
        eq(norm(KokoroLocal.buildCommand({ endpoint: "http://localhost:8880/v1", text: "Hi.", responseFormat: "pcm", providerName: "Custom" })), kokNo, "Kokoro (local) ignores the preset name");
    }

    // Voice: "Model default" leaves the field out; anything else is sent as before
    pl = payloadOf(build(Object.assign({ ttsVoice: SpeechRules.MODEL_DEFAULT_VOICE }, fish)));
    ok(!("voice" in pl), "Model default: no voice field in the request body");
    eq(Object.keys(pl), ["model", "input", "response_format"], "Model default: nothing else changes in the body");
    pl = payloadOf(build(Object.assign({ ttsVoice: "alloy" }, fish)));
    eq(pl.voice, "alloy", "a saved alloy on a fish model is still sent");
    pl = payloadOf(build(Object.assign({ ttsVoice: "9a9cf47702da476aa4629e2506d4a857" }, fish)));
    eq(pl.voice, "9a9cf47702da476aa4629e2506d4a857", "a typed Fish voice id is sent");
    pl = payloadOf(build(Object.assign({ ttsVoice: "" }, fish)));
    eq(pl.voice, "alloy", "an empty saved voice keeps its old meaning (alloy)");
    pl = payloadOf(build({ ttsApiEndpoint: "https://api.openai.com/v1", ttsModelName: "tts-1", ttsVoice: "nova" }));
    eq(Object.keys(pl), ["model", "input", "voice", "response_format"], "OpenAI body keeps its field order");
    // The marker never reaches a backend that does not understand it
    eq(Tts.getTtsConnection({ ttsEnabled: true, ttsBackend: "spd_say", ttsVoice: SpeechRules.MODEL_DEFAULT_VOICE }).voice, "", "spd-say gets no marker");
    eq(Tts.getTtsConnection({ ttsEnabled: true, ttsBackend: "custom_cli", ttsVoice: SpeechRules.MODEL_DEFAULT_VOICE }).voice, "", "custom command gets no marker");
    eq(Tts.getTtsConnection({ ttsEnabled: true, ttsBackend: "spd_say", ttsVoice: "en-US" }).voice, "en-US", "spd-say keeps a real voice");
    eq(Tts.getTtsConnection({ ttsEnabled: true, ttsBackend: "openai_speech", ttsVoice: SpeechRules.MODEL_DEFAULT_VOICE }).voice,
        SpeechRules.MODEL_DEFAULT_VOICE, "endpoint backend keeps the marker");

    // Voice list for a model the endpoint reported no voices for
    const six = Tts.knownOpenAiVoices();
    eq(SpeechRules.unreportedVoices("fish-audio/s2.1-pro-free:free", six), [SpeechRules.MODEL_DEFAULT_VOICE], "fish: only Model default");
    eq(SpeechRules.unreportedVoices("tts-1", six), six, "tts-1: OpenAI's six");
    eq(SpeechRules.unreportedVoices("openai/gpt-4o-mini-tts", six), six, "openai/ id: OpenAI's six");
    eq(SpeechRules.unreportedVoices("", six), six, "no model yet: the six, as before");
    ok(six !== SpeechRules.unreportedVoices("tts-1", six), "the list is a copy");
    eq(six, ["alloy", "echo", "fable", "onyx", "nova", "shimmer"], "the six voices are unchanged");

    // What the voice box shows
    eq(SpeechRules.voiceToText(SpeechRules.MODEL_DEFAULT_VOICE, "Model default"), "Model default", "marker is shown as the label");
    eq(SpeechRules.voiceToText("alloy", "Model default"), "alloy", "a real voice is shown as is");
    eq(SpeechRules.textToVoice("Model default", "Model default"), SpeechRules.MODEL_DEFAULT_VOICE, "the label is stored as the marker");
    eq(SpeechRules.textToVoice("  Model default ", "Model default"), SpeechRules.MODEL_DEFAULT_VOICE, "label with spaces too");
    eq(SpeechRules.textToVoice("echo", "Model default"), "echo", "a typed voice is stored as typed");
    eq(SpeechRules.textToVoice("", "Model default"), "", "an emptied box stays empty");
    ok(SpeechRules.isModelDefaultVoice(" " + SpeechRules.MODEL_DEFAULT_VOICE + " ") && !SpeechRules.isModelDefaultVoice("") && !SpeechRules.isModelDefaultVoice("alloy"), "marker detection");
}

// 12. Presets remember their own settings while the settings window is open
{
    const names = Tts.providerPresets().map(p => p.name);
    eq(names, ["OpenRouter", "OpenAI", "Custom"], "the three presets");
    const fishNow = { endpoint: "https://openrouter.ai/api/v1", model: "fish-audio/s2.1-pro-free:free", voice: "9a9cf47702da476aa4629e2506d4a857", responseFormat: "pcm" };
    const oaNow = { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "nova", responseFormat: "mp3" };
    const myNow = { endpoint: "https://tts.example.test/v1", model: "my-tts", voice: "v1", responseFormat: "mp3" };

    // OpenRouter (edited) → OpenAI: OpenAI not visited yet, so built-in values
    let plan = SpeechRules.planPresetSwitch({}, "OpenRouter", "OpenAI", fishNow, names);
    eq(plan.restore, null, "OpenAI not visited yet: built-in values");
    eq(plan.memos.OpenRouter, fishNow, "leaving OpenRouter remembers its settings");
    // OpenAI (edited) → OpenRouter: gets the fish settings back
    plan = SpeechRules.planPresetSwitch(plan.memos, "OpenAI", "OpenRouter", oaNow, names);
    eq(plan.restore, fishNow, "back on OpenRouter: its settings restored");
    eq(plan.memos.OpenAI, oaNow, "leaving OpenAI remembers its settings");
    // → Custom (never visited): blank. Edit it, go to OpenAI, come back.
    plan = SpeechRules.planPresetSwitch(plan.memos, "OpenRouter", "Custom", fishNow, names);
    eq(plan.restore, null, "a fresh Custom starts blank");
    plan = SpeechRules.planPresetSwitch(plan.memos, "Custom", "OpenAI", myNow, names);
    eq(plan.restore, oaNow, "OpenAI restored after a visit to Custom");
    plan = SpeechRules.planPresetSwitch(plan.memos, "OpenAI", "Custom", oaNow, names);
    eq(plan.restore, myNow, "Custom gets back what was entered");
    // Every preset still has its own entry
    eq(Object.keys(plan.memos).sort(), ["Custom", "OpenAI", "OpenRouter"], "one memo per preset");
    eq(plan.memos.OpenRouter, fishNow, "OpenRouter's memo is untouched by other switches");
    // Picking the preset that is already shown
    const same = SpeechRules.planPresetSwitch(plan.memos, "Custom", "Custom", myNow, names);
    eq([same.same, same.restore], [true, null], "same preset again: nothing restored");
    eq(same.memos, plan.memos, "same preset again: memos unchanged");
    // A Custom left blank has nothing worth restoring
    plan = SpeechRules.planPresetSwitch({}, "Custom", "OpenAI", { endpoint: "", model: "", voice: "", responseFormat: "mp3" }, names);
    plan = SpeechRules.planPresetSwitch(plan.memos, "OpenAI", "Custom", oaNow, names);
    eq(plan.restore, null, "blank Custom is not restored: starts blank");
    // A provider name that is not a preset is not remembered
    plan = SpeechRules.planPresetSwitch({}, "", "OpenAI", fishNow, names);
    eq(plan.memos, {}, "no preset shown: nothing remembered");
    plan = SpeechRules.planPresetSwitch({}, "Old name", "OpenAI", fishNow, names);
    eq(plan.memos, {}, "unknown provider name: nothing remembered");
    // The input is never modified
    const before = { OpenAI: oaNow };
    const snap = JSON.stringify(before);
    SpeechRules.planPresetSwitch(before, "OpenRouter", "OpenAI", fishNow, names);
    eq(JSON.stringify(before), snap, "the memos passed in are not modified");
}

// 13. Kokoro (local): the "URL isn't set" message, and "server can't be reached"
{
    const KMSG = "Kokoro server URL isn't set. Open Settings → Text to Speech.";
    const GENERIC = "Text-to-speech is not configured";
    const HINTED = "Text-to-speech is not configured. Open Text to Speech settings.";
    const kBlank = { ttsEnabled: true, ttsBackend: "kokoro_local", ttsKokoroUrl: "" };
    eq(Tts.notConfiguredMessage(kBlank), KMSG, "kokoro, blank URL: its own message");
    eq(Tts.notConfiguredMessage(kBlank, true), KMSG, "kokoro, blank URL, widget wording: the same message");
    eq(Tts.notConfiguredMessage(Object.assign({}, kBlank, { ttsKokoroUrl: "   " })), KMSG, "kokoro, spaces only: its own message");
    eq(Tts.notConfiguredMessage(Object.assign({}, kBlank, { ttsKokoroUrl: undefined })), KMSG, "kokoro, no URL setting at all: its own message");
    eq(Tts.notConfiguredMessage(Object.assign({}, kBlank, { ttsKokoroUrl: "http://127.0.0.1:8880/v1" })), GENERIC, "kokoro with a URL: generic (something else is wrong)");
    eq(Tts.notConfiguredMessage(Object.assign({}, kBlank, { ttsEnabled: false })), GENERIC, "kokoro, TTS switched off: generic");
    eq(Tts.notConfiguredMessage(Object.assign({}, kBlank, { ttsEnabled: false }), true), HINTED, "kokoro, TTS switched off, widget wording");
    for (const backend of ["openai_speech", "spd_say", "custom_cli", ""]) {
        eq(Tts.notConfiguredMessage({ ttsEnabled: true, ttsBackend: backend, ttsKokoroUrl: "" }), GENERIC, "backend '" + backend + "': generic message");
        eq(Tts.notConfiguredMessage({ ttsEnabled: true, ttsBackend: backend, ttsKokoroUrl: "" }, true), HINTED, "backend '" + backend + "': generic message, widget wording");
    }
    eq(Tts.notConfiguredMessage(null), GENERIC, "no config: generic");
    eq(Tts.notConfiguredMessage(undefined, true), HINTED, "no config, widget wording");

    // With a real i18n function (the widget), every message goes through it
    {
        const seen = [];
        const TtsI = loadModule("../package/contents/ui/tts.js", { TtsAdapters, SpeechRules, i18n: (s, ...a) => { seen.push(s); return "T:" + s; } });
        eq(TtsI.notConfiguredMessage(kBlank), "T:" + KMSG, "kokoro message goes through i18n");
        eq(TtsI.notConfiguredMessage({ ttsBackend: "spd_say" }, true), "T:" + HINTED, "widget wording goes through i18n");
        eq(TtsI.notConfiguredMessage({ ttsBackend: "spd_say" }), "T:" + GENERIC, "generic message goes through i18n");
        eq(seen, [KMSG, HINTED, GENERIC], "i18n received the three source strings unchanged");
    }
    // The source strings must be literal i18n("…") calls somewhere xgettext looks
    {
        const src = fs.readFileSync(path.join(__dirname, "../package/contents/ui/tts.js"), "utf8");
        for (const s of [KMSG, HINTED, GENERIC])
            ok(src.includes("i18n(\"" + s + "\")"), "tts.js has a literal i18n() for: " + s);
    }

    // Test Voice and the widget both go through speak()
    let got = null;
    Tts.speak({ config: kBlank, text: "Hello there.", runCommand: () => { throw new Error("must not run"); }, callback: (e, r) => { got = { e, r }; } });
    eq(got, { e: KMSG, r: null }, "speak(): kokoro with a blank URL says so");
    got = null;
    Tts.speak({ config: { ttsEnabled: true, ttsBackend: "openai_speech", ttsApiEndpoint: "" }, text: "Hello there.", runCommand: () => { throw new Error("must not run"); }, callback: (e, r) => { got = { e, r }; } });
    eq(got, { e: GENERIC, r: null }, "speak(): the endpoint backend keeps the generic message");
    let doneArgs = null;
    const q0 = Tts.createSpeechQueue({ config: kBlank, runCommand: () => { throw new Error("must not run"); }, onDone: (e, i) => { doneArgs = [e, i]; } });
    q0.push("Hello there.");
    eq(doneArgs, [KMSG, null], "speech queue: kokoro with a blank URL says so");

    // parseResult: only a failed connection (curl exit 7) is "unreachable"
    let pr = KokoroLocal.parseResult("", "", 7);
    ok(pr.err && pr.unreachable === true, "kokoro parseResult exit 7: unreachable");
    pr = KokoroLocal.parseResult("", "", "7");
    ok(pr.err && pr.unreachable === true, "kokoro parseResult exit \"7\" (string): unreachable");
    pr = KokoroLocal.parseResult("", "{\"message\":\"bad voice\"}", 1);
    ok(pr.err && pr.err.includes("bad voice") && !pr.unreachable, "kokoro parseResult HTTP error (exit 1): not unreachable");
    pr = KokoroLocal.parseResult("", "", 28);
    ok(pr.err && !pr.unreachable, "kokoro parseResult exit 28: not unreachable");
    pr = KokoroLocal.parseResult("TTS_READY", "", 0);
    ok(!pr.err && !pr.unreachable, "kokoro parseResult success");
    ok(!OpenaiSpeech.parseResult("", "", 7).unreachable, "the endpoint adapter never reports unreachable");

    // speak(): a failed connection hands the widget what it needs
    const kUp = { ttsEnabled: true, ttsBackend: "kokoro_local", ttsKokoroUrl: " http://127.0.0.1:8880/v1 ", ttsKokoroVoice: "af_heart" };
    const runs = (exitCode, stderr) => (cmd, cb) => cb(null, { stdout: "", stderr: stderr || "", exitCode });
    got = null;
    Tts.speak({ config: kUp, text: "Hello there.", runCommand: runs(7), callback: (e, r) => { got = { e, r }; } });
    eq(got, { e: "Kokoro isn't running at http://127.0.0.1:8880/v1.", r: { unreachable: true, backend: "kokoro_local", endpoint: "http://127.0.0.1:8880/v1" } },
        "speak(): connection failed: message and info");
    got = null;
    Tts.speak({ config: kUp, text: "Hello there.", runCommand: runs(1, "boom"), callback: (e, r) => { got = { e, r }; } });
    eq(got, { e: "Text-to-speech request failed: boom", r: null }, "speak(): an HTTP error keeps its message and has no info");
    got = null;
    Tts.speak({ config: Object.assign({}, kUp, { ttsBackend: "openai_speech", ttsApiEndpoint: "http://127.0.0.1:8880/v1", ttsModelName: "kokoro", ttsVoice: "af_heart" }),
        text: "Hello there.", runCommand: runs(7), callback: (e, r) => { got = { e, r }; } });
    eq(got, { e: "Text-to-speech request failed: Exit code 7", r: null }, "speak(): the endpoint backend's exit 7 is not Kokoro's message");
    got = null;
    let ran = 0;
    Tts.speak({ config: kUp, text: "Hello there.", runCommand: (cmd, cb) => { ran++; cb(null, { stdout: "TTS_READY", stderr: "", exitCode: 0 }); }, callback: (e, r) => { got = { e, r }; } });
    eq([ran, got.e, got.r], [2, null, { success: true }], "speak(): success runs synthesize then play, no info");

    // Speech queue: the first chunk's failed connection ends it with the info
    doneArgs = null;
    let started = 0;
    const q = Tts.createSpeechQueue({ config: kUp, runCommand: (cmd, cb) => { started++; cb(null, { stdout: "", stderr: "", exitCode: 7 }); }, onDone: (e, i) => { doneArgs = [e, i]; } });
    q.push("First sentence here.");
    q.push("Second sentence here.");
    q.finish();
    eq(doneArgs, ["Kokoro isn't running at http://127.0.0.1:8880/v1.", { unreachable: true, backend: "kokoro_local", endpoint: "http://127.0.0.1:8880/v1" }],
        "queue: connection failed: message and info");
    let doneCalls = 0;
    doneArgs = null;
    const q2 = Tts.createSpeechQueue({ config: kUp, runCommand: (cmd, cb) => cb(null, { stdout: "", stderr: "nope", exitCode: 1 }), onDone: (e, i) => { doneCalls++; doneArgs = [e, i]; } });
    q2.push("First sentence here.");
    q2.push("Second sentence here.");
    q2.finish();
    eq([doneCalls, doneArgs], [1, ["Text-to-speech request failed: nope", null]], "queue: an HTTP error ends it once, with no info");
    doneArgs = null;
    const q3 = Tts.createSpeechQueue({ config: kUp, runCommand: (cmd, cb) => cb(null, { stdout: "TTS_READY", stderr: "", exitCode: 0 }), onDone: (e, i) => { doneArgs = [e, i]; } });
    q3.push("First sentence here.");
    q3.finish();
    eq(doneArgs, [null, null], "queue: success ends with no error and no info");
}

if (failed) {
    console.error(failed + " failure(s)");
    process.exit(1);
}
console.log("tts: ok");
