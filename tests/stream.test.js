// Drives the real openai_chat.js sendStreaming() through a fake XHR, replaying
// the SSE shapes that corrupt tool calls. Asserts the invariant that matters:
// every function.arguments handed back is a parseable JSON object.
const fs = require('fs');
const { UI_SLASH: base } = require('./paths');

function load(file, injectNames, injectVals, exportList) {
  const src = fs.readFileSync(base + file, 'utf8')
    .replace(/^\s*\.pragma library\s*$/gm, '')
    .replace(/^\s*\.import .*$/gm, '');
  const m = {};
  new Function('module', 'console', 'i18n', 'XMLHttpRequest', ...injectNames,
    src + `\nmodule.exports={${exportList}};`)(m, quietConsole, i18n, FakeXHR, ...injectVals);
  return m.exports;
}

const warnings = [];
const quietConsole = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
const i18n = (s, ...a) => a.reduce((acc, v, idx) => acc.replace(`%${idx + 1}`, v), s);

let instances = [];
function FakeXHR() {
  this.readyState = 0; this.status = 0; this.responseText = '';
  this.open = () => {}; this.setRequestHeader = () => {}; this.abort = () => {};
  this.send = (p) => { this.payload = p; };
  instances.push(this);
}

const Normalizer = load('toolCallNormalizer.js', [], [],
  'repairArguments,normalizeToolCalls,sanitizeStoredToolCallsJson,reconcileToolCallMessages,logNotes');
const ToolManagerStub = { getEnabledToolsMetadata: () => [] };
const Chat = load('adapters/openai_chat.js', ['ToolManager', 'ToolCallNormalizer'],
  [ToolManagerStub, Normalizer], 'sendStreaming,parseSSEChunks');

// Replay a list of SSE `data:` payloads, then close the stream.
function stream(chunks, { truncate = false } = {}) {
  return new Promise(res => {
    instances = [];
    let result = null;
    Chat.sendStreaming({
      endpoint: 'https://x/v1', apiKey: 'k', model: 'm', messages: [], temperature: 50, maxTokens: 100,
      tools: [], onChunk() {}, onThinkingChunk() {},
      onComplete: (text, error, toolCalls) => { result = { text, error, toolCalls }; },
    });
    const xhr = instances[0];
    let buf = '';
    for (const c of chunks) {
      buf += `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`;
      xhr.responseText = buf; xhr.readyState = 3; xhr.onreadystatechange();
    }
    if (!truncate) { buf += 'data: [DONE]\n\n'; xhr.responseText = buf; }
    xhr.readyState = 4; xhr.status = 200; xhr.onreadystatechange();
    res(result);
  });
}

