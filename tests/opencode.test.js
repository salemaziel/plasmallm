// Drives adapters/opencode.js with stubbed strategies to verify wire-format
// routing, the bounded retry, and error attribution.
//
// Protocol selection itself lives in opencodeRoute.js and is covered by
// opencode_route.mjs; that real module is loaded here so these tests exercise
// the adapter's actual routing rather than a copy of the rules.
const fs = require('fs');
const { UI } = require('./paths');
const strip = s => s.replace(/^\s*\.import .*$/gm, '');

// The real routing module — pure, no QML or network.
const routeMod = {};
new Function('module',
  fs.readFileSync(UI + '/opencodeRoute.js', 'utf8')
  + '\nmodule.exports={productFromEndpoint,npmToProtocol,resolveProtocol};'
)(routeMod);
const Route = routeMod.exports;

const ZEN = 'https://opencode.ai/zen/v1';
const GO = 'https://opencode.ai/zen/go/v1';

// Scripted responses: model -> { chat: {status, body, ok}, anthropic: {...} }
let script = {};
let callLog = [];

function makeStrategy(kind) {
  return {
    sendStreaming(opts) {
      const r = (script[opts.model] || {})[kind] || { status: 503, body: 'Endpoint is unavailable.' };
      callLog.push({ kind, model: opts.model, endpoint: opts.endpoint, tools: opts.tools, opencodeAuth: opts.opencodeAuth });
      const xhr = { status: r.status, responseText: r.body || '' };
      // Strategies invoke onComplete synchronously here; real ones do it from
      // the xhr callback, which is equivalent for this logic.
      setTimeout(() => {
        if (r.status === 200) opts.onComplete(r.text ?? 'hello', null, r.toolCalls || null, {});
        else opts.onComplete(r.partial || '', `API error ${r.status}`, null, null);
      }, 0);
      return { xhr, processBuffer() {}, setPollTimer() {} };
    },
    buildTools: o => [],
    buildContentArray: (t) => t,
    fetchModels: () => {},
  };
}

// Mirrors KDE's i18n(): "%1"-style positional substitution.
const i18n = (s, ...a) => a.reduce((acc, v, i) => acc.split(`%${i + 1}`).join(String(v)), s);

const mod = {};
new Function('module', 'console', 'i18n', 'Chat', 'Anthropic', 'Responses', 'Gemini', 'Route',
  strip(fs.readFileSync(UI + '/adapters/opencode.js', 'utf8'))
  + '\nmodule.exports={sendStreaming,protocolFor,fetchModels,toAnthropicTools,toResponsesTools,'
  + 'convertMessagesForAnthropic,convertMessagesForResponses,explainError,learnedFormats,presets};'
)(mod, { warn() {} }, i18n,
  makeStrategy('chat'), makeStrategy('anthropic'), makeStrategy('responses'), makeStrategy('gemini'),
  Route);
