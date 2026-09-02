// Drives adapters/opencode.js with stubbed strategies to verify wire-format
// routing, the one-shot fallback, and error attribution.
const fs = require('fs');
const { UI } = require('./paths');
const p = UI + '/adapters/opencode.js';
const src = fs.readFileSync(p, 'utf8').replace(/^\s*\.import .*$/gm, '');

// Scripted responses: model -> { openai: {status, body, ok}, anthropic: {...} }
let script = {};
let callLog = [];

function makeStrategy(kind) {
  return {
    sendStreaming(opts) {
      const r = (script[opts.model] || {})[kind] || { status: 503, body: 'Endpoint is unavailable.' };
      callLog.push({ kind, model: opts.model, endpoint: opts.endpoint, tools: opts.tools });
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
new Function('module', 'console', 'i18n', 'Chat', 'Anthropic', 'Responses',
  src + '\nmodule.exports={sendStreaming,formatFor,toAnthropicTools,toResponsesTools,'
      + 'convertMessagesForAnthropic,convertMessagesForResponses,explainError,learnedFormats};'
)(mod, { warn() {} }, i18n, makeStrategy('openai'), makeStrategy('anthropic'), makeStrategy('responses'));
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
const run = (model, tools) => new Promise(res => {
  callLog = [];
  OC.sendStreaming({ model, tools: tools || [], messages: [], onChunk() {}, onComplete: (t, e) => res({ text: t, error: e, log: callLog.slice() }) });
});

console.log('\nformatFor — measured routing');
eq('qwen3.7-plus -> anthropic (messages-only)', OC.formatFor('qwen3.7-plus'), 'anthropic');
eq('qwen3.8-max -> anthropic', OC.formatFor('qwen3.8-max'), 'anthropic');
eq('future qwen3.9-plus -> anthropic (family rule)', OC.formatFor('qwen3.9-plus'), 'anthropic');
eq('glm-5.3 -> openai', OC.formatFor('glm-5.3'), 'openai');
eq('minimax-m3 -> openai', OC.formatFor('minimax-m3'), 'openai');
eq('gpt-5.6-luna -> responses (docs; avoids the chat shim)', OC.formatFor('gpt-5.6-luna'), 'responses');
eq('grok-4.5 -> responses (unreachable on the other two)', OC.formatFor('grok-4.5'), 'responses');

console.log('\ntoResponsesTools — flat schema, no function wrapper');
eq('nested openai tool -> flat responses tool', OC.toResponsesTools([
  { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]), [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]);
eq('malformed tool skipped', OC.toResponsesTools([{ type: 'function' }]), []);

console.log('\nconvertMessagesForResponses — chat parts -> responses parts');
eq('text -> input_text, image_url -> input_image (bare url)', OC.convertMessagesForResponses([
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
]), [{ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }]);
eq('tool result text converted too (translateMessages reads input_text)', OC.convertMessagesForResponses([
  { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'out' }] },
]), [{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'input_text', text: 'out' }] }]);
eq('string content untouched', OC.convertMessagesForResponses([{ role: 'user', content: 'plain' }]),
   [{ role: 'user', content: 'plain' }]);