const tc = (index, id, name, args) => {
  const fn = {};
  if (name !== undefined) fn.name = name;
  if (args !== undefined) fn.arguments = args;
  const callObj = { index };
  if (id !== undefined) callObj.id = id;
  callObj.function = fn;
  return { choices: [{ delta: { tool_calls: [callObj] } }] };
};

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}
function allArgsValid(label, calls) {
  let ok = Array.isArray(calls) && calls.length > 0;
  for (const c of calls || []) {
    try { const v = JSON.parse(c.function.arguments); if (!v || typeof v !== 'object' || Array.isArray(v)) ok = false; }
    catch { ok = false; }
  }
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label} -> ${JSON.stringify(calls)}`));
}

(async () => {
  console.log('\ncontrol — well-behaved incremental stream still works');
  let r = await stream([
    tc(0, 'call_1', 'read_file', ''),
    tc(0, undefined, undefined, '{"path":'),
    tc(0, undefined, undefined, '"/etc/hostname"}'),
  ]);
  eq('single call assembled', r.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hostname"}' } }]);

  console.log('\nregression — parallel calls that share delta index 0 (MiniMax)');
  r = await stream([
    tc(0, 'call_A', 'read_file', '{"path":"/etc/hostname"}'),
    tc(0, 'call_B', 'list_dir', '{"path":"/tmp"}'),
  ]);
  eq('two distinct calls, not merged', r.toolCalls.length, 2);
  eq('ids preserved', r.toolCalls.map(c => c.id), ['call_A', 'call_B']);
  eq('names not concatenated', r.toolCalls.map(c => c.function.name), ['read_file', 'list_dir']);
  allArgsValid('both arg strings are valid JSON', r.toolCalls);

  console.log('\nregression — provider repeats the whole object every chunk');
  r = await stream([
    tc(0, 'call_R', 'read_file', '{"path":"/etc"}'),
    tc(0, 'call_R', 'read_file', '{"path":"/etc"}'),
    tc(0, 'call_R', 'read_file', '{"path":"/etc"}'),
  ]);
  eq('deduped to one clean object', r.toolCalls[0].function.arguments, '{"path":"/etc"}');
  eq('name not tripled', r.toolCalls[0].function.name, 'read_file');

  console.log('\nregression — tool call with no arguments delta at all');
  r = await stream([tc(0, 'call_Z', 'get_clipboard', undefined)]);
  eq('empty args become {}', r.toolCalls[0].function.arguments, '{}');
  allArgsValid('valid JSON despite no delta', r.toolCalls);

  console.log('\nregression — arguments delivered pre-parsed as an object');
  r = await stream([tc(0, 'call_O', 'read_file', undefined), {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: { path: '/etc' } } }] } }],
  }]);
  eq('object delta replaces, not appended', r.toolCalls[0].function.arguments, '{"path":"/etc"}');

  console.log('\nregression — stream cut mid-object');
  r = await stream([
    tc(0, 'call_T', 'read_file', '{"justification":"check","pa'),
  ], { truncate: true });
  allArgsValid('truncated args salvaged into valid JSON', r.toolCalls);
  eq('finished field kept', JSON.parse(r.toolCalls[0].function.arguments).justification, 'check');

  console.log('\nregression — deltas with neither index nor id');
  r = await stream([
    tc(0, 'call_N', 'read_file', ''),
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '"/x"}' } }] } }] },
  ]);
  eq('continuation fragments join the open call', r.toolCalls.length, 1);
  eq('assembled correctly', r.toolCalls[0].function.arguments, '{"path":"/x"}');

  console.log('\nthree parallel calls, interleaved fragments');
  r = await stream([
    tc(0, 'c1', 'read_file', '{"p":'), tc(1, 'c2', 'list_dir', '{"p":'), tc(2, 'c3', 'notify', '{"m":'),
    tc(0, undefined, undefined, '"a"}'), tc(1, undefined, undefined, '"b"}'), tc(2, undefined, undefined, '"c"}'),
  ]);
  eq('three calls kept separate', r.toolCalls.map(c => c.id), ['c1', 'c2', 'c3']);
  eq('args routed to the right call', r.toolCalls.map(c => c.function.arguments), ['{"p":"a"}', '{"p":"b"}', '{"m":"c"}']);

  // ---- Traces captured verbatim from the live OpenCode Go gateway ----------
  console.log('\ncaptured trace — gpt-5.6-luna reuses index 0 for BOTH calls');
  r = await stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fc_tmp_7emt7h5qw0h', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"justification":"Read the requested hostname file.","path":"/etc/hostname"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fc_tmp_4t28ber8x7c', type: 'function', function: { name: 'list_dir', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"justification":"List the requested temporary directory.","path":"/tmp"}' } }] } }] },
  ]);
  eq('two calls recovered from one index', r.toolCalls.length, 2);
  eq('names not concatenated into read_filelist_dir', r.toolCalls.map(c => c.function.name), ['read_file', 'list_dir']);
  eq('both real ids kept', r.toolCalls.map(c => c.id), ['fc_tmp_7emt7h5qw0h', 'fc_tmp_4t28ber8x7c']);
  eq('args routed to the right call', r.toolCalls.map(c => JSON.parse(c.function.arguments).path), ['/etc/hostname', '/tmp']);
  allArgsValid('both arg strings valid JSON', r.toolCalls);

  console.log('\ncaptured trace — minimax-m3 (id + partial "{" then fragments)');
  r = await stream([
    tc(0, 'call_a63e38fae181b527', 'read_file', '{'),
    tc(0, undefined, undefined, '"justification": "User requested reading this file to view its contents"'),
    tc(0, undefined, undefined, ', "path": "/etc/hostname"}'),
    tc(1, 'call_80236aba94c445e5', 'list_dir', '{"justification": "User requested listing this directory to see its contents"'),
    tc(1, undefined, undefined, ', "path": "/tmp"}'),
  ]);
  eq('minimax: two calls', r.toolCalls.map(c => c.function.name), ['read_file', 'list_dir']);
  eq('minimax: paths correct', r.toolCalls.map(c => JSON.parse(c.function.arguments).path), ['/etc/hostname', '/tmp']);

  console.log('\ncaptured trace — kimi-k3 (empty opener, token-by-token fragments)');
  r = await stream([
    tc(0, 'read_file_0', 'read_file', ''),
    ...['{"justification":"', 'User', ' requested', ' to', ' read', ' the', ' hostname', ' file', '"', ',"path":"', '/etc', '/', 'hostname', '"', '}']
      .map(frag => tc(0, undefined, undefined, frag)),
  ]);
  eq('kimi: reassembled from 15 fragments', JSON.parse(r.toolCalls[0].function.arguments).path, '/etc/hostname');
  eq('kimi: justification intact', JSON.parse(r.toolCalls[0].function.arguments).justification, 'User requested to read the hostname file');

  console.log('\ncaptured trace — glm-5.3 (one complete call per delta)');
  r = await stream([
    tc(0, 'call_f041f11e37164a8687073204', 'read_file', '{"justification":"Read the system hostname","path":"/etc/hostname"}'),
    tc(1, 'call_ea1497268b234fcf9fb2ffc6', 'list_dir', '{"justification":"List the contents of the /tmp directory","path":"/tmp"}'),
  ]);
  eq('glm: two clean calls', r.toolCalls.map(c => JSON.parse(c.function.arguments).path), ['/etc/hostname', '/tmp']);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (warnings.length) console.log(`\n(${warnings.length} repair warnings logged, as designed)`);
  process.exit(fail ? 1 : 0);
})();
