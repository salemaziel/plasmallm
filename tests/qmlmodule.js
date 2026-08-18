// Loads a QML JavaScript library into Node by stripping `.pragma library` and
// resolving its `.import` chain, so tests exercise the real files rather than a
// copy. Only for suites that need a module's genuine dependencies (toolManager
// reaching the tool registry, api.js reaching toolManager); suites that want to
// stub a dependency out strip the imports themselves instead.
const fs = require('fs');
const path = require('path');
const { UI } = require('./paths');

const cache = {};

function load(rel) {
    const abs = path.resolve(UI, rel);
    if (cache[abs]) return cache[abs];
    const ns = {};
    cache[abs] = ns; // seeded before evaluation so import cycles terminate

    let src = fs.readFileSync(abs, 'utf8').replace(/^\s*\.pragma library\s*$/m, '');
    const deps = [];
    src = src.replace(/^\s*\.import\s+"([^"]+)"\s+as\s+(\w+)\s*$/gm, (m, file, alias) => {
        deps.push([alias, path.join(path.dirname(rel), file)]);
        return '';
    });

    // QML libraries have no export statement; expose every top-level binding.
    const decls = [];
    const re = /^(?:function\s+(\w+)|var\s+(\w+)\s*=)/gm;
    let m;
    while ((m = re.exec(src))) decls.push(m[1] || m[2]);
    const unique = [...new Set(decls)];
    const body = src + '\nreturn {' +
        unique.map(n => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(',') + '};';

    const stubQt = { btoa: s => Buffer.from(s).toString('base64') };
    const out = new Function(...deps.map(d => d[0]), 'console', 'Qt', 'XMLHttpRequest', body)(
        ...deps.map(d => load(d[1])), console, stubQt, function () {});
    Object.assign(ns, out);
    return ns;
}

module.exports = { load };
