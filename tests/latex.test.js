// The fallback LaTeX replacement in api.js. The case that matters: dollar signs
// inside code are literal. A regex like ^a$ in a code block was being read as
// inline math and mangled.
const { load } = require('./qmlmodule');

let pass = 0, fail = 0;
const eq = (l, g, w) => JSON.stringify(g) === JSON.stringify(w)
  ? (pass++, console.log('  ok   ' + l))
  : (fail++, console.log(`  FAIL ${l}\n         got  ${JSON.stringify(g)}\n         want ${JSON.stringify(w)}`));

const Api = load('api.js');
const r = Api.replaceLatexSymbols;

console.log('\nmath in prose is still replaced');
eq('inline $...$', r('Energy $E=mc^2$ here'), 'Energy  `E=mc²`  here');
eq('greek letter', r('angle $\\alpha$'), 'angle  `α` ');

console.log('\ncode is left alone');
const regexReply = '```regex\n^(?=.{3,32}$)(?=.*[0-9]{2}$)[a-z0-9_]+$\n```\n\nUse the **i** flag.';
eq('fenced block with $ anchors', r(regexReply), regexReply);
eq('tilde fence', r('~~~\n$a$\n~~~'), '~~~\n$a$\n~~~');
eq('unclosed fence (still streaming)', r('```\nx $a$ y'), '```\nx $a$ y');
eq('inline code span', r('use `a$b$c` here'), 'use `a$b$c` here');
eq('double-backtick span', r('``a`$b$`` ok'), '``a`$b$`` ok');

console.log('\nmath between code is still replaced');
eq('after a fence', r('```\n$a$\n```\nthen $b$'), '```\n$a$\n```\nthen  `b` ');
eq('between two inline spans', r('`x` $\\beta$ `y`'), '`x`  `β`  `y`');

console.log('\na stray backtick does not swallow later code or math');
const stray = 'Type a backtick (`) like this:\n\n```js\nconst s = `$x$`;\n```';
eq('fence after a stray backtick stays literal', r(stray), stray);
eq('stray backtick does not cross a blank line', r('a ` b\n\nthen $\\alpha$'), 'a ` b\n\nthen  `α` ');
eq('unpartnered backtick run is literal', r('`` x ` $\\pi$'), '`` x `  `π` ');

console.log('\nuser message line breaks');
const k = Api.keepLineBreaks;
eq('single break becomes a hard break', k('one\ntwo'), 'one  \ntwo');
eq('blank line (paragraph) untouched', k('one\n\ntwo'), 'one\n\ntwo');
eq('fenced code untouched', k('a\n```\nx\ny\n```\nb'), 'a\n```\nx\ny\n```\nb');
eq('CRLF line endings', k('one\r\ntwo'), 'one  \r\ntwo');
eq('stray backtick does not hide later breaks', k('a ` b\nc\n\nd\ne'), 'a ` b  \nc\n\nd  \ne');
eq('list items keep their breaks', k('- a\n- b'), '- a  \n- b');

console.log('\ncode blocks become wrapping <pre> blocks (Qt never wraps a fenced line)');
const w = Api.wrapCodeBlocks;
const PRE = '<table width="100%"><tr><td><pre style="white-space: pre-wrap;">';
eq('fence with language', w('Use:\n\n```latex\n\\texttt{a}\n```\nok'), 'Use:\n\n\n' + PRE + '\\texttt{a}</pre></td></tr></table>\n\nok');
eq('HTML characters escaped', w('```\na<b && c>d\n```'), '\n' + PRE + 'a&lt;b &amp;&amp; c&gt;d</pre></td></tr></table>\n');
eq('indentation and blank lines kept', w('```\n  x\n\n  y\n```'), '\n' + PRE + '  x\n\n  y</pre></td></tr></table>\n');
eq('tilde fence', w('~~~\nz\n~~~'), '\n' + PRE + 'z</pre></td></tr></table>\n');
eq('unclosed fence (still streaming)', w('```\npartial'), '\n' + PRE + 'partial</pre></td></tr></table>\n');
eq('inline code untouched', w('use `a$b` here'), 'use `a$b` here');
eq('two blocks', w('```\na\n```\nmid\n```\nb\n```'), '\n' + PRE + 'a</pre></td></tr></table>\n\nmid\n\n' + PRE + 'b</pre></td></tr></table>\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
