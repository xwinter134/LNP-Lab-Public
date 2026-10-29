// The oldest browser engine the app has to run on, and nothing newer slipping in (usability cycle 5, K5).
//
// The macOS app draws its window with the system's WKWebView, which is the Safari of the installed macOS, and
// src-tauri/tauri.conf.json says which macOS is the oldest it installs on. WebKit cannot run in the cloud
// session, so this is a static scan: every app/**/*.js and index.html, read with the comments taken out, is
// searched for the features below, each with the Safari version that first shipped it. A use the floor does
// not have fails the test unless it is guarded (a feature check, or a fallback the older engine keeps) and is
// listed in ALLOWED with the reason. Two kinds of CSS guard are recognised without a listing, because they can
// be read off the style sheet: a color-mix() in an @supports block, with a plain value for the same rule
// outside it, and the -webkit- declaration just before an unprefixed property.
//
// Checked and within Safari 15.0, so not listed: inset (14.1), aspect-ratio (15.0), gap in flexbox (14.1),
// :is() and :where() (14.0), ??= ||= &&= (14.0), private methods and #x in obj (15.0), top-level await (15.0),
// the RegExp d flag (15.0), Error cause (15.0), Intl.ListFormat and Intl.Segmenter (14.1), File.text() and
// arrayBuffer() (14.0), IDBTransaction.commit() (15.0, and called as commit?.()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The Safari each macOS shipped with: Big Sur (11) came with Safari 14, and every later major release with the
// next major Safari. macOS 12 before 12.3 has Safari 15.0 to 15.3; 12.3 brought 15.4, where most of the list
// below begins. A new minimum in tauri.conf.json needs its line here, so the floor is looked up, never guessed.
const SAFARI_OF_MACOS = { '11.0': '14.0', '12.0': '15.0', '13.0': '16.0', '14.0': '17.0', '15.0': '18.0' };
const MACOS = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle?.macOS?.minimumSystemVersion;
const FLOOR = SAFARI_OF_MACOS[MACOS];

const parts = (v) => String(v).split('.').map(Number);
/** Whether Safari version a is later than b ('15.4' > '15.0'). */
function later(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/* ---------------- reading the sources ---------------- */

const blank = (chars, a, b) => { for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' '; };
// After these words a slash starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * JavaScript, read far enough to know what is code. Three views of the source, each the same length with every
 * line break kept, so a match points at its source line: `text` is the source with its comments blanked out;
 * `code` has its strings, template text and regular expressions blanked as well (a feature named in a message
 * or a pattern is not a use of it); `markup` keeps only the text of strings and templates, which is where the
 * CSS and HTML of a screen live. `problem` says where the reading lost its place, which would leave the rest
 * of the file unscanned.
 */
function lexJs(src) {
  const text = src.split(''), code = src.split(''), regexes = [], n = src.length;
  const braces = []; // one per open brace: true where it opened a template's ${ … }
  let i = 0, last = '', word = '', problem = null;
  const template = () => { // from inside a template literal to its end, or into a ${ … }
    const start = i;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(code, start, i); i++; last = '0'; return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(code, start, i); braces.push(true); i += 2; last = '{'; return; }
      i++;
    }
    problem = `template literal from offset ${start} never ends`;
  };
  while (i < n && !problem) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(text, i, end); blank(code, i, end); i = end; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) { problem = `comment at offset ${i} never ends`; break; }
      blank(text, i, e + 2); blank(code, i, e + 2); i = e + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] !== c) { problem = `string at offset ${i} never ends`; break; }
      blank(code, i + 1, j); i = j + 1; last = '0'; continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/') {
      const regexHere = last === '' || /[(,=:[!&|?{};+\-*%<>~^}]/.test(last) || (last === 'w' && BEFORE_REGEX.has(word));
      if (!regexHere) { i++; last = '/'; continue; }
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (inClass) { if (src[j] === ']') inClass = false; } else if (src[j] === '[') inClass = true; else if (src[j] === '/') break;
        j++;
      }
      if (src[j] !== '/') { problem = `regular expression at offset ${i} never ends`; break; }
      let k = j + 1;
      while (k < n && /[a-z]/i.test(src[k])) k++;
      regexes.push({ start: i, body: src.slice(i + 1, j), flags: src.slice(j + 1, k) });
      blank(code, i + 1, j); i = k; last = '0'; continue;
    }
    if (c === '{') { braces.push(false); i++; last = '{'; continue; }
    if (c === '}') {
      if (!braces.length) { problem = `unmatched } at offset ${i}`; break; }
      i++;
      if (braces.pop()) template(); else last = '}';
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; word = src.slice(i, j); last = 'w'; i = j; continue; }
    if (/\d/.test(c)) { let j = i; while (j < n && /[\w.]/.test(src[j])) j++; last = '0'; i = j; continue; }
    last = c; i++;
  }
  if (!problem && braces.length) problem = `${braces.length} brace(s) never closed`;
  const markup = text.map((c, k) => (c === '\n' || c !== code[k] ? c : ' '));
  for (const r of regexes) blank(markup, r.start, r.start + r.body.length + 2);
  return { text: text.join(''), code: code.join(''), markup: markup.join(''), regexes, problem };
}

