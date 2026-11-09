// emptyState and the quiet look of an empty KPI value (stage 6a).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, kpi } from '../app/ui/kit.js';

test('emptyState: title, text and a link action, escaped', () => {
  const h = emptyState({ title: 'No <x>', text: 'Say it.', actionLabel: 'New stock', actionHref: '#/stocks?new=1' });
  assert.match(h, /class="emptyState"/);
  assert.match(h, /<h3>No &lt;x&gt;<\/h3>/);
  assert.match(h, /<a class="btn primary" href="#\/stocks\?new=1">New stock<\/a>/);
});
test('emptyState: without an action there is no button', () => {
  assert.doesNotMatch(emptyState({ text: 'Nothing.' }), /btn|button/);
});
test('kpi: an empty value gets .empty, a real one does not', () => {
  assert.match(kpi('Lipid stock', 'not chosen'), /class="v empty"/);
  assert.match(kpi('Next due', 'nothing open'), /class="v empty"/);
  assert.match(kpi('N/P', '5.2'), /class="v"/);
});
