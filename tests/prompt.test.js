// Assembles the real system prompt through api.js. The point of interest is the
// negative case: the memory-archive line must not advertise `recall` when tool
// gating has removed it, because a prompt that names an unavailable tool is
// worse than one that says nothing.
const { load } = require('./qmlmodule');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));

const Api = load('api.js');
const MS = load('memoryStore.js');

let mem = [];
for (let i = 0; i < MS.MAX_PINNED + 7; i++) mem = MS.addMemory(mem, 'durable fact number ' + i, '2026-01-01', 'test').memories;
const SYS = { osRelease: 'Fedora 42', hostname: 'ravenclaw' };
const toolsOn  = { enableTools: true, memoryEnabled: true, memoryAutoRun: true };
const toolsOff = { enableTools: true, memoryEnabled: false };

console.log('\ndefault template');
const p = Api.buildSystemPrompt(SYS, '', { memories: mem, toolsConfig: toolsOn });
eq('pinned facts are in the prompt', p.indexOf('durable fact number 0') !== -1, true);
eq('exactly MAX_PINNED of them', (p.match(/durable fact number/g) || []).length, MS.MAX_PINNED);
eq('the archive is counted', p.indexOf('7 further saved facts') !== -1, true);
eq('and recall is named', p.indexOf('Call recall') !== -1, true);

console.log('\nmemory off -> recall is gated out, so the archive line must not lie');
const pOff = Api.buildSystemPrompt(SYS, '', { memories: mem, toolsConfig: toolsOff });
eq('no archive line', pOff.indexOf('further saved facts'), -1);
const pNoTools = Api.buildSystemPrompt(SYS, '', { memories: mem, toolsConfig: null });
eq('no toolsConfig at all -> still no archive line', pNoTools.indexOf('further saved facts'), -1);
eq('pinned facts still shown', pNoTools.indexOf('durable fact number 0') !== -1, true);

console.log('\nno memories');
const pEmpty = Api.buildSystemPrompt(SYS, '', { memories: [], toolsConfig: toolsOn });
eq('no Memory heading at all', pEmpty.indexOf('## Memory\n'), -1);

console.log('\ncustom template written before memory existed');
const custom = 'You are a bot.\n\n## System\n{{system_info}}\n\n{{tools}}';
const pc = Api.buildSystemPrompt(SYS, custom, { memories: mem, toolsConfig: toolsOn });
eq('memories are appended, not dropped', pc.indexOf('durable fact number 0') !== -1, true);
eq('archive index comes along', pc.indexOf('7 further saved facts') !== -1, true);

console.log('\ntemplate with an explicit {{memories}} tag');
const tagged = 'Bot.\n\n{{memories}}\n\n{{tools}}';
const pt = Api.buildSystemPrompt(SYS, tagged, { memories: mem, toolsConfig: toolsOn });
eq('placed once, not twice', (pt.match(/## Memory\n/g) || []).length, 1);

console.log('\naccuracy instructions');
eq('default template carries them', p.indexOf('## Accuracy\n') !== -1, true);
eq('custom template without the tag still gets them', pc.indexOf('## Accuracy\n') !== -1, true);
const pa = Api.buildSystemPrompt(SYS, 'Bot.\n\n{{accuracy}}\n\nMore.', { memories: [], toolsConfig: null });
eq('explicit {{accuracy}} tag places them once', (pa.match(/## Accuracy\n/g) || []).length, 1);
eq('at the tag, not the end', pa.indexOf('## Accuracy') < pa.indexOf('More.'), true);

const pd = Api.buildSystemPrompt(SYS, custom, { memories: [], toolsConfig: null, accuracyEnabled: false });
eq('switched off -> absent', pd.indexOf('## Accuracy'), -1);
const pdt = Api.buildSystemPrompt(SYS, 'Bot.\n{{accuracy}}', { memories: [], toolsConfig: null, accuracyEnabled: false });
eq('switched off -> tag renders empty', pdt.indexOf('Accuracy'), -1);
const pcu = Api.buildSystemPrompt(SYS, custom, { memories: [], toolsConfig: null, accuracyText: 'Be exact.' });
eq('custom text replaces the default', [pcu.indexOf('Be exact.') !== -1, pcu.indexOf('## Accuracy')], [true, -1]);
const pbl = Api.buildSystemPrompt(SYS, custom, { memories: [], toolsConfig: null, accuracyText: '   ' });
eq('blank custom text falls back to the default', pbl.indexOf('## Accuracy\n') !== -1, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
