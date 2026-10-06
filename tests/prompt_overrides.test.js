// promptOverrides: every built-in system-prompt section can be replaced from
// Settings. Blank, missing, or unparseable overrides must fall back to the
// built-in text, and tokens must be filled in at build time.
const fs = require('fs');
const path = require('path');
const { load } = require('./qmlmodule');
const { UI } = require('./paths');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));

const Api = load('api.js');
const MS = load('memoryStore.js');
const TM = load('toolManager.js');
const Skills = load('skills.js');

const ov = o => JSON.stringify(o);
const has = (s, t) => s.indexOf(t) !== -1;
const SYS = { osRelease: 'Fedora 42' };

let mem = [];
for (let i = 0; i < MS.MAX_PINNED + 3; i++) mem = MS.addMemory(mem, 'fact number ' + i, '2026-01-01', 'test').memories;
const tools = { enableTools: true, memoryEnabled: true, memoryAutoRun: true, useCommandTool: true };
const base = { memories: mem, toolsConfig: tools, sessionMultiplexer: 'tmux: work', autoMode: true };
const build = (overrides, extra) => Api.buildSystemPrompt(SYS, '', Object.assign({}, base, extra || {}, { promptOverrides: overrides }));
const plain = build(undefined);

console.log('\nparsePromptOverrides');
eq('empty string', Api.parsePromptOverrides(''), {});
eq('undefined', Api.parsePromptOverrides(undefined), {});
eq('bad JSON', Api.parsePromptOverrides('{nope'), {});
eq('array is not an object', Api.parsePromptOverrides('["a"]'), {});
eq('blank and non-string values are dropped', Api.parsePromptOverrides(ov({ a: '  ', b: 3, c: ' x ' })), { c: 'x' });

console.log('\nfallbacks');
eq('empty override -> unchanged prompt', build(''), plain);
eq('bad JSON -> unchanged prompt', build('{{{'), plain);
eq('blank value -> unchanged prompt', build(ov({ end_marker: '   ', skills: '' })), plain);
eq('unknown key is ignored', build(ov({ nothing: 'x' })), plain);
eq('default ends with the marker', plain.endsWith('\n\nEND OF SYSTEM PROMPT\n'), true);

console.log('\nend marker');
const pe = build(ov({ end_marker: 'STOP HERE' }));
eq('replaced', [pe.endsWith('\n\nSTOP HERE\n'), has(pe, 'END OF SYSTEM PROMPT')], [true, false]);

console.log('\nsession multiplexer tokens');
eq('default carries the real values', [has(plain, '**tmux**'), has(plain, '`work`'), has(plain, 'tmux new-session -A -s work')], [true, true, true]);
const pm = build(ov({ session_multiplexer: 'MUX {{multiplexer}} / {{session}} / {{attach_command}} / {{ Session }}' }));
eq('tokens substituted', has(pm, 'MUX tmux / work / tmux new-session -A -s work / work'), true);
eq('default text gone', has(pm, 'persistent **'), false);
const pms = build(ov({ session_multiplexer: 'X {{attach_command}}' }), { sessionMultiplexer: 'screen: s1' });
eq('screen attach command', has(pms, 'X screen -xRR s1'), true);
eq('no multiplexer -> override not rendered', has(build(ov({ session_multiplexer: 'ZZZ' }), { sessionMultiplexer: '' }), 'ZZZ'), false);
eq('default editor text is the template form', has(Api.PROMPT_DEFAULTS.session_multiplexer, '{{multiplexer}}'), true);

console.log('\napproval mode');
const pa = build(ov({ approval_mode: '## Auto\nGo wild.' }));
eq('replaced', [has(pa, '## Auto\nGo wild.'), has(pa, 'Skip approvals mode is ACTIVE')], [true, false]);
eq('not shown when mode is off', has(build(ov({ approval_mode: 'GO WILD' }), { autoMode: false }), 'GO WILD'), false);
eq('default text matches built-in', has(plain, Api.PROMPT_DEFAULTS.approval_mode), true);

