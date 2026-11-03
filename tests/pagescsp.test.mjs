// The policy GitHub Pages publishes the app with (scripts/pages-csp.mjs): built from this index.html, it must name
// every inline script by its hash, leave no inline handler behind, and keep the page to its own host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { harden } from '../scripts/pages-csp.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the published index.html allows exactly its own inline scripts, by hash, and no other host', () => {
  const out = harden(html);
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(out)?.[1];
  assert.ok(csp, 'the policy is in the page');
  const inline = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  assert.ok(inline.length >= 2);
  for (const h of inline) assert.ok(csp.includes(h), `the policy names inline script ${h}`);
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe-inline/, 'no inline script runs by default');
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(out, /\son[a-z]+="/i, 'no inline event handler is left, the policy would block it');
  assert.match(out, /<meta name="referrer" content="no-referrer">/);
  // the policy sits before anything that loads
  assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<script'));
});

test('the repository copy stays as it is: the Mac app and npm start load it without the policy', () => {
  assert.doesNotMatch(html, /Content-Security-Policy/);
});