const OC = mod.exports;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}
function like(label, got, needle) {
  const ok = String(got).toLowerCase().includes(needle.toLowerCase());
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label}\n         got "${got}"\n         want substring "${needle}"`));
}
const run = (model, tools, endpoint) => new Promise(res => {
  callLog = [];
  OC.sendStreaming({
    model, tools: tools || [], messages: [], endpoint: endpoint || GO,
    onChunk() {}, onComplete: (t, e) => res({ text: t, error: e, log: callLog.slice() })
  });
});

console.log('\nprotocolFor — routing through the real opencodeRoute rules');
eq('qwen3.7-plus -> anthropic (messages-only)', OC.protocolFor({ endpoint: GO }, 'qwen3.7-plus'), 'anthropic');
eq('future qwen3.9-plus -> anthropic (family rule)', OC.protocolFor({ endpoint: GO }, 'qwen3.9-plus'), 'anthropic');
eq('glm-5.3 -> chat (defaulted)', OC.protocolFor({ endpoint: GO }, 'glm-5.3'), 'chat');
eq('gpt-5.6-luna -> responses (avoids the lossy chat shim)', OC.protocolFor({ endpoint: GO }, 'gpt-5.6-luna'), 'responses');
eq('grok-4.5 -> responses', OC.protocolFor({ endpoint: GO }, 'grok-4.5'), 'responses');
eq('claude-sonnet-5 -> anthropic', OC.protocolFor({ endpoint: ZEN }, 'claude-sonnet-5'), 'anthropic');
eq('gemini-3-pro -> gemini', OC.protocolFor({ endpoint: ZEN }, 'gemini-3-pro'), 'gemini');

console.log('\nproduct — Zen and Go are both served, and they differ');
eq('two presets, Zen and Go', OC.presets.map(p => p.name), ['OpenCode Zen', 'OpenCode Go']);
eq('minimax-m3 on Go -> anthropic', OC.protocolFor({ endpoint: GO }, 'minimax-m3'), 'anthropic');
eq('minimax-m3 on Zen -> chat (Go-only rule)', OC.protocolFor({ endpoint: ZEN }, 'minimax-m3'), 'chat');

console.log('\ntoResponsesTools — flat schema, no function wrapper');
eq('nested openai tool -> flat responses tool', OC.toResponsesTools([
  { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }
]), [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }]);
eq('malformed tool skipped', OC.toResponsesTools([{ type: 'function' }]), []);

console.log('\nconvertMessagesForResponses — chat parts -> responses parts');
eq('text -> input_text, image_url -> input_image (bare url)', OC.convertMessagesForResponses([
  { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }
]), [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] }]);
eq('string content untouched', OC.convertMessagesForResponses([{ role: 'user', content: 'plain' }]),
   [{ role: 'user', content: 'plain' }]);

console.log('\ntoAnthropicTools — schema shape conversion');
eq('openai tool -> anthropic tool', OC.toAnthropicTools([
  { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }
]), [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }]);
eq('malformed tool skipped', OC.toAnthropicTools([{ type: 'function' }]), []);

console.log('\nconvertMessagesForAnthropic — attachments survive the /messages route');
eq('image_url data URL -> anthropic image block', OC.convertMessagesForAnthropic([
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }
]), [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }]);
eq('remote image URL dropped, not sent as-is', OC.convertMessagesForAnthropic([
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }
]), [{ role: 'user', content: [] }]);
eq('tool_call_id preserved through conversion', OC.convertMessagesForAnthropic([
  { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'out' }] }
])[0].tool_call_id, 'c1');

(async () => {
  console.log('\nrouting — no wasted round trips, and auth is flagged for the gateway');
  script = { 'qwen3.7-plus': { anthropic: { status: 200 } }, 'glm-5.3': { chat: { status: 200 } } };
  let r = await run('qwen3.7-plus');
  eq('qwen goes straight to messages, no chat attempt', r.log.map(c => c.kind), ['anthropic']);
  eq('qwen succeeds', r.error, null);
  eq('opencodeAuth set so the strategy rewrites URL/headers', r.log[0].opencodeAuth, true);
  eq('endpoint passed through untouched (no manual base juggling)', r.log[0].endpoint, GO);

  r = await run('glm-5.3');
  eq('glm goes straight to chat', r.log.map(c => c.kind), ['chat']);

  console.log('\nretry — bounded to models whose route DEFAULTED to chat');
  script = { 'newmodel-x': { chat: { status: 503, body: 'Endpoint is unavailable.' }, anthropic: { status: 200 } } };
  r = await run('newmodel-x');
  eq('falls back to messages after 503', r.log.map(c => c.kind), ['chat', 'anthropic']);
  eq('fallback succeeds', r.error, null);
  eq('learned for the session', OC.learnedFormats['newmodel-x'], 'anthropic');
  r = await run('newmodel-x');
  eq('second call skips the failed format', r.log.map(c => c.kind), ['anthropic']);

  // A prefix-matched route is deliberate and its payload was built in that
  // protocol's shape, so retrying would post a mis-shaped body. Must not retry.
  script = { 'grok-4.5': { responses: { status: 503, body: 'Endpoint is unavailable.' }, chat: { status: 200 } } };
  r = await run('grok-4.5');
  eq('a prefix-matched model never retries into another shape', r.log.map(c => c.kind), ['responses']);
  eq('no learned entry for a non-retryable route', OC.learnedFormats['grok-4.5'], undefined);

  script = { 'gemini-3-pro': { gemini: { status: 503, body: 'Endpoint is unavailable.' }, chat: { status: 200 } } };
  r = await run('gemini-3-pro', [], ZEN);
  eq('gemini is reachable and likewise never retries', r.log.map(c => c.kind), ['gemini']);

  console.log('\nconversion happens on the retry path, where the shape is wrong');
  const NESTED = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }];
  script = { 'shapeshift-a': { chat: { status: 503, body: 'Endpoint is unavailable.' }, anthropic: { status: 200 } } };
  r = await run('shapeshift-a', NESTED);
  eq('chat attempt sends the nested tools as built', r.log[0].tools, NESTED);
  eq('anthropic retry converts them to input_schema', r.log[1].tools,
     [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }]);

  script = { 'shapeshift-b': {
    chat: { status: 503, body: 'Endpoint is unavailable.' },
    anthropic: { status: 404, body: 'not found' },
    responses: { status: 200 },
  } };
  r = await run('shapeshift-b', NESTED);
  eq('walks chat -> anthropic -> responses', r.log.map(c => c.kind), ['chat', 'anthropic', 'responses']);
  eq('responses retry gets flat tools', r.log[2].tools,
     [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }]);

  console.log('\nerror attribution');
  script = { 'ghost-model': {
    chat: { status: 503, body: 'Endpoint is unavailable.' },
    anthropic: { status: 404, body: 'not found' },
    responses: { status: 401, body: 'unauthorized' },
  } };
  r = await run('ghost-model');
  eq('walks all three formats before giving up', r.log.map(c => c.kind), ['chat', 'anthropic', 'responses']);
  like('does NOT blame the API key', r.error, 'any supported wire format');
  like('names every attempt', r.error, 'anthropic: HTTP 404');
  eq('no misleading key advice', /api key/i.test(r.error), false);

  script = { 'deepseek-v4-pro': { chat: { status: 403, body: '{"error":{"type":"RegionError","message":"only available hosted in China and requires explicit opt-in"}}' } } };
  r = await run('deepseek-v4-pro');
  eq('403 RegionError does not trigger a pointless retry', r.log.map(c => c.kind), ['chat']);
  like('explains the region opt-in', r.error, 'China-hosted region');

  script = { 'mimo-v2-pro': { chat: { status: 400, body: '[404] This model has been deprecated. It is recommended...' } } };
  r = await run('mimo-v2-pro');
  like('deprecated model explained', r.error, 'retired this model');

  script = { 'hy3-preview': { chat: { status: 400, body: 'Model is unavailable.' } } };
  r = await run('hy3-preview');
  like('unavailable model explained', r.error, 'no backend for this model');

  script = { 'somemodel': { chat: { status: 401, body: 'nope' } } };
  r = await run('somemodel');
  like('genuine 401 still points at the key', r.error, 'rejected the API key');

  // Captured verbatim: POST /responses with model=minimax-m3 answers HTTP 401,
  // which is a format mismatch, not an auth failure.
  console.log('\ncaptured — 401 that is a format mismatch, not a bad key');
  const MODEL_ERR = '{"type":"error","error":{"type":"ModelError","message":"Model minimax-m3 is not supported for format openai"}}';
  eq('401 ModelError is recognised as a wrong-endpoint signal',
     OC.explainError(401, MODEL_ERR, 'x').includes('not a problem with your API key'), true);

  script = { 'oddball': { responses: { status: 401, body: MODEL_ERR }, chat: { status: 200 } } };
  OC.learnedFormats['oddball'] = 'responses';   // pretend a prior turn landed there
  r = await run('oddball');
  eq('a 401 ModelError still triggers the retry', r.log.map(c => c.kind), ['responses', 'chat']);
  eq('and the retry succeeds', r.error, null);

  console.log('\nsafety — never retry after partial output');
  script = { 'partial-x': { chat: { status: 503, body: 'Endpoint is unavailable.', partial: 'half a sentence' }, anthropic: { status: 200 } } };
  r = await run('partial-x');
  eq('no retry once text was emitted', r.log.map(c => c.kind), ['chat']);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
