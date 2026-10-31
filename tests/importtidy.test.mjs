// The historical-data converter (scripts/import-tidy.mjs, docs/HISTORICAL-DATA.md) on its own example tables:
// what passes the app's checks goes into the restore file, what does not goes to quarantine with its reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the example tables: five formulations in, one refused for an unknown lipid, a PDI of 8.5 quarantined', () => {
  const out = mkdtempSync(join(tmpdir(), 'tidy-'));
  execFileSync(process.execPath, ['scripts/import-tidy.mjs', 'docs/historical-example', '--first', '200', '--out', out], { stdio: 'pipe' });
  const imp = JSON.parse(readFileSync(join(out, 'import.json'), 'utf8'));
  const c = imp.collections;
  assert.deepEqual(c.experiments.map((e) => e.id), ['E200', 'E201']);
  assert.equal(c.batches.length, 5);
  assert.equal(c.measurements.length, 7);
  assert.equal(c.compositions.length, 1, 'the ALC-0315 mix is new; the MC3 one is the shipped composition #1');
  assert.equal(c.batches.find((b) => b.id === 'E201-F1').compositionId, 1);
  assert.deepEqual(c.mixers, [], 'a mixer named in a sheet stays on the record; the device list is not added to');
  assert.equal(c.batches[0].plan.conditions.mixer, 'PEEK tee 0.5 mm');
  const b = c.batches[0];
  assert.equal(b.plan.conditions.loadingPH, 4);
  assert.equal(b.plan.conditions.sterileFiltered, true);
  assert.equal(b.provenance.importId, imp.importId);
  assert.equal(b.provenance.row, 2, 'each record names the row it came from');
  const q = readFileSync(join(out, 'quarantine.csv'), 'utf8');
  assert.match(q, /Lipid-X/);
  assert.match(q, /pdi 8\.5 is outside 0–1, probably a typing slip/);
  assert.match(q, /no formulation GH-2024-05\/C/);
  assert.match(readFileSync(join(out, 'quality-report.md'), 'utf8'), /\| Formulations \| 6 \| 5 \| 1 \|/);
});
