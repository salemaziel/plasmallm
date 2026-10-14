// Tasks used to live inside each profile, so switching profiles swapped the
// task list and a task added under one profile seemed to vanish. The v6 -> v7
// migration folds every profile's tasks into the one shared list.
const { load } = require('./qmlmodule');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));

const P = load('profiles.js');
const names = r => JSON.parse(r.tasks).map(t => t.name);

const security = { name: 'Security Check', prompt: 'check things', auto: false, autoSubmit: true };
const update = { name: 'Run updates', prompt: 'update things', auto: true, autoSubmit: true };

console.log('\ntasks are no longer a per-profile setting');
const cfg = { tasks: '[{"name":"kept"}]' };
P.applyToConfig({ name: 'Other', tasks: '[]' }, cfg);
eq('switching profile leaves the task list alone', cfg.tasks, '[{"name":"kept"}]');
eq('saving a profile does not copy tasks into it', 'tasks' in P.captureFromConfig({ name: 'Z' }, cfg), false);

console.log('\nmerging');
const profiles = [
  { name: 'Luna', tasks: JSON.stringify([security]) },
  { name: 'Qwen', tasks: JSON.stringify([update]) },
  { name: 'MiMo', tasks: JSON.stringify([update]) },
  { name: 'Empty', tasks: '' },
];
const r = P.mergeProfileTasks(profiles, JSON.stringify([security]));
eq('every task kept once', names(r), ['Security Check', 'Run updates']);
eq('flags kept', JSON.parse(r.tasks)[1], update);
eq('per-profile copies removed', r.profiles.filter(p => 'tasks' in p).length, 0);
eq('profile count unchanged', r.profiles.length, 4);

const clash = P.mergeProfileTasks([
  { name: 'A', tasks: JSON.stringify([{ name: 'Daily', prompt: 'one' }]) },
  { name: 'B', tasks: JSON.stringify([{ name: 'daily', prompt: 'two' }]) },
], '');
eq('same name, different prompt -> both kept, second named after its profile', names(clash), ['Daily', 'daily (B)']);

eq('bad JSON is skipped, not fatal', names(P.mergeProfileTasks([{ name: 'X', tasks: '{oops' }], JSON.stringify([update]))), ['Run updates']);
eq('nothing anywhere', P.mergeProfileTasks([], '').tasks, '[]');
eq('tasks stored as an array, not a string', names(P.mergeProfileTasks([{ name: 'Y', tasks: [security] }], '')), ['Security Check']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
