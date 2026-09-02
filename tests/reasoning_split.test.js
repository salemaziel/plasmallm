// reasoningSplit.js — inlined <think> reasoning routed to the thinking channel.
//
// The regression this guards is observable in a real chat log: minimax-m3
// stored its whole scratchpad inside the message content as <think> tags,
// while `thinking` and `thinking_blocks_json` were both empty. Every
// gpt-5.6-luna log in the same directory has the opposite shape, which is what
// proves the storage layer was fine and only the routing was wrong.
const { load } = require('./qmlmodule');
const RS = load('reasoningSplit.js');

let passed = 0, failed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { passed++; }
    else { failed++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
}

console.log('split — leading-tag gate');
// Verbatim from ~/.local/share/plasmallm/chats/2026-09-01_16-44.jsonl
const REAL = "<think>The user is just greeting me casually. No tools needed. Keep it short and "
           + "conversational as per systeminstructions.</think>\n\nHey, not much — just here ready to help. What's up?";
eq('the real minimax response splits cleanly', RS.split(REAL).visible,
   "Hey, not much — just here ready to help. What's up?");
eq('and its reasoning is captured', RS.split(REAL).thinking,
   'The user is just greeting me casually. No tools needed. Keep it short and conversational as per systeminstructions.');
eq('and it is marked inline', RS.split(REAL).inline, true);

eq('no tag -> passthrough, untouched', RS.split('Just a normal reply.'),
   { visible: 'Just a normal reply.', thinking: '', open: false, inline: false });
// The gate is what stops a reply that merely discusses the tag being eaten.
eq('a tag that does not lead is left alone',
   RS.split('Here is how it works: <think>not reasoning</think> see?').inline, false);
eq('and that text survives byte-for-byte',
   RS.split('Here is how it works: <think>not reasoning</think> see?').visible,
   'Here is how it works: <think>not reasoning</think> see?');
eq('leading whitespace still counts as leading', RS.split('\n  <think>a</think>b').thinking, 'a');
eq('<thinking> is accepted too', RS.split('<thinking>a</thinking>b').thinking, 'a');

console.log('split — streaming states');
eq('an unterminated block is open', RS.split('<think>half a thou').open, true);
eq('an unterminated block shows nothing yet', RS.split('<think>half a thou').visible, '');
eq('an unterminated block still yields its text', RS.split('<think>half a thou').thinking, 'half a thou');
eq('a closed block is not open', RS.split('<think>a</think>b').open, false);
eq('two blocks both collected', RS.split('<think>a</think>mid<think>b</think>end').thinking, 'ab');
eq('two blocks keep the visible text between them',
   RS.split('<think>a</think>mid<think>b</think>end').visible, 'midend');
// A tag split across two SSE deltas must not flash as visible text.
eq('a partial open tag is withheld', RS.split('<think>a</think>b<thi').visible, 'b');
eq('a complete later tag is not withheld', RS.split('<think>a</think>b<c>').visible, 'b<c>');

console.log('wrapStreamOpts — routing');
function collect(chunks, fullText) {
    const out = { chunk: [], thinking: [], complete: null };
    const w = RS.wrapStreamOpts({
        onChunk: (d, a) => out.chunk.push([d, a]),
        onThinkingChunk: (d, a) => out.thinking.push([d, a]),
        onComplete: (t, e, tc, am) => { out.complete = t; }
    });
    let acc = '';
    for (const c of chunks) { acc += c; w.onChunk(c, acc); }
    w.onComplete(fullText === undefined ? acc : fullText, null, null, null);
    return out;
}

let r = collect(['<think>rea', 'soning</think>', '\n\nHello', ' there']);
eq('reply reaches onChunk without the tags', r.chunk.map(x => x[0]).join(''), 'Hello there');
eq('reasoning reaches onThinkingChunk', r.thinking.map(x => x[0]).join(''), 'reasoning');
eq('accumulated reply never contains a tag', r.chunk.every(x => x[1].indexOf('<think') === -1), true);
eq('onComplete gets the stripped text — this is what stops history replay',
   r.complete, 'Hello there');

r = collect(['No reasoning ', 'at all.']);
eq('native path: deltas forwarded byte-for-byte', r.chunk.map(x => x[0]), ['No reasoning ', 'at all.']);
eq('native path: thinking channel untouched', r.thinking.length, 0);
eq('native path: onComplete unchanged', r.complete, 'No reasoning at all.');

