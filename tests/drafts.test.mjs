// Drafts of records not yet created (app/ui/kit.js): creating a record drops the draft its own form continued
// or wrote and no other, and clearing a lab (Store.clear: "Delete all data", the demo's "Start over") takes that
// lab's drafts with it, so a fresh lab does not offer back forms that name stocks and lots it never had.
import test from 'node:test';
import assert from 'node:assert/strict';

// node has neither: stand-ins with the part of the Storage interface the app uses.
const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
const { Store, memoryBackend } = await import('../app/store.js');
const { readDraft, writeDraft, dropDraft } = await import('../app/ui/kit.js');

test('creating a record drops the draft its form wrote, not one that was only offered above it', () => {
  const ctx = { store: { ns: 'lnp-lab' } };
  writeDraft(ctx, 'experiment.single', { state: { name: 'My half-planned run' }, draftId: 'a' });
  // "Repeat as new" created untouched: its form (b) never wrote a draft, and the one offered above it stays
  dropDraft(ctx, 'experiment.single', 'b');
  assert.equal(readDraft(ctx, 'experiment.single')?.state.name, 'My half-planned run');
  // the form that continued it (or typed into it) created its record: then it goes
  dropDraft(ctx, 'experiment.single', 'a');
  assert.equal(readDraft(ctx, 'experiment.single'), null);
  // "Discard it" and "Start afresh" name no form, and drop whatever is there
  writeDraft(ctx, 'stock', { state: {}, draftId: 'c' });
  dropDraft(ctx, 'stock');
  assert.equal(readDraft(ctx, 'stock'), null);
  // a draft kept before drafts had an id goes by the time it was written
  sessionStorage.setItem('lnp-lab.draft.buffer', JSON.stringify({ state: {}, draftAt: '2026-10-27T10:00:00.000Z' }));
  const old = readDraft(ctx, 'buffer');
  assert.equal(old.draftId, '2026-10-27T10:00:00.000Z');
  dropDraft(ctx, 'buffer', 'another form');
  assert.ok(readDraft(ctx, 'buffer'));
  dropDraft(ctx, 'buffer', old.draftId);
  assert.equal(readDraft(ctx, 'buffer'), null);
});

test("clearing a lab takes its drafts with it, and leaves the other lab's", async () => {
  const demo = new Store('lnp-demo', { backend: memoryBackend() });
  await demo.ready();
  demo.put('stocks', { id: 'Stock-001' });
  writeDraft({ store: demo }, 'experiment.single', { state: { name: 'Left before Start over', stockId: 'Stock-001' }, draftId: 'x' });
  writeDraft({ store: demo }, 'stock', { state: { molarity_mM: 12.5 }, draftId: 'y' });
  writeDraft({ store: { ns: 'lnp-lab' } }, 'stock', { state: { molarity_mM: 50 }, draftId: 'z' });
  assert.deepEqual(await demo.clear(), { ok: true, error: null });
  assert.equal(readDraft({ store: demo }, 'experiment.single'), null);
  assert.equal(readDraft({ store: demo }, 'stock'), null);
  assert.equal(readDraft({ store: { ns: 'lnp-lab' } }, 'stock')?.draftId, 'z', 'the real lab keeps its draft');
  dropDraft({ store: { ns: 'lnp-lab' } }, 'stock');
});

test('an experiment not created is kept past the window, one per wizard, and listed newest first', async () => {
  const { listDrafts, draftsStoring } = await import('../app/ui/kit.js');
  const ctx = { store: { ns: 'lnp-lab' } };
  // in localStorage, so closing the tab keeps it; a stock's stays with the window
  writeDraft(ctx, 'experiment.doe.a', { state: { type: 'doe', name: 'First DoE' }, draftId: 'a', draftAt: '2026-10-28T09:00:00.000Z' }, { keepTime: true });
  writeDraft(ctx, 'experiment.doe.b', { state: { type: 'doe', name: 'Second DoE' }, draftId: 'b' });
  writeDraft(ctx, 'stock', { state: {}, draftId: 's' });
  assert.ok(localStorage.getItem('lnp-lab.draft.experiment.doe.a') && !sessionStorage.getItem('lnp-lab.draft.experiment.doe.a'));
  assert.ok(sessionStorage.getItem('lnp-lab.draft.stock') && !localStorage.getItem('lnp-lab.draft.stock'));
  assert.deepEqual(listDrafts(ctx, 'experiment.').map((d) => [d.kind, d.state.name]), [['experiment.doe.b', 'Second DoE'], ['experiment.doe.a', 'First DoE']],
    'a second DoE started is a second draft, not the first one written over');
  // one being created is not offered
  draftsStoring.add('b');
  assert.deepEqual(listDrafts(ctx, 'experiment.').map((d) => d.draftId), ['a']);
  draftsStoring.delete('b');
  // a draft an earlier version kept in this window only moves to where it now lives when read
  sessionStorage.setItem('lnp-lab.draft.experiment.single', JSON.stringify({ state: { type: 'single', name: 'Old one' }, draftId: 'o', draftAt: '2026-10-01T08:00:00.000Z' }));
  assert.deepEqual(listDrafts(ctx, 'experiment.').map((d) => d.draftId), ['b', 'a', 'o']);
  assert.ok(localStorage.getItem('lnp-lab.draft.experiment.single') && !sessionStorage.getItem('lnp-lab.draft.experiment.single'));
  for (const k of ['experiment.doe.a', 'experiment.doe.b', 'experiment.single', 'stock']) dropDraft(ctx, k);
  assert.deepEqual(listDrafts(ctx, 'experiment.'), []);
});
