// Token usage and cost (usage.js), plus the adapters that feed it. The
// normalizers are checked against each provider's real wire shape, then the
// adapters are driven through a fake XHR to prove the usage they report is
// the one the stream carried: last-one-wins for Gemini's repeating totals,
// message_start + message_delta merged for Anthropic, include_usage only
// where asked.
const fs = require('fs');
const { UI_SLASH: base } = require('./paths');
const U = require('./qmlmodule').load('usage.js');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));
const near = (l, g, w) => (typeof g === 'number' && Math.abs(g - w) < 1e-12)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${g}\n         want ${w}`));
const pick = u => u && [u.inputTokens, u.outputTokens, u.reasoningTokens, u.cachedInputTokens, u.cacheWriteTokens, u.cost, u.costSource];

console.log('\nnormalizers');
eq('openai chat, cached + reasoning',
  pick(U.fromOpenAIChat({ prompt_tokens: 1200, completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 120 } })),
  [1200, 300, 120, 1000, 0, null, '']);
eq('openrouter cost is reported',
  pick(U.fromOpenAIChat({ prompt_tokens: 10, completion_tokens: 5, cost: 0.00042,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 } })),
  [10, 5, 0, 0, 4, 0.00042, 'reported']);
eq('deepseek cache hits', U.fromOpenAIChat({ prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 40 }).cachedInputTokens, 40);
eq('responses api',
  pick(U.fromResponses({ input_tokens: 900, output_tokens: 400,
    input_tokens_details: { cached_tokens: 512 }, output_tokens_details: { reasoning_tokens: 256 } })),
  [900, 400, 256, 512, 0, null, '']);
eq('anthropic folds cache counts into input',
  pick(U.fromAnthropic({ input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, output_tokens: 77 })),
  [1320, 77, 0, 1000, 300, null, '']);
eq('gemini adds thoughts to output',
  pick(U.fromGemini({ promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 250, cachedContentTokenCount: 600 })),
  [800, 350, 250, 600, 0, null, '']);
eq('gemini tool-use prompt counts as input', U.fromGemini({ promptTokenCount: 10, toolUsePromptTokenCount: 5, candidatesTokenCount: 1 }).inputTokens, 15);
eq('interactions',
  pick(U.fromInteractions({ total_input_tokens: 100, total_output_tokens: 40, total_thought_tokens: 60,
    total_cached_tokens: 30, total_tool_use_tokens: 7, total_tokens: 207 })),
  [107, 100, 60, 30, 0, null, '']);
eq('empty report -> null', U.fromOpenAIChat({ prompt_tokens: 0, completion_tokens: 0 }), null);
eq('missing report -> null', U.fromGemini(undefined), null);
eq('garbage numbers ignored', pick(U.fromOpenAIChat({ prompt_tokens: 'x', completion_tokens: -3, cost: 'free' })), null);

console.log('\naddUsage / totalOf');
const a = U.makeUsage({ inputTokens: 100, outputTokens: 10, cost: 0.01 });
const b = U.makeUsage({ inputTokens: 50, outputTokens: 5 });
const s = U.addUsage(a, b);
eq('tokens summed', [s.inputTokens, s.outputTokens, s.requests], [150, 15, 2]);
near('known cost kept', s.cost, 0.01);
eq('unpriced part flags a lower bound', s.costIncomplete, true);
eq('null + x = copy of x', U.addUsage(null, a).inputTokens, 100);
eq('addUsage does not mutate', a.requests, 1);
const est = Object.assign(U.makeUsage({ inputTokens: 1, outputTokens: 1 }), { cost: 0.5, costSource: 'estimated' });
eq('any estimate marks the sum estimated', U.addUsage(a, est).costSource, 'estimated');
eq('both unpriced -> cost null', U.addUsage(b, b).cost, null);
const t = U.totalOf(['', 'not json', JSON.stringify(a), undefined, JSON.stringify(a)]);
eq('totalOf skips old/garbage rows', [t.inputTokens, t.requests], [200, 2]);
near('totalOf cost', t.cost, 0.02);
eq('totalOf of nothing', U.totalOf([]), null);

console.log('\npricing — provider mapping');
const DATA = {
  openai: { models: { 'gpt-x': { cost: { input: 2, output: 8, cache_read: 0.5 } } } },
  anthropic: { models: { 'claude-y': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  google: { models: { 'gemini-z': { cost: { input: 1, output: 10,
    tiers: [{ input: 2, output: 20, tier: { type: 'context', size: 200000 } }] } } } },
  'google-vertex': { models: { 'gemini-z': { cost: { input: 1.1, output: 11 } } } },
  openrouter: { api: 'https://openrouter.ai/api/v1', models: { 'openai/gpt-x': { cost: { input: 2, output: 8 } } } },
  opencode: { api: 'https://opencode.ai/zen/v1', models: { 'm1': { cost: { input: 0, output: 0 } } } },
  'opencode-go': { api: 'https://opencode.ai/zen/go/v1', models: { 'm1': { cost: { input: 0.4, output: 0.8 } } } },
  deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-chat': { cost: { input: 0.27, output: 1.1 } } } },
  nocost: { models: { 'n': {} } },
  // A real models.dev entry whose api URL is a localhost default.
  privatemode: { api: 'http://localhost:8080/v1', models: { 'm': { cost: { input: 1, output: 1 } } } },
};
eq('openai host', U.pricingProviders({ apiType: 'openai', endpoint: 'https://api.openai.com/v1' }, DATA), ['openai']);
eq('anthropic host', U.pricingProviders({ apiType: 'anthropic', endpoint: 'https://api.anthropic.com' }, DATA), ['anthropic']);
eq('gemini ai studio', U.pricingProviders({ apiType: 'gemini', geminiAuthMethod: 'aistudio' }, DATA), ['google']);
eq('gemini vertex', U.pricingProviders({ apiType: 'gemini_interactions', geminiAuthMethod: 'agentplatform' }, DATA), ['google-vertex']);
eq('openrouter by api url', U.pricingProviders({ apiType: 'openai', endpoint: 'https://openrouter.ai/api/v1/' }, DATA), ['openrouter']);
eq('openrouter even before data loads', U.pricingProviders({ apiType: 'openai', endpoint: 'https://openrouter.ai/api/v1' }, null), ['openrouter']);
eq('opencode go beats zen (longest prefix)', U.pricingProviders({ apiType: 'opencode', endpoint: 'https://opencode.ai/zen/go/v1' }, DATA), ['opencode-go']);
eq('opencode zen', U.pricingProviders({ apiType: 'opencode', endpoint: 'https://opencode.ai/zen/v1' }, DATA), ['opencode']);
eq('deepseek with /v1 suffix', U.pricingProviders({ apiType: 'openai', endpoint: 'https://api.deepseek.com/v1' }, DATA), ['deepseek']);
eq('local endpoint: nothing guessed', U.pricingProviders({ apiType: 'openai', endpoint: 'http://localhost:11434/v1' }, DATA), []);
eq('local endpoint never matches a localhost api url', U.pricingProviders({ apiType: 'openai', endpoint: 'http://localhost:8080/v1' }, DATA), []);
eq('LAN endpoint', U.pricingProviders({ apiType: 'openai', endpoint: 'http://192.168.1.20:8000/v1' }, DATA), []);
eq('custom proxy: nothing guessed', U.pricingProviders({ apiType: 'openai', endpoint: 'https://llm.example.com/v1' }, DATA), []);
eq('regional vertex host', U.pricingProviders({ apiType: 'openai', endpoint: 'https://us-central1-aiplatform.googleapis.com/v1' }, DATA), ['google-vertex']);

console.log('\npricing — lookup and estimate');
eq('exact id', U.findModelCost(DATA, ['openai'], 'gpt-x').input, 2);
eq('gemini models/ prefix stripped', U.findModelCost(DATA, ['google'], 'models/gemini-z').output, 10);
eq('case-insensitive fallback', U.findModelCost(DATA, ['openai'], 'GPT-X').input, 2);
eq('unknown model', U.findModelCost(DATA, ['openai'], 'nope'), null);
eq('entry without cost', U.findModelCost(DATA, ['nocost'], 'n'), null);
eq('no provider ids', U.findModelCost(DATA, [], 'gpt-x'), null);
// 1000 input (800 cached) + 500 output at 2/0.5/8 per 1M.
near('cache reads at cache_read rate',
  U.estimateCost({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, DATA.openai.models['gpt-x'].cost),
  (200 * 2 + 800 * 0.5 + 500 * 8) / 1e6);
near('anthropic cache writes at cache_write rate',
  U.estimateCost(U.fromAnthropic({ input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }),
    DATA.anthropic.models['claude-y'].cost),
  (100 * 3 + 1000 * 0.3 + 200 * 3.75 + 50 * 15) / 1e6);
near('no cache_read rate -> input rate',
  U.estimateCost({ inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 }, DATA.google.models['gemini-z'].cost), 1000 / 1e6);
near('long-context tier applies past its size',
  U.estimateCost({ inputTokens: 250000, outputTokens: 1000 }, DATA.google.models['gemini-z'].cost),
  (250000 * 2 + 1000 * 20) / 1e6);
near('below the tier: base rate',
  U.estimateCost({ inputTokens: 1000, outputTokens: 1000 }, DATA.google.models['gemini-z'].cost), (1000 + 10000) / 1e6);
const p = U.priceUsage(U.makeUsage({ inputTokens: 1e6, outputTokens: 0 }), DATA, ['openai'], 'gpt-x');
eq('estimate marked', [p.cost, p.costSource], [2, 'estimated']);
const r = U.priceUsage(U.fromOpenAIChat({ prompt_tokens: 1e6, completion_tokens: 0, cost: 0.1 }), DATA, ['openrouter'], 'openai/gpt-x');
eq('reported cost never replaced', [r.cost, r.costSource], [0.1, 'reported']);
const nop = U.priceUsage(U.makeUsage({ inputTokens: 5, outputTokens: 5 }), DATA, [], 'gpt-x');
eq('no price -> tokens only', [nop.cost, nop.costSource], [null, '']);
eq('no data -> tokens only', U.priceUsage(U.makeUsage({ inputTokens: 5, outputTokens: 5 }), null, ['openai'], 'gpt-x').cost, null);

console.log('\nformatting');
eq('tokens', [0, 999, 1234, 12345, 1234567, 2000000].map(U.formatTokens), ['0', '999', '1.2k', '12k', '1.23M', '2M']);
eq('reported cost', U.formatCost({ cost: 0.01234, costSource: 'reported' }), '$0.0123');
eq('estimated cost', U.formatCost({ cost: 1.5, costSource: 'estimated' }), '~$1.50');
eq('tiny cost', U.formatCost({ cost: 0.00001, costSource: 'estimated' }), '~<$0.0001');
eq('unknown cost', U.formatCost({ cost: null }), '');
eq('rates', [0.15, 2, 0.075, 0, 15].map(U.formatRate), ['$0.15', '$2', '$0.075', '$0', '$15']);
const labels = U.priceLabels(DATA, { apiType: 'opencode', endpoint: 'https://opencode.ai/zen/v1' }, ['m1', 'unknown']);
eq('picker labels: free model', labels, { m1: { input: '$0', output: '$0', free: true } });
eq('picker labels: no data', U.priceLabels(null, {}, ['x']), {});

console.log('\nstream_options allowlist');
eq('openai yes', U.acceptsStreamOptions('https://api.openai.com/v1'), true);
eq('openrouter yes', U.acceptsStreamOptions('https://openrouter.ai/api/v1'), true);
eq('local no', U.acceptsStreamOptions('http://localhost:11434/v1'), false);
eq('custom no', U.acceptsStreamOptions('https://my-proxy.example/v1'), false);
eq('gemini openai-compat no (undocumented; sends usage unasked)', U.acceptsStreamOptions('https://generativelanguage.googleapis.com/v1beta/openai'), false);
eq('mistral no (strict validation)', U.acceptsStreamOptions('https://api.mistral.ai/v1'), false);

// --- adapters, through a fake XHR ------------------------------------------

let instances = [];
function FakeXHR() {
  this.readyState = 0; this.status = 0; this.responseText = '';
  this.open = () => {}; this.setRequestHeader = () => {}; this.abort = () => {};
  this.send = (body) => { this.body = body; };
  instances.push(this);
}
FakeXHR.DONE = 4;
const i18n = (str, ...args) => args.reduce((acc, v, i) => acc.replace('%' + (i + 1), v), str);
const quiet = { warn() {}, error() {}, log() {} };
const Normalizer = { normalizeToolCalls: c => ({ calls: c, notes: [] }), logNotes() {} };
const UtilsStub = { isOpenRouterProvider: () => false, applyOpenRouterAttribution() {}, uuidv4: () => 'u' };

function loadAdapter(file, names, vals) {
  const src = fs.readFileSync(base + file, 'utf8')
    .replace(/^\s*\.pragma library\s*$/gm, '')
    .replace(/^\s*\.import .*$/gm, '');
  const m = {};
  new Function('module', 'console', 'i18n', 'XMLHttpRequest', ...names,
    src + '\nmodule.exports={sendStreaming};')(m, quiet, i18n, FakeXHR, ...vals);
  return m.exports;
}
const deps = [['ToolManager', 'ToolCallNormalizer', 'Utils', 'Usage', 'GeminiThinking'],
  [{ getEnabledToolsMetadata: () => [] }, Normalizer, UtilsStub, U, { buildThinkingConfig: () => ({}) }]];
const Chat = loadAdapter('adapters/openai_chat.js', ...deps);
const Resp = loadAdapter('adapters/openai_responses.js', ...deps);
const Anth = loadAdapter('adapters/anthropic.js', ...deps);
const Gem = loadAdapter('adapters/gemini.js', ...deps);
const Inter = loadAdapter('adapters/gemini_interactions.js', ...deps);

// Feeds SSE lines to an adapter and returns {usage, order, body}. `order`
// records that onUsage fires before onComplete, which main.qml relies on.
function run(adapter, lines, extra) {
  instances = [];
  const out = { usage: null, order: [] };
  adapter.sendStreaming(Object.assign({
    endpoint: 'https://x/v1', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
    temperature: 50, maxTokens: 100, tools: [],
    onChunk() {}, onThinkingChunk() {},
    onUsage(u) { out.usage = u; out.order.push('usage'); },
    onComplete() { out.order.push('complete'); },
  }, extra || {}));
  const xhr = instances[0];
  out.body = JSON.parse(xhr.body);
  let buf = '';
  for (const l of lines) {
    buf += l + '\n\n';
    xhr.responseText = buf; xhr.readyState = 3; xhr.onreadystatechange();
  }
  xhr.status = 200; xhr.readyState = 4; xhr.onreadystatechange();
  return out;
}
const data = o => 'data: ' + JSON.stringify(o);

console.log('\nadapter: openai chat');
let o = run(Chat, [
  data({ choices: [{ delta: { content: 'Hi' } }] }),
  data({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0001 } }),
  'data: [DONE]',
], { streamUsage: true });
eq('final usage chunk read', pick(o.usage), [12, 3, 0, 0, 0, 0.0001, 'reported']);
eq('onUsage before onComplete', o.order, ['usage', 'complete']);
eq('stream_options sent when asked', o.body.stream_options, { include_usage: true });
o = run(Chat, [data({ choices: [{ delta: { content: 'Hi' } }] }), 'data: [DONE]']);
eq('not sent unless asked', o.body.stream_options, undefined);
eq('no usage on the wire -> onUsage not called', o.order, ['complete']);
o = run(Chat, [data({ choices: [{ delta: { content: 'x' } }], x_groq: { usage: { prompt_tokens: 4, completion_tokens: 2 } } }), 'data: [DONE]']);
eq('groq x_groq.usage', [o.usage.inputTokens, o.usage.outputTokens], [4, 2]);

console.log('\nadapter: responses');
o = run(Resp, [
  data({ type: 'response.output_text.delta', delta: 'Hi' }),
  data({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 4 }, input_tokens_details: { cached_tokens: 10 } } } }),
]);
eq('response.completed usage', pick(o.usage), [30, 9, 4, 10, 0, null, '']);
eq('order', o.order, ['usage', 'complete']);

console.log('\nadapter: anthropic');
o = run(Anth, [
  data({ type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
  data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
  data({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
  data({ type: 'message_stop' }),
]);
eq('start + delta merged; delta output wins', pick(o.usage), [125, 42, 0, 100, 0, null, '']);

console.log('\nadapter: gemini');
o = run(Gem, [
  data({ candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 } }),
  data({ candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2 } }),
  data({ candidates: [{ content: { parts: [{ text: 'c' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 3, thoughtsTokenCount: 7 } }),
], { geminiAuthMethod: 'aistudio' });
eq('last usageMetadata, not the sum', pick(o.usage), [50, 10, 7, 0, 0, null, '']);

console.log('\nadapter: gemini interactions');
o = run(Inter, [
  data({ event_type: 'interaction.created', interaction: { id: 'i1' } }),
  data({ event_type: 'step.delta', delta: { type: 'text', text: 'Hi', metadata: { total_usage: { total_input_tokens: 5, total_output_tokens: 1 } } } }),
  data({ event_type: 'interaction.completed', interaction: { id: 'i1', usage: { total_input_tokens: 20, total_output_tokens: 6, total_thought_tokens: 4 } } }),
]);
eq('completed interaction usage wins', pick(o.usage), [20, 10, 4, 0, 0, null, '']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
