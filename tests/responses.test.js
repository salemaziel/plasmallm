// Replays real /zen/go/v1/responses SSE traces (captured 2026-08-17) through
// the actual openai_responses.js strategy, via a fake XHR.
//
// Grok and Luna stream function calls in two structurally different ways on the
// same endpoint, so both are pinned here:
//   grok-4.5      complete arguments inline on output_item.added, no deltas
//   gpt-5.6-luna  empty opener, then one arguments delta per item
const fs = require('fs');
const { UI_SLASH: base } = require('./paths');

const warnings = [];
const quietConsole = { warn: (...a) => warnings.push(a.join(' ')), error: () => {}, log: () => {} };
const i18n = (s, ...a) => a.reduce((acc, v, idx) => acc.split(`%${idx + 1}`).join(String(v)), s);

let instances = [];
function FakeXHR() {
  this.readyState = 0; this.status = 0; this.responseText = '';
  this.open = () => {}; this.setRequestHeader = () => {}; this.abort = () => {};
  this.send = (p) => { this.payload = p; };
  instances.push(this);
}

function load(file, injectNames, injectVals, exportList) {
  const src = fs.readFileSync(base + file, 'utf8')
    .replace(/^\s*\.pragma library\s*$/gm, '')
    .replace(/^\s*\.import .*$/gm, '');
  const m = {};
  new Function('module', 'console', 'i18n', 'XMLHttpRequest', ...injectNames,
    src + `\nmodule.exports={${exportList}};`)(m, quietConsole, i18n, FakeXHR, ...injectVals);
  return m.exports;
}

const Normalizer = load('toolCallNormalizer.js', [], [],
  'repairArguments,normalizeToolCalls,sanitizeStoredToolCallsJson,reconcileToolCallMessages,logNotes');
const UtilsStub = {
  uuidv4: () => "00000000-0000-0000-0000-000000000000",
  isOpenRouterProvider: () => false,
  isOpenRouterEndpoint: () => false,
  applyOpenRouterAttribution: () => {},
};
const Resp = load('adapters/openai_responses.js', ['ToolManager', 'ToolCallNormalizer', 'Utils'],
  [{ getEnabledToolsMetadata: () => [] }, Normalizer, UtilsStub], 'sendStreaming,buildTools,translateMessages');

function stream(events) {
  return new Promise(res => {
    instances = [];
    let result = null;
    Resp.sendStreaming({
      endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'm', messages: [],
      temperature: 50, maxTokens: 300, tools: [], onChunk() {}, onThinkingChunk() {},
      onComplete: (text, error, toolCalls) => { result = { text, error, toolCalls }; },
    });
    const xhr = instances[0];
    let buf = '';
    for (const e of events) {
      buf += `data: ${JSON.stringify(e)}\n\n`;
      xhr.responseText = buf; xhr.readyState = 3; xhr.onreadystatechange();
    }
    xhr.readyState = 4; xhr.status = 200; xhr.onreadystatechange();
    res(result);
  });
}

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}

// ---- grok-4.5: arguments arrive complete on output_item.added -------------
const GROK_A = { id: 'fc_7ad897ae-2c72-4845-a7dc-68e154b0ec9a', type: 'function_call', status: 'completed',
  name: 'read_file', call_id: 'call-822134f5-506d-4de1-831f-2f1082533bef-0',
  arguments: '{"justification":"Read /etc/hostname as requested by the user","path":"/etc/hostname"}' };
const GROK_B = { id: 'fc_f237f0c0-3e91-4282-8d03-6ada4a9b5918', type: 'function_call', status: 'completed',
  name: 'list_dir', call_id: 'call-822134f5-506d-4de1-831f-2f1082533bef-1',
  arguments: '{"justification":"List /tmp as requested by the user","path":"/tmp"}' };

// ---- gpt-5.6-luna: empty opener then one delta per item -------------------
const LUNA_A_ARGS = '{"justification":"Read the requested system hostname file.","path":"/etc/hostname"}';
const LUNA_B_ARGS = '{"justification":"List the requested temporary directory.","path":"/tmp"}';

(async () => {
  console.log('\ncaptured trace — grok-4.5 (complete args on item.added, zero deltas)');
  let r = await stream([
    { type: 'response.output_item.added', output_index: 1, item: GROK_A },
    { type: 'response.output_item.added', output_index: 2, item: GROK_B },
    { type: 'response.output_item.done', output_index: 1, item: GROK_A },
    { type: 'response.output_item.done', output_index: 2, item: GROK_B },
    { type: 'response.completed' },
  ]);
  eq('two calls', r.toolCalls.length, 2);
  eq('names', r.toolCalls.map(c => c.function.name), ['read_file', 'list_dir']);
  eq('ids are call_id, not the fc_ item id (needed for function_call_output)',
     r.toolCalls.map(c => c.id),
     ['call-822134f5-506d-4de1-831f-2f1082533bef-0', 'call-822134f5-506d-4de1-831f-2f1082533bef-1']);
  eq('args not duplicated by the repeated item on item.done',
     r.toolCalls.map(c => JSON.parse(c.function.arguments).path), ['/etc/hostname', '/tmp']);

  console.log('\ncaptured trace — gpt-5.6-luna native (the shape the chat shim mangles)');
  r = await stream([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_tmp_fxrij3a5l7t', type: 'function_call', status: 'in_progress', name: 'read_file', call_id: 'call_Y0Q99WEw0lpqwA0UfN2QUOTs', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_tmp_fxrij3a5l7t', delta: LUNA_A_ARGS },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_tmp_fxrij3a5l7t', arguments: LUNA_A_ARGS, name: 'read_file' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_tmp_fxrij3a5l7t', type: 'function_call', status: 'completed', name: 'read_file', call_id: 'call_Y0Q99WEw0lpqwA0UfN2QUOTs', arguments: LUNA_A_ARGS } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_tmp_3f914ve69qu', type: 'function_call', status: 'in_progress', name: 'list_dir', call_id: 'call_1AzVPNZ0SlRAQFN9kUbiLmTa', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_tmp_3f914ve69qu', delta: LUNA_B_ARGS },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_tmp_3f914ve69qu', arguments: LUNA_B_ARGS, name: 'list_dir' },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_tmp_3f914ve69qu', type: 'function_call', status: 'completed', name: 'list_dir', call_id: 'call_1AzVPNZ0SlRAQFN9kUbiLmTa', arguments: LUNA_B_ARGS } },
    { type: 'response.completed' },
  ]);
  eq('two calls kept separate by item id', r.toolCalls.length, 2);
  eq('names NOT concatenated into read_filelist_dir',
     r.toolCalls.map(c => c.function.name), ['read_file', 'list_dir']);
  eq('ids are the real call_ids', r.toolCalls.map(c => c.id),
     ['call_Y0Q99WEw0lpqwA0UfN2QUOTs', 'call_1AzVPNZ0SlRAQFN9kUbiLmTa']);
  eq('arguments parse and route correctly',
     r.toolCalls.map(c => JSON.parse(c.function.arguments).path), ['/etc/hostname', '/tmp']);
  eq('no repair was needed on the native route', warnings.length, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (warnings.length) console.log(`\nrepair warnings: ${warnings.length}`);
  process.exit(fail ? 1 : 0);
})();