/**
 * index.html in the same three views: outside the scripts it is all markup (HTML and CSS, comments blanked), and
 * each inline script is read as JavaScript.
 */
function lexHtml(src) {
  const text = src.split(''), code = src.replace(/[^\n]/g, ' ').split(''), regexes = [];
  let problem = null;
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) blank(text, m.index, m.index + m[0].length);
  for (const m of src.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
    const at = m.index + m[1].length;
    for (const c of m[2].matchAll(/\/\*[\s\S]*?\*\//g)) blank(text, at + c.index, at + c.index + c[0].length);
  }
  const markup = text.slice();
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const at = m.index + m[1].length, js = lexJs(m[2]);
    for (let k = 0; k < m[2].length; k++) { text[at + k] = js.text[k]; code[at + k] = js.code[k]; markup[at + k] = js.markup[k]; }
    regexes.push(...js.regexes.map((r) => ({ ...r, start: r.start + at })));
    problem ||= js.problem && `inline script: ${js.problem}`;
  }
  return { text: text.join(''), code: code.join(''), markup: markup.join(''), regexes, problem };
}

const lex = (file, src) => (file.endsWith('.html') ? lexHtml(src) : lexJs(src));

/* ---------------- what to look for ---------------- */

const all = (view, re) => [...view.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))].map((m) => m.index);
const inCode = (re) => (lx) => all(lx.code, re); // JavaScript, outside strings, template text and regexes
const inMarkup = (re) => (lx) => all(lx.markup, re); // CSS and HTML: the page's, and what screens write in strings
const inText = (re) => (lx) => all(lx.text, re); // everything but comments
const inRegex = (test) => (lx) => lx.regexes.filter(test).map((r) => r.start);

/** The CSS declaration around offset i, and the one before it in the same block or style attribute. */
function declarations(css, i) {
  const startOf = (k) => Math.max(...[';', '{', '"', "'", '`'].map((c) => css.lastIndexOf(c, k))) + 1;
  const endOf = (k) => Math.min(...[';', '}', '"', "'", '`'].map((c) => css.indexOf(c, k)).filter((x) => x >= 0), css.length);
  const parse = (s) => { const c = s.indexOf(':'); return c < 0 ? null : { prop: s.slice(0, c).trim(), value: s.slice(c + 1).trim() }; };
  const start = startOf(i - 1);
  return { here: parse(css.slice(start, endOf(i))), before: css[start - 1] === ';' ? parse(css.slice(startOf(start - 2), start - 1)) : null };
}
// An unprefixed property right after its -webkit- form: the older engine reads the prefixed one.
const prefixedBefore = (lx, i) => {
  const { here, before } = declarations(lx.markup, i);
  return !!(here && before && before.prop === `-webkit-${here.prop}`);
};

/**
 * The rules of the <style> elements: the selector, the at-rules around it, its declarations with their offsets,
 * and whether it sits inside another rule (CSS nesting; @media and @supports holding rules is not nesting).
 */
const RULES = new WeakMap();
function cssRules(lx) {
  if (RULES.has(lx)) return RULES.get(lx);
  const rules = [];
  for (const m of lx.markup.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
    const css = m[2], at = m.index + m[1].length, open = [];
    let from = 0;
    for (let k = 0; k < css.length; k++) {
      const c = css[k];
      if (c === '"' || c === "'") { const e = css.indexOf(c, k + 1); k = e < 0 ? css.length : e; continue; }
      if (c === '{') {
        const raw = css.slice(from, k), prelude = raw.trim().replace(/\s+/g, ' '), parent = open[open.length - 1];
        const block = { prelude, group: prelude.startsWith('@'), within: open.filter((o) => o.group).map((o) => o.prelude), nested: !!parent && !parent.group, start: at + from + raw.length - raw.trimStart().length, decls: [] };
        open.push(block); if (!block.group) rules.push(block); from = k + 1;
      } else if (c === ';' || c === '}') {
        const top = open[open.length - 1], d = css.slice(from, k), colon = d.indexOf(':');
        if (top && !top.group && colon > 0) top.decls.push({ prop: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim(), start: at + from, end: at + k });
        if (c === '}') open.pop();
        from = k + 1;
      }
    }
  }
  RULES.set(lx, rules);
  return rules;
}
const nestedRules = (lx) => cssRules(lx).filter((r) => r.nested).map((r) => r.start);

