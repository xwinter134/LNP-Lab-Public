// Buffer design: a compact re-implementation of the CurTiPot pH_calc idea (Gutz, USP) in JavaScript.
// Scope for the simple menu: "I want X mM buffer Y at pH Z, V mL" -> grams of acid form / base form (or titrant).
// Scope for the advanced menu: speciation, ionic strength, Davies activity correction, buffer capacity.
// pKa values come from app/data/pka.json (CurTiPot database, thermodynamic constants at I = 0, 25 °C).
// To validate against CurTiPot: 0.0265 M NaH2PO4 + 0.02 M Na2HPO4 gives pH 7.00 (pH_calc example, with activity).
//
// Two pH scales. solvePH() works with concentration constants, so its `pH` is p[H] = −log [H⁺]; with activity
// on it also gives `pH_activity` = −log a(H⁺), which is what a pH meter reads. A buffer is designed to the pH the
// meter will read: with activity on, the designs below aim at pH_activity and report it as the predicted pH
// (and p[H] beside it as predictedPcH). Before, they aimed at p[H] while the screen said "activity scale", so a
// citrate 50 mM "pH 4.00" recipe read about pH 4.1 on the meter.
//
// One ionic strength. designBuffer() is the whole recipe the Buffers screen shows, and the process designer
// (calc/process.js, ionicStrength_mM) asks it for the ionic strength of a buffer named on a plan, so the two
// screens give the same number for the same buffer: species at the designed pH with Davies activity
// correction, the counter-ions of the reagents actually weighed in (Na⁺ of trisodium citrate, of NaOH), and NaCl.

const KW = 1e-14;
const DAVIES_A = 0.509; // 25 °C

/** Davies log10 activity coefficient for charge z at ionic strength I (mol/L). Valid to roughly I = 0.1–0.3. */
export function logGammaDavies(z, I) {
  if (I <= 0) return 0;
  const s = Math.sqrt(I);
  return -DAVIES_A * z * z * (s / (1 + s) - 0.3 * I);
}

/**
 * Species fractions of an n-protic system at a given [H+] (concentration scale).
 * pka: ascending list (pKa1 is the first proton lost from the fully protonated form).
 * Returns alpha[k] for k = 0..n protons attached, charge(k) = chargeOfBase + k.
 */
export function speciation(pka, h) {
  const n = pka.length;
  const ka = pka.map((p) => Math.pow(10, -p));
  // term for k protons attached: h^k * Ka1 * ... * Ka_(n-k)   (k = n -> h^n, k = 0 -> product of all Ka)
  const terms = [];
  for (let k = 0; k <= n; k++) {
    let t = Math.pow(h, k);
    for (let j = 0; j < n - k; j++) t *= ka[j];
    terms.push(t);
  }
  const D = terms.reduce((a, b) => a + b, 0);
  return terms.map((t) => t / D);
}

/**
 * Solve the pH of a solution by charge balance (bisection), optionally with Davies activity correction.
 * @param {object} sol
 * @param {Array<{pka:number[], chargeOfBase:number, conc:number}>} sol.systems  acid/base systems, conc in mol/L (total)
 * @param {Array<{z:number, conc:number}>} [sol.ions]  strong electrolyte ions (Na+ z=+1, Cl- z=-1 ...)
 * @param {boolean} [sol.activity=false]  apply Davies correction (apparent pKa' = pKa + 2*A*f(I)*z_base)
 */
