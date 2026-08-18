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
cp.execSync(cmd, { shell: '/bin/bash' });

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