console.log('\nmemory');
const pmem = build(ov({ memory_heading: 'Notes', memory_intro: 'My intro.', memory_archive_intro: '{{x}}%1 hidden. Use recall.' }));
eq('heading + intro', [has(pmem, '## Notes\nMy intro.'), has(pmem, '## Memory\n')], [true, false]);
eq('archive intro with %1 count', has(pmem, '{{x}}3 hidden. Use recall.'), true);
eq('one override leaves the others', has(build(ov({ memory_heading: 'Notes' })), 'Durable facts you previously'), true);
const loc = build(ov({ memory_heading: 'Notes' }), { localizeSystemPrompt: true, i18n: s => 'L:' + s });
eq('override beats the localized default', [has(loc, '## Notes\nL:Durable'), has(loc, '## L:Memory\n')], [true, false]);

console.log('\nskills');
const sk = [{ name: 'demo', valid: true, body: 'BODY' }];
eq('default intro', has(Skills.buildSystemPromptSection(sk, '', []), Skills.SKILLS_INTRO_DEFAULT), true);
const skO = Skills.buildSystemPromptSection(sk, '', ['demo'], 'Custom skills intro.');
eq('override intro, heading and loaded body kept', [has(skO, '## Skills'), has(skO, 'Custom skills intro.'), has(skO, 'BODY'), has(skO, 'load it with the `skill` tool')], [true, true, true, false]);
const withSkills = Object.assign({}, tools, { skillsEnabled: true, loadedSkills: sk });
const pk = Api.buildSystemPrompt(SYS, '', { toolsConfig: withSkills, promptOverrides: ov({ skills: 'Skills override.' }) });
eq('through buildSystemPrompt', has(pk, 'Skills override.'), true);

console.log('\ndesktop driving');
const dmSrc = fs.readFileSync(path.join(UI, 'driverManager.js'), 'utf8').replace(/^\s*\.pragma library\s*$/m, '').replace('var isSessionActive = false;', 'var isSessionActive = true;');
const DM = new Function(dmSrc + '\nreturn { getDrivingInstructions: getDrivingInstructions, getDefaultDrivingInstructions: getDefaultDrivingInstructions };')();
eq('default', has(DM.getDrivingInstructions(), '## Desktop Automation'), true);
eq('override', DM.getDrivingInstructions('Drive carefully.').trim(), 'Drive carefully.');
eq('blank override -> default', DM.getDrivingInstructions('  '), DM.getDefaultDrivingInstructions());
eq('inactive session -> nothing', Api.buildSystemPrompt(SYS, '', { promptOverrides: ov({ driving_instructions: 'DRIVE' }) }).indexOf('DRIVE'), -1);
eq('editor default is the real text', Api.PROMPT_DEFAULTS.driving_instructions, DM.getDefaultDrivingInstructions().trim());

console.log('\ntools');
const tOnly = (o) => TM.buildSystemPromptSection(tools, null, Api.parsePromptOverrides(ov(o)));
const tBase = tOnly({});
eq('default unchanged', tBase, TM.buildSystemPromptSection(tools, null));
eq('default intro matches the constant', has(tBase, TM.TOOLS_INTRO_DEFAULT.split('\n\n')[0]), true);
const tIntro = tOnly({ tools_intro: 'Use tools wisely:' });
eq('intro replaced', [has(tIntro, 'Use tools wisely:'), has(tIntro, 'pre-authorized'), has(tIntro, 'Enabled tools:')], [true, false, false]);
const tRecall = tOnly({ 'tool:recall': 'RECALL OVERRIDE' });
const line = (s, id) => s.split('\n').filter(l => l.indexOf('- ' + TM.TOOLS[id].name + ' (') === 0)[0];
eq('recall line changed', has(line(tRecall, 'recall'), 'RECALL OVERRIDE'), true);
eq('other tools untouched', [line(tRecall, 'remember'), line(tRecall, 'run_command')], [line(tBase, 'remember'), line(tBase, 'run_command')]);
eq('beats the legacy per-tool instructions', has(line(TM.buildSystemPromptSection(Object.assign({}, tools, { toolsInstructions: ov({ recall: 'OLD' }) }), null, { 'tool:recall': 'NEW' }), 'recall'), 'NEW'), true);
eq('every listed tool id has default text', TM.getPromptToolIds().every(id => TM.getDefaultToolInstruction(id).length > 0), true);
eq('recall is offered for editing', TM.getPromptToolIds().indexOf('recall') !== -1, true);
const pt = build(ov({ 'tool:recall': 'RECALL VIA API' }));
eq('through buildSystemPrompt', has(pt, 'RECALL VIA API'), true);

console.log('\naccuracy still works alongside');
eq('accuracy present', has(build(ov({ end_marker: 'E' })), '## Accuracy\n'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