console.log('\ntoAnthropicTools — schema shape conversion');
eq('openai tool -> anthropic tool', OC.toAnthropicTools([
  { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]), [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
eq('malformed tool skipped', OC.toAnthropicTools([{ type: 'function' }]), []);

console.log('\nconvertMessagesForAnthropic — attachments survive the /messages route');
eq('image_url data URL -> anthropic image block', OC.convertMessagesForAnthropic([
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
]), [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]);
eq('remote image URL dropped, not sent as-is', OC.convertMessagesForAnthropic([
  { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
]), [{ role: 'user', content: [] }]);
eq('string content untouched', OC.convertMessagesForAnthropic([{ role: 'user', content: 'plain' }]),
   [{ role: 'user', content: 'plain' }]);
eq('tool_call_id preserved through conversion', OC.convertMessagesForAnthropic([
  { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'out' }] },
])[0].tool_call_id, 'c1');

(async () => {
  console.log('\nrouting — no wasted round trips');
  script = { 'qwen3.7-plus': { anthropic: { status: 200 } }, 'glm-5.3': { openai: { status: 200 } } };
  let r = await run('qwen3.7-plus');
  eq('qwen goes straight to messages, no chat attempt', r.log.map(c => c.kind), ['anthropic']);
  eq('qwen uses the parent base path', r.log[0].endpoint, 'https://opencode.ai/zen/go');
  eq('qwen succeeds', r.error, null);

  r = await run('glm-5.3');
  eq('glm goes straight to chat', r.log.map(c => c.kind), ['openai']);
  eq('glm uses the /v1 base', r.log[0].endpoint, 'https://opencode.ai/zen/go/v1');

  console.log('\nfallback — unknown model that turns out to be messages-only');
  script = { 'newmodel-x': { openai: { status: 503, body: 'Endpoint is unavailable.' }, anthropic: { status: 200 } } };
  r = await run('newmodel-x');
  eq('falls back to messages after 503', r.log.map(c => c.kind), ['openai', 'anthropic']);
  eq('fallback succeeds', r.error, null);
  eq('learned for the session', OC.learnedFormats['newmodel-x'], 'anthropic');
  r = await run('newmodel-x');
  eq('second call skips the failed format', r.log.map(c => c.kind), ['anthropic']);

  console.log('\nrouting — the /responses models');
  script = { 'grok-4.5': { responses: { status: 200 } }, 'gpt-5.6-luna': { responses: { status: 200 } } };
  r = await run('grok-4.5');
  eq('grok goes straight to responses, no wasted attempts', r.log.map(c => c.kind), ['responses']);
  eq('responses uses the /v1 base (strategy appends /responses)', r.log[0].endpoint, 'https://opencode.ai/zen/go/v1');
  eq('grok succeeds', r.error, null);
  r = await run('gpt-5.6-luna');
  eq('luna routed to responses, bypassing the chat shim', r.log.map(c => c.kind), ['responses']);

  console.log('\nrouting — tools are converted per format, not sent raw');
  const NESTED = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }];
  r = await run('grok-4.5', NESTED);
  eq('responses route gets flat tools', r.log[0].tools, [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }]);
  script = { 'qwen3.7-plus': { anthropic: { status: 200 } }, 'glm-5.3': { openai: { status: 200 } } };
  r = await run('qwen3.7-plus', NESTED);
  eq('anthropic route gets input_schema tools', r.log[0].tools, [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }]);
  r = await run('glm-5.3', NESTED);
  eq('chat route gets the nested tools unchanged', r.log[0].tools, NESTED);

  console.log('\nerror attribution');
  script = { 'ghost-model': {
    openai: { status: 503, body: 'Endpoint is unavailable.' },
    anthropic: { status: 404, body: 'not found' },
    responses: { status: 401, body: 'unauthorized' },
  } };
  r = await run('ghost-model');
  eq('walks all three formats before giving up', r.log.map(c => c.kind), ['openai', 'anthropic', 'responses']);
  like('does NOT blame the API key', r.error, 'any supported wire format');
  like('names every attempt', r.error, 'anthropic: HTTP 404');
  eq('no misleading key advice', /api key/i.test(r.error), false);

  script = { 'deepseek-v4-pro': { openai: { status: 403, body: '{"error":{"type":"RegionError","message":"only available hosted in China and requires explicit opt-in"}}' } } };
  r = await run('deepseek-v4-pro');
  eq('403 RegionError does not trigger a pointless retry', r.log.map(c => c.kind), ['openai']);
  like('explains the region opt-in', r.error, 'China-hosted region');

  script = { 'mimo-v2-pro': { openai: { status: 400, body: '[404] This model has been deprecated. It is recommended...' } } };
  r = await run('mimo-v2-pro');
  like('deprecated model explained', r.error, 'retired this model');

  script = { 'hy3-preview': { openai: { status: 400, body: 'Model is unavailable.' } } };
  r = await run('hy3-preview');
  like('unavailable model explained', r.error, 'no backend for this model');

  script = { 'somemodel': { openai: { status: 401, body: 'nope' } } };
  r = await run('somemodel');
  like('genuine 401 still points at the key', r.error, 'rejected the API key');

  // Captured verbatim: POST /responses with model=minimax-m3 answers HTTP 401,
  // which is a format mismatch, not an auth failure.
  console.log('\ncaptured — 401 that is a format mismatch, not a bad key');
  const MODEL_ERR = '{"type":"error","error":{"type":"ModelError","message":"Model minimax-m3 is not supported for format openai"}}';
  script = { 'minimax-m3': { openai: { status: 200 } } };
  eq('401 ModelError is recognised as a wrong-endpoint signal',
     OC.explainError(401, MODEL_ERR, 'x').includes('not a problem with your API key'), true);

  script = { 'oddball': { responses: { status: 401, body: MODEL_ERR }, openai: { status: 200 } } };
  OC.learnedFormats['oddball'] = 'responses';   // pretend it was routed there
  r = await run('oddball');
  eq('a 401 ModelError still triggers the retry', r.log.map(c => c.kind), ['responses', 'openai']);
  eq('and the retry succeeds', r.error, null);

  console.log('\nsafety — never retry after partial output');
  script = { 'partial-x': { openai: { status: 503, body: 'Endpoint is unavailable.', partial: 'half a sentence' }, anthropic: { status: 200 } } };
  r = await run('partial-x');
  eq('no retry once text was emitted', r.log.map(c => c.kind), ['openai']);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
