#!/usr/bin/env node
// openai_transcriptions STT adapter: JSON body for OpenRouter, multipart
// upload for every other host (Groq, OpenAI, local whisper servers).
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const Utils = (() => {
    let code = fs.readFileSync(path.join(__dirname, "../package/contents/ui/utils.js"), "utf8");
    code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
    const sb = { console, i18n: (s) => s };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    return sb;
})();

const sent = [];
function FakeXHR() {
    this.headers = {};
    this.open = (m, u) => { this.method = m; this.url = u; };
    this.setRequestHeader = (k, v) => { this.headers[k] = v; };
    this.send = (body) => {
        this.body = body;
        sent.push(this);
        this.readyState = 4; this.status = 200; this.responseText = '{"text":"hello"}';
        this.onreadystatechange();
    };
}
FakeXHR.DONE = 4;

let code = fs.readFileSync(path.join(__dirname, "../package/contents/ui/sttAdapters/openai_transcriptions.js"), "utf8");
code = code.replace(/^\s*\.(import|pragma)\s+.*$/gm, "");
const sandbox = { console, Utils, XMLHttpRequest: FakeXHR, i18n: (s) => s, Uint8Array, Date, Math };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const A = sandbox;

let failed = 0;
function ok(cond, msg) {
    if (!cond) { failed++; console.error("FAIL:", msg); } else console.log("ok -", msg);
}

// base64 decode matches Node's
const raw = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 0xff));
for (const n of [0, 1, 2, 3, 999, 1000]) {
    const b = raw.subarray(0, n);
    ok(Buffer.from(A.base64ToBytes(b.toString("base64"))).equals(b), "base64ToBytes length " + n);
}

ok(A.usesJsonBody("https://openrouter.ai/api/v1"), "openrouter uses JSON body");
ok(!A.usesJsonBody("https://api.groq.com/openai/v1"), "groq uses multipart");
ok(!A.usesJsonBody("http://localhost:8000/v1"), "local server uses multipart");

// Multipart body shape
const mp = A.buildMultipartBody({ model: "whisper-large-v3-turbo", language: "", response_format: "json" },
    new Uint8Array([0, 255, 13, 10]), "wav", "BND");
const text = Buffer.from(mp.body).toString("latin1");
ok(mp.contentType === "multipart/form-data; boundary=BND", "content type carries boundary");
ok(text.indexOf('name="model"\r\n\r\nwhisper-large-v3-turbo\r\n') >= 0, "model field present");
ok(text.indexOf('name="language"') < 0, "empty language left out");
ok(text.indexOf('filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n\u0000ÿ\r\n\r\n--BND--\r\n') >= 0,
    "file part carries raw bytes and closing boundary");

// Groq request goes out as multipart with the audio bytes
let result = null;
A.transcribe({ endpoint: "https://api.groq.com/openai/v1/", apiKey: "k", model: "whisper-large-v3-turbo",
    audioBase64: raw.toString("base64"), format: "wav", language: "en",
    callback: (e, r) => { result = [e, r && r.text]; } });
let x = sent[sent.length - 1];
ok(x.url === "https://api.groq.com/openai/v1/audio/transcriptions", "groq url");
ok(/^multipart\/form-data; boundary=/.test(x.headers["Content-Type"]), "groq content type multipart");
ok(x.body instanceof ArrayBuffer || (x.body && x.body.byteLength !== undefined), "groq body is binary");
const groqBody = Buffer.from(new Uint8Array(x.body));
ok(groqBody.indexOf(raw) > 0, "groq body contains the exact audio bytes");
ok(groqBody.toString("latin1").indexOf('name="language"\r\n\r\nen\r\n') >= 0, "language sent");
ok(result && result[0] === null && result[1] === "hello", "response text parsed");

// OpenRouter keeps the JSON body
A.transcribe({ endpoint: "https://openrouter.ai/api/v1", apiKey: "k", model: "openai/whisper-1",
    audioBase64: "AAAA", format: "wav", callback: () => {} });
x = sent[sent.length - 1];
ok(x.headers["Content-Type"] === "application/json", "openrouter content type json");
ok(JSON.parse(x.body).input_audio.data === "AAAA", "openrouter body is JSON input_audio");

if (failed) { console.error(failed + " failure(s)"); process.exit(1); }
console.log("stt_upload: all passed");