export function solvePH(sol) {
  const ions = sol.ions ?? [];
  let I = 0;
  let result = null;
  for (let iter = 0; iter < 20; iter++) {
    const fI = I > 0 ? Math.sqrt(I) / (1 + Math.sqrt(I)) - 0.3 * I : 0;
    const systems = sol.systems.map((s) => {
      // apparent constants: each step k (base charge z_b) shifts by 2*A*f*z_b when activity is on
      const pkaApp = sol.activity
        ? s.pka.map((p, i) => {
            const zBaseOfStep = s.chargeOfBase + (s.pka.length - 1 - i); // charge of the conjugate base in step i
            return p + 2 * DAVIES_A * fI * zBaseOfStep;
          })
        : s.pka;
      return { ...s, pkaApp };
    });
    const charge = (pH) => {
      const h = Math.pow(10, -pH);
      let q = h - KW / h;
      for (const ion of ions) q += ion.z * ion.conc;
      for (const s of systems) {
        const a = speciation(s.pkaApp, h);
        for (let k = 0; k < a.length; k++) q += s.conc * a[k] * (s.chargeOfBase + k);
      }
      return q;
    };
    let lo = -1, hi = 15;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (charge(mid) > 0) lo = mid; else hi = mid;
    }
    const pH = (lo + hi) / 2;
    const h = Math.pow(10, -pH);
    // ionic strength from all charged species
    let Inew = 0.5 * (h + KW / h);
    for (const ion of ions) Inew += 0.5 * ion.z * ion.z * ion.conc;
    const species = systems.map((s) => {
      const a = speciation(s.pkaApp, h);
      return a.map((frac, k) => {
        const z = s.chargeOfBase + k;
        Inew += 0.5 * z * z * s.conc * frac;
        return { protons: k, charge: z, fraction: frac, conc: s.conc * frac };
      });
    });
    // pH on the concentration scale (p[H]) and on the activity scale (pH = -log a_H), as CurTiPot reports both
    const logGammaH = sol.activity ? logGammaDavies(1, Inew) : 0;
    result = { pH, pH_activity: pH - logGammaH, gammaH: Math.pow(10, logGammaH), ionicStrength: Inew, species, charge: charge(pH) };
    if (!sol.activity || Math.abs(Inew - I) < 1e-7) break;
    I = Inew;
  }
  // buffer capacity by numeric derivative: add a little strong base, see the pH move
  const dB = 1e-4;
  const perturbed = solvePHOnce({ ...sol, ions: [...ions, { z: 1, conc: dB }] }, result.ionicStrength);
  result.bufferCapacity = dB / Math.max(perturbed.pH - result.pH, 1e-9);
  return result;
}

function solvePHOnce(sol, I) {
  const fI = I > 0 ? Math.sqrt(I) / (1 + Math.sqrt(I)) - 0.3 * I : 0;
  const charge = (pH) => {
    const h = Math.pow(10, -pH);
    let q = h - KW / h;
    for (const ion of sol.ions ?? []) q += ion.z * ion.conc;
    for (const s of sol.systems) {
      const pk = sol.activity ? s.pka.map((p, i) => p + 2 * DAVIES_A * fI * (s.chargeOfBase + (s.pka.length - 1 - i))) : s.pka;
      const a = speciation(pk, h);
      for (let k = 0; k < a.length; k++) q += s.conc * a[k] * (s.chargeOfBase + k);
    }
    return q;
  };
  let lo = -1, hi = 15;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (charge(m) > 0) lo = m; else hi = m; }
  return { pH: (lo + hi) / 2 };
}

/** The pH a meter reads: the activity scale when activity is on, else the concentration scale (the same then). */
const meterPH = (res, activity) => (activity ? res.pH_activity : res.pH);

/**
 * Simple buffer design: split a total concentration between an acid-form reagent and a base-form reagent
 * (e.g. acetic acid + sodium acetate, NaH2PO4 + Na2HPO4) so that the solution hits the target pH.
 * Reagent descriptors come from app/data/reagents.json:
 *   { name, mw, system, protonsAttached, counterIons:[{z, perMol}] }
 * Returns grams of each reagent for the given volume plus the predicted pH and ionic strength.
 */
