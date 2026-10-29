// Materials: the lists the user can extend (TFF modules, dialysis devices), what older records keep when the
// shipped lists shrink, and the lipid-class marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The store keeps its bookkeeping in localStorage; node has none, so give it one before the modules load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store } = await import('../app/store.js');
const { getRef, keepRetiredTffModules } = await import('../app/refdata.js');
const { lipidClassChip, lipidClassColor, compositionBar, LIPID_CLASSES } = await import('../app/ui/lipidclass.js');

const read = (f) => JSON.parse(readFileSync(new URL(`../app/data/${f}.json`, import.meta.url), 'utf8'));
const data = {};
for (const f of ['lipids', 'compositions', 'buffers_catalog', 'tff_modules', 'tff_modules_retired', 'materials', 'pka', 'reagents', 'devices']) data[f] = read(f);
data.lipidByKey = Object.fromEntries(data.lipids.map((l) => [l.key, l]));
data.compositionById = Object.fromEntries(data.compositions.map((c) => [c.id, c]));
const lab = () => { mem.clear(); return { store: new Store('lnp-lab'), data }; };

test('one representative TFF module ships, a 100 kD mPES MidiKros; the user adds, edits and hides by id', () => {
  assert.equal(data.tff_modules.length, 1);
  const [mod] = data.tff_modules;
  assert.match(`${mod.family} ${mod.mwco} ${mod.membrane}`, /MidiKros 100 kD mPES/);
  const ctx = lab();
  assert.deepEqual(getRef(ctx).tffModules.map((x) => x.id), [mod.part], 'a shipped module is known by its part number');
  ctx.store.put('tffModules', { id: 'own-1', part: 'OWN-1', surface_cm2: 50 });
  ctx.store.put('tffModules', { id: mod.part, surface_cm2: 120 });
  let ref = getRef(ctx);
  assert.equal(ref.tffModules.length, 2);
  assert.equal(ref.tffModules[0].surface_cm2, 120, 'an edit lies over the shipped entry');
  assert.equal(ref.tffModules[0].family, 'MidiKros', 'and keeps what it did not change');
  ctx.store.put('tffModules', { id: mod.part, deleted: true });
  ref = getRef(ctx);
  assert.deepEqual(ref.tffModules.map((x) => x.part), ['OWN-1'], 'hidden');
});

test('a formulation that used a TFF module no longer shipped keeps it, copied into the user\'s own list once', () => {
  const ctx = lab();
  const gone = data.tff_modules_retired[1].part;
  ctx.store.put('batches', { id: 'E1-F1', plan: { downstream: { tff: { enabled: true, module: gone } } } });
  // TFF off: the default part every record carries does not count.
  ctx.store.put('batches', { id: 'E1-F2', plan: { downstream: { tff: { enabled: false, module: data.tff_modules_retired[0].part } } } });
  assert.deepEqual(keepRetiredTffModules(ctx.store, data), [gone]);
  assert.deepEqual(keepRetiredTffModules(ctx.store, data), [], 'and only once');
  const ref = getRef(ctx);
  const kept = ref.tffModules.find((x) => x.part === gone);
  assert.ok(kept && kept.surface_cm2 > 0, 'the record finds its module, with its surface area');
  assert.equal(ref.tffModules.length, 2);
});

test('dialysis devices: three examples; the record\'s cassette menu keeps the old names first, its default included', () => {
  const ctx = lab();
  const ref = getRef(ctx);
  assert.equal(ref.dialysis.length, 3);
  assert.ok(ref.dialysis.every((d) => d.mwco_kDa > 0 && d.volume_max_mL >= d.volume_min_mL));
  // formulation.js defaults a new record to the fourth cassette of this menu.
  assert.equal(ref.materials.dialysis_cassettes[3], data.materials.dialysis_cassettes[3]);
  assert.ok(ref.dialysis.every((d) => ref.materials.dialysis_cassettes.includes(d.name)), 'the devices are in the menu too');
  ctx.store.put('dialysis', { id: 'mine', name: 'My 3.5K cassette', mwco_kDa: 3.5 });
  ctx.store.put('dialysis', { id: ref.dialysis[0].id, deleted: true });
  const after = getRef(ctx);
  assert.ok(after.materials.dialysis_cassettes.includes('My 3.5K cassette'));
  assert.ok(!after.materials.dialysis_cassettes.includes(ref.dialysis[0].name), 'a hidden device leaves the menu');
  assert.deepEqual(after.materials.filters, data.materials.filters, 'the filters are untouched');
});

test('lipid classes: Okabe–Ito colours, and a letter and a word on every chip, never the colour alone', () => {
  assert.equal(lipidClassColor('ionizable'), '#0072B2');
  assert.equal(lipidClassColor('helper'), '#E69F00');
  assert.equal(lipidClassColor('sterol'), '#009E73');
  assert.equal(lipidClassColor('peg'), '#CC79A7');
  assert.equal(lipidClassColor('something new'), LIPID_CLASSES.other.color, 'an unknown class is "other"');
  assert.match(lipidClassChip('ionizable'), />I · ionizable</);
  assert.match(lipidClassChip('peg'), />P · PEG-lipid</);
  assert.match(lipidClassChip(undefined), /O · other/);
  // Every class's text on its fill reads at 4.5:1 or better (WCAG AA), whichever theme is behind it.
  const lum = (hex) => { const c = hex.slice(1).match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  for (const [cls, { color, ink }] of Object.entries(LIPID_CLASSES)) {
    const [a, b] = [lum(color), lum(ink)].sort((x, y) => y - x);
    assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `${cls}: contrast ${((a + 0.05) / (b + 0.05)).toFixed(2)}`);
  }
});

test('the composition bar: classes in recipe order, each segment lettered, the names listed', () => {
  const ref = { lipidByKey: data.lipidByKey };
  const bar = compositionBar({ DMG0PEG2000: 1.5, Chol: 38.5, MC3: 50, DSPC: 10 }, ref);
  const letters = [...bar.matchAll(/class="lc-seg lc-(\w+)"/g)].map((x) => x[1]);
  assert.deepEqual(letters, ['ionizable', 'helper', 'sterol', 'peg']);
  assert.match(bar, /DLin-MC3-DMA 50/);
  assert.match(compositionBar({}, ref), /no lipids/);
});
