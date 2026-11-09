import test from 'node:test';
import assert from 'node:assert/strict';
import { nameRepeatsType, shortVerdict } from '../app/calc/listing.js';

test('a name that only repeats the type is not shown beside it', () => {
  assert.equal(nameRepeatsType('Reference reproducibility', 'reference'), true);
  assert.equal(nameRepeatsType('DoE · 2026-11-09', 'doe'), true);
  assert.equal(nameRepeatsType('Optimization · DoE (2 to n factors) 3', 'doe'), true);
  assert.equal(nameRepeatsType('', 'single'), true);
  assert.equal(nameRepeatsType('N/P scan with MC3', 'ofat'), false);
  assert.equal(nameRepeatsType('DoE for PEG screening', 'doe'), false);
});

test('a verdict is cut to its first sentence and one line', () => {
  assert.equal(shortVerdict('Reproducible: yes. Size CV 1.7 %.'), 'Reproducible: yes');
  const long = 'Predicted optimum: FRR 4, flow 117 mL/min, PEG 2.5 mol% gives size 83 nm, PDI 0.09 and EE 94 % at the edge of the tested range';
  const s = shortVerdict(long, 60);
  assert.ok(s.length <= 60 && s.endsWith('…'), s);
  assert.equal(shortVerdict(''), '');
});

test('a bracketed aside is dropped before a verdict is cut mid-word', () => {
  assert.equal(shortVerdict('Reproducible: Z-ave CV 1.7 %, PDI CV 11.2 % and EE CV 1.0 % over 3 batches (limits 5 %, 15 %, 5 %)', 90),
    'Reproducible: Z-ave CV 1.7 %, PDI CV 11.2 % and EE CV 1.0 % over 3 batches');
});
