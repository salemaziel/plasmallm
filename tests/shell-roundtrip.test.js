// Memories are persisted by handing a `printf '%s' '<escaped>'` command to a
// DataSource, so the shell — not JSON — is the last thing standing between a
// saved fact and a corrupted store. This drives the exact command string
// main.qml builds through a real bash and reads the file back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { UI } = require('./paths');

const src = fs.readFileSync(path.join(UI, 'memoryStore.js'), 'utf8')
    .replace(/^\s*\.pragma library\s*$/m, '');
const mod = {};
new Function('module', 'console', src + '\nmodule.exports={parseJsonl,serializeJsonl,addMemory};')(mod, console);
const M = mod.exports;

const HOSTILE = [
    "Sam's laptop is called \"ravenclaw\"",
    'Backup path is $HOME/media and costs $5',
    'Never run `rm -rf /` or $(id -u) as root',
    'Windows share is \\\\nas\\public — note the backslashes',
    'printf codes %s %d %% appear in the log format',
    'Tags: newline\nand tab\there'
];

let list = [];
for (const t of HOSTILE) {
    list = M.addMemory(list, t, '2026-08-17T12:00:00.000Z', 'test', { tags: ["it's", 'a "tag"'] }).memories;
}

const text = M.serializeJsonl(list);
// The escaping from main.qml persistMemories(), character for character.
const escaped = text.replace(/'/g, "'\\''");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plasmallm-test-'));
const out = path.join(dir, 'memories.jsonl');
const cmd = `mkdir -p "$(dirname ${out})" && printf '%s' '${escaped}' > "${out}"`;
// /bin/sh, NOT bash. P5Support's executable DataSource runs every command
// through /bin/sh, which is dash on Debian and Ubuntu. Testing under bash
// makes this suite pass on syntax the widget will never successfully run —
// that gap is exactly how `sort -t$'\t'` reached production in
// fetchHistoryList() and silently emptied the history list.
cp.execSync(cmd, { shell: '/bin/sh' });

const back = M.parseJsonl(fs.readFileSync(out, 'utf8')).memories;
let pass = 0, fail = 0;
for (let i = 0; i < list.length; i++) {
    const got = back[i];
    const same = got && got.text === list[i].text
        && JSON.stringify(got.tags) === JSON.stringify(list[i].tags)
        && got.pinned === list[i].pinned;
    same ? (pass++, console.log('  ok   ' + JSON.stringify(list[i].text).slice(0, 62)))
         : (fail++, console.log('  FAIL ' + JSON.stringify(list[i].text) + '\n         got ' + JSON.stringify(got)));
}
fs.rmSync(dir, { recursive: true, force: true });

// --- fetchHistoryList under the production shell --------------------------
//
// Pulls the real command expression out of main.qml and runs it under
// /bin/sh against fixture files. `sort -t$'\t'` passed review, worked in every
// bash the author tried, and returned NOTHING under dash — and because sort
// sits mid-pipeline, `head` still exited 0, so the widget saw a successful
// command with empty stdout and rendered "No recent chats" beside a folder
// full of them. A test that only ran bash could never have caught it.
{
    const { UI } = require('./paths');
    const eq = (label, got, want) => {
        JSON.stringify(got) === JSON.stringify(want)
            ? (pass++, console.log('  ok   ' + label))
            : (fail++, console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
    };

    const qml = fs.readFileSync(path.join(UI, 'main.qml'), 'utf8');
    const start = qml.indexOf('function fetchHistoryList()');
    const body = qml.slice(start, qml.indexOf('\n    }\n', start));
    const m = body.match(/var cmd = ([\s\S]*?);\n/);
    eq('the fetchHistoryList command expression was located', !!m, true);

    if (m) {
        // The expression is pure concatenation over chatsDir and TAB.
        const build = new Function('chatsDir', 'TAB', 'return ' + m[1] + ';');
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plasmallm-hist-'));
        const chats = path.join(fixture, 'plasmallm', 'chats');
        fs.mkdirSync(chats, { recursive: true });
        const files = ['2026-01-01_09-00.jsonl', '2026-01-02_09-00.jsonl', '2026-01-03_09-00.jsonl'];
        files.forEach((f, i) => {
            fs.writeFileSync(path.join(chats, f),
                '{"_type":"meta","model":"m"}\n{"role":"user","content":"question ' + i + '"}\n');
            // Distinct mtimes, oldest first, so newest-first ordering is provable.
            const when = new Date(Date.now() - (files.length - i) * 60000);
            fs.utimesSync(path.join(chats, f), when, when);
        });

        const cmd = build(chats, '\t');
        eq('no ANSI-C quoting survives into the command', cmd.indexOf("$'"), -1);

        // A broken command here yields no rows rather than a non-zero exit —
        // that is the whole failure mode — so every assertion below must
        // survive an empty result and report it, not throw.
        let out = '';
        try {
            out = cp.execSync(cmd, { shell: '/bin/sh', encoding: 'utf8' });
        } catch (e) {
            out = (e && e.stdout) ? String(e.stdout) : '';
        }
        const rows = out.split('\n').filter(l => l.trim().length > 0);
        eq('every chat file is listed', rows.length, files.length);
        eq('newest first', rows.map(r => path.basename(r.split('\t')[0])),
           files.slice().reverse());
        // rows.length is part of the claim: [].every() is vacuously true, so
        // without it this assertion passes loudest exactly when nothing works.
        eq('each row is filePath TAB mtime TAB preview',
           rows.length > 0 && rows.every(r => r.split('\t').length === 3), true);
        eq('the preview carries the first user message',
           rows.length > 0 ? rows[0].split('\t')[2] : '<no rows>', 'question 2');
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