console.log('wrapStreamOpts — OpenCode retry restart');
// A rejected format restarts the stream from empty. Diffing the second attempt
// against the first one's output would emit nothing at all.
(function () {
    const out = { chunk: [], thinking: [] };
    const w = RS.wrapStreamOpts({
        onChunk: (d, a) => out.chunk.push(d),
        onThinkingChunk: (d, a) => out.thinking.push(d),
        onComplete: () => {}
    });
    w.onChunk('<think>a</think>first', '<think>a</think>first');
    w.onChunk('<think>b</think>second', '<think>b</think>second'); // restart: shorter than prev
    eq('second attempt still emits its reply', out.chunk.join('').indexOf('second') !== -1, true);
    eq('second attempt still emits its reasoning', out.thinking.join('').indexOf('b') !== -1, true);
})();

console.log('\nno thinkingBlocks are synthesised');
// Unsigned blocks invented here would be replayed verbatim and rejected.
(function () {
    let seen = null;
    const w = RS.wrapStreamOpts({
        onChunk: () => {}, onThinkingChunk: () => {},
        onComplete: (t, e, tc, am) => { seen = am; }
    });
    const msg = { role: 'assistant' };
    w.onComplete('<think>a</think>b', null, null, msg);
    eq('assistantMsg is passed through unmodified', seen, { role: 'assistant' });
    eq('no thinkingBlocks added', seen.thinkingBlocks, undefined);
})();

console.log('\nchunk-boundary exhaustion');
// The bug this replaces was found in production, not here, because the
// original suite only tried hand-picked chunk splits and none of them landed
// inside "</think>". A boundary there leaks the partial close tag into the
// reasoning pane, and the corrected text is SHORTER than what was already
// shown — so a grow-only emit guard never repairs it. Every boundary is
// cheap to check, so check every boundary.
(function () {
    const RAW = '<think>The user just said "yo" - a casual greeting. No tools needed, '
              + 'just a brief friendly response.</think>Yo! What\'s up?';
    const WANT_T = 'The user just said "yo" - a casual greeting. No tools needed, '
                 + 'just a brief friendly response.';
    const WANT_V = "Yo! What's up?";

    function drive(chunks) {
        let lastT = '', lastV = '', complete = null;
        const w = RS.wrapStreamOpts({
            onChunk: (d, a) => { lastV = a; },
            onThinkingChunk: (d, a) => { lastT = a; },
            onComplete: (t) => { complete = t; }
        });
        let acc = '';
        for (const c of chunks) { acc += c; w.onChunk(c, acc); }
        w.onComplete(acc, null, null, null);
        return { lastT, lastV, complete };
    }

    let badT = 0, badV = 0;
    for (let i = 1; i < RAW.length; i++) {
        const r = drive([RAW.slice(0, i), RAW.slice(i)]);
        if (r.lastT !== WANT_T) badT++;
        if (r.lastV !== WANT_V || r.complete !== WANT_V) badV++;
    }
    eq('every 2-chunk boundary yields the exact reasoning', badT, 0);
    eq('every 2-chunk boundary yields the exact reply', badV, 0);

    // Character-by-character is the realistic worst case for a token stream,
    // and it failed 100% of the time before the fix.
    const c = drive(RAW.split(''));
    eq('char-by-char reasoning is exact', c.lastT, WANT_T);
    eq('char-by-char reply is exact', c.lastV, WANT_V);
    eq('char-by-char onComplete is exact', c.complete, WANT_V);

    // A partial CLOSING tag must never be shown as reasoning.
    eq('a half-arrived close tag is withheld',
       RS.split('<think>done.</thi').thinking, 'done.');
    eq('and the block is still open', RS.split('<think>done.</thi').open, true);
})();

console.log('\napi.js wiring');
// The splitter is inert unless api.js actually applies it. Structural, because
// stubbing the adapter registry through the .pragma library loader is not
// worth the machinery — but an unwired module is a silent no-op, so the
// wiring needs a guard of its own.
(function () {
    const fs = require('fs');
    const path = require('path');
    const { UI } = require('./paths');
    const src = fs.readFileSync(path.resolve(UI, 'api.js'), 'utf8');
    eq('api.js imports reasoningSplit.js',
       /\.import\s+"reasoningSplit\.js"\s+as\s+ReasoningSplit/.test(src), true);
    eq('sendStreaming passes opts through wrapStreamOpts',
       /sendStreaming\s*\(\s*ReasoningSplit\.wrapStreamOpts\s*\(\s*opts\s*\)\s*\)/.test(src), true);
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