export function designTwoReagentBuffer({ system, acidReagent, baseReagent, targetPH, conc_M, volume_mL, extraIons = [], extraSystems = [], activity = true }) {
  const build = (xBase) => {
    const ions = [...extraIons];
    for (const [reagent, frac] of [[acidReagent, 1 - xBase], [baseReagent, xBase]]) {
      for (const ci of reagent.counterIons ?? []) ions.push({ z: ci.z, conc: conc_M * frac * ci.perMol });
    }
    for (const x of extraSystems) for (const ci of x.ions || []) ions.push(ci);
    const systems = [{ pka: system.pka, chargeOfBase: system.charge_of_base, conc: conc_M }, ...extraSystems.map((x) => ({ pka: x.pka, chargeOfBase: x.chargeOfBase, conc: x.conc }))];
    return { systems, ions, activity };
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (meterPH(solvePH(build(mid)), activity) < targetPH) lo = mid; else hi = mid;
  }
  const xBase = (lo + hi) / 2;
  const res = solvePH(build(xBase));
  const mol = (conc_M * volume_mL) / 1000;
  return {
    xBase,
    acid: { reagent: acidReagent.name, mol: mol * (1 - xBase), grams: mol * (1 - xBase) * acidReagent.mw },
    base: { reagent: baseReagent.name, mol: mol * xBase, grams: mol * xBase * baseReagent.mw },
    predictedPH: meterPH(res, activity),
    predictedPcH: res.pH,
    ionicStrength: res.ionicStrength,
    bufferCapacity: res.bufferCapacity,
    reachable: xBase > 0.001 && xBase < 0.999,
  };
}

/**
 * Titrant design: a single reagent (e.g. HEPES free acid, Tris base, citric acid) adjusted with NaOH or HCl.
 * Returns mmol of titrant needed for the target pH.
 */
export function designTitratedBuffer({ system, reagent, titrant, targetPH, conc_M, volume_mL, extraIons = [], extraSystems = [], activity = true }) {
  const build = (t) => {
    const ions = [...extraIons];
    for (const ci of reagent.counterIons ?? []) ions.push({ z: ci.z, conc: conc_M * ci.perMol });
    ions.push({ z: titrant.z, conc: t }); // NaOH adds Na+ (z=+1), HCl adds Cl- (z=-1)
    for (const x of extraSystems) for (const ci of x.ions || []) ions.push(ci);
    const systems = [{ pka: system.pka, chargeOfBase: system.charge_of_base, conc: conc_M }, ...extraSystems.map((x) => ({ pka: x.pka, chargeOfBase: x.chargeOfBase, conc: x.conc }))];
    return { systems, ions, activity };
  };
  const maxT = conc_M * system.pka.length;
  let lo = 0, hi = maxT;
  const up = titrant.z > 0; // base raises pH
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const ph = meterPH(solvePH(build(mid)), activity);
    if (up ? ph < targetPH : ph > targetPH) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  const res = solvePH(build(t));
  return {
    reagent: { name: reagent.name, mol: (conc_M * volume_mL) / 1000, grams: ((conc_M * volume_mL) / 1000) * reagent.mw },
    titrant: { name: titrant.name, mmol: t * volume_mL, mL_of_1M: t * volume_mL },
    predictedPH: meterPH(res, activity),
    predictedPcH: res.pH,
    ionicStrength: res.ionicStrength,
    bufferCapacity: res.bufferCapacity,
  };
}

/**
 * The ways a buffer system can be made from the reagents on record (app/data/reagents.json), the recommended one
 * first: its acid and base forms weighed together; else one form titrated with NaOH or HCl. [{value, label}].
 * With no reagent on record the one way is 'none': the pH and the ionic strength are still worked out (as the
 * neutral form titrated to the pH), but there are no grams to weigh.
 */
