// Resolves the QML source tree relative to this file, so the suites run from
// any working directory and survive the repo being cloned elsewhere.
const path = require('path');
const UI = path.resolve(__dirname, '..', 'package', 'contents', 'ui');
module.exports = { UI, UI_SLASH: UI + path.sep };
