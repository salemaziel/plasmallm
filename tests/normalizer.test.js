// Standalone harness for toolCallNormalizer.js (strips the QML .pragma line).
const fs = require('fs');
const { UI } = require('./paths');
const path = UI + '/toolCallNormalizer.js';
const src = fs.readFileSync(path, 'utf8').replace(/^\s*\.pragma library\s*$/m, '');
const mod = {};
new Function('module', 'exports', 'console', src + '\nmodule.exports={repairArguments,normalizeToolCalls,sanitizeStoredToolCallsJson,reconcileToolCallMessages};')(mod, {}, console);
const { repairArguments, normalizeToolCalls, sanitizeStoredToolCallsJson, reconcileToolCallMessages } = mod.exports;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}

console.log('\nrepairArguments — the failure modes seen in the wild');
eq('empty string (no args delta)', repairArguments(''), { text: '{}', status: 'empty' });
eq('undefined', repairArguments(undefined), { text: '{}', status: 'empty' });
eq('valid object string', repairArguments('{"path":"/etc/hostname"}'), { text: '{"path":"/etc/hostname"}', status: 'ok' });
eq('whitespace-padded valid', repairArguments('  {"a":1}  '), { text: '{"a":1}', status: 'ok' });
eq('pre-parsed object', repairArguments({ a: 1 }), { text: '{"a":1}', status: 'coerced' });
eq('repeated whole object', repairArguments('{"a":1}{"a":1}'), { text: '{"a":1}', status: 'deduped' });
eq('repeated x3 with spaces', repairArguments('{"a":1} {"a":1} {"a":1}'), { text: '{"a":1}', status: 'deduped' });
eq('two DIFFERENT objects (index collision)', repairArguments('{"path":"/etc"}{"path":"/tmp"}'), { text: '{"path":"/etc"}', status: 'split' });
eq('truncated mid-value', repairArguments('{"path":"/etc/host'), { text: '{"path":"/etc/host"}', status: 'truncated' });
eq('truncated after comma', repairArguments('{"a":1,"b":'), { text: '{"a":1}', status: 'truncated' });
eq('truncated dangling key', repairArguments('{"a":1,"pat'), { text: '{"a":1}', status: 'truncated' });
eq('braces inside string value', repairArguments('{"cmd":"echo {hi}"}'), { text: '{"cmd":"echo {hi}"}', status: 'ok' });
eq('escaped quote in value', repairArguments('{"cmd":"say \\"hi\\""}'), { text: '{"cmd":"say \\"hi\\""}', status: 'ok' });
eq('repeated w/ braces in strings', repairArguments('{"c":"a{b}"}{"c":"a{b}"}'), { text: '{"c":"a{b}"}', status: 'deduped' });
eq('array (invalid for fn args)', repairArguments('[1,2]'), { text: '{}', status: 'lost' });
eq('bare garbage', repairArguments('not json at all'), { text: '{}', status: 'lost' });
eq('empty object stays', repairArguments('{}'), { text: '{}', status: 'ok' });

