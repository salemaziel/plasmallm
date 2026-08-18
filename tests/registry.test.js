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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