/**
 * Whether the color-mix() at offset i leaves a colour behind on an engine without it. A plain declaration
 * written before it is enough only when the color-mix() holds no var(): a declaration with var() in it is kept
 * until the variables are filled in and dropped only then, and the property goes with it, fallback and all. With
 * var(), which is every theme colour, the color-mix() has to sit in an @supports block that tests for it, and a
 * rule for the same selector outside that block has to give the property a plain value. Never for a custom
 * property (--x: color-mix(…)), which takes any value and leaves whatever reads it with nothing.
 */
function colorMixGuarded(lx, i) {
  const test = lx.markup.lastIndexOf('@supports', i);
  if (test >= 0 && !/[{};]/.test(lx.markup.slice(test, i))) return true; // the condition of an @supports: a test, not a use
  const rules = cssRules(lx), rule = rules.find((r) => r.decls.some((d) => d.start <= i && i < d.end));
  const sameProp = (d, x) => !!x && !/color-mix\(/.test(x.value) && (x.prop === d.prop || d.prop.startsWith(`${x.prop}-`));
  if (!rule) { const { here, before } = declarations(lx.markup, i); return !!here && !here.prop.startsWith('--') && !/var\(/.test(here.value) && sameProp(here, before); }
  const k = rule.decls.findIndex((d) => d.start <= i && i < d.end), d = rule.decls[k];
  if (d.prop.startsWith('--')) return false;
  if (!/var\(/.test(d.value)) return sameProp(d, rule.decls[k - 1]);
  const tested = (w) => /^@supports\b.*color-mix\(/.test(w);
  return rule.within.some(tested) && rules.some((r) => r.prelude === rule.prelude && !r.within.some(tested) && r.decls.some((x) => sameProp(d, x)));
}

const duplicateGroupNames = (r) => { const names = [...r.body.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1]); return new Set(names).size < names.length; };

/**
 * The deny-list: what the app must not use unguarded, with the Safari version that first has it. `safari: null`
 * is a feature Safari does not ship at all. `context` marks what exists only under some origins or windows,
 * whatever the version: the macOS app's tauri:// page may not be a secure context, and WKWebView is not Safari.
 * `sample` is a use the scan has to find (checked below), so a broken pattern cannot pass everything.
 */
const FEATURES = [
  // JavaScript
  { name: 'Object.hasOwn()', safari: '15.4', find: inCode(/\bObject\.hasOwn\b/), sample: 'if (Object.hasOwn(o, k)) f();' },
  { name: 'structuredClone()', safari: '15.4', find: inCode(/\bstructuredClone\b/), sample: 'const b = structuredClone(a);' },
  { name: '.at()', safari: '15.4', find: inCode(/\.at\(/), sample: 'const z = xs.at(-1);' },
  { name: '.findLast()', safari: '15.4', find: inCode(/\.findLast(?:Index)?\(/), sample: 'xs.findLast((x) => x > 1);' },
  { name: 'crypto.randomUUID()', safari: '15.4', find: inCode(/\brandomUUID\b/), sample: 'const id = crypto.randomUUID();' },
  { name: 'BroadcastChannel', safari: '15.4', find: inCode(/\bBroadcastChannel\b/), sample: 'new BroadcastChannel("x");' },
  { name: 'navigator.locks', safari: '15.4', find: inCode(/\bnavigator\.locks\b/), sample: 'navigator.locks.request("a", f);' },
  { name: 'Intl.NumberFormat v3', safari: '15.4', find: inCode(/\bsupportedValuesOf\b|\.formatRange(?:ToParts)?\(|\b(?:roundingMode|roundingPriority|roundingIncrement|trailingZeroDisplay)\s*:/), sample: 'new Intl.NumberFormat("en", { roundingMode: "floor" });' },
  { name: '<dialog>', safari: '15.4', find: (lx) => [...inCode(/\.showModal\(/)(lx), ...inMarkup(/<dialog\b/)(lx)], sample: 'box.showModal();' },
  { name: 'inert', safari: '15.5', find: (lx) => [...inCode(/\.inert\b/)(lx), ...inMarkup(/<[a-z][^<>]*\sinert(?=[\s=>])/i)(lx)], sample: 'main.inert = true;' },
  { name: '.toSorted() and kin', safari: '16.0', find: inCode(/\.(?:toSorted|toReversed|toSpliced|with)\(/), sample: 'const s = xs.toSorted();' },
  { name: 'AbortSignal.timeout()', safari: '16.0', find: inCode(/\bAbortSignal\.timeout\b/), sample: 'fetch(u, { signal: AbortSignal.timeout(5000) });' },
  { name: 'showPicker()', safari: '16.0', find: inCode(/\.showPicker\(/), sample: 'input.showPicker();' },
  { name: 'requestSubmit()', safari: '16.0', find: inCode(/\.requestSubmit\(/), sample: 'form.requestSubmit();' },
  { name: 'Array.fromAsync()', safari: '16.4', find: inCode(/\bArray\.fromAsync\b/), sample: 'await Array.fromAsync(gen());' },
  { name: 'OffscreenCanvas', safari: '16.4', find: inCode(/\bOffscreenCanvas\b/), sample: 'new OffscreenCanvas(1, 1);' },
  { name: 'CompressionStream', safari: '16.4', find: inCode(/\b(?:De)?CompressionStream\b/), sample: 'new CompressionStream("gzip");' },
  { name: '.isWellFormed()', safari: '16.4', find: inCode(/\.(?:is|to)WellFormed\(/), sample: 's.isWellFormed();' },
  { name: 'Intl.DurationFormat', safari: '16.4', find: inCode(/\bIntl\.DurationFormat\b/), sample: 'new Intl.DurationFormat("en");' },
  { name: 'class static block', safari: '16.4', find: inCode(/\bstatic\s*\{/), sample: 'class A { static { init(); } }' },
  { name: 'Set methods', safari: '17.0', find: inCode(/\.(?:union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/), sample: 'const u = a.union(b);' },
  { name: 'URL.canParse()', safari: '17.0', find: inCode(/\bURL\.(?:canParse|parse)\b/), sample: 'if (URL.canParse(s)) go(s);' },
  { name: 'popover', safari: '17.0', find: (lx) => [...inCode(/\.(?:show|hide|toggle)Popover\(/)(lx), ...inMarkup(/<[a-z][^<>]*\spopover(?:target)?(?=[\s=>])/i)(lx)], sample: 'tip.showPopover();' },
  { name: 'import attributes', safari: '17.2', find: inCode(/\bimport\b[^;\n]*\b(?:with|assert)\s*\{\s*type\s*:/), sample: 'import data from "./d.json" with { type: "json" };' },
  { name: 'Object.groupBy()', safari: '17.4', find: inCode(/\b(?:Object|Map)\.groupBy\b/), sample: 'Object.groupBy(xs, f);' },
  { name: 'Promise.withResolvers()', safari: '17.4', find: inCode(/\bPromise\.withResolvers\b/), sample: 'const { promise } = Promise.withResolvers();' },
  { name: 'AbortSignal.any()', safari: '17.4', find: inCode(/\bAbortSignal\.any\b/), sample: 'AbortSignal.any([a, b]);' },
  { name: 'checkVisibility()', safari: '17.4', find: inCode(/\.checkVisibility\(/), sample: 'el.checkVisibility();' },
  { name: 'iterator helpers', safari: '18.4', find: inCode(/\bIterator\.from\b|\.(?:keys|values|entries)\(\)\s*\.(?:map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\(/), sample: 'm.values().map((x) => x * 2);' },
  { name: 'requestIdleCallback()', safari: null, find: inCode(/\brequestIdleCallback\b/), sample: 'requestIdleCallback(work);' },
  // Regular expressions: a pattern the engine cannot read stops the whole module from loading.
  { name: 'RegExp lookbehind', safari: '16.4', find: inText(/\(\?<[=!]/), sample: 'const r = /(?<=a)b/;' },
  { name: 'RegExp v flag', safari: '17.0', find: (lx) => [...inRegex((r) => r.flags.includes('v'))(lx), ...inText(/\bnew RegExp\([^)]*,\s*['"`][a-z]*v[a-z]*['"`]\s*\)/)(lx)], sample: 'const r = /[\\p{L}--a]/v;' },
  { name: 'RegExp duplicate group names', safari: '17.0', find: inRegex(duplicateGroupNames), sample: 'const r = /(?<y>\\d{4})|(?<y>\\d{2})/;' },
  // Present only under some origins, whatever the version.
  { name: 'navigator.storage', safari: '15.2', context: 'estimate() needs 17.0, and WKWebView may not give it to a tauri:// page', find: inCode(/\bnavigator\.storage\b/), sample: 'navigator.storage.persist();' },
  { name: 'crypto.subtle', safari: '11.0', context: 'exists only in a secure context, which a tauri:// page may not be', find: inCode(/\bcrypto\??\.subtle\b/), sample: 'await crypto.subtle.digest("SHA-256", b);' },
  { name: 'navigator.clipboard', safari: '13.1', context: 'exists only in a secure context, which a tauri:// page may not be', find: inCode(/\bnavigator\.clipboard\b/), sample: 'navigator.clipboard.writeText(s);' },
  { name: 'Notification', safari: '7.0', context: 'is not part of WKWebView; in the app it comes from the notification plugin, if at all', find: inCode(/\bnew\s+Notification\b|\bNotification\s*\./), sample: 'new Notification("Due today");' },
  // CSS
  { name: ':has()', safari: '15.4', find: inMarkup(/:has\(/), lang: 'css', sample: 'li:has(> a) { color: red }' },
  { name: '@layer', safari: '15.4', find: inMarkup(/@layer\b/), lang: 'css', sample: '@layer base { a { color: red } }' },
  { name: ':focus-visible', safari: '15.4', find: inMarkup(/:focus-visible\b/), lang: 'css', sample: 'a:focus-visible { outline: 0 }' },
  { name: 'accent-color', safari: '15.4', find: inMarkup(/(?<![-\w])accent-color\s*:/), lang: 'css', sample: 'input { accent-color: red }' },
  { name: 'appearance', safari: '15.4', find: inMarkup(/(?<![-\w])appearance\s*:/), fallback: prefixedBefore, lang: 'css', sample: 'input { appearance: none }' },
  { name: 'print-color-adjust', safari: '15.4', find: inMarkup(/(?<![-\w])print-color-adjust\s*:/), fallback: prefixedBefore, lang: 'css', sample: 'th { print-color-adjust: exact }' },
  { name: 'mask', safari: '15.4', find: inMarkup(/(?<![-\w])mask(?:-[a-z]+)?\s*:/), fallback: prefixedBefore, lang: 'css', sample: 'i { mask-image: url(a.svg) }' },
  { name: 'dvh, svh, lvh', safari: '15.4', find: inMarkup(/\d(?:[dsl]v(?:h|w|i|b|min|max))\b/), lang: 'css', sample: 'main { height: 100dvh }' },
  { name: 'overflow-wrap: anywhere', safari: '15.4', find: inMarkup(/overflow-wrap\s*:\s*anywhere/), lang: 'css', sample: 'td { overflow-wrap: anywhere }' },
  { name: 'contain', safari: '15.4', find: inMarkup(/(?<![-\w])contain\s*:/), lang: 'css', sample: '.card { contain: layout }' },
  { name: 'scroll-behavior', safari: '15.4', find: inMarkup(/\bscroll-behavior\s*:/), lang: 'css', sample: 'html { scroll-behavior: smooth }' },
  { name: '::backdrop', safari: '15.4', find: inMarkup(/::backdrop\b/), lang: 'css', sample: 'dialog::backdrop { background: grey }' },
  { name: '@container', safari: '16.0', find: inMarkup(/@container\b|(?<![-\w])container(?:-type|-name)?\s*:|\d(?:cq(?:w|h|i|b|min|max))\b/), lang: 'css', sample: '@container (min-width: 400px) { a { color: red } }' },
  { name: 'subgrid', safari: '16.0', find: inMarkup(/\bsubgrid\b/), lang: 'css', sample: '.row { grid-template-columns: subgrid }' },
  { name: 'overflow: clip', safari: '16.0', find: inMarkup(/overflow(?:-[xy])?\s*:\s*clip\b/), lang: 'css', sample: '.box { overflow: clip }' },
  { name: 'text-align-last', safari: '16.0', find: inMarkup(/\btext-align-last\s*:/), lang: 'css', sample: 'p { text-align-last: right }' },
  { name: 'overscroll-behavior', safari: '16.0', find: inMarkup(/\boverscroll-behavior(?:-[xy])?\s*:/), lang: 'css', sample: 'nav { overscroll-behavior: contain }' },
  { name: 'color-mix()', safari: '16.2', find: inMarkup(/color-mix\(/), fallback: colorMixGuarded, lang: 'css', sample: '.chip { background: color-mix(in srgb, red 13%, white) }' },
  { name: '@property', safari: '16.4', find: inMarkup(/@property\s+--/), lang: 'css', sample: '@property --x { syntax: "<length>"; inherits: false; initial-value: 0px }' },
  { name: 'range media query', safari: '16.4', find: inMarkup(/\(\s*(?:width|height|aspect-ratio)\s*[<>]=?/), lang: 'css', sample: '@media (width < 860px) { nav { display: none } }' },
  { name: 'lh unit', safari: '16.4', find: inMarkup(/\d(?:r?lh)\b/), lang: 'css', sample: 'p { margin: 1lh 0 }' },
  { name: ':dir()', safari: '16.4', find: inMarkup(/:dir\(/), lang: 'css', sample: 'p:dir(rtl) { text-align: right }' },
  { name: 'CSS nesting', safari: '16.5', find: nestedRules, lang: 'css', sample: '.card { color: red; .title { font-weight: 600 } }' },
  { name: ':user-invalid', safari: '16.5', find: inMarkup(/:user-(?:in)?valid\b/), lang: 'css', sample: 'input:user-invalid { border-color: red }' },
  { name: 'text-wrap', safari: '17.5', find: inMarkup(/\btext-wrap(?:-mode|-style)?\s*:/), lang: 'css', sample: 'h1 { text-wrap: balance }' },
  { name: '@scope', safari: '17.4', find: inMarkup(/@scope\b/), lang: 'css', sample: '@scope (.card) { p { margin: 0 } }' },
  { name: '@starting-style', safari: '17.5', find: inMarkup(/@starting-style\b/), lang: 'css', sample: '@starting-style { .toast { opacity: 0 } }' },
  { name: 'light-dark()', safari: '17.5', find: inMarkup(/light-dark\(/), lang: 'css', sample: 'body { color: light-dark(black, white) }' },
  { name: 'backdrop-filter', safari: '18.0', find: inMarkup(/(?<![-\w])backdrop-filter\s*:/), fallback: prefixedBefore, lang: 'css', sample: '.pop { backdrop-filter: blur(8px) }' },
  { name: 'content-visibility', safari: '18.0', find: inMarkup(/\bcontent-visibility\s*:/), lang: 'css', sample: '.long { content-visibility: auto }' },
  { name: 'user-select', safari: null, find: inMarkup(/(?<![-\w])user-select\s*:/), fallback: prefixedBefore, lang: 'css', sample: 'th { user-select: none }' },
  // HTML
  { name: '<search>', safari: '17.0', find: inMarkup(/<search\b/), lang: 'html', sample: '<search><input type="search"></search>' },
  { name: '<details name>', safari: '17.2', find: inMarkup(/<details\b[^<>]*\sname=/), lang: 'html', sample: '<details name="faq"><summary>A</summary></details>' },
];

// Whether a feature fails at the floor: newer than it, missing from Safari, or there only under some origins.
const beyondFloor = (f) => !!f.context || f.safari === null || later(f.safari, FLOOR);
const needs = (f) => [f.safari === null ? 'is not in Safari' : later(f.safari, FLOOR) ? `needs Safari ${f.safari}` : '', f.context].filter(Boolean).join('; ');

/**
 * Uses that are guarded. Each names its file, the feature, text that its line contains, and why it is safe.
 * A use is let through only on a line that contains that text, so a new, unguarded use of the same feature
 * in the same file still fails; and an entry that no longer matches anything fails too, so the list stays true.
 */
const ALLOWED = [
  { file: 'app/store.js', feature: 'navigator.storage', line: 'navigator.storage?.persist?.()', reason: 'optional calls: where the API is missing nothing is asked, and `persisted` stays null' },
  { file: 'app/ui/settings.js', feature: 'navigator.storage', line: 'navigator.storage?.estimate?.()', reason: 'optional call: without it the storage meter gives what it knows and leaves out the quota' },
  { file: 'app/ui/settings.js', feature: 'navigator.storage', line: 'navigator.storage?.persisted?.()', reason: 'optional call: without it the meter does not say whether the data is kept' },
  { file: 'app/store.js', feature: 'BroadcastChannel', line: "typeof BroadcastChannel === 'function'", reason: 'the feature check itself' },
  { file: 'app/store.js', feature: 'BroadcastChannel', line: 'new BroadcastChannel(', reason: 'inside that check; without it the windows talk through localStorage\'s storage event (windowLink), which Safari 15.0 has' },
  { file: 'app/ui/kit.js', feature: 'crypto.subtle', line: 'globalThis.crypto?.subtle?.digest(', reason: 'optional call; without it the same digest comes from app/calc/sha256.js' },
  { file: 'app/ui/measurements.js', feature: 'navigator.clipboard', line: 'try { await navigator.clipboard.writeText(', reason: 'in a try: the catch says the clipboard could not be reached and points to the blank sheet' },
  { file: 'app/ui/doe.js', feature: 'navigator.clipboard', line: 'try { await navigator.clipboard.writeText(', reason: 'in a try: the catch copies through a hidden textarea, then says to use the CSV export' },
  { file: 'app/ui/experiments.js', feature: 'navigator.clipboard', line: "(navigator.clipboard?.writeText(names) ?? Promise.reject(", reason: 'no clipboard, or a refusal, saves the names as a text file instead' },
  { file: 'app/ui/calendar.js', feature: 'Notification', line: 'await Notification.requestPermission()', reason: "after the 'Notification' in window check on the line above" },
  { file: 'app/ui/calendar.js', feature: 'Notification', line: "Notification.permission !== 'granted'", reason: "after the 'Notification' in window check earlier in the same condition" },
  { file: 'app/ui/calendar.js', feature: 'Notification', line: "new Notification('LNP Lab: due today'", reason: "below that condition, and inside a try" },
  { file: 'index.html', feature: 'accent-color', line: 'accent-color: var(--accent)', reason: 'colour only: an older engine draws checkboxes and radio buttons in the system accent' },
  { file: 'index.html', feature: ':focus-visible', line: 'details.fold > summary:focus-visible', reason: 'an older engine drops the rule and keeps its own focus ring on the fold' },
];

/* ---------------- the scan ---------------- */

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(join(ROOT, 'app'));
  out.push(join(ROOT, 'index.html'));
  return out.map((p) => ({ file: relative(ROOT, p).split(sep).join('/'), src: readFileSync(p, 'utf8') }));
}

/** Every use of a feature beyond the floor in one file, with its line, unless the line shows its fallback. */
function scan(file, src, features = FEATURES) {
  const lx = lex(file, src), lines = src.split('\n'), hits = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  for (const f of features) {
    for (const i of new Set(f.find(lx))) {
      if (f.fallback?.(lx, i)) continue;
      const line = lineAt(i);
      hits.push({ file, line, feature: f, text: lines[line - 1].trim() });
    }
  }
  return { hits, problem: lx.problem };
}

const allowedBy = (h) => ALLOWED.filter((a) => a.file === h.file && a.feature === h.feature.name && h.text.includes(a.line));
const describe = (h) => `${h.file}:${h.line}  ${h.feature.name} ${needs(h.feature)}\n      ${h.text.slice(0, 160)}`;

/* ---------------- tests ---------------- */

test('the floor is the Safari of the oldest macOS in tauri.conf.json', () => {
  assert.ok(MACOS, 'tauri.conf.json names no bundle.macOS.minimumSystemVersion');
  assert.ok(FLOOR, `no Safari version known for macOS ${MACOS}: add it to SAFARI_OF_MACOS`);
  for (const f of FEATURES) assert.ok(f.safari === null || /^\d+\.\d+$/.test(f.safari), `${f.name}: Safari version "${f.safari}"`);
  assert.equal(new Set(FEATURES.map((f) => f.name)).size, FEATURES.length, 'feature names are unique (the allowlist refers to them)');
});

test('every source is read to its end, so nothing past a confusing line goes unscanned', () => {
  const lost = sources().map(({ file, src }) => [file, lex(file, src).problem]).filter(([, p]) => p);
  assert.deepEqual(lost, [], lost.map(([f, p]) => `${f}: ${p}`).join('\n'));
});

test('the scan finds each listed feature, and not in comments, strings or behind a fallback', () => {
  const wrap = (f) => (f.lang === 'css' ? ['t.html', `<style>\n${f.sample}\n</style>`] : f.lang === 'html' ? ['t.html', `<body>${f.sample}</body>`] : ['t.js', f.sample]);
  for (const f of FEATURES) {
    const [file, src] = wrap(f);
    assert.equal(scan(file, src, [f]).hits.length, 1, `${f.name}: not found in its sample "${f.sample}"`);
  }
  const quiet = [
    ['t.js', '// structuredClone(a) needs Safari 15.4\nconst m = "use xs.at(-1)"; const r = /\\.at\\(/; const t = `Object.hasOwn(${n})`;'],
    ['t.js', "ds.fill.push({ container: '2R glass', count: 10 }); const css = `.a { -webkit-user-select: none; user-select: none }`;"],
    ['t.html', '<style>\n/* a { color: color-mix(in srgb, red 5%, blue) } */\n.chip { background: #fee; background: color-mix(in srgb, red 13%, white); }\n'
      + '.bad { background: #fee; }\n@supports (color: color-mix(in srgb, red, red)) { .bad { background: color-mix(in srgb, var(--danger) 13%, var(--card)); } }\n'
      + '.s { -webkit-appearance: none; appearance: none; }\n@media (max-width: 860px) { .a { color: red } }\n</style>'],
  ];
  for (const [file, src] of quiet) assert.deepEqual(scan(file, src).hits.map(describe), [], `should be quiet: ${src}`);
  const still = [
    ['t.html', '<style>.chip { color: red; background: color-mix(in srgb, red 13%, white); }</style>', 'color-mix()'],
    ['t.html', '<style>.chip { background: #fee; background: color-mix(in srgb, var(--danger) 13%, var(--card)); }</style>', 'color-mix()'],
    ['t.html', '<style>@supports (color: color-mix(in srgb, red, red)) { .chip { background: color-mix(in srgb, var(--danger) 13%, var(--card)); } }</style>', 'color-mix()'],
    ['t.html', '<style>.chip { color: #fee; }\n@supports (color: color-mix(in srgb, red, red)) { .chip { background: color-mix(in srgb, var(--danger) 13%, var(--card)); } }</style>', 'color-mix()'],
    ['t.html', '<style>:root { --tint: #fee; --tint: color-mix(in srgb, red 13%, white); }</style>', 'color-mix()'],
    ['t.html', '<style>.card { color: red; .title { font-weight: 600 } }\n@media (min-width: 1px) { .card { color: blue } }</style>', 'CSS nesting'],
    ['t.html', '<style>.a { color: red; appearance: none; }</style>', 'appearance'],
    ['t.js', 'const s = `${xs.at(-1)} of ${n}`;', '.at()'],
    ['t.js', 'el.innerHTML = `<b style="color: red; background: color-mix(in srgb, red 5%, blue)">x</b>`;', 'color-mix()'],
  ];
  for (const [file, src, name] of still) assert.deepEqual(scan(file, src).hits.map((h) => h.feature.name), [name], `should be found: ${src}`);
});

test(`nothing the floor lacks (macOS ${MACOS}: Safari ${FLOOR}) is used unguarded`, () => {
  const bad = sources().flatMap(({ file, src }) => scan(file, src, FEATURES.filter(beyondFloor)).hits).filter((h) => !allowedBy(h).length);
  assert.deepEqual(bad.map(describe), [], `\nUsed but missing from Safari ${FLOOR} or not under every origin (replace it, guard it and list it in ALLOWED with the reason, `
    + `or for CSS a plain value the older engine keeps; see the guards above):\n${bad.map(describe).join('\n')}\n`);
});

test('every allowlist entry still matches a use', () => {
  const hits = sources().flatMap(({ file, src }) => scan(file, src).hits);
  const stale = ALLOWED.filter((a) => !hits.some((h) => allowedBy(h).includes(a)));
  assert.deepEqual(stale.map((a) => `${a.file}: ${a.feature} on a line with "${a.line}"`), [], 'remove or update these entries');
  for (const a of ALLOWED) assert.ok(a.reason?.length > 10, `${a.file} ${a.feature}: say why it is safe`);
});

test('the plain-JavaScript SHA-256 gives the digest node and crypto.subtle give', async () => {
  const { sha256 } = await import('../app/calc/sha256.js');
  const hex = (b) => Buffer.from(b).toString('hex');
  assert.equal(hex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // Lengths either side of the 55/56/64-byte block edges, where the padding changes shape.
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 255);
    assert.equal(hex(sha256(bytes)), createHash('sha256').update(bytes).digest('hex'), `${n} bytes`);
  }
});

test('an import is fingerprinted where crypto.subtle is missing (not a secure context)', async () => {
  const { sha256Hex } = await import('../app/ui/kit.js');
  const text = 'Probenname;Größe (d.nm);PdI\nE1-F1_final;82,4;0,08\n'; // bytes outside ASCII, as in a German export
  const want = createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(await sha256Hex(text), want, 'with crypto.subtle');
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try { assert.equal(await sha256Hex(text), want, 'without crypto.subtle'); }
  finally { Object.defineProperty(globalThis, 'crypto', real); }
});