export function bufferMethods(system, reagents = []) {
  const list = (reagents || []).filter((r) => r.system === system);
  const acid = list.filter((r) => r.form === 'acid'), base = list.filter((r) => r.form === 'base'), out = [];
  if (acid.length && base.length) out.push({ value: 'pair', label: `${acid[0].name} + ${base[0].name}` });
  for (const a of acid) out.push({ value: 'acid+NaOH:' + a.name, label: `${a.name} + NaOH` });
  for (const b of base) out.push({ value: 'base+HCl:' + b.name, label: `${b.name} + HCl` });
  if (!out.length) out.push({ value: 'none', label: 'No reagent data for this system (pH check only)' });
  return out;
}

/**
 * The whole recipe of a buffer, as the Buffers screen shows it and the process designer reads its ionic
 * strength from. `spec`: {system, method ('auto' = the recommended one), targetPH, conc_mM, volume_mL (1000),
 * nacl_mM, system2, conc2_mM, reagent2, activity (true)}; `tables`: {pka, reagents}. Returns
 * {method, reagents: [{name, grams | mL, mol | mmol}], pH (what the meter reads), pcH, I (mol/L), bc, reachable,
 * sys, note} or {err}.
 */
export function designBuffer(spec, { pka = [], reagents = [] } = {}) {
  const sys = pka.find((p) => p.name === spec.system);
  if (!sys) return { err: 'Unknown system' };
  const activity = spec.activity !== false;
  const system = { pka: sys.pka, charge_of_base: sys.charge_of_base };
  const extraIons = [];
  const nacl = Number(spec.nacl_mM) || 0;
  if (nacl > 0) extraIons.push({ z: 1, conc: nacl / 1000 }, { z: -1, conc: nacl / 1000 });
  const conc_M = (Number(spec.conc_mM) || 0) / 1000, volume_mL = Number(spec.volume_mL ?? 1000) || 0;
  const targetPH = Number(spec.targetPH);
  if (!(conc_M > 0) || spec.targetPH == null || spec.targetPH === '' || !Number.isFinite(targetPH)) return { err: 'Give the concentration and the pH' };
  const ways = bufferMethods(spec.system, reagents);
  const m = !spec.method || spec.method === 'auto' || !ways.some((w) => w.value === spec.method) ? ways[0].value : spec.method;
  const own = (reagents || []).filter((r) => r.system === spec.system);
  // An optional second buffer component (HEPES 10 mM + 3P 5 mM), added as its salt or free form.
  const extraSystems = [], extraReagents = [];
  const sys2 = spec.system2 ? pka.find((p) => p.name === spec.system2) : null;
  if (sys2 && Number(spec.conc2_mM) > 0) {
    const list2 = (reagents || []).filter((x) => x.system === spec.system2);
    const reagent2 = list2.find((x) => x.name === spec.reagent2) || list2.find((x) => x.form === 'base') || list2[0];
    const c2 = Number(spec.conc2_mM) / 1000;
    extraSystems.push({ pka: sys2.pka, chargeOfBase: sys2.charge_of_base, conc: c2, ions: (reagent2?.counterIons || []).map((ci) => ({ z: ci.z, conc: c2 * ci.perMol })) });
    if (reagent2) extraReagents.push({ name: reagent2.name, grams: c2 * (volume_mL / 1000) * reagent2.mw, mol: c2 * (volume_mL / 1000) });
  }
  const common = { system, targetPH, conc_M, volume_mL, extraIons, extraSystems, activity };
  try {
    if (m === 'pair') {
      const d = designTwoReagentBuffer({ ...common, acidReagent: own.find((r) => r.form === 'acid'), baseReagent: own.find((r) => r.form === 'base') });
      return { method: m, reagents: [{ name: d.acid.reagent, grams: d.acid.grams, mol: d.acid.mol }, { name: d.base.reagent, grams: d.base.grams, mol: d.base.mol }, ...extraReagents],
        pH: d.predictedPH, pcH: d.predictedPcH, I: d.ionicStrength, bc: d.bufferCapacity, reachable: d.reachable, sys };
    }
    if (m.startsWith('acid+NaOH:') || m.startsWith('base+HCl:')) {
      const name = m.slice(m.indexOf(':') + 1);
      const reagent = own.find((x) => x.name === name);
      const titrant = m.startsWith('acid') ? { name: 'NaOH 1 M', z: 1 } : { name: 'HCl 1 M', z: -1 };
      const d = designTitratedBuffer({ ...common, reagent, titrant });
      return { method: m, reagents: [{ name: d.reagent.name, grams: d.reagent.grams, mol: d.reagent.mol }, ...extraReagents, { name: d.titrant.name, mL: d.titrant.mL_of_1M, mmol: d.titrant.mmol }],
        pH: d.predictedPH, pcH: d.predictedPcH, I: d.ionicStrength, bc: d.bufferCapacity, reachable: true, sys };
    }
    // No reagent on record: the neutral form, titrated to the pH with whichever of NaOH and HCl moves it there,
    // which gives the species and the counter-ions, so the ionic strength is still the buffer's.
    const neutral = { name: sys.name, mw: 0, counterIons: [] };
    const plain = solvePH({ systems: [{ pka: sys.pka, chargeOfBase: sys.charge_of_base, conc: conc_M }, ...extraSystems], ions: [...extraIons, ...extraSystems.flatMap((x) => x.ions)], activity });
    const titrant = meterPH(plain, activity) < targetPH ? { name: 'NaOH 1 M', z: 1 } : { name: 'HCl 1 M', z: -1 };
    const d = designTitratedBuffer({ ...common, reagent: neutral, titrant });
    return { method: 'none', reagents: [], pH: d.predictedPH, pcH: d.predictedPcH, I: d.ionicStrength, bc: d.bufferCapacity, reachable: false, sys,
      note: 'No reagent descriptors for this system, so no amounts to weigh: the pH and the ionic strength assume it is brought to the pH with NaOH or HCl. Reagents are added in app/data/reagents.json.' };
  } catch (e) { return { err: e.message }; }
}

