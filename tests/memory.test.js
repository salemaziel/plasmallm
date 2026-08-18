// Exercises memoryStore.js — the pure half of the memory feature.
const fs = require('fs');
const { UI } = require('./paths');
const path = UI + '/memoryStore.js';
const src = fs.readFileSync(path, 'utf8').replace(/^\s*\.pragma library\s*$/m, '');
const mod = {};
new Function('module', 'console', src +
  '\nmodule.exports={parseJsonl,serializeJsonl,addMemory,removeMemory,setPinned,searchMemories,markUsed,' +
  'formatSearchResults,buildPromptSection,pinnedMemories,archivedMemories,countPinned,collectTags,makeId,' +
  'MAX_MEMORIES,MAX_PINNED,MAX_TEXT,RECALL_LIMIT};'
)(mod, console);
const M = mod.exports;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok   ${label}`))
     : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}
const NOW = '2026-08-17T12:00:00.000Z';

// Convenience: add n archived facts.
function seed(texts, opts) {
  let list = [];
  for (const t of texts) list = M.addMemory(list, t, NOW, 'test', opts).memories;
  return list;
}

console.log('\nparseJsonl — tolerant of a damaged file');
eq('empty input', M.parseJsonl('').memories, []);
eq('undefined input', M.parseJsonl(undefined).memories, []);
{
  const r = M.parseJsonl('{"id":"m_a","text":"one"}\n{ broken\n{"id":"m_b","text":"two"}\n');
  eq('a corrupt line costs only itself', r.memories.map(m => m.text), ['one', 'two']);
  eq('and is counted', r.skipped, 1);
}
eq('blank lines ignored', M.parseJsonl('\n\n{"id":"m_a","text":"x"}\n\n').memories.length, 1);
eq('record with no text is dropped', M.parseJsonl('{"id":"m_a","text":"  "}').memories, []);
eq('missing id is synthesized', M.parseJsonl('{"text":"x"}').memories[0].id.startsWith('m_'), true);

console.log('\nmigration from the pre-tier format');
eq('a record with no pinned field stays in the prompt',
   M.parseJsonl('{"id":"m_a","text":"legacy fact"}').memories[0].pinned, true);
eq('explicit false is honoured',
   M.parseJsonl('{"id":"m_a","text":"x","pinned":false}').memories[0].pinned, false);
eq('legacy defaults survive a round-trip', (() => {
  const legacy = M.parseJsonl('{"id":"m_a","text":"legacy fact"}').memories;
  return M.parseJsonl(M.serializeJsonl(legacy)).memories[0].pinned;
})(), true);
eq('an over-budget legacy file is not silently trimmed', (() => {
  let lines = '';
  for (let i = 0; i < M.MAX_PINNED + 30; i++) lines += `{"id":"m_${i}","text":"legacy ${i}"}\n`;
  const loaded = M.parseJsonl(lines).memories;
  return [loaded.length, M.countPinned(loaded)];
})(), [M.MAX_PINNED + 30, M.MAX_PINNED + 30]);

console.log('\nround-trip');
{
  const start = M.parseJsonl('{"id":"m_a","text":"one","created":"c","source":"assistant","pinned":true,"tags":["kde"],"lastUsed":"u","useCount":3}').memories;
  eq('serialize -> parse is stable', M.parseJsonl(M.serializeJsonl(start)).memories, start);
  eq('empty list serializes to empty string', M.serializeJsonl([]), '');
  eq('tags are normalized on write', M.parseJsonl(M.serializeJsonl(
      [{ id: 'm_a', text: 'x', tags: ['  KDE Plasma ', 'kde plasma', ''] }])).memories[0].tags,
     ['kde-plasma']);
}

console.log('\naddMemory');
{
  let r = M.addMemory([], 'Sam prefers dark themes', NOW, 'assistant');
  eq('added', r.added, true);
  eq('stored trimmed text', r.memories[0].text, 'Sam prefers dark themes');
  eq('carries created + source', [r.memories[0].created, r.memories[0].source], [NOW, 'assistant']);
  eq('pins itself while there is room', r.pinned, true);

  eq('empty text refused', M.addMemory([], '   ', NOW).added, false);
  eq('and says why', M.addMemory([], '', NOW).reason, 'empty');

  const dup = M.addMemory(r.memories, 'sam prefers dark themes.', NOW);
  eq('case/punctuation-insensitive duplicate refused', dup.added, false);
  eq('duplicate reports the existing id', dup.id, r.memories[0].id);
  eq('duplicate does not grow the list', dup.memories.length, 1);

  const long = M.addMemory([], 'x'.repeat(M.MAX_TEXT + 50), NOW);
  eq('over-long text truncated to the cap', long.memories[0].text.length, M.MAX_TEXT);

  eq('input array is never mutated', (() => {
    const orig = [];
    M.addMemory(orig, 'a', NOW);
    return orig.length;
  })(), 0);

  eq('explicit pinned:false archives even with room',
     M.addMemory([], 'narrow detail', NOW, '', { pinned: false }).pinned, false);
  eq('tags are stored', M.addMemory([], 'the printer is a Brother HL', NOW, '', { tags: ['hardware'] })
     .memories[0].tags, ['hardware']);
}

console.log('\npin budget');
{
  let list = [];
  for (let i = 0; i < M.MAX_PINNED; i++) list = M.addMemory(list, 'pinned fact ' + i, NOW).memories;
  eq('first MAX_PINNED all pin', M.countPinned(list), M.MAX_PINNED);

  const overflow = M.addMemory(list, 'one more fact', NOW);
  eq('the next one is still saved', overflow.added, true);
  eq('but archived, not pinned', overflow.pinned, false);
  eq('and the pinned set is untouched', M.countPinned(overflow.memories), M.MAX_PINNED);

  const forced = M.addMemory(list, 'insistently pinned', NOW, '', { pinned: true });
  eq('an explicit pin over budget is refused', forced.pinned, false);
  eq('with a reason the tool can report', forced.reason, 'pin_budget');
  eq('the fact itself is not lost', forced.added, true);
}

console.log('\nsetPinned');
{
  const list = seed(['fact one', 'fact two']);
  const un = M.setPinned(list, list[0].id, false);
  eq('unpin works', [un.changed, un.memories[0].pinned], [true, false]);
  eq('re-pin works', M.setPinned(un.memories, list[0].id, true).memories[0].pinned, true);
  eq('unknown id reported', M.setPinned(list, 'm_nope', true).reason, 'notfound');
  eq('no-op reported', M.setPinned(list, list[0].id, true).reason, 'unchanged');
  eq('input array is never mutated', (() => {
    const orig = seed(['a']);
    M.setPinned(orig, orig[0].id, false);
    return orig[0].pinned;
  })(), true);
  eq('pinning over budget is refused', (() => {
    let l = [];
    for (let i = 0; i < M.MAX_PINNED; i++) l = M.addMemory(l, 'p' + i, NOW).memories;
    l = M.addMemory(l, 'archived one', NOW).memories;
    const target = l[l.length - 1];
    return M.setPinned(l, target.id, true).reason;
  })(), 'pin_budget');
}

console.log('\nMAX_MEMORIES eviction never touches pinned entries');
{
  let list = [];
  for (let i = 0; i < M.MAX_PINNED; i++) list = M.addMemory(list, 'pinned ' + i, NOW).memories;
  for (let i = 0; i < M.MAX_MEMORIES + 5; i++) list = M.addMemory(list, 'archived ' + i, NOW).memories;
  eq('capped at MAX_MEMORIES', list.length, M.MAX_MEMORIES);
  eq('every pinned entry survived', M.countPinned(list), M.MAX_PINNED);
  eq('oldest archived evicted first', M.archivedMemories(list)[0].text, 'archived 25');
  eq('newest kept', list[list.length - 1].text, 'archived ' + (M.MAX_MEMORIES + 4));
}

console.log('\nremoveMemory');
{
  const list = seed(['Sam uses Fedora', 'Sam has an HP desktop']);
  const byId = M.removeMemory(list, list[0].id);
  eq('removed by id', byId.removed, true);
  eq('returns what was removed', byId.text, 'Sam uses Fedora');
  eq('other entry survives', byId.memories.length, 1);

  const byText = M.removeMemory(list, 'hp desktop');
  eq('removed by case-insensitive substring', byText.removed, true);
  eq('the right one', byText.text, 'Sam has an HP desktop');

  eq('no match reports false', M.removeMemory(list, 'nothing like this').removed, false);
  eq('no match leaves list intact', M.removeMemory(list, 'zzz').memories.length, 2);
  eq('empty target refused', M.removeMemory(list, '  ').removed, false);
  eq('id match wins over substring', (() => {
    const l = [{ id: 'm_1', text: 'contains m_2 inside' }, { id: 'm_2', text: 'other' }];
    return M.removeMemory(l, 'm_2').text;
  })(), 'other');
}

console.log('\nsearchMemories');
{
  const ARCHIVE = [
    'The office printer is a Brother HL-L2350DW on the hallway shelf',
    'Sam runs Fedora 42 on the workstation called ravenclaw',
    'The backup NAS is a Synology DS220 named vault',
    'Sam prefers tea over coffee in the afternoon',
    'The garage door opener battery is a CR2032',
    'Deploys for the payroll service go through the staging cluster first'
  ];
  const list = seed(ARCHIVE, { pinned: false });

  eq('everything is archived', M.countPinned(list), 0);

  const printer = M.searchMemories(list, 'printer model');
  eq('finds the printer', printer.results[0].memory.text.indexOf('Brother') !== -1, true);
  eq('reports how much was searched', printer.scanned, ARCHIVE.length);

  eq('finds the NAS by a distinctive word',
     M.searchMemories(list, 'synology').results[0].memory.text.indexOf('Synology') !== -1, true);
  eq('finds by hostname',
     M.searchMemories(list, 'ravenclaw').results[0].memory.text.indexOf('ravenclaw') !== -1, true);
  eq('multi-word query ranks the right entry first',
     M.searchMemories(list, 'where do payroll deploys go').results[0].memory.text.indexOf('payroll') !== -1, true);

  eq('an unrelated query returns nothing', M.searchMemories(list, 'quantum chromodynamics').results, []);
  eq('an empty query returns nothing', M.searchMemories(list, '').results, []);
  eq('a stopword-only query returns nothing', M.searchMemories(list, 'the and of').results, []);
  eq('no memories returns nothing', M.searchMemories([], 'printer').results, []);

  eq('results are capped', (() => {
    let big = [];
    for (let i = 0; i < 40; i++) big = M.addMemory(big, 'printer note number ' + i, NOW, '', { pinned: false }).memories;
    return M.searchMemories(big, 'printer').results.length;
  })(), M.RECALL_LIMIT);
  eq('limit is overridable', M.searchMemories(list, 'sam', { limit: 1 }).results.length, 1);

  eq('pinned entries are skipped — they are already in the prompt', (() => {
    const mixed = M.addMemory(list, 'The lobby printer is out of toner', NOW, '', { pinned: true }).memories;
    return M.searchMemories(mixed, 'printer').results.every(r => r.memory.pinned !== true);
  })(), true);
  eq('includePinned opts back in', (() => {
    const mixed = M.addMemory(list, 'The lobby printer is out of toner', NOW, '', { pinned: true }).memories;
    return M.searchMemories(mixed, 'lobby printer', { includePinned: true })
             .results.some(r => r.memory.pinned === true);
  })(), true);

  eq('a tag hit counts', (() => {
    const tagged = M.addMemory([], 'CR2032 goes in the little remote', NOW, '', { pinned: false, tags: ['garage'] }).memories;
    return M.searchMemories(tagged, 'garage').results.length;
  })(), 1);

  eq('ordering is stable across identical queries', (() => {
    const a = M.searchMemories(list, 'sam').results.map(r => r.memory.id).join(',');
    const b = M.searchMemories(list, 'sam').results.map(r => r.memory.id).join(',');
    return a === b;
  })(), true);

  eq('non-ASCII text is searchable', (() => {
    const l = seed(['Le café préféré de Sam est près de la gare'], { pinned: false });
    return M.searchMemories(l, 'café').results.length;
  })(), 1);

  eq('search never mutates the store', (() => {
    const before = JSON.stringify(list);
    M.searchMemories(list, 'printer');
    return JSON.stringify(list) === before;
  })(), true);
}

console.log('\nmarkUsed');
{
  const list = seed(['a fact', 'another fact'], { pinned: false });
  const marked = M.markUsed(list, [list[0].id], NOW);
  eq('counts the use', marked.memories[0].useCount, 1);
  eq('stamps the time', marked.memories[0].lastUsed, NOW);
  eq('leaves others alone', marked.memories[1].useCount, 0);
  eq('reports whether anything changed', M.markUsed(list, ['m_nope'], NOW).changed, false);
  eq('empty id list is a no-op', M.markUsed(list, [], NOW).changed, false);
  eq('input array is never mutated', (() => {
    const orig = seed(['x'], { pinned: false });
    M.markUsed(orig, [orig[0].id], NOW);
    return orig[0].useCount;
  })(), 0);
}

console.log('\nformatSearchResults');
{
  const list = seed(['The office printer is a Brother HL-L2350DW'], { pinned: false });
  const res = M.searchMemories(list, 'printer').results;
  const text = M.formatSearchResults(res);
  eq('includes the fact', text.indexOf('Brother') !== -1, true);
  eq('exposes the id so forget can target it', text.indexOf('[' + list[0].id + ']') !== -1, true);
  eq('no hits produces a plain sentence, not an empty string',
     M.formatSearchResults([]).length > 0, true);
  eq('custom empty label honoured (localization)',
     M.formatSearchResults([], { empty: 'Rien.' }), 'Rien.');
}

console.log('\nbuildPromptSection');
{
  eq('no memories -> no section at all', M.buildPromptSection([]), '');
  eq('undefined -> no section', M.buildPromptSection(undefined), '');

  const pinned = seed(['Sam uses Fedora']);
  const sec = M.buildPromptSection(pinned, null, { recallAvailable: true });
  eq('has a heading', sec.indexOf('## Memory') !== -1, true);
  eq('includes the fact', sec.indexOf('Sam uses Fedora') !== -1, true);
  eq('exposes the id so forget can target it', sec.indexOf('[' + pinned[0].id + ']') !== -1, true);
  eq('no archive line when nothing is archived', sec.indexOf('archive') !== -1, false);
  eq('custom labels honoured (localization)',
     M.buildPromptSection(pinned, { heading: 'Mémoire', intro: 'Faits.' }).indexOf('## Mémoire') !== -1, true);

  const mixed = M.addMemory(pinned, 'a narrow detail about the printer', NOW, '', { pinned: false }).memories;
  const withArchive = M.buildPromptSection(mixed, null, { recallAvailable: true });
  eq('archive is counted, not listed', withArchive.indexOf('narrow detail') === -1, true);
  eq('and the count is stated', withArchive.indexOf('1 further saved') !== -1, true);
  eq('recall is named', withArchive.indexOf('recall') !== -1, true);

  eq('no archive line when recall is unavailable',
     M.buildPromptSection(mixed, null, { recallAvailable: false }).indexOf('further saved'), -1);
  eq('nor when opts is omitted entirely',
     M.buildPromptSection(mixed).indexOf('further saved'), -1);
  eq('pinned facts still print without recall',
     M.buildPromptSection(mixed).indexOf('Sam uses Fedora') !== -1, true);

  eq('archive-only store still gets its index', (() => {
    const onlyArchive = seed(['some archived thing'], { pinned: false });
    return M.buildPromptSection(onlyArchive, null, { recallAvailable: true }).indexOf('## Memory archive') !== -1;
  })(), true);

  eq('tags are surfaced as topics', (() => {
    let l = M.addMemory([], 'printer fact', NOW, '', { pinned: false, tags: ['hardware'] }).memories;
    l = M.addMemory(l, 'kde fact', NOW, '', { pinned: false, tags: ['desktop'] }).memories;
    return M.buildPromptSection(l, null, { recallAvailable: true }).indexOf('desktop, hardware') !== -1;
  })(), true);
  eq('collectTags ignores pinned entries', (() => {
    const l = M.addMemory([], 'pinned thing', NOW, '', { pinned: true, tags: ['secret'] }).memories;
    return M.collectTags(l);
  })(), []);
}

console.log('\nthe prompt stays bounded as the archive grows');
{
  let list = [];
  for (let i = 0; i < 500; i++) list = M.addMemory(list, 'distinct fact number ' + i + ' about topic ' + i, NOW).memories;
  const sec = M.buildPromptSection(list, null, { recallAvailable: true });
  eq('only the pinned budget is listed', (sec.match(/\n- \[/g) || []).length, M.MAX_PINNED);
  eq('the rest are reachable by search',
     M.searchMemories(list, 'topic 300').results[0].memory.text.indexOf('number 300') !== -1, true);
}

console.log('\nids are unique');
{
  const seen = {};
  let collisions = 0;
  for (let i = 0; i < 5000; i++) {
    const id = M.makeId();
    if (seen[id]) collisions++;
    seen[id] = true;
  }
  eq('5000 generated ids, no collisions', collisions, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
