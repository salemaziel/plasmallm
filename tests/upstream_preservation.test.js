// SPDX-FileCopyrightText: 2026 Joshua Roman
// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise the upstream initialization changes against existing fork state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { UI } = require('./paths');
const Profiles = require('./qmlmodule').load('profiles.js');
let passed = 0;
function check(condition) { assert.ok(condition); passed++; }

for (const raw of ['{broken', 'null', '{}', '"saved"']) {
    for (const prefix of ['', 'cfg_']) {
        const config = { [prefix + 'profiles']: raw, [prefix + 'activeProfileId']: 'saved' };
        Profiles.ensureDefault(config, 'Default');
        check(config[prefix + 'profiles'] === raw);
        check(config[prefix + 'activeProfileId'] === 'saved');
    }
}
for (const raw of ['', '[]']) {
    const config = { profiles: raw, activeProfileId: '' };
    const seeded = Profiles.ensureDefault(config, 'Default');
    check(seeded.length === 1 && seeded[0].id === 'p_default');
    check(config.activeProfileId === 'p_default');
}
const saved = { profiles: '[{"id":"custom","name":"My profile"}]', activeProfileId: 'custom' };
const before = JSON.stringify(saved);
Profiles.ensureDefault(saved, 'Default');
check(JSON.stringify(saved) === before);

// Execute the actual QML function body with its runtime dependencies supplied.
const qml = fs.readFileSync(UI + '/main.qml', 'utf8');
const start = qml.indexOf('    function initSystemPrompt() {');
const end = qml.indexOf('    function regatherSysInfo()', start);
assert.ok(start >= 0 && end > start);
const messages = [];
const memories = [{ text: 'Keep my customization' }];
let failBuild = true;
const warnings = [];
const context = {
    Api: { buildSystemPrompt(info, template, opts) {
        if (failBuild) throw new Error('prompt unavailable');
        check(opts.memories === memories);
        return 'Prompt with customization';
    } },
    Plasmoid: { configuration: { memoryEnabled: true } },
    root: { memories, sessionChipText() { return ''; } },
    sysInfo: {}, i18n() {}, getToolsConfig() { return {}; },
    systemPromptReady: false,
    sysInfoTimeout: { stop() {} },
    console: { warn(message) { warnings.push(message); } },
    chatMessages: {
        get count() { return messages.length; },
        append(message) { messages.push(message); },
        setProperty(index, key, value) { messages[index][key] = value; }
    }
};
vm.createContext(context);
vm.runInContext(qml.slice(start, end), context);
context.initSystemPrompt();
check(!context.systemPromptReady && messages.length === 0);
check(warnings[0].includes('prompt unavailable'));
failBuild = false;
context.initSystemPrompt();
check(context.systemPromptReady && messages.length === 1);
failBuild = true;
context.initSystemPrompt();
check(!context.systemPromptReady && messages[0].content === 'Prompt with customization');
failBuild = false;
context.initSystemPrompt();
check(context.systemPromptReady && messages.length === 1);
console.log(`${passed} passed, 0 failed`);
