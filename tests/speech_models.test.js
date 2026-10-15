// Speech model lists and prices: the TTS model fetch uses the endpoint's own
// list (built-ins only as a fallback), schemeless endpoints get a scheme, and
// OpenRouter's speech pricing turns into per-minute / per-character labels.
const fs = require('fs');
const path = require('path');
const { UI } = require('./paths');
const load = require('./qmlmodule').load;
const Utils = load('utils.js');
const U = load('usage.js');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));

console.log('\nwithScheme');
eq('local ip gets http', Utils.withScheme('127.0.0.1:8880/v1'), 'http://127.0.0.1:8880/v1');
eq('localhost gets http', Utils.withScheme('localhost:2022/v1'), 'http://localhost:2022/v1');
eq('remote gets https', Utils.withScheme('openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
eq('scheme kept', Utils.withScheme('http://openrouter.ai/api/v1'), 'http://openrouter.ai/api/v1');
eq('empty stays empty', Utils.withScheme(''), '');

console.log('\nspeechPriceLabel');
eq('stt per second → per minute', U.speechPriceLabel({ prompt: '0.0001', completion: '0' }, 'stt'), { label: '$0.006/min', free: false });
eq('tts per char → per 1M chars', U.speechPriceLabel({ prompt: '0.00000062', completion: '0' }, 'tts'), { label: '$0.62/1M chars', free: false });
eq('tts without completion', U.speechPriceLabel({ prompt: '0.00004' }, 'tts'), { label: '$40/1M chars', free: false });
eq('token-priced', U.speechPriceLabel({ prompt: '0.0000025', completion: '0.00001' }, 'stt'), { label: '$2.5 in · $10 out /1M tokens', free: false });
eq('free', U.speechPriceLabel({ prompt: '0', completion: '0' }, 'tts'), { label: '', free: true });
eq('no pricing', U.speechPriceLabel(null, 'tts'), null);

// openai_speech.js with a fake XHR answering per URL.
function loadSpeech(routes, seen) {
  let src = fs.readFileSync(path.join(UI, 'ttsAdapters/openai_speech.js'), 'utf8')
    .replace(/^\s*\.import\s+.*$/gm, '');
  function XHR() {}
  XHR.DONE = 4;
  XHR.prototype.open = function (m, u) { this.url = u; seen.push(u); };
  XHR.prototype.setRequestHeader = function () {};
  XHR.prototype.send = function () {
    const r = routes[this.url];
    this.readyState = 4;
    this.status = r ? 200 : 404;
    this.responseText = r ? JSON.stringify(r) : '';
    this.onreadystatechange();
  };
  return new Function('Utils', 'XMLHttpRequest', src + '\nreturn { fetchModels, buildCommand, defaultKnownModels };')(Utils, XHR);
}

console.log('\nTTS fetchModels');
{
  const seen = [];
  const S = loadSpeech({
    'http://127.0.0.1:8880/v1/models?output_modalities=speech': { data: [{ id: 'tts-1' }, { id: 'tts-1-hd' }, { id: 'kokoro' }] },
    'http://127.0.0.1:8880/v1/audio/voices': { voices: ['af_heart', 'am_adam'] }
  }, seen);
  let got;
  S.fetchModels('127.0.0.1:8880/v1', '', function () { got = Array.from(arguments); });
  eq('local list replaces built-ins', got[1], ['tts-1', 'tts-1-hd', 'kokoro']);
  eq('server-wide voices', got[2], { '*': ['af_heart', 'am_adam'] });
  eq('schemeless endpoint fetched over http', seen[0], 'http://127.0.0.1:8880/v1/models?output_modalities=speech');
}
{
  const S = loadSpeech({}, []);
  let got;
  S.fetchModels('http://10.0.0.9/v1', '', function () { got = Array.from(arguments); });
  eq('unreachable → built-in fallback', got[1], S.defaultKnownModels());
}
{
  const S = loadSpeech({
    'https://openrouter.ai/api/v1/models?output_modalities=speech': { data: [
      { id: 'hexgrad/kokoro-82m', architecture: { output_modalities: ['speech'] }, supported_voices: ['af_heart'], pricing: { prompt: '0.00000062', completion: '0' } },
      { id: 'some/chat-model', architecture: { output_modalities: ['text'] } }
    ] }
  }, []);
  let got;
  S.fetchModels('https://openrouter.ai/api/v1', '', function () { got = Array.from(arguments); });
  eq('openrouter speech models only', got[1], ['hexgrad/kokoro-82m']);
  eq('per-model voices', got[2], { 'hexgrad/kokoro-82m': ['af_heart'] });
  eq('prices passed through', got[3], { 'hexgrad/kokoro-82m': { prompt: '0.00000062', completion: '0' } });
}
{
  const S = loadSpeech({}, []);
  const cmd = String(S.buildCommand({ endpoint: '127.0.0.1:8880/v1', model: 'kokoro', text: 'hi', voice: 'af_heart', responseFormat: 'mp3' }));
  eq('buildCommand adds scheme', cmd.indexOf("'http://127.0.0.1:8880/v1/audio/speech'") >= 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
