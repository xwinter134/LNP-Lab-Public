// The common buffers on the Buffers screen: each opens with its own recipe, and the pH solver makes that recipe
// come out at the pH its name states (usability cycle 6, I7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { designTwoReagentBuffer, designTitratedBuffer } from '../app/calc/buffer.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../app/data/${f}.json`, import.meta.url), 'utf8'));
const catalog = read('buffers_catalog'), pka = read('pka'), reagents = read('reagents');

/** The recipe the screen's "Recommended" method makes: a reagent pair, else one reagent titrated. */
function design(b) {
  const sys = pka.find((p) => p.name === b.system);
  const r = reagents.filter((x) => x.system === b.system);
  const acid = r.filter((x) => x.form === 'acid'), base = r.filter((x) => x.form === 'base');
  const system = { pka: sys.pka, charge_of_base: sys.charge_of_base };
  const extraIons = b.nacl_mM ? [{ z: 1, conc: b.nacl_mM / 1000 }, { z: -1, conc: b.nacl_mM / 1000 }] : [];
  const common = { system, targetPH: b.targetPH, conc_M: b.conc_mM / 1000, volume_mL: 1000, extraIons, activity: true };
  if (acid.length && base.length) {
    const d = designTwoReagentBuffer({ ...common, acidReagent: acid[0], baseReagent: base[0] });
    assert.ok(d.reachable, `${b.name}: the reagent pair cannot reach pH ${b.targetPH}`);
    return d;
  }
  if (acid.length) return designTitratedBuffer({ ...common, reagent: acid[0], titrant: { name: 'NaOH 1 M', z: 1 } });
  assert.ok(base.length, `${b.name}: no reagent on record for ${b.system}`);
  return designTitratedBuffer({ ...common, reagent: base[0], titrant: { name: 'HCl 1 M', z: -1 } });
}

test('every common buffer names its system, pH and concentration, as its name says', () => {
  assert.ok(catalog.length >= 18);
  for (const b of catalog) {
    assert.ok(pka.some((p) => p.name === b.system), `${b.name}: system ${b.system} is not in pka.json`);
    const pH = Number(/pH (\d+(?:\.\d+)?)/.exec(b.name)[1]);
    assert.equal(b.targetPH, pH, `${b.name}: target pH`);
    const mM = /^\w+ (\d+) mM/.exec(b.name);
    if (mM) assert.equal(b.conc_mM, Number(mM[1]), `${b.name}: concentration`);
    const nacl = /(\d+) mM NaCl/.exec(b.name);
    assert.equal(b.nacl_mM || 0, nacl ? Number(nacl[1]) : /^PBS/.test(b.name) ? 137 : 0, `${b.name}: NaCl`);
    const suc = /(\d+) mM sucrose/.exec(b.name);
    if (suc) assert.equal(b.sucrose_mM, Number(suc[1]), `${b.name}: sucrose`);
    if (/10 % w\/v sucrose/.test(b.name)) assert.ok(Math.abs(b.sucrose_mM - 100 / 342.3 * 1000) < 1, `${b.name}: sucrose`);
    if (!/sucrose/.test(b.name)) assert.ok(!b.sucrose_mM, `${b.name}: no sucrose`);
  }
});

test('the pH solver makes each common buffer at the pH its name states', () => {
  for (const b of catalog) {
    const d = design(b);
    assert.ok(Math.abs(d.predictedPH - b.targetPH) < 0.01, `${b.name}: predicted pH ${d.predictedPH}`);
  }
});