/**
 * Species fractions of a system at p[H] (the concentration scale, designBuffer's `pcH`), as {protons, charge,
 * fraction}; with the ionic strength I (mol/L) the constants are the apparent ones solvePH uses at that strength.
 */
export function speciesAt(sys, pcH, I = 0) {
  const fI = I > 0 ? Math.sqrt(I) / (1 + Math.sqrt(I)) - 0.3 * I : 0;
  const pka = sys.pka.map((p, i) => p + 2 * DAVIES_A * fI * (sys.charge_of_base + (sys.pka.length - 1 - i)));
  const a = speciation(pka, Math.pow(10, -Number(pcH)));
  return a.map((fraction, k) => ({ protons: k, charge: sys.charge_of_base + k, fraction }));
}

/**
 * A buffer lot number: Buffer-001, Buffer-002, and so on.
 *
 * Sequential rather than encoded. A lot number that tries to carry the recipe, the date and the operator in
 * its own characters has to be decoded by everyone who reads it, and goes stale the moment any of the three
 * changes. Those belong in the record, which is where this program keeps them.
 *
 * @param {number} n       the next free number
 * @param {string} prefix  something other than "Buffer" if a lab wants its own word
 */
export function bufferLot(n, prefix = 'Buffer') {
  return `${prefix}-${String(Math.max(1, Math.floor(n) || 1)).padStart(3, '0')}`;
}

/**
 * The next free lot number given the lots already used: lot strings or buffer records. Pass
 * `usedIds(store, 'buffer')` (app/schema.js) rather than the shelf, so a deleted lot's number, which the
 * formulations made with it still carry, is not given to a new one.
 */
export function nextBufferLot(existing = [], prefix = 'Buffer') {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const used = existing.map((x) => re.exec(String(x?.lot ?? x ?? ''))).filter(Boolean).map((m) => Number(m[1]));
  return bufferLot(used.length ? Math.max(...used) + 1 : 1, prefix);
}
