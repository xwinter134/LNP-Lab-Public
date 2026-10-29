// The feedback button: what goes into the pre-filled GitHub issue, and what never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackUrl, ISSUES_URL } from '../app/ui/feedback.js';

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

test('a problem report names the screen, the version and the browser, and goes to the project issues', () => {
  const u = new URL(feedbackUrl('bug', { screen: 'doe', title: 'Design & results', version: '0.15.0', ua: SAFARI }));
  assert.equal(`${u.origin}${u.pathname}`, ISSUES_URL);
  assert.equal(u.searchParams.get('title'), 'Problem: Design & results');
  assert.equal(u.searchParams.get('labels'), 'bug');
  const body = u.searchParams.get('body');
  assert.match(body, /\*\*What happened\?\*\*/);
  assert.match(body, /Design & results \(`#\/doe`\)/);
  assert.match(body, /LNP Lab v0\.15\.0 \(browser\)/);
  assert.match(body, /Safari 17\.5 on macOS 14\.5/);
});

test('an idea is labelled as one, and nothing but the screen id ever goes with it', () => {
  // The caller passes the screen id alone; an address with record ids in it is not something it can pass.
  const u = new URL(feedbackUrl('idea', { screen: 'formulation', title: 'Formulations', version: '0.15.0', ua: '' }));
  assert.equal(u.searchParams.get('labels'), 'enhancement');
  assert.doesNotMatch(u.searchParams.get('body'), /batch=|E\d+-F\d+/);
});

test('by e-mail: the same text to the feedback address, for anyone without a GitHub account', async (t) => {
  const { feedbackMail, FEEDBACK_EMAIL } = await import('../app/ui/feedback.js');
  const m = feedbackMail('bug', { screen: 'doe', title: 'Design & results', version: '0.15.0', ua: SAFARI });
  if (!FEEDBACK_EMAIL) { assert.equal(m, null, 'no address set: no e-mail way offered'); t.skip('no feedback address set'); return; }
  assert.ok(m.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`));
  const body = decodeURIComponent(/body=(.*)$/.exec(m)[1]);
  assert.match(body, /What happened\?/);
  assert.doesNotMatch(body, /\*\*|<!--/, 'no Markdown or HTML comments in a plain e-mail');
  assert.match(decodeURIComponent(/subject=([^&]*)/.exec(m)[1]), /^LNP Lab · Problem: Design & results$/);
});
