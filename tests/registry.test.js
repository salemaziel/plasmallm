// Checks that the tools are actually wired up, not just written. A module that
// is never added to tools/index.js, or an id never pushed in getEnabledTools,
// disappears with no error anywhere — the model simply never sees the tool.
const { load } = require('./qmlmodule');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  JSON.stringify(got) === JSON.stringify(want)
    ? (pass++, console.log('  ok   ' + label))
    : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
};

const TM = load('toolManager.js');
const Registry = load('tools/index.js');

console.log('\nregistry');
const names = Registry.tools.map(t => t.module.name);
eq('recall is registered', names.indexOf('recall') !== -1, true);
eq('no duplicate tool names', names.length, new Set(names).size);
eq('every registered module has a name and execute',
   Registry.tools.filter(t => !t.module.name || typeof t.module.execute !== 'function').length, 0);

console.log('\ngating');
const base = { enableTools: true, memoryEnabled: true, memoryAutoRun: true };
const on = TM.getEnabledTools(base);
eq('memory on -> all three tools', ['remember','forget','recall'].every(n => on.indexOf(n) !== -1), true);
const off = TM.getEnabledTools({ enableTools: true, memoryEnabled: false });
eq('memory off -> none of them', ['remember','forget','recall'].some(n => off.indexOf(n) !== -1), false);

console.log('\nmetadata resolves (a missing registry entry silently drops the tool)');
for (const id of ['remember','forget','recall']) {
  const meta = TM.getToolMetadata(id, base);
  eq(`${id} resolves`, !!meta, true);
  eq(`${id} has a schema`, !!(meta && meta.parameters && meta.parameters.properties), true);
}
eq('recall needs no justification',
   TM.getToolMetadata('recall', base).parameters.required, ['query']);
eq('remember still demands one',
   TM.getToolMetadata('remember', base).parameters.required.indexOf('justification') !== -1, true);

console.log('\nauto-run');
eq('recall auto-runs (read-only)', TM.isAutoRun('recall', base), true);
eq('remember follows the setting', TM.isAutoRun('remember', base), true);
eq('remember respects it being off', TM.isAutoRun('remember', { memoryEnabled: true, memoryAutoRun: false }), false);
eq('forget respects it being off', TM.isAutoRun('forget', { memoryEnabled: true, memoryAutoRun: false }), false);

console.log('\nschemas reach the wire');
const schemas = TM.buildToolSchemas ? TM.buildToolSchemas(base) : null;
if (schemas) {
  const ids = schemas.map(s => (s.function && s.function.name) || s.name);
  eq('recall is in the built schema list', ids.indexOf('recall') !== -1, true);
}
const section = TM.buildSystemPromptSection(base, null);
eq('recall is described in the system prompt', section.indexOf('recall') !== -1, true);

// The store refuses ambiguous references; these check the tools actually
// surface that refusal instead of reporting a success the user cannot see is
// wrong. Thin glue, but it is the glue the user-visible behaviour rides on.
console.log('\nforget — an ambiguous phrase is reported, not guessed at');
{
  const Forget = load('tools/Forget.js');
  const candidates = [
    { id: 'm_a', text: 'the printer is a Brother HL-L2350DW' },
    { id: 'm_b', text: 'the printer lives in the back room' }
  ];
  let out = null;
  Forget.execute({ target: 'the printer', justification: 'x' }, {
    memory: {
      remove: () => ({ removed: false, reason: 'ambiguous', matches: candidates, memories: candidates })
    },
    onDone: (text, err, code) => { out = { text, err, code }; },
    error: (e) => { out = { text: '', err: e, code: 1 }; }
  });
  eq('reports a failure', out && out.code, 1);
  eq('says how many matched', out.err.indexOf('matches 2 saved memories') !== -1, true);
  eq('names both ids so the model can retry precisely',
     out.err.indexOf('m_a') !== -1 && out.err.indexOf('m_b') !== -1, true);
}

console.log('\nremember — replaces routes to update, not a second add');
{
  const Remember = load('tools/Remember.js');
  const meta = TM.getToolMetadata('remember', base);
  eq('replaces is offered', !!meta.parameters.properties.replaces, true);
  eq('but is not required', meta.parameters.required.indexOf('replaces'), -1);

  let called = null, out = null;
  const ctx = (updateResult) => ({
    config: { memoryEnabled: true },
    memory: {
      add: () => { called = 'add'; return { added: true, id: 'm_new', pinned: true, text: 'x', reason: 'ok' }; },
      update: (target, text) => { called = 'update'; return updateResult(target, text); }
    },
    onDone: (text, err, code) => { out = { text, err, code }; },
    error: (e) => { out = { text: '', err: e, code: 1 }; }
  });

  Remember.execute({ text: 'Sam runs Via Del Web', replaces: 'm_1', justification: 'x' },
    ctx(() => ({ updated: true, id: 'm_1', oldText: 'Sam works at Via Del Web', text: 'Sam runs Via Del Web', matches: [], reason: 'ok' })));
  eq('calls update, never add', called, 'update');
  eq('succeeds', out.code, 0);
  eq('reports both wordings', out.text.indexOf('Sam works at Via Del Web') !== -1
     && out.text.indexOf('Sam runs Via Del Web') !== -1, true);

  called = null; out = null;
  Remember.execute({ text: 'new wording', replaces: 'the printer', justification: 'x' },
    ctx(() => ({ updated: false, matches: [{ id: 'm_a', text: 'a' }, { id: 'm_b', text: 'b' }], reason: 'ambiguous' })));
  eq('an ambiguous replaces is refused', out.code, 1);
  eq('and does NOT silently fall back to adding a duplicate', called, 'update');

  called = null; out = null;
  Remember.execute({ text: 'a brand new fact', justification: 'x' }, ctx(() => null));
  eq('without replaces it still adds', called, 'add');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