console.log('\nnormalizeToolCalls — array-level repair');
const holey = [];
holey[2] = { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc"}' } };
eq('sparse array compacts', normalizeToolCalls(holey).calls,
   [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc"}' } }]);

eq('nameless call dropped', normalizeToolCalls([{ id: 'x', function: { name: '', arguments: '{}' } }]).calls, []);

eq('duplicate ids renamed', normalizeToolCalls([
  { id: 'dup', function: { name: 'a', arguments: '{}' } },
  { id: 'dup', function: { name: 'b', arguments: '{}' } },
]).calls.map(c => c.id), ['dup', 'dup_2']);

eq('missing id synthesized', normalizeToolCalls([{ function: { name: 'list_dir', arguments: '{}' } }]).calls[0].id, 'call_list_dir_0');

eq('empty args become {}', normalizeToolCalls([
  { id: 'c1', type: 'function', function: { name: 'get_clipboard', arguments: '' } },
]).calls, [{ id: 'c1', type: 'function', function: { name: 'get_clipboard', arguments: '{}' } }]);

console.log('\nsanitizeStoredToolCallsJson — healing poisoned history');
eq('poisoned stored history heals',
   sanitizeStoredToolCallsJson('[{"id":"call_wXhSU","type":"function","function":{"name":"read_file","arguments":""}}]'),
   '[{"id":"call_wXhSU","type":"function","function":{"name":"read_file","arguments":"{}"}}]');
eq('unparseable history -> dropped', sanitizeStoredToolCallsJson('{{{'), '');
eq('empty passthrough', sanitizeStoredToolCallsJson(''), '');

console.log('\nevery repaired value must be parseable JSON (the actual contract)');
const nasty = ['', '{"a":1}{"a":1}', '{"path":"/etc/host', 'garbage', '[1,2]', '{"a":1,"b":', '{}', '{"c":"}"}'];
let allOk = true;
for (const n of nasty) {
  const r = repairArguments(n);
  try {
    const v = JSON.parse(r.text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) { allOk = false; console.log(`  FAIL not an object: ${n}`); }
  } catch (e) { allOk = false; console.log(`  FAIL unparseable output for input ${JSON.stringify(n)} -> ${r.text}`); }
}
eq('all outputs are JSON objects', allOk, true);

eq('gemini thought_signature preserved', normalizeToolCalls([
  { id: 'g1', type: 'function', thought_signature: 'sig123', function: { name: 'read_file', arguments: '' } },
]).calls, [{ id: 'g1', type: 'function', function: { name: 'read_file', arguments: '{}' }, thought_signature: 'sig123' }]);

eq('duplicated name not doubled by normalizer', normalizeToolCalls([
  { id: 'n1', function: { name: 'read_file', arguments: '{}' } },
]).calls[0].function.name, 'read_file');

console.log('\nreconcileToolCallMessages — assistant/tool pairing');
const A = (calls, content = '') => ({ role: 'assistant', content, tool_calls: calls });
const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const T = (id, c = 'out') => ({ role: 'tool', tool_call_id: id, content: c });

eq('intact pair survives untouched',
   reconcileToolCallMessages([A([call('c1', 'read_file')]), T('c1')]).messages.length, 2);

eq('unanswered call dropped, empty assistant removed',
   reconcileToolCallMessages([{ role: 'user', content: 'hi' }, A([call('c1', 'read_file')])]).messages,
   [{ role: 'user', content: 'hi' }]);

eq('unanswered call dropped, assistant text kept',
   reconcileToolCallMessages([A([call('c1', 'read_file')], 'let me check')]).messages,
   [{ role: 'assistant', content: 'let me check' }]);

eq('orphaned tool result dropped',
   reconcileToolCallMessages([{ role: 'user', content: 'hi' }, T('ghost')]).messages,
   [{ role: 'user', content: 'hi' }]);

eq('partial: answered call kept, unanswered dropped',
   reconcileToolCallMessages([A([call('c1', 'read_file'), call('c2', 'list_dir')]), T('c1')])
     .messages[0].tool_calls.map(c => c.id), ['c1']);

eq('compaction cutting off results yields a valid request',
   reconcileToolCallMessages([A([call('c9', 'read_file')]), { role: 'user', content: 'next' }]).messages,
   [{ role: 'user', content: 'next' }]);

eq('non-tool messages pass through',
   reconcileToolCallMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]).messages.length, 2);

// ---- duplicate tool_call_ids across turns (the DeepSeek 400) --------------
console.log('\nreconcile — globally unique tool_call_ids');

// Adapters that synthesize "call_0" from a per-turn counter collide on turn 2.
const dupTurns = reconcileToolCallMessages([
  { role: 'user', content: 'first' },
  A([call('call_0', 'read_file')]), T('call_0', 'hostname'),
  { role: 'user', content: 'second' },
  A([call('call_0', 'list_dir')]), T('call_0', 'tmp listing'),
]).messages;

const idsOf = ms => ms.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id));
const resultIdsOf = ms => ms.filter(m => m.role === 'tool').map(m => m.tool_call_id);

eq('both turns survive', dupTurns.filter(m => m.tool_calls).length, 2);
eq('call ids are now distinct', idsOf(dupTurns), ['call_0', 'call_0_dup2']);
eq('each result follows its own call', resultIdsOf(dupTurns), ['call_0', 'call_0_dup2']);
eq('results keep their content', dupTurns.filter(m => m.role === 'tool').map(m => m.content),
   ['hostname', 'tmp listing']);
eq('no call is left unanswered (would be dropped)', dupTurns.filter(m => m.tool_calls).length, 2);

eq('three turns colliding on one id',
   idsOf(reconcileToolCallMessages([
     A([call('c', 'f')]), T('c'), A([call('c', 'f')]), T('c'), A([call('c', 'f')]), T('c'),
   ]).messages),
   ['c', 'c_dup2', 'c_dup3']);

eq('duplicates *within* one message are separated too',
   idsOf(reconcileToolCallMessages([A([call('x', 'f'), call('x', 'g')]), T('x'), T('x')]).messages),
   ['x', 'x_dup2']);

eq('distinct ids are left completely alone',
   idsOf(reconcileToolCallMessages([A([call('a1', 'f')]), T('a1'), A([call('b2', 'g')]), T('b2')]).messages),
   ['a1', 'b2']);

eq('renaming is reported for the log',
   reconcileToolCallMessages([A([call('c', 'f')]), T('c'), A([call('c', 'f')]), T('c')])
     .notes.some(n => n.includes('re-issued')), true);

// A collision must not let one result vouch for two calls: without dedup the
// second turn's call would match the first turn's result and both survive
// unpaired, which is the shape DeepSeek rejects.
eq('unanswered duplicate is still dropped, not rescued by the earlier result',
   reconcileToolCallMessages([
     A([call('call_0', 'read_file')]), T('call_0'),
     A([call('call_0', 'list_dir')]),
     { role: 'user', content: 'next' },
   ]).messages.filter(m => m.tool_calls).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
