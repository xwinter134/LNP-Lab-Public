// Browser scenarios run by tests/smoke.mjs after the screen sweep. Each gets {page, open, base, errors}.
const expectText = async (page, selector, re, label) => {
  // innerText is the *rendered* text, so a label with text-transform:uppercase arrives uppercased. Match
  // case-insensitively where that matters, and quote enough of the page that a failure is diagnosable.
  const t = await page.locator(selector).first().innerText();
  if (!re.test(t)) throw new Error(`${label}: expected ${re} in "${t.slice(0, 500)}"`);
};

/**
 * Read or replace a whole data collection from a scenario. Scenarios go through these (or `window.lnpDb`
 * inside page.evaluate) rather than a storage engine, so the engine underneath can change without every
 * scenario changing with it: the records live in IndexedDB since cycle 4, cached in the page's memory.
 * `ns` is the store namespace: 'lnp-lab' for real data, 'lnp-demo' in demo mode. writeCol resolves once the
 * rows are stored, so a reload after it sees them.
 */
export const readCol = (page, col, ns = 'lnp-lab') => page.evaluate(([c, n]) => window.lnpDb.read(c, n), [col, ns]);
export const writeCol = (page, col, rows, ns = 'lnp-lab') => page.evaluate(([c, r, n]) => window.lnpDb.write(c, r, n), [col, rows, ns]);

/** The other direction: something that must not be on the screen at all. */
const expectNoText = async (page, selector, re, label) => {
  const t = await page.locator(selector).first().innerText();
  const m = re.exec(t);
  if (m) throw new Error(`${label}: found ${re} at "${t.slice(Math.max(0, m.index - 120), m.index + 120)}"`);
};

/**
 * Open every folded section on the screen, one click each, the way a reader who doubts the verdict would.
 * innerText leaves out what a closed <details> holds, so a check on the evidence has to open it first. Folds
 * hidden in simple mode cannot be clicked and are left alone.
 */
const openFolds = async (page) => {
  const closed = page.locator('#main details.fold:not([open]) > summary:visible');
  for (let guard = 0; guard < 20 && await closed.count(); guard++) { await closed.first().click(); await page.waitForTimeout(60); }
};

export async function stocksCreateAndSave({ page, open }) {
  await open('stocks?new=1');
  await page.selectOption('select[name=compositionId]', '1');
  await page.fill('input[name=molarity_mM]', '50');
  await page.fill('input[name=volume_mL]', '20');
  await page.dispatchEvent('input[name=volume_mL]', 'change');
  // #1 is the MC3 reference: 50 / 10 / 38.5 / 1.5 at 50 mM in 20 mL is 1.0 mmol in total, so DSPC is
  // 0.1 mmol x 790.15 g/mol = 0.0790 g, uncorrected for purity.
  await expectText(page, '[data-key=DSPC]', /0\.0790/, 'DSPC weigh-in, with no purity correction applied');
  for (const [k, v] of [['MC3', '0.3051'], ['DSPC', '0.0744'], ['Chol', '0.1415'], ['DMG0PEG2000', '0.0359']]) {
    await page.fill(`input[name=actual_${k}]`, v);
  }
  await page.dispatchEvent('input[name=actual_DMG0PEG2000]', 'change');
  await expectText(page, '#stockForm', /Add ethanol[\s\S]*mL/, 'the ethanol step is worked out once every mass is in');
  await expectText(page, '#stockForm', /Result[\s\S]*mM/, 'and the resulting stock with it');
  await page.click('#saveStock');
  await page.waitForTimeout(200);
  await expectText(page, '#stockList', /Stock-001/, 'the saved stock is numbered in its own series');
}

export async function buffersDesignAndSave({ page, open }) {
  await open('buffers?new=1');
  if (!(await page.locator('#bufferForm').count())) return;
  await page.selectOption('select[name=system]', 'Acetic acid');
  await page.fill('input[name=targetPH]', '5.5');
  await page.fill('input[name=conc_mM]', '50');
  await page.fill('input[name=volume_mL]', '1000');
  await page.dispatchEvent('input[name=volume_mL]', 'change');
  await expectText(page, '#bufferResult', /predicted pH\s*5\.5/i, 'buffer design');
  await page.fill('input[name=name]', 'Acetate 50 mM pH 5.5');
  await page.click('#saveBuffer');
  await page.waitForTimeout(200);
  // lots are numbered in sequence now, not coded
  await expectText(page, '#bufferList', /Buffer-001/, 'saved buffer lot is numbered');
  await expectText(page, '#bufferList', /Acetate 50 mM pH 5\.5/, 'and carries its name');
}

export async function materialsAddLots({ page, open }) {
  await open('materials?tab=rna');
  // RNA lots open in place, like the other materials: "+ Add RNA lot", then the editor's fields
  await page.click('#tabBody [data-act=new]');
  await page.fill('[data-editor] [name=e_id]', 'RNA-TEST-01');
  await page.selectOption('[data-editor] [name=e_cargo]', 'mRNA');
  await page.fill('[data-editor] [name=e_construct]', 'FLuc');
  await page.fill('[data-editor] [name=e_conc_mg_mL]', '2.06');
  await page.click('[data-editor] [data-act=save]');
  await page.waitForTimeout(200);
  await expectText(page, '#tabBody', /RNA-TEST-01/, 'rna lot listed');
  await open('materials?tab=lipids');
  await page.selectOption('#lotForm select[name=lipidKey]', 'Chol');
  await page.fill('#lotForm input[name=lot]', 'K53436572');
  await page.fill('#lotForm input[name=purityPct]', '95');
  await page.click('#addLot');
  await page.waitForTimeout(200);
  await expectText(page, '#tabBody', /K53436572/, 'lipid lot listed');
  await open('materials?tab=compositions');
  await open('materials?tab=tff');
  await open('materials?tab=consumables');
  // a tab that no longer exists must fall back rather than break the screen
  await open('materials?tab=mixers');
  await expectText(page, '#tabBody', /Lipid/, 'an unknown tab falls back to the first one');
}

export async function experimentsStabilityAndSingle({ page, open }) {
  await open('experiments?new=1');
  await expectText(page, '#main', /Stability study/, 'type cards');
  await open('experiments?new=1&type=stability');
  await page.fill('input[name=name]', 'Stability MC3 vs ref');
  await page.selectOption('select[name=form_0]', '1');
  await page.click('#addForm');
  await page.waitForTimeout(100);
  await page.selectOption('select[name=form_1]', '1');
  await page.fill('input[name=st_durationDays]', '28');
  await page.dispatchEvent('input[name=st_durationDays]', 'change');
  await expectText(page, '#main', /Formulations\s*2/, 'the preview counts the formulations it will create');
  // With the custom-timepoints box left empty, the schedule comes from duration and interval. An empty box
  // once parsed as [0] and the study got T0 alone: no later pulls, reminders or potency slots.
  await expectText(page, '#main', /Timepoints:\s*T0\s*·\s*T3\b[\s\S]*\bT28\b/, 'the wizard lists every pull up to the duration, not T0 alone');
  await page.click('#createExp');
  await page.waitForTimeout(300);
  // The plan is the stability table of the Results card (the separate measurement matrix is gone): days across.
  await expectText(page, '#stabTable', /\bT0\b[\s\S]*\bT3\b[\s\S]*\bT28\b/, 'the created study has its later timepoints as table columns');
  await expectNoText(page, '#main', /Measurement matrix/, 'the matrix card that repeated the table');
  await expectText(page, '#main', /Composition[\s\S]*#1/, 'first formulation is the composition');
  await expectText(page, '#main', /Mixing[\s\S]*mL\/min/, 'overview card names the mixing settings');
  await open('experiments?new=1&type=single');
  await page.fill('input[name=name]', 'Single MC3');
  await page.selectOption('select[name=compositionId]', '1');
  await page.waitForTimeout(150);
  await page.click('#createExp');
  await page.waitForTimeout(300);
  await expectText(page, '#main', /E2-F1/, 'the second experiment numbers its formulations from 1 again');
  await open('experiments');
  await expectText(page, '#main', /Experiment 2/, 'list shows second experiment');
}

export async function batchRecordAndCalendar({ page, open }) {
  await open('formulation');
  await expectText(page, '#main', /E2-F1/, 'the formulation list');
  await open('formulation?batch=E2-F1');
  await page.selectOption('select[name=rna_lotId]', 'RNA-TEST-01');
  await page.fill('input[name=rna_mass_mg]', '3');
  await page.dispatchEvent('input[name=rna_mass_mg]', 'change');
  // a planned batch opens on step 1; mixing and dialysis are a click away, and stay open through the redraws
  await openStep(page, 2); await openStep(page, 3);
  await expectText(page, '#main', /RNA volume \(mL\)[\s\S]*7\.50/, 'mixing RNA volume');
  await page.selectOption('select[name=stockId]', 'Stock-001');
  await page.fill('input[name=ds_dialysis_start_mL]', '10');
  await page.dispatchEvent('input[name=ds_dialysis_start_mL]', 'change');
  await page.fill('input[name=a_dialysis_end_mL]', '14');
  await page.dispatchEvent('input[name=a_dialysis_end_mL]', 'change');
  await expectText(page, '#main', /0\.714/, 'dialysis dilution factor');
  // the record is stored as it is filled in; wait for the write rather than press a Save button
  await page.evaluate(() => window.lnpDb.flush());
  await open('calendar');
  await expectText(page, '#main', /Produce E2-F1/, 'calendar shows the day it is to be made');
}

export async function measurementsManualAndImport({ page, open }) {
  await open('measurements');
  const opt = await page.locator('select[name=slotId] option', { hasText: 'E2-F1_final · dls' }).first().getAttribute('value');
  await page.selectOption('select[name=slotId]', opt);
  await page.fill('input[name=run_z1]', '82.4'); await page.fill('input[name=run_p1]', '0.08');
  await page.fill('input[name=run_z2]', '83.1'); await page.fill('input[name=run_p2]', '0.09');
  await page.click('#saveManual');
  await page.waitForTimeout(200);
  await openFolds(page); // the stored results are one line until opened
  await expectText(page, '#main', /E2-F1_final[\s\S]*82\.8 nm/, 'manual dls result listed');
  const csv = ['Sample Name,Z-Average (d.nm),PdI,Derived Count Rate (kcps)', 'E1-F1_4C_T00 1,80.1,0.07,300', 'E1-F1_4C_T00 2,80.5,0.08,305', 'E1-F2_25C_T00 1,91.2,0.11,280', 'Blank PBS,,,10'].join('\n');
  await page.setInputFiles('#csvFile', { name: 'dls.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForTimeout(300);
  await expectText(page, '#importPreview', /2 matched/, 'import preview matched');
  await page.selectOption('#importPreview select[data-target]', '__ignore');
  await page.click('#doImport');
  await page.waitForTimeout(300);
  await openFolds(page);
  await expectText(page, '#main', /E1-F2_25C_T00[\s\S]*91\.2 nm/, 'imported result listed');
  await open('experiments?id=E1');
  await expectText(page, '#main', /80\.3 \/ 0\.0[78]/, 'stability matrix shows imported T0 value');
  await open('experiments?id=E2');
  await expectText(page, '#main', /82\.8 \/ 0\.0[89]/, 'single experiment shows latest DLS');
}

export async function importFromPaste({ page, open }) {
  // The easy path: the app says what it is waiting for, you name the samples that way on the instrument, and
  // the numbers come back by paste rather than by file. Nothing here should need a mapping step.
  await open('measurements');
  const names = await page.$$eval('[data-wait-name]', (e) => e.map((x) => x.dataset.waitName));
  if (!names.length) throw new Error('the waiting-for-results card named no samples');
  if (new Set(names).size !== names.length) throw new Error('a sample is listed once per test; it should be once per vial');

  await page.click('#main details summary');
  await page.fill('#pasteBox', `Sample Name\tZ-Average (d.nm)\tPdI\n${names[0]}\t91.7\t0.064`);
  await page.click('#pasteGo');
  await page.waitForTimeout(400);
  await expectText(page, '#importPreview', /1 matched/, 'a pasted block is read like a file');
  // Which formulation it belongs to, not which slot: the card lists a sample once however many tests it is
  // still due, so the open slot for the name it gave may be for a test other than the one being imported.
  const target = names[0].replace(/_.*$/, '');
  await expectText(page, '#importPreview', new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and the preview names the formulation it belongs to');
  await page.click('#doImport');
  await page.waitForTimeout(500);
  await openFolds(page);
  await expectText(page, '#main', new RegExp(`${names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*91\\.7 nm`), 'the pasted result is stored against that sample');
}

export async function doeOverviewInsightsSettings({ page, open }) {
  await open('experiments?new=1&type=ofat');
  await page.fill('input[name=name]', 'N/P scan');
  await page.click('#createExp');
  await page.waitForTimeout(300);
  await expectText(page, '#main', /N\/P ratio 3/, 'ofat batches labelled by level');
  await open('doe');
  await expectText(page, '#main', /Run table[\s\S]*N\/P ratio/, 'doe screen shows the OFAT run table');
  await open('overview');
  await expectText(page, '#main', /Recent formulations[\s\S]*E\d+-F\d+/, 'the overview lists what was made most recently');
  await open('insights');
  await expectText(page, '#main', /Control chart/, 'insights renders');
  await open('settings');
  await page.fill('input[name=operator]', 'AbCd'); // stored as typed, and at the latest as the screen is left
  await open('stocks?new=1');
  const op = await page.inputValue('input[name=operator]');
  if (op !== 'AbCd') throw new Error('settings operator not applied: ' + op);
  await open('calendar');
  await expectText(page, '#main', /Upcoming/, 'calendar renders');
}

export async function wizardOtherTypes({ page, open }) {
  // Only the one reference composition ships, so a comparison needs a second recipe registered first.
  await open('materials?tab=compositions');
  await page.fill('#compForm input[name=synonym]', 'High PEG variant');
  for (const [i, [key, pct]] of [['MC3', '50'], ['DSPC', '10'], ['Chol', '37'], ['DMG0PEG2000', '3']].entries()) {
    await page.selectOption(`#compForm select[name=k${i}]`, key);
    await page.fill(`#compForm input[name=p${i}]`, pct);
  }
  await page.click('#addComp'); await page.waitForTimeout(250);
  await expectText(page, '#tabBody', /High PEG variant/, 'the new composition is registered');

  await open('experiments?new=1&type=comparison');
  await page.fill('input[name=name]', 'Lipid screen');
  await page.click('#addCmp'); await page.waitForTimeout(100);
  await page.selectOption('select[name=cmp_1]', '2');
  await page.dispatchEvent('select[name=cmp_1]', 'change');
  await expectText(page, '#main', /Formulations\s*2/, 'comparison preview');
  await page.click('#createExp'); await page.waitForTimeout(300);
  // The scenario order decides which experiment number this is, so assert the shape and not the number.
  await expectText(page, '#main', /E\d+-F2/, 'a comparison numbers its arms inside the experiment');
  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', 'Reference repeats');
  await page.fill('input[name=ref_n]', '2'); await page.dispatchEvent('input[name=ref_n]', 'change');
  await expectText(page, '#main', /Formulations\s*2/, 'reference preview');
  await page.click('#createExp'); await page.waitForTimeout(300);
  await expectText(page, '#main', /rep 2/, 'reference batches');
  await open('experiments?new=1&type=doe');
  await page.fill('input[name=name]', 'FRR x TFR');
  await expectText(page, '#main', /Formulations\s*7/, 'doe full factorial 2^2 + 3 center points');
  await page.click('#addCustomF'); await page.waitForTimeout(100);
  await page.fill('input[name=doe_f_name_2]', 'temperature'); await page.fill('input[name=doe_f_unit_2]', 'degC');
  await page.fill('input[name=doe_f_low_2]', '4'); await page.fill('input[name=doe_f_center_2]', '21'); await page.fill('input[name=doe_f_high_2]', '37');
  await page.dispatchEvent('input[name=doe_f_high_2]', 'change');
  await page.selectOption('select[name=doe_designType]', 'ccd_faced'); await page.dispatchEvent('select[name=doe_designType]', 'change');
  await page.selectOption('select[name=doe_model]', 'quadratic'); await page.dispatchEvent('select[name=doe_model]', 'change');
  await page.fill('input[name=doe_centerPoints]', '4'); await page.dispatchEvent('input[name=doe_centerPoints]', 'change');
  await expectText(page, '#main', /18 runs: 8 factorial · 6 axial · 4 center[\s\S]*9 terms, 8 residual df[\s\S]*Formulations\s*18/, 'ccd preview with design summary');
  await page.click('#createExp'); await page.waitForTimeout(300);
  await expectText(page, '#main', /R0\d\d \(center\)[\s\S]*temperature = 21/, 'doe batches labelled by run id with the record-only factor');
  await page.click('a.btn[href^="#/doe?id="]'); await page.waitForTimeout(300);
  await expectText(page, '#main', /Design and runs[\s\S]*Take the data elsewhere[\s\S]*Model fit/, 'doe screen sections');
}

export async function mlOptimizer({ page, open }) {
  // Seed a history the optimiser can learn from: four experiments, six batches each, with a known truth.
  await page.evaluate(async () => {
    const rnd = ((s) => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
    const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const batches = await lnpDb.read('batches');
    const meas = await lnpDb.read('measurements');
    const exps = await lnpDb.read('experiments');
    let k = 1;
    for (let e = 0; e < 4; e++) {
      const expId = `ML-${e + 1}`, ids = [];
      for (let i = 0; i < 6; i++) {
        const frr = 2 + rnd() * 4, tfr = 25 + rnd() * 120, peg = 0.6 + rnd() * 2.2, ion = 38 + rnd() * 20;
        const id = `MLB${String(k++).padStart(3, '0')}`;
        ids.push(id);
        const date = `2026-0${e + 4}-${String(5 + i).padStart(2, '0')}`;
        batches.push({ id, experimentId: expId, label: `run ${i + 1}`, compositionId: 2, stockId: null, plannedDate: date, status: 'produced',
          plan: { rna: { working_mg_mL: 0.4, mass_mg: 3, np: 6 }, mixing: { frr, totalFlow: tfr, quenchFactor: 2, lipidStock_mM: 50, flows: null },
            compositionOverride: { ionizable: ion, helper: 10, peg, sterol: 100 - ion - 10 - peg }, factors: {}, downstream: {} }, actual: {} });
        meas.push({ id: 'M' + id + 'd', batchId: id, experimentId: expId, test: 'dls', stage: 'final', date,
          values: { zave_nm: 140 - 9 * (frr - 2) - 0.18 * (tfr - 20) - 14 * (peg - 0.5) + g() * 2,
            pdi: Math.max(0.03, 0.08 + 0.02 * Math.abs(frr - 4) + 0.0004 * Math.abs(tfr - 95) + 0.05 * Math.max(0, 1.2 - peg) + g() * 0.008) } });
        meas.push({ id: 'M' + id + 'e', batchId: id, experimentId: expId, test: 'ee', stage: 'final', date,
          values: { ee_pct: Math.min(99, Math.max(20, 97 / (1 + Math.exp(-(ion - 44) / 3)) - 2 * Math.max(0, frr - 5) + g() * 1.2)) } });
      }
      exps.push({ id: expId, type: 'single', name: `Screen ${e + 1}`, startDate: `2026-0${e + 4}-05`, compositionId: 2, status: 'done', spec: {}, design: {}, batchIds: ids, expected: [] });
    }
    await lnpDb.write('batches', batches);
    await lnpDb.write('measurements', meas);
    await lnpDb.write('experiments', exps);
  });
  await open('ml');
  // earlier scenarios leave their own measured batches behind, so the count is "at least the 24 seeded here"
  const usable = Number(/(\d+) formulations? from \d+ experiments?/.exec(await page.locator('#main').innerText())?.[1] || 0);
  if (usable < 24) throw new Error(`ml screen should see at least the 24 seeded runs, saw ${usable}`);
  await expectText(page, '#main', /What counts as a good batch/, 'ml screen with the seeded history');
  await expectText(page, '#main', /held constant/, 'factors that never varied are marked, not silently dropped');
  await page.click('#runBtn');
  await page.waitForTimeout(12000);
  // The answer leads and the evidence is folded under it; open it, then read all of it as before.
  await openFolds(page);
  await expectText(page, '#main', /Does the model know anything[\s\S]*Cross-validated Q²/, 'model report card');
  await expectText(page, '#main', /Mean of all runs/, 'the predict-the-average baseline is always shown');
  await expectText(page, '#main', /Null check: shuffling the results/, 'the null check is reported');
  await expectText(page, '#main', /What to run next[\s\S]*Beats best/, 'suggestions with their odds');
  await expectText(page, '#main', /What drives what[\s\S]*associations in the runs you did, not causes/, 'the attribution caveat is shown');
  await expectText(page, '#main', /The map[\s\S]*Darker is better/, 'the design-space map');
  await expectText(page, '#main', /Try a setting[\s\S]*Overall score/, 'the what-if box predicts a typed setting');
  // typing a setting outside everything run so far must be called out as extrapolation
  await page.fill('input[name=wi_frr]', '5.9');
  await page.dispatchEvent('input[name=wi_frr]', 'change');
  await page.waitForTimeout(900);
  await expectText(page, '#main', /Try a setting[\s\S]*Overall score/, 'the what-if box survives an edit');
  // the loop closes: suggestions become real planned batches. A recipe that cannot be formulated asks first;
  // accept it here so the scenario tests the path rather than the dialog.
  page.on('dialog', (d) => d.accept());
  await page.click('#makeExp');
  await page.waitForTimeout(600);
  await expectText(page, '#main', /ML round 1/, 'an experiment was created from the suggestions');
  await expectText(page, '#main', /suggestion 1[\s\S]*suggestion 2/, 'with one formulation per suggested run');
  const comp = await page.evaluate(async () => {
    const b = (await lnpDb.read('batches')).filter((x) => x.ml);
    if (!b.length) return null;
    const c = b[0].plan.compositionOverride;
    return { n: b.length, sum: ['ionizable', 'helper', 'peg', 'sterol', 'other'].reduce((s, k) => s + (c[k] || 0), 0), hasPrediction: !!b[0].ml.predicted };
  });
  if (!comp || comp.n < 4) throw new Error('suggested batches were not stored: ' + JSON.stringify(comp));
  if (Math.abs(comp.sum - 100) > 0.01) throw new Error(`suggested composition does not total 100 mol%: ${comp.sum}`);
  if (!comp.hasPrediction) throw new Error('the batch does not carry what the model predicted for it');
  // A changed composition has to exist in the registry, because the batch record, the weigh-in calculator and
  // the lot number all resolve it by id. An override alone would never reach the operator.
  const reg = await page.evaluate(async () => {
    const comps = await lnpDb.read('compositions');
    const b = (await lnpDb.read('batches')).filter((x) => x.ml);
    return { added: comps.length, pointed: b.every((x) => Number.isFinite(x.compositionId)),
      sums: comps.map((c) => Math.round(Object.values(c.mol_pct).reduce((s, v) => s + v, 0) * 100) / 100),
      dates: [...new Set(b.map((x) => x.plannedDate))].length };
  });
  if (!reg.pointed) throw new Error('a suggested batch has no composition id');
  if (reg.added && reg.sums.some((v) => Math.abs(v - 100) > 0.05)) throw new Error(`a registered composition does not total 100 mol%: ${reg.sums.join(', ')}`);
  if (reg.added) await expectText(page, '#main', /ML round 1 · from #/, 'the new composition is named after the one it came from');
  // the run-by-run table sits under the line that says how the predictions did
  await openFolds(page);
  await expectText(page, '#main', /What the model expected[\s\S]*not measured yet/, 'the experiment shows what was predicted for each run');
  // record a result for the first suggested batch and check the prediction is scored against it
  const mlBatch = (await readCol(page, 'batches')).find((b) => b.ml)?.id;
  await page.evaluate(async (id) => {
    const m = await lnpDb.read('measurements');
    const b = (await lnpDb.read('batches')).find((x) => x.id === id);
    const p = b.ml.predicted.particle_size_nm;
    m.push({ id: 'MLCHECK', batchId: id, test: 'dls', stage: 'final', date: '2026-09-01', values: { zave_nm: p.mean, pdi: 0.09 } });
    await lnpDb.write('measurements', m); // stored before the reload below
  }, mlBatch);
  await page.reload(); await page.waitForTimeout(600);
  await openFolds(page);
  await expectText(page, '#main', /What the model expected[\s\S]*as predicted/, 'a result inside the interval is marked as predicted');
  // the operator's batch record must show the recipe that will actually be weighed out
  const firstMl = (await readCol(page, 'batches')).find((b) => b.ml)?.id;
  await open(`formulation?batch=${firstMl}`);
  await expectText(page, '#main', /Experiment \d+ · formulation \d+/, 'the suggested formulation has a record');
  const recordText = await page.locator('#main').innerText();
  if (/varies the composition/.test(recordText) && !/mol% totals|total is 100 mol%/.test(recordText)) {
    throw new Error('the batch record says the composition varies but does not say what it totals');
  }

  // back on the ML screen the new runs are counted as the optimiser's own
  await open('ml');
  await page.waitForTimeout(400);
  await expectText(page, '#main', /formulations? from \d+ experiments?/, 'ml screen still renders after the round trip');
  await open('overview');
  await expectText(page, '#main', /Optimizer[\s\S]*suggested formulation/, 'the overview reports the optimizer is waiting on results');
  // repeated edits must not get slower: the delegated listener lives on a container the redraw replaces, so
  // handlers cannot accumulate (the same bug this project hit once on the process screen)
  await open('ml');
  await page.click('#runBtn');
  await page.waitForTimeout(9000);
  // after a run the goals fold to one line; opened, they must stay open through every redraw an edit causes
  await page.click('#setupFold > summary');
  const times = [];
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    await page.fill('input[name=g_weight_0]', String(1 + i * 0.5));
    await page.dispatchEvent('input[name=g_weight_0]', 'change');
    await page.waitForTimeout(100);
    times.push(Date.now() - t0);
  }
  const early = (times[0] + times[1]) / 2, late = (times[4] + times[5]) / 2;
  if (late > early * 1.8 + 60) throw new Error(`ml screen slows down with repeated edits (${times.join(', ')} ms): listeners are accumulating`);
}

export async function advisorAndReference({ page, open }) {
  // The planner opens on a choice of door, not on the first question.
  await open('advisor');
  await expectText(page, '#main', /How do you want to start\?/, 'the planner offers a choice of door');
  const doors = await page.locator('a.adv-door').count();
  if (doors !== 3) throw new Error(`expected three doors on the planner, found ${doors}`);
  await page.click('a.adv-door[href="#/advisor?mode=wizard"]'); await page.waitForTimeout(300);
  await expectText(page, '#main', /What are you trying to do\?/, 'the first door starts the questions');
  await page.click('[data-set="aim=size"]'); await page.waitForTimeout(250);
  await expectText(page, '#main', /How many batches can you run/, 'then asks the budget');
  await page.click('[data-set="budget=medium"]'); await page.waitForTimeout(250);
  await expectText(page, '#main', /What are you allowed to change/, 'then asks the scope');
  await page.click('[data-set="scope=composition"]'); await page.waitForTimeout(350);
  // the demo data has runs on file, so the advice is a model-led round rather than a design from scratch
  await expectText(page, '#main', /Recommendation[\s\S]*propose the next \d+ runs/i, 'and recommends what to run next');
  await expectText(page, '#main', /Why this and not something else[\s\S]*What will happen[\s\S]*What usually goes wrong/,
    'with reasons, expectations and the usual traps');
  await expectText(page, '#main', /Where you are starting from/, 'and says what it knows about the data on file');

  // an earlier answer can be changed, and the later ones are cleared rather than left stale
  await page.click('[data-set="aim="]'); await page.waitForTimeout(300);
  await expectText(page, '#main', /What are you trying to do\?/, 'changing the first answer returns to the first question');

  // the recommendation hands itself over rather than asking to be retyped: a model-led round opens the module
  await open('advisor?aim=size&budget=medium&scope=composition');
  const toModule = await page.locator('a.btn.primary').first().getAttribute('href');
  if (!/^#\/ml\?factors=/.test(toModule || '')) throw new Error(`a model-led round should open the ML module: ${toModule}`);
  await page.goto(page.url().split('#')[0] + toModule);
  await page.waitForTimeout(700);
  await expectText(page, '#main', /came from[\s\S]*planner/, 'the module says where its factors came from');

  // and a design recommendation opens the wizard already filled in, design and all
  await open('advisor?aim=screen&budget=medium&scope=composition');
  await expectText(page, '#main', /Recommendation[\s\S]*Screen \d+ factors in \d+ runs/i, 'an explicit screen gets a screening design');
  const setup = await page.locator('a.btn.primary').first().getAttribute('href');
  if (!/factors=/.test(setup || '')) throw new Error(`the set-up link carries no factors: ${setup}`);
  if (!/design=/.test(setup || '')) throw new Error(`the set-up link carries no design: ${setup}`);
  await page.goto(page.url().split('#')[0] + setup);
  await page.waitForTimeout(700);
  await expectText(page, '#main', /Filled in from[\s\S]*planner/, 'the target screen says where its setup came from');
  const prefilled = await page.evaluate(() => [...document.querySelectorAll('input[name^="doe_f_name_"]')].map((i) => i.value));
  if (prefilled.length < 2) throw new Error(`the wizard was not prefilled: ${prefilled.join(',')}`);

  // the troubleshooting path costs no batches, and has a door of its own
  await open('advisor');
  await page.click('a.adv-door[href="#/advisor?mode=wizard&aim=trouble"]'); await page.waitForTimeout(350);
  await expectText(page, '#main', /What is wrong\?/, 'the third door starts from a symptom');
  await open('advisor?mode=wizard');
  await page.click('[data-set="aim=trouble"]'); await page.waitForTimeout(250);
  await expectText(page, '#main', /What is wrong\?/, 'the trouble path asks for a symptom');
  await page.click('[data-set="symptom=pdi"]'); await page.waitForTimeout(350);
  await expectText(page, '#main', /Likely causes[\s\S]*Check:[\s\S]*If that is it:/, 'and lists ordered causes with checks and fixes');

  // the "?" explainer opens, stacks through a related link, and closes on Escape
  await page.click('#main button.learn:not([disabled])'); await page.waitForTimeout(300);
  await expectText(page, '.learn-card', /Why it matters here[\s\S]*At the bench/i, 'the explainer has the teaching sections');
  const first = await page.locator('.learn-card h2').innerText();
  if (await page.locator('#learnBack').count()) throw new Error('the first entry should have nothing behind it');
  if (await page.locator('.learn-rel').count()) {
    await page.locator('.learn-rel').first().click();
    await page.waitForTimeout(250);
    const second = await page.locator('.learn-card h2').innerText();
    if (second === first) throw new Error('following a related link did not change the explainer');
    // and the way back exists, by button and by key
    if (!(await page.locator('#learnBack').count())) throw new Error('no way back from a related entry');
    await page.click('#learnBack'); await page.waitForTimeout(250);
    if ((await page.locator('.learn-card h2').innerText()) !== first) throw new Error('the back button did not return to the previous entry');
    await page.locator('.learn-rel').first().click(); await page.waitForTimeout(250);
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(250);
    if ((await page.locator('.learn-card h2').innerText()) !== first) throw new Error('the left arrow did not step back');
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  if (await page.locator('.learn-card').count()) throw new Error('the explainer did not close on Escape');
  // it also belongs to the screen it was opened from: navigating must not leave it floating over the next one
  await open('learn?topic=frr');
  if (!(await page.locator('.learn-card').count())) throw new Error('a topic in the address did not open its entry');
  await open('overview');
  if (await page.locator('.learn-card').count()) throw new Error('the explainer survived a navigation');

  // the reference index is searchable
  await open('learn');
  await expectText(page, '#main', /Formulation[\s\S]*Process[\s\S]*Measurement/, 'the reference is grouped');
  await page.fill('input[name=q]', 'flow rate');
  await page.waitForTimeout(500);
  await expectText(page, '#main', /flow rate/i, 'and searchable');
  const tiles = await page.locator('button.learn-tile').count();
  if (tiles > 6) throw new Error(`search did not narrow the list (${tiles} entries still shown)`);
}

export async function batchRecordRepeatedEdits({ page, open }) {
  // The guard this replaces watched the process screen for handlers piling up on every redraw. The batch
  // record redraws the same way on every keystroke, so the same mistake would show up here.
  await open('formulation?batch=E2-F1');
  await openStep(page, 2); // the step whose table this checks; E2-F1 is further on by now, or measured
  const t0 = Date.now();
  for (const v of ['50', '60', '70', '80', '90', '100']) {
    await page.fill('input[name=mixing_totalFlow]', v);
    await page.dispatchEvent('input[name=mixing_totalFlow]', 'change');
    await page.waitForTimeout(30);
  }
  if (Date.now() - t0 > 4000) throw new Error('batch record became slow after repeated edits');
  await expectText(page, '#main', /Total process flow \(mL\/min\)[\s\S]*100/, 'last edit applied');
}

export async function designCatalogue({ page, open }) {
  await open('designs');
  await expectText(page, '#main', /Simple experiments[\s\S]*Which factors matter[\s\S]*Where the optimum is/, 'the catalogue is grouped by the question each design answers, simple experiments first');
  // each entry is read by its shape first: a figure per tile, and one line on what it answers
  const tiles = await page.locator('#catRoot .dc-item').count();
  const figs = await page.locator('#catRoot .dc-item .dc-fig svg').count();
  if (!tiles || figs !== tiles) throw new Error(`every catalogue entry should have a figure: ${figs} of ${tiles}`);
  await expectText(page, '[data-entry=bbd] .dc-ans', /without the extreme corners/, 'one line on the question it answers');
  if (await page.locator('[data-entry=bbd] .dc-more p').first().isVisible()) throw new Error('the long text should wait behind "More"');
  const bbRow = () => page.locator('#catRoot [data-entry=bbd] .dc-count').first().innerText();

  // the batch count is computed for the factor count you choose, so it has to move when that changes
  const atThree = await bbRow();
  await page.click('#kSeg button[data-k="4"]'); await page.waitForTimeout(400);
  const atFour = await bbRow();
  if (atThree === atFour) throw new Error('the batch count did not change with the factor count');

  // the hand-over carries the design, not just the screen
  await page.click('#kSeg button[data-k="3"]'); await page.waitForTimeout(400);
  const setup = await page.locator('#catRoot a.btn.primary').last().getAttribute('href');
  if (!/type=doe[\s\S]*design=|#\/ml|type=(single|reference|comparison|stability|ofat)/.test(setup || '')) {
    throw new Error(`a catalogue entry set-up link goes nowhere useful: ${setup}`);
  }

  // a budget marks what does not fit rather than hiding it
  await page.fill('input[name=budget]', '8'); await page.waitForTimeout(500);
  await expectText(page, '#main', /over budget/, 'a budget marks the designs that do not fit');

  // and the planner's second door opens it
  await open('advisor');
  await page.click('a.adv-door[href="#/designs"]'); await page.waitForTimeout(400);
  await expectText(page, '#main', /Design catalogue/, 'the second door opens the catalogue');
}

/**
 * Demo mode, end to end, including the walk the user actually takes: a measured design, its diagnostics, and
 * then the optimiser picking those same batches up. It runs last and switches itself off again, because every
 * other scenario and every screenshot expects the real namespace.
 */
export async function demoModeAndDoeToMl({ page, open, base }) {
  const realBefore = (await readCol(page, 'experiments')).length;
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await expectText(page, 'nav', /DEMO/i, 'the sidebar says which data you are looking at');

  const seeded = {
    exps: (await readCol(page, 'experiments', 'lnp-demo')).length,
    batches: (await readCol(page, 'batches', 'lnp-demo')).length,
    real: (await readCol(page, 'experiments', 'lnp-lab')).length, // the closed namespace, read from where it is kept
  };
  if (seeded.exps !== 7) throw new Error(`demo seeded ${seeded.exps} experiments, expected 7`);
  if (seeded.batches < 30) throw new Error(`demo seeded only ${seeded.batches} batches`);
  if (seeded.real !== realBefore) throw new Error('switching to demo mode changed the real namespace');

  // the response surface design, with results: the diagnostics must all be there
  await open('doe?id=E4&response=particle_size_nm');
  await expectText(page, '#main', /Response surface FRR x flow x PEG/, 'the demo design is selected');
  await expectText(page, '#designLine', /18 runs[\s\S]*all measured/, 'every run has results');
  await expectText(page, '#main', /Is this fit any good\?/, 'the diagnostics card');
  await expectText(page, '#balanceCard', /Best balance of all responses[\s\S]*Overall score\s*0\.\d\d/, 'one setting that balances every response leads the page');
  // the verdict leads, one sentence, beside the one plot it points at; every other plot is one click away
  await expectText(page, '#fitVerdict', /^The fit looks sound: residuals shapeless, no run stands out, no lack of fit, predicted R² 0\.9\d\.$/, 'a sound fit says so, and what was checked');
  if (await page.locator('#fitVerdict').getAttribute('data-plot') !== 'measured-vs-predicted') throw new Error('a sound fit should show measured against predicted');
  await expectText(page, '#fitCard', /Measured against predicted/i, 'observed-predicted, open beside the verdict');
  if (await page.locator('#plotsFold').evaluate((d) => d.open)) throw new Error('the other diagnostic plots should fold under the verdict');
  await expectNoText(page, '#fitCard', /Which terms are real|Normal plot of the residuals|The fitted surface/i, 'the other plots stay folded until asked for');
  await expectText(page, '#plotsFold > summary', /All diagnostic plots[\s\S]*Pareto[\s\S]*normal plot[\s\S]*surface/i, 'the folded plots are named on its line');
  await page.click('#plotsFold > summary');
  await expectText(page, '#plotsFold', /Which terms are real[\s\S]*Residuals against fitted/i, 'Pareto and residuals');
  await expectText(page, '#plotsFold', /Normal plot of the residuals/i, 'normal plot');
  await expectText(page, '#main', /The fitted surface[\s\S]*circles are the runs you measured/i, 'the surface, with the runs on it');
  const svgs = await page.locator('#main svg').count();
  if (svgs < 7) throw new Error(`expected the design diagram plus six diagnostic plots, found ${svgs} svg`);

  // the surface is a slice: changing which two factors it shows must change the picture
  const surface = page.locator('#main svg[aria-label^="fitted surface"]');
  const before = await surface.first().innerHTML();
  await page.selectOption('[name=fb]', 'PEG_mol_pct');
  await page.waitForTimeout(700);
  if (!(await page.locator('#plotsFold').evaluate((d) => d.open))) throw new Error('the plots fold closed again when the surface was redrawn');
  await expectText(page, '#main', /held at the centre/, 'the screen says what it is holding fixed');
  const after = await page.locator('#main svg[aria-label^="fitted surface"]').first().innerHTML();
  if (before === after) throw new Error('choosing a different factor pair redrew the same surface');

  // and the interaction view
  await page.selectOption('[name=eg]', 'flow_rate'); // eg never offers the factor already chosen as ef
  await page.waitForTimeout(700);
  await expectText(page, '#main', /Parallel lines mean the two factors do not interact/, 'the interaction plot');

  // the handover: the optimiser sees every demo batch, not just this design
  await open('ml');
  const usable = Number(/(\d+) formulations? from \d+ experiments?/.exec(await page.locator('#main').innerText())?.[1] || 0);
  if (usable < 25) throw new Error(`ml should see the whole demo lab, saw ${usable} runs`);
  await expectText(page, '#main', /Size drift/, 'the stability study reaches the optimiser as a response');
  await page.click('#runBtn');
  await page.waitForTimeout(12000);
  await expectText(page, '#main', /What to run next[\s\S]*Beats best/, 'suggestions from the demo history');
  await expectText(page, '#main', /The map/, 'and the map of the space');

  // switch back: the real namespace must be exactly as it was
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await expectNoText(page, 'nav', /DEMO/, 'the chip is gone with the mode');
  const realAfter = (await readCol(page, 'experiments')).length;
  if (realAfter !== realBefore) throw new Error(`real experiments went from ${realBefore} to ${realAfter} across a demo session`);
  const demoKept = (await readCol(page, 'experiments', 'lnp-demo')).length;
  if (demoKept !== 7) throw new Error('the demo lab should survive being switched off, for the next time');
}

/**
 * A blend design, end to end: pick the lipids, cross them with the process, make the runs, and check that the
 * blend survives all the way onto the batch record an operator weighs out from.
 *
 * The thing this is really guarding is that nothing in the chain quietly falls back to the class-based
 * composition override, which cannot express "45.8 mol% of this ionizable lipid and none of that one".
 */
export async function mixtureDesignAndBlend({ page, open }) {
  await open('experiments?new=1&type=doe');
  await page.fill('input[name=name]', 'Blend and process');
  await page.selectOption('select[name=doe_mode]', 'crossed');
  await page.waitForSelector('select[name=doe_c_lipidKey_0]', { timeout: 10000 });

  // the lipids come from the composition chosen above, in recipe order
  const seeded = await page.$$eval('select[name^=doe_c_lipidKey_]', (s) => s.map((x) => x.value));
  if (seeded.length < 3) throw new Error(`switching to a blend mode should seed the lipids, got ${seeded.join(', ') || 'none'}`);
  if (await page.locator('input[name=doe_f_name_0]').count() !== 1) throw new Error('a crossed design keeps its process factors');

  // a lipid mol% the blend already chooses must not be offered as a process factor as well
  const applyOpts = await page.$$eval('select[name=doe_f_applyTo_0] option', (o) => o.map((x) => x.value));
  if (applyOpts.some((v) => v === 'peg_pct' || v === 'ionizable_pct')) {
    throw new Error('a blend design still offers a class-based lipid override as a process factor');
  }

  // drop one lipid to get a three-component system, which is the case with a ternary plot
  const rows = await page.$$eval('select[name^=doe_c_lipidKey_]', (s) => s.map((x) => x.value));
  const drop = rows.indexOf('DSPC');
  if (drop >= 0) { await page.click(`button[data-rmc="${drop}"]`); await page.waitForTimeout(400); }
  await page.waitForTimeout(1800);

  await expectText(page, '#doeSummary', /runs chosen from \d+ candidates over \d+ distinct blends/, 'the summary says what was selected and from how much');
  await expectNoText(page, '#doeSummary', /cannot determine/, 'the suggested budget must fit the model it suggests for');

  await page.click('#createExp');
  await page.waitForTimeout(2500);

  await open('doe');
  await page.waitForTimeout(1200);
  await expectText(page, '#main', /Blend and process/, 'the DoE screen names the blend design, not a factorial');
  await expectText(page, '#main', /mol%[\s\S]*every run adds up to 100/, 'the run table is in mol% and says what it sums to');
  await expectText(page, '#main', /Take the data elsewhere/, 'a blend design exports like any other');

  // the blend has to reach the bench
  const lot = await page.locator('#main a[href^="#/formulation?batch="]').first().getAttribute('href');
  if (!lot) throw new Error('no batch linked from the run table');
  await open(lot.replace('#/', ''));
  await page.waitForTimeout(600);
  await expectText(page, '#main', /This run .{0,8}is.{0,8} the blend/, 'the batch record says the run is the blend');
  await expectText(page, '#main', /weigh out what is listed here/, 'and tells the operator which recipe wins');
}

/**
 * B4: the stock form redraws when a value changes, and a typed value changes on blur, which is while the user
 * is already clicking into the next field. That field used to be rebuilt under the click, so what was typed
 * next went nowhere, and a second blur during the rebuild threw ("no longer a child of this node").
 */
export async function formKeepsTheFieldYouMovedTo({ page, open }) {
  await open('stocks?new=1');
  await page.fill('input[name=molarity_mM]', '25');
  const before = await page.inputValue('input[name=volume_mL]');
  // A person's press lasts long enough for the redraw to land inside it, and they type a moment later.
  await page.click('input[name=volume_mL]', { delay: 80 });
  await page.waitForTimeout(120);
  await page.keyboard.type('5');
  const now = await page.evaluate(() => ({
    focused: document.activeElement?.name,
    volume: document.querySelector('input[name=volume_mL]').value,
    molarity: document.querySelector('input[name=molarity_mM]').value,
  }));
  if (now.focused !== 'volume_mL') throw new Error(`focus left the field that was clicked, now on "${now.focused}"`);
  // the click put the caret after the value, so the typing extends it; a rebuilt field would have it at the start
  if (now.volume !== before + '5') throw new Error(`volume reads "${now.volume}", expected "${before}5"`);
  if (now.molarity !== '25') throw new Error(`molarity reads "${now.molarity}"`);
  await expectText(page, '#stockForm', /Weigh[\s\S]*0\.5000 mmol/, 'the plan was redrawn for 25 mM × 20 mL');

  // Tab on: the redraw follows the user to the next field rather than pulling them back
  await page.keyboard.press('Tab');
  await page.waitForTimeout(120);
  const next = await page.evaluate(() => document.activeElement?.name);
  if (next !== 'date') throw new Error(`Tab from volume should land on the date, landed on "${next}"`);
  await expectText(page, '#stockForm', /Weigh[\s\S]*5\.1250 mmol/, 'and redrawn for 25 mM × 205 mL');

  // Save pressed straight after typing: the redraw waits for the release, so the click still lands
  await page.fill('input[name=molarity_mM]', '30');
  await page.click('#saveStock', { delay: 120 });
  await page.waitForFunction(() => /stocks\?id=Stock-\d+/.test(location.hash), null, { timeout: 3000 })
    .catch(() => { throw new Error('Save pressed right after typing did not save'); });
  const id = await page.evaluate(() => location.hash.match(/Stock-\d+/)[0]);
  const saved = (await readCol(page, 'stocks')).find((s) => s.id === id);
  if (saved?.molarity_mM !== 30 || saved?.volume_mL !== 205) throw new Error(`saved ${id} with ${saved?.molarity_mM} mM, ${saved?.volume_mL} mL`);
  // the note raised on the way here belongs to this screen and survives the navigation it caused
  await expectText(page, '#toast', new RegExp(`Saved stock ${id}`), 'the save is confirmed on the screen it opens');
}

/** B2: "Export everything" with advanced options on, and the other preferences under the same prefix. */
export async function exportWithPreferencesSet({ page, open }) {
  const { readFile } = await import('node:fs/promises');
  await open('settings');
  // "auto" and a date string, stored beside the data as bare text; the export read them as JSON
  await page.click('#themeSeg button[data-theme="auto"]');
  for (const round of [1, 2]) { // the first export writes lastExport, one more bare string, for the second to meet
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#exportAll')]);
    const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
    if (!Array.isArray(data.collections?.experiments) || !data.collections.experiments.length) {
      throw new Error(`export ${round} has no experiments: ${Object.keys(data.collections || {}).join(', ')}`);
    }
    const prefs = ['mode', 'theme', 'navExperiments', 'lastExport', 'demo'].filter((k) => k in data.collections);
    if (prefs.length) throw new Error(`export ${round} carries preferences as data: ${prefs.join(', ')}`);
  }
  // F5: the same note twice is one note with a count, and it does not follow you to the next screen
  await expectText(page, '#toast', /Exported ×2/, 'a repeated note counts up instead of stacking');
  const notes = await page.locator('#toast > *', { hasText: 'Exported' }).count();
  if (notes !== 1) throw new Error(`${notes} "Exported" notes showing after two identical ones`);
  await page.waitForTimeout(1700);
  await open('overview');
  const left = await page.locator('#toast > *').count();
  if (left) throw new Error(`${left} note(s) from settings followed the user to the overview`);
}

/**
 * An import ends in its evaluation, not in the list it started from (usability cycle 1, finding F1): the card
 * says what came in, draws it, flags what needs a look, and can be reopened later from the recent imports.
 */
export async function importEvaluation({ page, open }) {
  await open('measurements');
  const names = (await page.$$eval('[data-wait-name]', (e) => e.map((x) => x.dataset.waitName))).slice(0, 6);
  if (names.length < 3) throw new Error(`need a few samples still waiting to import against, found ${names.length}`);
  // Three runs a sample; the last sample is broad enough to fail the PDI limit, so something needs a look.
  const csv = ['Sample Name,Z-Average (d.nm),PdI,Derived Count Rate (kcps)', ...names.flatMap((n, i) => [0, 1, 2].map((r) => {
    const last = i === names.length - 1;
    return `${n} ${r + 1},${(84 + 2 * i + 0.4 * r).toFixed(1)},${(last ? 0.34 : 0.09 + 0.005 * r).toFixed(3)},${300 + r}`;
  }))].join('\n');
  await page.setInputFiles('#csvFile', { name: 'evaluate_me.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForTimeout(300);
  await page.click('#doImport');
  await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
  await page.waitForTimeout(200);

  await expectText(page, '#importEval', /Evaluation of this import/, 'the import ends in its evaluation');
  await expectText(page, '#importEval', new RegExp(`${names.length} samples in the DLS data`), 'which says how much came in');
  await expectText(page, '#importEval', /1 sample needs a look[\s\S]*PDI 0\.340 is above the 0\.2 limit/, 'and which sample needs a look, and why');
  await expectText(page, '#importEval', /Where each experiment stands[\s\S]*Experiment \d+/i, 'and where the experiment it fed now stands');
  const sizes = await page.$$eval('#main #importEval svg', (s) => s.map((x) => { const r = x.getBoundingClientRect(); return [r.width, r.height]; }));
  if (!sizes.some(([w, h]) => w > 200 && h > 100)) throw new Error(`no chart of real size in the evaluation: ${JSON.stringify(sizes)}`);
  for (const kind of ['svg', 'png']) {
    if (!(await page.locator(`#importEval [data-fig-dl="${kind}"]`).count())) throw new Error(`no ${kind.toUpperCase()} button on the evaluation's charts`);
  }
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('#importEval [data-fig-dl="svg"]').first().click()]);
  if (!/^evaluate_me_.*\.svg$/.test(dl.suggestedFilename())) throw new Error(`the SVG button saved "${dl.suggestedFilename()}"`);
  const first = names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await openFolds(page); // the stored results are one line until opened
  await expectText(page, '#main > .card:last-child', new RegExp(`Results[\\s\\S]*${first}`), 'the results list is still underneath');

  // Closing it and coming back: the recent imports reopen any evaluation.
  await page.click('#importEval a[href="#/measurements"]');
  await page.waitForTimeout(400);
  if (await page.locator('#importEval').count()) throw new Error('Close left the evaluation on the screen');
  await expectText(page, '#recentImports', /evaluate_me\.csv[\s\S]*DLS · \d+ samples/, 'the import is listed under recent imports');
  await page.locator('#recentImports tr', { hasText: 'evaluate_me.csv' }).locator('a[data-evaluate]').click();
  await page.waitForTimeout(500);
  await expectText(page, '#importEval', /evaluate_me\.csv[\s\S]*needs a look/, 'and reopens its evaluation');
}

// Read straight from the store, so a result counts as stored only when it is, whatever the screen says.
const storedMeasurements = (page) => readCol(page, 'measurements');
const slotStatus = (page, sampleName, test) => page.evaluate(async ([n, t]) => {
  for (const e of await lnpDb.read('experiments')) {
    const s = (e.expected || []).find((x) => x.sampleName === n && x.test === t);
    if (s) return s.status;
  }
  return null;
}, [sampleName, test]);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** EE comes off a plate reader as a two-column block; pasted, it must be read as EE without being told. */
export async function eeImportFromPaste({ page, open }) {
  await open('measurements');
  const name = await page.evaluate(async () => {
    for (const e of await lnpDb.read('experiments')) {
      const s = (e.expected || []).find((x) => x.test === 'ee' && x.status === 'open');
      if (s) return s.sampleName;
    }
    return null;
  });
  if (!name) throw new Error('no sample is waiting for EE');
  await page.selectOption('#importTest', 'dls'); // the paste has to switch it, not the person
  await page.click('#main details summary');
  await page.fill('#pasteBox', `Sample Name\tEE (%)\n${name}\t93.4`);
  await page.click('#pasteGo');
  await page.waitForTimeout(400);
  const chosen = await page.inputValue('#importTest');
  if (chosen !== 'ee') throw new Error(`a pasted EE block left the import type at "${chosen}"`);
  await expectText(page, '#importPreview', /1 matched[\s\S]*EE[\s\S]*93\.4/, 'the preview shows the EE value it is about to store');
  await expectNoText(page, '#importPreview', /Z-ave|kcps/, 'and not the DLS columns');
  await page.click('#doImport');
  await page.waitForTimeout(500);
  const m = (await storedMeasurements(page)).find((x) => x.sampleName === name && x.test === 'ee');
  if (m?.values?.ee_pct !== 93.4) throw new Error(`the pasted EE was not stored: ${JSON.stringify(m?.values)}`);
  if (await slotStatus(page, name, 'ee') !== 'done') throw new Error('the EE slot it answered is still open');
  await expectText(page, '#main', new RegExp(`${reEsc(name)}[\\s\\S]*EE 93\\.4 %`), 'the pasted EE is listed against its sample');
}

/** Everything still waiting, typed as a grid: Tab goes down a column, a pasted column fills down, Save all saves. */
export async function resultsGrid({ page, open }) {
  await open('measurements');
  await page.click('#gridOpen');
  await page.waitForSelector('#resultGrid input.gcell', { timeout: 5000 });
  // a column with cells on two neighbouring rows, so that both Tab and a two-line paste land in it
  const pick = await page.$$eval('#resultGrid input.gcell', (cs) => {
    const at = new Set(cs.map((c) => `${c.dataset.col}:${c.dataset.row}`));
    const c = cs.find((x) => at.has(`${x.dataset.col}:${+x.dataset.row + 1}`));
    return c && { col: c.dataset.col, row: +c.dataset.row, key: c.dataset.key };
  });
  if (!pick) throw new Error('the grid has no column with two neighbouring cells');
  const good = { zave_nm: ['84.2', '85.1'], pdi: ['0.081', '0.092'], ee_pct: ['93.1', '94.2'], zeta_mV: ['-3.1', '-2.8'], rna_mg_mL: ['0.101', '0.098'] }[pick.key] || ['7.2', '7.3'];
  const bad = { zave_nm: '-5', pdi: '5', ee_pct: '925', zeta_mV: '-350', rna_mg_mL: '-1' }[pick.key] || '-1';
  const column = page.locator(`#resultGrid input.gcell[data-col="${pick.col}"]`);
  const cell = (r) => page.locator(`#resultGrid input.gcell[data-col="${pick.col}"][data-row="${r}"]`);

  await cell(pick.row).click();
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('2');
  if (await cell(pick.row + 1).inputValue() !== '2') throw new Error('Tab did not move down the column');
  await page.keyboard.press('Enter');
  const moved = await page.evaluate(([c, r]) => {
    const a = document.activeElement;
    return (a?.classList.contains('gcell') || a?.id === 'gridSave') && !(a.dataset.col === c && +a.dataset.row === r);
  }, [pick.col, pick.row + 1]);
  if (!moved) throw new Error('Enter did not move on to the next cell');

  // a column copied out of Excel, pasted into its first cell
  await cell(pick.row).evaluate((el, text) => {
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `${good[0]}\r\n${good[1]}\r\n`);
  if (await cell(pick.row).inputValue() !== good[0] || await cell(pick.row + 1).inputValue() !== good[1]) throw new Error('a pasted column did not fill down');

  // one more cell, if the column has one, with a value no measurement can have
  const idx = await column.evaluateAll((cs, r) => cs.findIndex((c) => +c.dataset.row === r + 1), pick.row);
  const third = (await column.count()) > idx + 1 ? column.nth(idx + 1) : null;
  const thirdSlot = third ? await third.getAttribute('data-slot') : null;
  if (third) await third.fill(bad);

  const before = (await storedMeasurements(page)).length;
  await page.click('#gridSave');
  await page.waitForTimeout(500);
  const after = (await storedMeasurements(page)).length;
  if (after !== before + 2) throw new Error(`Save all stored ${after - before} results, expected 2`);
  // A refused cell keeps its experiment waiting, so the grid is drawn again with the report; without one the
  // experiment may have nothing left to wait for, and the grid with it.
  if (third || await page.locator('#gridReport').count()) await expectText(page, '#gridReport', /Saved 2 results/, 'the grid says how many it saved');
  if (third) {
    await expectText(page, '#gridReport', /Not saved[\s\S]*(did you mean|must be above|cannot be negative|is outside)/, 'and which it refused, and why');
    const kept = page.locator(`#resultGrid input.gcell[data-slot="${thirdSlot}"][data-key="${pick.key}"]`);
    if (await kept.inputValue() !== bad) throw new Error('a refused value was not left in the grid to correct');
    if (!(await kept.getAttribute('class')).includes('invalid')) throw new Error('the refused cell is not marked');
  }
}

/** B5: a PDI of 5 typed for 0.05 is refused at the form, with the reason, and nothing is stored. */
export async function manualEntryRefusesImpossible({ page, open }) {
  await open('measurements');
  const opt = await page.locator('select[name=slotId] option', { hasText: ' · dls · ' }).first().getAttribute('value');
  if (!opt) throw new Error('no DLS measurement is waiting');
  await page.selectOption('select[name=slotId]', opt);
  const sampleName = (await page.locator(`select[name=slotId] option[value="${opt}"]`).innerText()).split(' · ')[0];
  const before = (await storedMeasurements(page)).length;
  await page.fill('input[name=v_zave_nm]', '82.4');
  await page.fill('input[name=v_pdi]', '5');
  await page.click('#saveManual');
  await page.waitForTimeout(250);
  await expectText(page, '#manualCheck', /Not saved[\s\S]*PDI 5 is outside 0–1 — did you mean 0\.05\?/, 'the refusal says why');
  if (!(await page.locator('input[name=v_pdi].invalid').count())) throw new Error('the PDI field is not marked');
  if ((await storedMeasurements(page)).length !== before) throw new Error('an impossible PDI was stored');
  if (await slotStatus(page, sampleName, 'dls') !== 'open') throw new Error('the slot was closed by a refused result');
  // corrected, the same form saves
  await page.fill('input[name=v_pdi]', '0.05');
  await page.click('#saveManual');
  await page.waitForTimeout(300);
  if ((await storedMeasurements(page)).length !== before + 1) throw new Error('the corrected result was not stored');
}

/**
 * Results recorded straight into the store, the way saveMeasurement leaves them: the measurement with its
 * replicate runs, its slot closed, its formulation moved on to "measured". Going round the import screen
 * keeps these scenarios about the experiment page, which is what they test.
 * `values(batch, index, slot)` returns {z, p, ee} for one formulation; runs are spread ±1 nm around z.
 */
async function seedResults(page, expId, values, { timepoint = null } = {}) {
  await page.evaluate(async ({ expId, values, timepoint }) => {
    const [exps, batches, meas] = await Promise.all(['experiments', 'batches', 'measurements'].map((k) => lnpDb.read(k)));
    const exp = exps.find((e) => e.id === expId);
    const fn = new Function('b', 'i', 'slot', `return (${values})(b, i, slot);`);
    exp.batchIds.forEach((id, i) => {
      const b = batches.find((x) => x.id === id);
      const slots = exp.expected.filter((s) => s.batchId === id && (timepoint == null ? s.timepoint == null : s.timepoint === timepoint) && ['dls', 'ee'].includes(s.test));
      for (const s of slots) {
        const v = fn(b, i, s);
        const values = s.test === 'dls'
          ? { zave_nm: v.z, pdi: v.p, runs: [-1, 0, 1].map((d) => ({ zave_nm: v.z + d, pdi: v.p + d * 0.004 })) }
          : { ee_pct: v.ee };
        meas.push({ id: `seed-${s.id}`, batchId: id, experimentId: expId, test: s.test, stage: s.stage, condition: s.condition, timepoint: s.timepoint,
          slotId: s.id, sampleName: s.sampleName, date: s.dueDate, values, flags: [] });
        s.status = 'done'; s.measurementId = `seed-${s.id}`;
      }
      if (slots.length && ['planned', 'produced'].includes(b.status)) b.status = 'measured';
    });
    await lnpDb.write('experiments', exps);
    await lnpDb.write('batches', batches);
    await lnpDb.write('measurements', meas);
  }, { expId, values: values.toString(), timepoint });
}

const latestOfType = async (page, type) => (await readCol(page, 'experiments'))
  .filter((e) => e.type === type && /^E\d+$/.test(e.id)).sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0]?.id;

/**
 * The GraphPad path: a comparison and a set of repeats, measured, read on their own page as mean ± SD with
 * n and CV, the statistics in words, bar charts that save as SVG and PNG, and the table as CSV.
 */
export async function resultsComparisonAndReference({ page, open }) {
  const cmp = await latestOfType(page, 'comparison');
  const rep = await latestOfType(page, 'reference');
  if (!cmp || !rep) throw new Error(`the earlier scenarios should have left a comparison and a reference experiment (${cmp}, ${rep})`);

  await open(`experiments?id=${cmp}`);
  await expectText(page, '#resultsCard', /Nothing measured yet[\s\S]*Measure/, 'before any result the card says what to measure');
  await seedResults(page, cmp, (b, i) => ({ z: [82, 95, 71, 88][i % 4], p: [0.08, 0.12, 0.1, 0.15][i % 4], ee: [94, 90.5, 92, 89][i % 4] }));
  await open('experiments'); // the same address twice is no hash change, so nothing would redraw
  await open(`experiments?id=${cmp}`);
  await expectText(page, '#resultsCard', /±/, 'the comparison shows mean ± SD');
  await expectText(page, '#resultsCard', /CV/, 'with the CV');
  await expectText(page, '#resultsCard', /against #\d+: Z-ave \+13\.0 nm/, 'and the difference from the first arm in words');
  await expectText(page, '#resultsCard', /technical replicates[\s\S]*not a test of batch-to-batch difference/, 'and says plainly what the SD of one batch is not');
  const charts = await page.locator('#resultsCard svg').count();
  if (charts < 3) throw new Error(`a comparison with DLS and EE should draw Z-ave, PDI and EE bar charts, found ${charts}`);
  if (!(await page.locator('#resultsCard [data-fig-dl="png"]').count())) throw new Error('the figures cannot be saved as PNG');
  await expectText(page, '#nextStep', /Next step: evaluate/, 'with everything measured, the next step is to evaluate');
  await expectText(page, '#expStage', /all measured/, 'and the header says so instead of the stored "planned"');
  // a figure saves as an image, and the table as CSV
  const [svgFile] = await Promise.all([page.waitForEvent('download'), page.locator('#resultsCard [data-fig-dl="svg"]').first().click()]);
  if (!/\.svg$/.test(svgFile.suggestedFilename())) throw new Error(`the SVG button saved ${svgFile.suggestedFilename()}`);
  const [csvFile] = await Promise.all([page.waitForEvent('download'), page.click('#exportResults')]);
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(await csvFile.path(), 'utf8');
  if (!/^experiment,formulation,label,composition,Z-ave \(nm\) mean,Z-ave \(nm\) SD,Z-ave n,Z-ave CV %/.test(csv)) throw new Error(`results CSV header: ${csv.split('\n')[0]}`);
  if (csv.trim().split('\n').length < 3) throw new Error('the results CSV should have a row per arm');

  await seedResults(page, rep, (b, i) => ({ z: 80 + i * 3, p: 0.09, ee: 93 }));
  await open(`experiments?id=${rep}`);
  await expectText(page, '#resultsCard', /Batch to batch, over \d+ batches: Z-ave [\d.]+ ± [\d.]+ nm \(CV [\d.]+ %\)/, 'repeats are summarised batch to batch as mean ± SD and CV');
  await expectText(page, '#resultsCard', /Batch to batch[\s\S]*±[\s\S]*CV/, 'with a batch-to-batch row in the data table');
  const repCharts = await page.locator('#resultsCard svg').count();
  if (repCharts < 1) throw new Error('the reference experiment draws no chart');
}

/** A stability study with a later day measured: the size-over-time chart, one line per formulation × shelf. */
export async function resultsStabilityOverTime({ page, open }) {
  const st = await latestOfType(page, 'stability');
  if (!st) throw new Error('no stability experiment left by the earlier scenarios');
  // The first later timepoint in the plan; a plan with day 0 only still gets a day-7 result, placed by its
  // sample name, which is what happens when a study is extended after it was set up.
  const plan = (await readCol(page, 'experiments')).find((e) => e.id === st).design.stability;
  const later = plan.timepoints.find((t) => t > 0);
  await seedResults(page, st, (b, i) => ({ z: 80 + i * 10, p: 0.08, ee: 94 }), { timepoint: 0 });
  if (later != null) await seedResults(page, st, (b, i, s) => ({ z: 80 + i * 10 + (s.condition === '25C' ? 6 : 1), p: 0.1, ee: 92 }), { timepoint: later });
  else {
    await page.evaluate(async ({ id, conds }) => {
      const m = await lnpDb.read('measurements');
      const e = (await lnpDb.read('experiments')).find((x) => x.id === id);
      e.batchIds.forEach((b, i) => conds.forEach((c) => m.push({ id: `seed-${b}-${c}-T7`, batchId: b, experimentId: id, test: 'dls', stage: 'T7', sampleName: `${b}_${c}_T07`, date: '2026-10-24',
        values: { zave_nm: 86 + i * 10, pdi: 0.1, runs: [{ zave_nm: 85 + i * 10, pdi: 0.1 }, { zave_nm: 87 + i * 10, pdi: 0.1 }] } })));
      await lnpDb.write('measurements', m);
    }, { id: st, conds: plan.conditions });
  }
  await open(`experiments?id=${st}`);
  const chart = page.locator('#resultsCard svg[aria-label="Z-ave over time"]');
  if (!(await chart.count())) throw new Error('the stability study has no size-over-time chart');
  const lines = await chart.first().locator('path').count();
  if (lines < 1) throw new Error('the size-over-time chart has no line');
  // the other figures fold under a line, and the table shows Z-ave / PDI until asked for every value
  await openFolds(page);
  await showEveryValue(page);
  await expectText(page, '#resultsCard', /PDI over time/, 'and PDI over time beside it');
  await expectText(page, '#resultsCard', new RegExp(`day ${later ?? 7}: Z-ave [\\d.]+ → [\\d.]+ nm`), 'the change from T0 is said in words');
  await expectText(page, '#resultsCard', /vs T0/, 'and shown in the data table');
  await expectText(page, '#stabTable', /[+−-][\d.]+ nm \([+−-]?[\d.]+ %\)/, 'as a change in each later cell');
}

/** The stability table in its full view (SD, change from T0, other tests, trend), whichever view it opened in. */
const showEveryValue = async (page) => {
  const b = page.locator('#resultsCard [data-resview][aria-pressed="false"]');
  if (await b.count()) await b.first().click();
};

/**
 * Bench day without eighteen record visits: one stock and one RNA lot for every formulation of an
 * experiment, all of them marked produced in one go, and the same from the Formulations list.
 */
export async function bulkBenchActions({ page, open }) {
  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', 'Bench day');
  await page.fill('input[name=ref_n]', '3'); await page.dispatchEvent('input[name=ref_n]', 'change');
  await page.waitForTimeout(150);
  await page.click('#createExp'); await page.waitForTimeout(400);
  const id = await latestOfType(page, 'reference');
  await expectText(page, '#nextStep', /Next step: make the formulations — 3 planned/, 'a new experiment says what to do next');
  await expectText(page, '#expStage', /planned/, 'and its progress chip starts at planned');
  const forms = async () => (await readCol(page, 'batches')).filter((b) => b.experimentId === id);

  await page.selectOption('#bulkStock', 'Stock-001');
  await page.click('#applyStock'); await page.waitForTimeout(250);
  let fs = await forms();
  if (!fs.every((b) => b.stockId === 'Stock-001')) throw new Error(`stock not set on every formulation: ${fs.map((b) => b.stockId).join(', ')}`);
  const stockMM = await readCol(page, 'stocks').then((all) => { const s = all.find((x) => x.id === 'Stock-001'); return s.molarityActual_mM || s.molarity_mM; });
  if (!fs.every((b) => b.plan.mixing.lipidStock_mM === stockMM)) throw new Error('the stock was set without its concentration, unlike choosing it on the record');
  await page.selectOption('#bulkRna', 'RNA-TEST-01');
  await page.click('#applyRna'); await page.waitForTimeout(250);
  fs = await forms();
  if (!fs.every((b) => b.plan.rna.lotId === 'RNA-TEST-01')) throw new Error('RNA lot not set on every formulation');
  if ((await page.inputValue('#bulkStock')) !== 'Stock-001') throw new Error('the stock select does not read back the stock now shared by every formulation');

  await page.click('#markAllProduced'); await page.waitForTimeout(250);
  fs = await forms();
  if (fs.length !== 3 || !fs.every((b) => b.status === 'produced')) throw new Error(`Mark all produced left: ${fs.map((b) => b.status).join(', ')}`);
  await expectText(page, '#nextStep', /Next step: measure — \d+ results still due/, 'once made, the next step is to measure');
  await expectText(page, '#expStage', /measuring/, 'and the progress chip follows');

  // the list: tick two planned formulations of another experiment, leave the rest alone
  const planned = (await readCol(page, 'batches')).filter((b) => b.status === 'planned').map((b) => b.id);
  if (planned.length < 3) throw new Error(`expected some planned formulations left by earlier scenarios, found ${planned.length}`);
  await open('formulation');
  await page.check('#selAllForms');
  const all = await page.locator('input[data-sel]').count(), ticked = await page.locator('input[data-sel]:checked').count();
  if (!all || ticked !== all) throw new Error(`select all ticked ${ticked} of ${all}`);
  await page.uncheck('#selAllForms');
  if (await page.locator('input[data-sel]:checked').count()) throw new Error('unticking select all left rows ticked');
  if (!(await page.locator('#markSelectedProduced').isDisabled())) throw new Error('the button should wait for a selection');
  await page.check(`input[data-sel="${planned[0]}"]`); await page.check(`input[data-sel="${planned[1]}"]`);
  await expectText(page, '#selCount', /2 selected/, 'the selection is counted');
  await page.click('#markSelectedProduced'); await page.waitForTimeout(250);
  const after = await readCol(page, 'batches').then((all) => planned.slice(0, 3).map((x) => all.find((b) => b.id === x).status));
  if (after[0] !== 'produced' || after[1] !== 'produced') throw new Error(`Mark selected produced: ${after.join(', ')}`);
  if (after[2] !== 'planned') throw new Error('an unticked formulation was marked produced as well');
}

/**
 * UX revision: the simple experiments are the catalogue's first group, and each hands over to the wizard at its
 * type, the way a design hands over with the design chosen. The screen it hands over to opens at the top.
 */
export async function catalogueSimpleExperiments({ page, open }) {
  await open('designs');
  const first = await page.locator('#catRoot .dc-group').first().getAttribute('data-cat');
  if (first !== 'simple') throw new Error(`the first group should be the simple experiments, is ${first}`);
  await expectText(page, '[data-cat=simple]', /Single formulation[\s\S]*Reference reproducibility[\s\S]*Compare compositions/, 'single, reference and comparison sit together');
  for (const type of ['single', 'reference', 'comparison']) {
    const href = await page.locator(`[data-entry=${type}] a.btn`).getAttribute('href');
    if (href !== `#/experiments?new=1&type=${type}`) throw new Error(`${type} hands over to ${href}`);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('[data-entry=reference] a.btn');
  await page.waitForFunction(() => location.hash === '#/experiments?new=1&type=reference', null, { timeout: 3000 });
  await page.waitForTimeout(300);
  if (!(await page.locator('input[name=ref_n]').count())) throw new Error('the reference wizard did not open');
  const y = await page.evaluate(() => window.scrollY);
  if (y > 0) throw new Error(`the wizard opened scrolled down by ${y}px`);
}

/**
 * UX revision: the Experiments list holds every experiment, finished ones included, grouped by where each
 * stands; a line opens to its formulations, "Expand all" and "Collapse all" do what they say, and what was
 * opened is still open when the list is drawn again.
 */
export async function experimentListAccordion({ page, open }) {
  const stored = (await readCol(page, 'experiments')).length;
  await open('overview');
  await open('experiments');
  const lines = await page.locator('#expAccordion details.xrow').count();
  if (lines !== stored) throw new Error(`the list shows ${lines} of ${stored} experiments`);
  await expectText(page, '#expAccordion', new RegExp(`^${stored} experiments?`), 'the list says how many there are');
  if (await page.locator('#expAccordion details.xrow[open]').count()) throw new Error('lines should start folded');
  // one line opens to its formulations
  const first = page.locator('#expAccordion details.xrow').first();
  const id = await first.getAttribute('data-exp');
  await first.locator('summary .xr-prog').click();
  await page.waitForTimeout(150); // 'toggle' is fired a task after the click, and the formulations are built then
  await expectText(page, `#expAccordion details.xrow[data-exp="${id}"] .xr-body`, new RegExp(`Formulation[\\s\\S]*${id}-F1`), 'an opened line lists its formulations');
  // and is still open after the list is drawn again
  await open('overview'); await open('experiments');
  if ((await page.locator(`#expAccordion details.xrow[data-exp="${id}"]`).getAttribute('open')) === null) throw new Error('a redraw closed the line that was opened');
  // expand all: every group and every line, each with its formulations
  await page.click('#expandAll'); await page.waitForTimeout(150);
  const opened = await page.locator('#expAccordion details.xrow[open]').count();
  if (opened !== lines) throw new Error(`Expand all opened ${opened} of ${lines} lines`);
  if (await page.locator('#expAccordion details.xrow .xr-body:empty').count()) throw new Error('an expanded line has no formulations drawn');
  // collapse all: nothing open, the groups included, and it stays that way when the list is drawn again
  await page.click('#collapseAll'); await page.waitForTimeout(150);
  if (await page.locator('#expAccordion details[open]').count()) throw new Error('Collapse all left something open');
  await open('overview'); await open('experiments');
  if (await page.locator('#expAccordion details[open]').count()) throw new Error('the collapsed list did not stay collapsed');
  // leave the list as a newcomer finds it for the scenarios after this one: groups open, lines folded
  await page.locator('#expAccordion details.xgroup > summary').evaluateAll((ss) => ss.forEach((x) => x.click()));
}

export const scenarios = [stocksCreateAndSave, buffersDesignAndSave, materialsAddLots, experimentsStabilityAndSingle, batchRecordAndCalendar, measurementsManualAndImport, importFromPaste, doeOverviewInsightsSettings, wizardOtherTypes, batchRecordRepeatedEdits, mlOptimizer, advisorAndReference, designCatalogue, catalogueSimpleExperiments, experimentListAccordion, demoModeAndDoeToMl, mixtureDesignAndBlend, formKeepsTheFieldYouMovedTo, exportWithPreferencesSet, importEvaluation, eeImportFromPaste, resultsGrid, manualEntryRefusesImpossible, resultsComparisonAndReference, resultsStabilityOverTime, bulkBenchActions];

// ---- Find, undo, glance (usability cycle 2, recommendation D: F6, F7, F9) ----
// Added with push rather than in the list above, so these lines do not collide with other additions to it.
scenarios.push(searchFindsRecords, deleteExperimentAndUndo, restoreFromSettings, overviewLatestResults);

// A collection as text, for "exactly as it was" comparisons.
const stored = async (page, col) => JSON.stringify(await readCol(page, col));

/** The sidebar search: Ctrl+K, a formulation typed without its dash and opened with Enter, a sample name by mouse. */
export async function searchFindsRecords({ page, open }) {
  await open('overview');
  await page.keyboard.press('Control+k');
  if (!(await page.evaluate(() => document.activeElement?.id === 'search'))) throw new Error('Ctrl+K did not put the cursor in the search box');
  await page.keyboard.type('e2f1');
  await page.waitForSelector('#searchResults:not([hidden]) a.sr-item', { timeout: 2000 });
  const top = page.locator('#searchResults a.sr-item').first();
  if ((await top.getAttribute('data-id')) !== 'E2-F1' || (await top.getAttribute('data-kind')) !== 'formulation') {
    throw new Error(`"e2f1" should list the formulation E2-F1 first: ${(await page.locator('#searchResults').innerText()).slice(0, 300)}`);
  }
  await expectText(page, '#searchResults', /Samples[\s\S]*E2-F1_final/i, 'its sample names are listed under it');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#/formulation?batch=E2-F1', null, { timeout: 3000 })
    .catch(async () => { throw new Error(`Enter did not open E2-F1: ${await page.evaluate(() => location.hash)}`); });
  // The hash changes a moment before the screen is drawn, and the Overview being left lists E2-F1 as well, so
  // wait for the record itself. Waiting for "E2-F1" anywhere in #main ended on the Overview, and the check then
  // read the router's "Loading …" of the moment in between (usability cycle 5, K7; see route() in app/main.js).
  await page.waitForSelector('#batchForm', { timeout: 5000 }).catch(() => {});
  await expectText(page, '#main', /E2-F1/, 'the formulation record');
  if ((await page.inputValue('#search')) !== '') throw new Error('the box keeps the query after opening a hit');

  // keyboard: the arrows move the highlight, Esc clears and closes
  await page.click('#search');
  await page.keyboard.type('E1');
  await page.waitForSelector('#searchResults:not([hidden]) a.sr-item');
  if ((await page.locator('#searchResults a.sr-item').first().getAttribute('data-id')) !== 'E1') throw new Error('"E1" should list experiment E1 first');
  await page.keyboard.press('ArrowDown');
  const on = await page.locator('#searchResults a.sr-item.on').getAttribute('data-i');
  if (on !== '1') throw new Error(`ArrowDown should highlight the second hit, highlighted ${on}`);
  await page.keyboard.press('Escape');
  if (!(await page.locator('#searchResults').isHidden()) || (await page.inputValue('#search')) !== '') throw new Error('Esc should clear the box and close the list');

  // a sample name, typed loosely (T0 for T00, spaces for the underscores), opened with the mouse
  await page.fill('#search', 'e1 f1 4c t0');
  const hit = page.locator('#searchResults a.sr-item[data-kind="sample"][data-id="E1-F1_4C_T00"]');
  await hit.waitFor({ timeout: 2000 }).catch(async () => { throw new Error(`no sample E1-F1_4C_T00 for "e1 f1 4c t0": ${(await page.locator('#searchResults').innerText()).slice(0, 300)}`); });
  await hit.click();
  await page.waitForFunction(() => /^#\/measurements\?id=/.test(location.hash) && /E1-F1_4C_T00/.test(document.querySelector('#main h1')?.textContent || ''), null, { timeout: 3000 })
    .catch(async () => { throw new Error(`the sample did not open its result: ${await page.evaluate(() => location.hash)}`); });

  await page.fill('#search', 'zzz no such thing');
  await expectText(page, '#searchResults', /Nothing found/, 'an empty search says so');
  await page.keyboard.press('Escape');
}

/** F7: an experiment deleted with its formulations comes back from the note's Undo, exactly as it was. */
export async function deleteExperimentAndUndo({ page, open }) {
  const id = 'E2';
  await open(`experiments?id=${id}`);
  const before = { experiments: await stored(page, 'experiments'), batches: await stored(page, 'batches'), measurements: await stored(page, 'measurements') };
  const forms = JSON.parse(before.batches).filter((b) => b.experimentId === id).map((b) => b.id);
  if (!forms.length) throw new Error(`${id} has no formulations to delete with it`);
  await page.click('#delExp');
  await page.waitForFunction(() => location.hash === '#/experiments', null, { timeout: 3000 });
  const gone = { exp: (await readCol(page, 'experiments')).some((x) => x.id === id), forms: (await readCol(page, 'batches')).filter((b) => b.experimentId === id).length };
  if (gone.exp || gone.forms) throw new Error(`delete left the experiment (${gone.exp}) or ${gone.forms} formulation(s)`);
  if ((await stored(page, 'measurements')) !== before.measurements) throw new Error('deleting an experiment changed the measurements');
  await expectText(page, '#toast', new RegExp(`Deleted Experiment 2 and its ${forms.length} formulation`), 'the note says what went');
  await page.click('#toast button[data-toast-action="Undo"]');
  await page.waitForFunction((e) => location.hash === `#/experiments?id=${e}`, id, { timeout: 3000 })
    .catch(async () => { throw new Error(`Undo did not reopen ${id}: ${await page.evaluate(() => location.hash)}`); });
  for (const col of ['experiments', 'batches', 'measurements']) {
    if ((await stored(page, col)) !== before[col]) throw new Error(`after Undo, ${col} is not exactly as it was`);
  }
  if (JSON.parse((await stored(page, 'trash')) || '[]').length) throw new Error('the undone delete is still in the trash');
  await expectText(page, '#toast', /Restored Experiment 2/, 'and the undo is confirmed');
}

/** Settings › Recently deleted: a stock and a buffer deleted without Undo come back from the list. */
export async function restoreFromSettings({ page, open }) {
  const stocks = await stored(page, 'stocks'), buffers = await stored(page, 'buffers');
  await open('stocks?id=Stock-001');
  await page.click('#deleteStock');
  await page.waitForFunction(() => location.hash === '#/stocks', null, { timeout: 3000 });
  await open('buffers?id=Buffer-001');
  await page.click('#deleteBuffer');
  await page.waitForFunction(() => location.hash === '#/buffers', null, { timeout: 3000 });
  if (JSON.parse(await stored(page, 'stocks')).some((s) => s.id === 'Stock-001')) throw new Error('Stock-001 was not deleted');
  await open('settings');
  await expectText(page, '#trashList', /Buffer-001[\s\S]*Stock-001/, 'the restore list, newest first');
  for (const [what, col, before] of [['Stock-001', 'stocks', stocks], ['Buffer-001', 'buffers', buffers]]) {
    await page.locator('#trashList tr', { hasText: what }).locator('button[data-restore]').click();
    await page.waitForTimeout(250);
    if ((await stored(page, col)) !== before) throw new Error(`${what} is not back exactly as it was`);
    await expectNoText(page, '#trashCard', new RegExp(what), `${what} leaves the list once restored`);
  }
  await expectText(page, '#trashList', /Nothing deleted/, 'an empty list says so');
}

/** F9: the overview's latest results, drawn against the QC band, each point opening its formulation. */
export async function overviewLatestResults({ page, open }) {
  // Nothing measured: no card at all.
  const kept = await stored(page, 'measurements');
  await writeCol(page, 'measurements', []);
  await open('overview');
  const shown = await page.locator('#latestCard').count();
  await writeCol(page, 'measurements', JSON.parse(kept));
  if (shown) throw new Error('the latest-results card shows before anything is measured');

  await open('settings'); // the same hash again would not redraw the overview
  await open('overview');
  await expectText(page, '#latestSentence', /inside the QC limits for size and PDI/, 'one sentence on how the latest results stand');
  const pts = page.locator('#latestCard svg a.lr-pt');
  const n = await pts.count();
  const want = Math.min(20, new Set((await readCol(page, 'measurements')).filter((m) => m.test === 'dls' && m.batchId && Number.isFinite(m.values?.zave_nm)).map((m) => m.batchId)).size);
  if (!n || n !== want) throw new Error(`${n} points drawn, expected one per formulation measured, at most 20 (${want})`);
  if (!(await page.locator('#latestCard [data-fig-dl="png"]').count())) throw new Error('the chart cannot be saved like the others');
  const batch = await pts.last().getAttribute('data-batch');
  await pts.last().click();
  await page.waitForFunction((b) => location.hash === `#/formulation?batch=${encodeURIComponent(b)}`, batch, { timeout: 3000 })
    .catch(async () => { throw new Error(`clicking ${batch} opened ${await page.evaluate(() => location.hash)}`); });
}
/** A new reference experiment of `n` formulations; returns its id and its formulation ids. */
async function newReference(page, open, name, n) {
  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', name);
  await page.fill('input[name=ref_n]', String(n)); await page.dispatchEvent('input[name=ref_n]', 'change');
  await page.waitForTimeout(150);
  await page.click('#createExp'); await page.waitForTimeout(400);
  const id = await latestOfType(page, 'reference');
  const forms = (await readCol(page, 'experiments')).find((x) => x.id === id).batchIds;
  return { id, forms };
}

/** Open one of the record's folded steps, as a click on its line does; one already open is left open. */
async function openStep(page, n) {
  if (!(await page.locator(`#step${n}[open]`).count())) await page.click(`#step${n} > summary`);
  await page.waitForTimeout(60);
}

/** Type a value into one of the record's inputs and let the record redraw. */
async function setInput(page, name, value) {
  const sel = `[name=${name}]`;
  if (await page.locator(`select${sel}`).count()) await page.selectOption(`select${sel}`, value);
  else { await page.fill(`input${sel}`, value); await page.dispatchEvent(`input${sel}`, 'change'); }
  await page.waitForTimeout(120);
}

/**
 * Usability cycle 2, F3: the numbers used at the bench lead the record, in bench order, and follow the inputs.
 * Each is checked twice: against the same quantity in the step tables (which must read identically, since both
 * come from one computation) and against docs/FORMULAS.md worked by hand.
 */
export async function benchCardFollowsInputs({ page, open }) {
  const { forms } = await newReference(page, open, 'Bench card', 2);
  const card = () => page.$$eval('#atBench [data-bench]', (ts) => Object.fromEntries(ts.map((t) => [t.dataset.bench, {
    text: t.querySelector('.bv').textContent.trim(), sub: t.querySelector('.bs')?.textContent.trim() || '', title: t.title }])));
  // The step tables' target column, by row label; step 3's start volume is an input pre-filled with its target.
  const steps = () => page.evaluate(() => {
    const target = (label) => {
      const tr = [...document.querySelectorAll('#batchForm tr')].find((r) => r.cells[0]?.textContent.trim() === label);
      return tr ? tr.cells[1].textContent.trim().split(/\s+/)[0] : null;
    };
    return {
      rna_stock_mL: target('RNA stock volume (mL)'), rna_buffer_mL: target('Dilution buffer (mL)'),
      rna_mL: target('RNA volume (mL)'), lipid_mL: target('Lipid/EtOH volume (mL)'), quench_mL: target('Quench buffer volume (mL)'),
      p1: target('Pump 1 RNA (mL/min)'), p2: target('Pump 2 lipid (mL/min)'), p3: target('Pump 3 quench (mL/min)'),
      totalFlow: target('Total process flow (mL/min)'), dialysis_start_mL: document.querySelector('input[name=ds_dialysis_start_mL]').value,
    };
  });
  const num = (s) => Number(String(s).replace(/,/g, '').split(/\s+/)[0]);
  const check = async (label, want) => {
    const c = await card(), s = await steps();
    for (const [k, v] of Object.entries(want)) {
      if (!c[k]) throw new Error(`${label}: no "${k}" on the bench card`);
      const unit = /^p\d|totalFlow/.test(k) ? 'mL/min' : 'mL';
      if (!c[k].text.endsWith(' ' + unit)) throw new Error(`${label}: ${k} reads "${c[k].text}", without its unit ${unit}`);
      const digits = (c[k].text.split(' ')[0].split('.')[1] || '').length;
      if (Math.abs(num(c[k].text) - v) > 0.5 * 10 ** -digits + 1e-9) throw new Error(`${label}: ${k} is ${c[k].text}, the formula gives ${v}`);
      const step = k === 'dialysis_start_mL' ? Number(s[k]).toFixed(2) : s[k];
      if (c[k].text.split(' ')[0] !== step) throw new Error(`${label}: ${k} is ${c[k].text} on the card but ${step} in the steps`);
      if (!/From /.test(c[k].title)) throw new Error(`${label}: ${k} does not say on hover what it was worked out from ("${c[k].title}")`);
    }
    return c;
  };

  // Formulation 1: 3 mg of RNA at 0.4 mg/mL from a 1.02 mg/mL stock, FRR 3, quench 2, 112.5 mL/min (the defaults).
  await open(`formulation?batch=${forms[0]}`);
  const order = await page.evaluate(() => {
    const at = document.querySelector('#atBench'), inputs = document.querySelector('#batchForm');
    return Boolean(at && inputs && (at.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  if (!order) throw new Error('the "At the bench" card should come before the inputs');
  let c = await card();
  if (c.rna_stock_mL.text !== '—' || !/choose an RNA lot/.test(c.rna_stock_mL.sub)) throw new Error(`with no RNA lot the stock volume should wait for one: "${c.rna_stock_mL.text}" / "${c.rna_stock_mL.sub}"`);
  await setInput(page, 'rna_stock_mg_mL', '1.02');
  // RNA stock 3/1.02 = 2.941 mL into 3/0.4 = 7.5 mL; lipid 7.5/3 = 2.5; quench 2.5 x 2 = 5; pumps 112.5 split 3:1:2;
  // primary product 0.4 x 56.25/112.5 = 0.2 mg/mL, so all 3 mg is 15 mL into dialysis.
  c = await check('3 mg at 0.4 mg/mL from 1.02 mg/mL', { rna_stock_mL: 2.941, rna_buffer_mL: 4.559, rna_mL: 7.5, lipid_mL: 2.5, quench_mL: 5,
    p1: 56.25, p2: 18.75, p3: 37.5, totalFlow: 112.5, dialysis_start_mL: 15 });
  if (!/RNA input 3 mg ÷ RNA stock conc\. 1\.02 mg\/mL/.test(c.rna_stock_mL.title)) throw new Error(`stock volume hover: "${c.rna_stock_mL.title}"`);
  if (!/prepare 5\.50 mL/.test(c.quench_mL.sub)) throw new Error(`the quench tile should say how much to prepare: "${c.quench_mL.sub}"`);
  // and it follows an input: FRR 4 is 112.5/7 = 16.07 on the lipid pump, 7.5/4 = 1.875 mL of lipid
  await setInput(page, 'mixing_frr', '4');
  await check('after FRR 3 → 4', { lipid_mL: 1.875, quench_mL: 3.75, p1: 64.2857, p2: 16.0714, p3: 32.1429, totalFlow: 112.5, dialysis_start_mL: 13.125 });

  // the worksheet carries the same block at its top
  const [sheet] = await Promise.all([page.context().waitForEvent('page', { timeout: 4000 }), page.click('#printBatch')]);
  await sheet.waitForLoadState();
  const printed = await sheet.locator('body').innerText();
  await page.waitForTimeout(400); await sheet.close();
  if (!/At the bench[\s\S]*RNA stock to pipette\s*2\.941 mL[\s\S]*Pump 2 · lipid\s*16\.07 mL\/min[\s\S]*Inputs/.test(printed)) {
    throw new Error(`the worksheet should open with the bench numbers: "${printed.slice(0, 400)}"`);
  }

  // Formulation 2: 1.5 mg at 0.2 mg/mL from RNA-TEST-01 (2.06 mg/mL), FRR 4, quench 1.5, 60 mL/min.
  await open(`formulation?batch=${forms[1]}`);
  for (const [k, v] of [['rna_lotId', 'RNA-TEST-01'], ['rna_mass_mg', '1.5'], ['rna_working_mg_mL', '0.2'], ['mixing_frr', '4'], ['mixing_quenchFactor', '1.5'], ['mixing_totalFlow', '60']]) await setInput(page, k, v);
  // 1.5/2.06 = 0.728 mL of stock into 7.5 mL; pumps 60 split 4:1:1.5, so 9.23 on the lipid pump; primary product
  // 0.2 x 36.92/60 = 0.1231 mg/mL, so 1.5 mg is 12.19 mL.
  c = await check('1.5 mg at 0.2 mg/mL from 2.06 mg/mL', { rna_stock_mL: 0.72816, rna_buffer_mL: 6.77184, rna_mL: 7.5, lipid_mL: 1.875, quench_mL: 2.8125,
    p1: 36.9231, p2: 9.2308, p3: 13.8462, totalFlow: 60, dialysis_start_mL: 12.1875 });
  if (!/RNA-TEST-01/.test(c.rna_stock_mL.sub)) throw new Error(`the stock tile should name the RNA lot: "${c.rna_stock_mL.sub}"`);
  // a start volume typed into step 3 is the one to load, and the card says so
  await openStep(page, 3);
  await setInput(page, 'ds_dialysis_start_mL', '11');
  c = await card();
  if (c.dialysis_start_mL.text !== '11.00 mL' || !/step 3/.test(c.dialysis_start_mL.sub)) throw new Error(`typed start volume: "${c.dialysis_start_mL.text}" / "${c.dialysis_start_mL.sub}"`);
  // emptying the RNA input leaves the volumes waiting for it, and the pumps (which do not depend on it) standing
  await setInput(page, 'rna_mass_mg', '');
  c = await card();
  if (c.rna_mL.text !== '—' || !/enter the RNA input/.test(c.rna_mL.sub)) throw new Error(`no RNA input: "${c.rna_mL.text}" / "${c.rna_mL.sub}"`);
  if (c.p2.text !== '9.23 mL/min') throw new Error(`the pump flows do not depend on the RNA input: "${c.p2.text}"`);
}

/**
 * Usability cycle 2, F10: the Formulations list is one group per experiment, a finished one folded, with a
 * filter for what is still to make that is remembered, and the selection only ever acting on what is shown.
 */
export async function formulationListGroupsAndFilters({ page, open }) {
  const done = await newReference(page, open, 'Finished set', 2);
  await seedResults(page, done.id, () => ({ z: 82, p: 0.11, ee: 94 }));
  const db = await page.evaluate(async () => {
    const batches = (await lnpDb.read('batches')).map((b) => ({ id: b.id, status: b.status }));
    const have = new Set(batches.map((b) => b.id));
    const exps = (await lnpDb.read('experiments'))
      .map((e) => ({ id: e.id, batchIds: (e.batchIds || []).filter((id) => have.has(id)) })).filter((e) => e.batchIds.length);
    return { exps, batches };
  });
  const planned = db.batches.filter((b) => b.status === 'planned');
  if (planned.length < 2) throw new Error(`expected planned formulations left by earlier scenarios, found ${planned.length}`);

  await open('formulation');
  // one group per experiment, holding exactly that experiment's formulations; a folded group draws its rows
  // only once it is opened (cycle 4, S2), so it is opened to read them and folded again
  for (const e of db.exps) {
    const g = `[data-group="${e.id}"]`;
    const folded = (await page.getAttribute(`${g} .fgToggle`, 'aria-expanded')) !== 'true';
    if (folded && await page.locator(`${g} tr[data-row]`).count()) throw new Error(`folded group ${e.id} drew its rows`);
    if (folded) await page.click(`${g} .fgToggle`);
    const rows = await page.$$eval(`${g} tr[data-row]`, (trs) => trs.map((t) => t.dataset.row));
    if (rows.join() !== e.batchIds.join()) throw new Error(`group ${e.id} holds ${rows.join(', ') || 'nothing'}, expected ${e.batchIds.join(', ')}`);
    if (folded) await page.click(`${g} .fgToggle`);
  }
  // the header counts by status
  const mixed = db.exps.find((e) => e.batchIds.some((id) => planned.some((b) => b.id === id)));
  const nPlanned = mixed.batchIds.filter((id) => planned.some((b) => b.id === id)).length;
  await expectText(page, `[data-group="${mixed.id}"] .fgCounts`, new RegExp(`\\b${nPlanned} to make`), 'a group header counts what is still to make');
  await expectText(page, `[data-group="${done.id}"] .fgCounts`, /2 measured/, 'and what is measured');
  // a finished group is folded, one with work left is open
  if (await page.locator(`[data-group="${done.id}"] .fgBody`).isVisible()) throw new Error('a group whose formulations are all measured should start folded');
  if (!(await page.locator(`[data-group="${mixed.id}"] .fgBody`).isVisible())) throw new Error('a group with formulations to make should start open');
  // opening one by hand is remembered
  await page.click(`[data-group="${done.id}"] .fgToggle`);
  await open('formulation');
  if (!(await page.locator(`[data-group="${done.id}"] .fgBody`).isVisible())) throw new Error('a group opened by hand should stay open');
  await page.click(`[data-group="${done.id}"] .fgToggle`);

  // "Still to make": only planned rows, groups with none hidden, and the choice survives a visit elsewhere
  await page.click('#formShow [data-show=todo]');
  const visible = () => page.$$eval('tr[data-row]', (trs) => trs.filter((t) => !t.hidden).map((t) => ({ id: t.dataset.row, status: t.dataset.status })));
  let shown = await visible();
  if (shown.length !== planned.length || shown.some((r) => r.status !== 'planned')) throw new Error(`"Still to make" shows ${shown.map((r) => `${r.id} ${r.status}`).join(', ')}`);
  if (await page.locator(`[data-group="${done.id}"]`).isVisible()) throw new Error('a finished experiment should drop out of "Still to make"');
  await expectText(page, '#formShown', new RegExp(`${planned.length} of ${db.batches.length} shown`), 'the list says how much it is showing');
  await open('overview');
  await open('formulation');
  if ((await page.getAttribute('#formShow [data-show=todo]', 'aria-pressed')) !== 'true') throw new Error('the filter was not remembered');
  shown = await visible();
  if (shown.length !== planned.length) throw new Error(`after coming back, "Still to make" shows ${shown.length} rows`);

  // select all, and a group's select-all, take only the rows shown
  await page.check('#selAllForms');
  const ticked = await page.$$eval('input[data-sel]:checked', (bs) => bs.map((b) => b.dataset.status));
  if (ticked.length !== planned.length || ticked.some((s) => s !== 'planned')) throw new Error(`select all under "Still to make" ticked ${ticked.join(', ')}`);
  await page.uncheck('#selAllForms');
  await page.check(`input[data-selall="${mixed.id}"]`);
  await expectText(page, '#selCount', new RegExp(`^${nPlanned} selected$`), 'a group select-all ticks that group\'s shown rows');
  await page.uncheck(`input[data-selall="${mixed.id}"]`);

  // "Waiting for results" is what was made and not measured yet
  await page.click('#formShow [data-show=waiting]');
  shown = await visible();
  const produced = db.batches.filter((b) => b.status === 'produced').length;
  if (shown.length !== produced || shown.some((r) => r.status !== 'produced')) throw new Error(`"Waiting for results" shows ${shown.length}, expected ${produced}`);

  // the text filter: an experiment's name finds its group and opens it, folded or not
  await page.click('#formShow [data-show=all]');
  await page.fill('#formFilter', 'finished set');
  shown = await visible();
  if (shown.map((r) => r.id).join() !== done.forms.join()) throw new Error(`filtering by the experiment name shows ${shown.map((r) => r.id).join(', ')}`);
  if (!(await page.locator(`[data-group="${done.id}"] .fgBody`).isVisible())) throw new Error('a folded group with a match should open');
  await page.fill('#formFilter', done.forms[1]);
  shown = await visible();
  if (shown.length !== 1 || shown[0].id !== done.forms[1]) throw new Error(`filtering by id shows ${shown.map((r) => r.id).join(', ')}`);
  // nothing matches: say so, and offer the way back
  await page.click('#formShow [data-show=todo]');
  await page.fill('#formFilter', 'no such formulation');
  await expectText(page, '#formNone', /No formulation still to make matches/, 'an empty result says why');
  await page.click('#formShowAll');
  // a folded group's rows are not drawn, so what is shown is read off the count line
  await expectText(page, '#formShown', new RegExp(`^${db.batches.length} formulations$`), '"Show all" should clear the filter');
  if (await page.inputValue('#formFilter')) throw new Error('"Show all" left the text filter in place');
}

scenarios.push(benchCardFollowsInputs, formulationListGroupsAndFilters);
const storedExperiment = async (page, id) => (await readCol(page, 'experiments')).find((e) => e.id === id);

/**
 * Cycle 2, F1 and S1: a stability study reads as one table, a row per formulation × shelf with the days
 * across (which is also the plan: what is due, what is missing), and says for each shelf how fast it drifts,
 * with a 95 % CI and the day the line reaches the QC limit.
 */
export async function stabilityTableAndSlope({ page, open }) {
  const st = await latestOfType(page, 'stability');
  const plan = (await storedExperiment(page, st)).design.stability;
  // resultsStabilityOverTime measured T0 and the first later day; two more make the three a slope needs
  const more = plan.timepoints.filter((t) => t > 0).slice(1, 3);
  if (more.length < 2) throw new Error(`the study needs two more timepoints, has ${plan.timepoints.join(', ')}`);
  for (const t of more) {
    await seedResults(page, st, (b, i, s) => ({ z: 80 + i * 10 + (s.condition === '25C' ? 2 : 0.3) * s.timepoint + (s.timepoint % 2 ? 0.4 : -0.3),
      p: i === 1 && s.condition === '25C' && s.timepoint > 6 ? 0.25 : 0.1, ee: 92 }), { timepoint: t });
  }
  await open('experiments');
  await open(`experiments?id=${st}`);
  await showEveryValue(page);
  const rows = await page.locator('#stabTable tbody tr').count();
  if (rows !== plan.formulations.length * plan.conditions.length) throw new Error(`one row per formulation × condition expected (${plan.formulations.length * plan.conditions.length}), found ${rows}`);
  await expectText(page, '#stabTable thead', /Formulation[\s\S]*Condition[\s\S]*T0[\s\S]*T28[\s\S]*Trend/i, 'the days run across, the trend at the end');
  await expectText(page, '#stabTable', /PDI 0\.\d{3}/, 'PDI under the size');
  await expectText(page, '#stabTable', /\+[\d.]+ nm \(\+[\d.]+ %\)/, 'the change from T0 in small type');
  await expectText(page, '#stabTable', /\+[\d.]+ nm\/day\s*95 % CI/, 'and the slope with its interval in the trend column');
  if (!(await page.locator('#stabTable .qc-out').count())) throw new Error('a PDI of 0.25 is not marked as outside the QC limit');
  await expectText(page, '#stabTable', /\b\d{1,2} (Oct|Nov|Dec)\b|missing|due today/, 'a day still to come says when it is due, as the matrix did');
  await expectText(page, '#resultsCard', /At 25 °C, E\d+-F\d+ grows [\d.]+ nm\/day \(95 % CI [\d.]+–[\d.]+\); at that rate it reaches 150 nm around day \d+\./,
    'one sentence per shelf: slope, 95 % CI and the projected day');
  await expectText(page, '#resultsCard', /Soonest to a QC limit: E\d+-F\d+ at 25 °C/, 'and which formulation and shelf gets there first');
  if (!(await page.locator('#resultsCard #copyNames').count())) throw new Error('"Copy names for next due date" did not move with the table');
  await expectNoText(page, '#main', /Measurement matrix/, 'the matrix that repeated the table');
  // the measured value opens its measurement
  const link = page.locator('#stabTable a.res-link').first();
  if (!/#\/measurements\?id=/.test(await link.getAttribute('href') || '')) throw new Error('a value in the table does not open its measurement');
}

/**
 * Cycle 2, F1: what is long is folded. The expected-measurement list is one line until opened, and a data
 * table past eight rows shows its first six with "Show all N rows".
 */
export async function expectedListAndLongTablesFold({ page, open }) {
  const st = await latestOfType(page, 'stability');
  await open('experiments');
  await open(`experiments?id=${st}`);
  await expectText(page, '#expectedSummary', /^\d+ expected · \d+ done · \d+ open, next due \d{1,2} [A-Z][a-z]{2}( · \d+ overdue)?$/, 'one line: the counts and the next due date');
  if ((await page.locator('#expectedDetails').getAttribute('open')) !== null) throw new Error('the expected-measurement list should start folded');
  if (await page.locator('#expectedDetails table').isVisible()) throw new Error('the folded list still shows its table');
  await page.click('#expectedDetails summary');
  if (!(await page.locator('#expectedDetails table').isVisible())) throw new Error('opening the summary does not show the list');
  await expectText(page, '#expectedDetails', /E\d+-F1_25C_T\d\d/, 'with every sample name');

  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', 'Ten repeats');
  await page.fill('input[name=ref_n]', '10'); await page.dispatchEvent('input[name=ref_n]', 'change');
  await page.waitForTimeout(150);
  await page.click('#createExp'); await page.waitForTimeout(400);
  const id = await latestOfType(page, 'reference');
  await seedResults(page, id, (b, i) => ({ z: 80 + i, p: 0.09, ee: 93 }));
  await open('experiments');
  await open(`experiments?id=${id}`);
  const visible = () => page.locator('#resultsCard .res-fold tbody tr:visible').count();
  await expectText(page, '#resultsCard [data-showall]', /Show all 10 rows/, 'a long table offers the rest');
  if (await visible() !== 7) throw new Error(`six rows and the batch-to-batch row should show, ${await visible()} do`);
  await page.click('#resultsCard [data-showall]');
  if (await visible() !== 11) throw new Error(`"Show all" showed ${await visible()} rows, not 11`);
  await expectText(page, '#resultsCard [data-showall]', /first rows only/, 'and folds them again');
}

/** Cycle 2, F5: "Repeat as new" opens the wizard filled in from the experiment, and creates a new one. */
export async function repeatAsNew({ page, open }) {
  const st = await latestOfType(page, 'stability');
  const src = await storedExperiment(page, st);
  await open(`experiments?id=${st}`);
  await page.click('#repeatExp');
  await page.waitForTimeout(400);
  const hash = await page.evaluate(() => location.hash);
  if (!hash.includes(`from=${st}`) || !hash.includes('type=stability')) throw new Error(`Repeat as new went to ${hash}`);
  await expectText(page, '#fromNote', new RegExp(`Filled in from Experiment ${st.slice(1)}\\b`), 'the wizard says where it was filled in from');
  if ((await page.inputValue('input[name=name]')) !== `${src.name} (repeat)`) throw new Error(`name: ${await page.inputValue('input[name=name]')}`);
  if ((await page.locator('select[name^=form_]').count()) !== src.design.stability.formulations.length) throw new Error('the formulations were not carried over');
  for (const c of src.design.stability.conditions) if (!(await page.isChecked(`input[name=cond_${c}]`))) throw new Error(`storage condition ${c} was not carried over`);
  await expectText(page, '#main', new RegExp(`Timepoints:\\s*${src.design.stability.timepoints.map((t) => `T${t}`).join('\\s*·\\s*')}\\s`), 'the same timepoints');
  await page.click('#createExp'); await page.waitForTimeout(400);
  const made = await latestOfType(page, 'stability');
  if (made === st) throw new Error('no new experiment was created');
  const rep = await storedExperiment(page, made);
  if (rep.batchIds.length !== src.batchIds.length || rep.expected.length !== src.expected.length) throw new Error('the repeat does not plan what the original did');
  await expectText(page, '#resultsCard', /Nothing measured yet/, 'and starts with nothing measured');

  // a comparison carries its compositions, a DoE its design down to the custom factor
  const cmp = await latestOfType(page, 'comparison');
  const ids = (await storedExperiment(page, cmp)).spec.comparison.compositionIds;
  await open(`experiments?id=${cmp}`);
  await page.click('#repeatExp'); await page.waitForTimeout(300);
  const shown = await page.$$eval('select[name^=cmp_]', (ss) => ss.map((s) => Number(s.value)));
  if (shown.join() !== ids.join()) throw new Error(`comparison compositions ${shown.join()} instead of ${ids.join()}`);
  const doe = (await readCol(page, 'experiments')).find((e) => e.name === 'FRR x TFR')?.id;
  if (doe) {
    await open(`experiments?id=${doe}`);
    await page.click('#repeatExp'); await page.waitForTimeout(300);
    if ((await page.inputValue('input[name=doe_f_name_2]')) !== 'temperature') throw new Error('the custom DoE factor was not carried over');
    await expectText(page, '#doeSummary', /18 runs: 8 factorial · 6 axial · 4 center/, 'and the design: a face-centred CCD with four centre points');
  }
  // a link to an experiment that is gone fills in nothing, and says so
  await open('experiments?new=1&type=single&from=E999');
  await expectText(page, '#fromNote', /Experiment 999 is not on record/, 'a stale repeat link');
  if (await page.inputValue('input[name=name]')) throw new Error('a stale repeat link filled in a name');
}

scenarios.push(stabilityTableAndSlope, expectedListAndLongTablesFold, repeatAsNew);

// ---- One sheet for every test, corrections, what is missing (usability cycle 2, recommendation B: F4, F2, F8) ----
/** A fresh set of repeats (DLS and EE due for each), so a measurement scenario starts from slots nobody has touched. */
async function newRepeats(page, open, name, n = 3) {
  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', name);
  await page.fill('input[name=ref_n]', String(n)); await page.dispatchEvent('input[name=ref_n]', 'change');
  await page.waitForTimeout(150);
  await page.click('#createExp'); await page.waitForTimeout(400);
  const id = await latestOfType(page, 'reference');
  const exp = (await readCol(page, 'experiments')).find((x) => x.id === id);
  if (exp?.name !== name) throw new Error(`the new experiment "${name}" was not created (latest is ${id})`);
  return exp;
}
// The last one stored: the smoke run's clock stands still, so every import carries the same importedAt.
const latestImport = async (page) => (await readCol(page, 'imports')).at(-1);

/**
 * F4: the blank sheet carries a column for every test still due, and the sheet filled in with size and EE comes
 * back in one import: one result per sample per test, each closing its own slot.
 */
export async function blankSheetEveryTest({ page, open }) {
  const exp = await newRepeats(page, open, 'One sheet for every test');
  const due = [...new Set(exp.expected.map((s) => s.test))];
  if (!due.includes('dls') || !due.includes('ee')) throw new Error(`repeats should be due DLS and EE, are due ${due.join(', ')}`);
  await open(`measurements?waiting=${exp.id}`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#blankSheet')]);
  const { readFileSync } = await import('node:fs');
  const [head, ...lines] = readFileSync(await dl.path(), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  const want = ['Sample Name', 'Z-Average (d.nm)', 'PdI', ...(due.includes('zeta') ? ['Zeta Potential (mV)'] : []), 'EE (%)', ...(due.includes('content') ? ['RNA (mg/mL)'] : [])];
  if (cols.join(',') !== want.join(',')) throw new Error(`blank sheet header "${head}", expected "${want.join(',')}"`);
  const names = lines.map((l) => l.split(',')[0]);
  const expected = [...new Set(exp.expected.map((s) => s.sampleName))];
  if (names.join() !== expected.join()) throw new Error(`blank sheet names ${names.join(', ')}, expected ${expected.join(', ')}`);

  // Size, PDI and EE typed in; the first PDI is a slip for 0.05, which the correction scenario puts right.
  const cell = (c, i) => ({ 'Sample Name': names[i], 'Z-Average (d.nm)': (82 + i).toFixed(1), PdI: i === 0 ? '0.5' : '0.09', 'EE (%)': (93 + i / 2).toFixed(1) }[c] ?? '');
  const filled = [head, ...names.map((n, i) => cols.map((c) => cell(c, i)).join(','))].join('\n');
  await page.setInputFiles('#csvFile', { name: 'one_sheet.csv', mimeType: 'text/csv', buffer: Buffer.from(filled) });
  await page.waitForTimeout(400);
  if (await page.inputValue('#importTest') !== 'auto') throw new Error('the import type should default to detecting the tests from the columns');
  await expectText(page, '#importReadAs', /read as DLS \+ EE\b/, 'the preview says which tests it found');
  await expectText(page, '#importPreview', new RegExp(`${names.length} matched`), 'every row matches by construction');
  const groups = await page.$$eval('#importPreview tr.grp th.g0', (t) => t.map((x) => x.textContent.trim()));
  if (groups.join(',') !== 'DLS,EE') throw new Error(`the preview should have a DLS and an EE column group, has ${groups.join(',')}`);
  const rows = await page.locator('#importPreview tbody tr').count();
  if (rows !== names.length) throw new Error(`one row per sample: ${rows} rows for ${names.length} samples`);
  await expectText(page, '#importMissing', /Nothing missing/, 'nothing this round expects is missing');

  await page.click('#doImport');
  await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
  const ms = (await storedMeasurements(page)).filter((m) => m.raw?.fileName === 'one_sheet.csv');
  for (const [i, n] of names.entries()) {
    const d = ms.filter((m) => m.sampleName === n && m.test === 'dls'), e = ms.filter((m) => m.sampleName === n && m.test === 'ee');
    if (d.length !== 1 || e.length !== 1) throw new Error(`${n}: ${d.length} DLS and ${e.length} EE results stored, expected one of each`);
    if (d[0].values.zave_nm !== 82 + i || e[0].values.ee_pct !== 93 + i / 2) throw new Error(`${n}: stored ${JSON.stringify(d[0].values)} / ${JSON.stringify(e[0].values)}`);
    for (const t of ['dls', 'ee']) if (await slotStatus(page, n, t) !== 'done') throw new Error(`the ${t} slot of ${n} is still open`);
    if (d[0].slotId === e[0].slotId) throw new Error('the DLS and the EE result closed the same slot');
  }
  const imp = await latestImport(page);
  if (imp?.measurementIds?.length !== 2 * names.length || imp.tests?.join() !== 'dls,ee') throw new Error(`the import record: ${JSON.stringify({ ids: imp?.measurementIds?.length, tests: imp?.tests })}`);
  await expectText(page, '#importEval', new RegExp(`${names.length} samples \\(${2 * names.length} results\\) in the DLS and EE data`), 'the evaluation counts samples and results');
  await expectText(page, '#recentImports', new RegExp(`one_sheet\\.csv[\\s\\S]*DLS \\+ EE · ${names.length} samples · ${2 * names.length} stored`), 'and the recent imports name both tests');
}

/** F2: a stored result is corrected with a reason, a PDI of 5 is still refused, and the old values are kept. */
export async function correctStoredResult({ page, open }) {
  const m = (await storedMeasurements(page)).find((x) => x.test === 'dls' && x.raw?.fileName === 'one_sheet.csv' && x.values?.pdi === 0.5);
  if (!m) throw new Error('the one-sheet scenario should have left a DLS result with a PDI of 0.5');
  await open(`measurements?id=${m.id}`);
  await page.click('#editResult');
  await page.waitForSelector('#editForm', { timeout: 3000 });
  // An imported result carries its run, and the mean follows the run: the run is what gets corrected.
  const box = (await page.locator('#editForm input[name="er_0_pdi"]').count()) ? '#editForm input[name="er_0_pdi"]' : '#editForm input[name="e_pdi"]';
  const stored = async () => (await storedMeasurements(page)).find((x) => x.id === m.id);

  await page.fill(box, '5');
  await page.fill('#editReason', 'typo');
  await page.click('#saveEdit'); await page.waitForTimeout(200);
  await expectText(page, '#editCheck', /Not saved[\s\S]*PDI 5 is outside 0–1 — did you mean 0\.05\?/, 'a PDI of 5 is refused on correction as on entry');
  if (!(await page.locator(`${box}.invalid`).count())) throw new Error('the refused field is not marked');
  let now = await stored();
  if (now.values.pdi !== 0.5 || now.history?.length) throw new Error('a refused correction changed the record');

  await page.fill(box, '0.05');
  await page.fill('#editReason', '');
  await page.click('#saveEdit'); await page.waitForTimeout(200);
  await expectText(page, '#editCheck', /Not saved[\s\S]*Say why/, 'a correction needs a reason');
  if ((await stored()).history?.length) throw new Error('a correction without a reason was stored');

  await page.fill('#editReason', 'typo');
  await page.click('#saveEdit'); await page.waitForTimeout(300);
  now = await stored();
  if (Math.abs(now.values.pdi - 0.05) > 1e-12) throw new Error(`the corrected PDI was not stored: ${JSON.stringify(now.values)}`);
  if (now.history?.length !== 1 || now.history[0].reason !== 'typo' || now.history[0].values?.pdi !== 0.5 || !now.history[0].at) throw new Error(`history: ${JSON.stringify(now.history)}`);
  if ((now.flags || []).some((f) => /PDI/.test(f.text))) throw new Error('the QC flag of the typo outlived its correction');
  if (now.slotId !== m.slotId || now.sampleName !== m.sampleName) throw new Error('the correction moved the result off its slot');
  await expectText(page, '#resultHistory', /Corrected \d{2} \w{3} \d{4}( by \S+)?: typo — was PDI 0\.5\b/, 'the history is shown under the values');
  await expectText(page, '#main', /PDI 0\.050/, 'and the result reads the corrected value');
  // The list shows 50 at a time (usability cycle 4, C), and with the smoke run's clock standing still every
  // result is stored in the same millisecond, so this one is looked up as a person would: by its sample name.
  await open(`measurements?rq=${encodeURIComponent(m.sampleName)}`);
  await expectText(page, `#main tr:has(a[href="#/measurements?id=${m.id}"])`, /corrected/, 'the results list marks a corrected result');
}

/** F8: the preview lists what the file is missing, and the one row that matched nothing is pointed at the one sample left. */
export async function importListsWhatIsMissing({ page, open }) {
  const exp = await newRepeats(page, open, 'Missing one');
  const names = [...new Set(exp.expected.filter((s) => s.test === 'dls').map((s) => s.sampleName))];
  const [a, b, left] = names;
  await open('measurements');
  await page.click('#main details:has(#pasteBox) > summary');
  // the third vial was not renamed on the instrument
  await page.fill('#pasteBox', ['Sample Name\tZ-Average (d.nm)\tPdI', `${a}\t81.0\t0.08`, `${b}\t83.5\t0.09`, 'vial C\t88.0\t0.10'].join('\n'));
  await page.click('#pasteGo');
  await page.waitForTimeout(400);
  await expectText(page, '#importMissing', new RegExp(`Still missing from this file: ${reEsc(left)}\\.`), 'the preview names the sample the file is missing');
  await expectNoText(page, '#importMissing', new RegExp(`${reEsc(a)}|${reEsc(b)}`), 'and not the ones it has');
  const sel = page.locator('#importPreview select[data-target]');
  if (await sel.count() !== 1) throw new Error(`one row should be unmatched, ${await sel.count()} are`);
  if (await sel.inputValue() !== left) throw new Error(`the only sample left was not preselected (got "${await sel.inputValue()}")`);
  await expectText(page, '#importPreview tr:has(select[data-target])', /only one left/, 'and the row says why it was chosen');
  await page.click('#doImport');
  await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
  if (await slotStatus(page, left, 'dls') !== 'done') throw new Error(`the DLS slot of ${left} is still open`);
  const stray = (await storedMeasurements(page)).find((m) => m.sampleName === 'vial C' && m.test === 'dls');
  const slot = exp.expected.find((s) => s.sampleName === left && s.test === 'dls');
  if (stray?.slotId !== slot.id || stray.batchId !== slot.batchId || stray.values.zave_nm !== 88) throw new Error(`the stray row was not stored against ${left}: ${JSON.stringify(stray)}`);
}


scenarios.push(blankSheetEveryTest, correctStoredResult, importListsWhatIsMissing);
/**
 * Cycle 2, F1 and F11: the DoE screen and the optimizer lead with their conclusion. On the demo response
 * surface the balanced setting comes first, then one sentence per response on what drives it, then the plots;
 * the run table, the coefficients and the exports fold to a line that still says what they hold, and open on a
 * click with every control in them working. On the optimizer, after a run, what to run next sits above the
 * model report, and the setup folds but stays one click away. Runs in demo mode and switches it off again.
 */
export async function conclusionsLead({ page, open }) {
  const y = (sel) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
  const isOpen = (sel) => page.locator(sel).evaluate((d) => d.open);
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  try {
    await open('doe?id=E4&response=particle_size_nm');
    await expectText(page, '#main', /Best balance of all responses[\s\S]*What drives each response[\s\S]*Is this fit any good\?[\s\S]*Design and runs[\s\S]*Coefficients and the one-response optimum[\s\S]*Take the data elsewhere/,
      'the DoE screen reads in the order a decision is made');
    const order = await Promise.all(['#balanceCard', '#driversCard', '#fitCard', '#runsFold', '#coefFold', '#exportFold'].map(y));
    if (order.some((v, i) => i && v <= order[i - 1])) throw new Error(`DoE sections out of order: ${order.map(Math.round).join(', ')}`);

    // one sentence per response: direction, and size in the units of the response and the factor
    await expectText(page, '#driversCard', /Size (falls|rises) with [^(;]+ \([−+][\d.]+ nm from [\d.]+ to [\d.]+( \S+)?\)/, 'size is summarised with direction and size in real units');
    await expectText(page, '#driversCard', /Size[\s\S]*R² 0\.\d\d[\s\S]*PDI[\s\S]*R² [\d.]+[\s\S]*EE[\s\S]*R² [\d.]+/, 'every response gets a line, each with its R²');
    await expectText(page, '#driversCard', /predicted R² [−-]?[\d.]+: below 0\.5/, 'a model that cannot predict new runs is flagged beside its sentence');

    // whole numbers read as whole numbers, small ones keep their digits
    await expectText(page, '#balanceCard', /target 80(?![.\d])/, 'target 80, not 80.00');
    await expectText(page, '#balanceCard', /\d+ mL\/min/, 'a flow rate reads as a whole number');
    await expectNoText(page, '#balanceCard', /\d\.0+(?!\d)/, 'no padded decimals on the balance card');
    await expectText(page, '#balanceCard', /PDI\s+0\.0\d\d(?!\d)/, 'a PDI keeps three decimals and no more');

    // folded: the line says what is inside, the inside is not on the page until asked for
    for (const f of ['#runsFold', '#coefFold', '#exportFold']) if (await isOpen(f)) throw new Error(`${f} should be folded once there are results`);
    if (await page.locator('#expCsv').isVisible()) throw new Error('the run table export shows through its fold');
    await expectText(page, '#runsFold > summary', /18 runs[\s\S]*all measured/, 'the folded run table says what it holds');
    await expectText(page, '#coefFold > summary', /\d+ of \d+ terms pass p < 0\.05[\s\S]*closest to target 80/, 'the folded coefficients say how many terms are real and where size alone would go');
    await page.click('#runsFold > summary');
    await expectText(page, '#runsFold', /R001[\s\S]*R018/, 'opened, the run table is all there');
    // a view select redraws the screen; the fold the user opened stays open, the others stay shut
    await page.selectOption('[name=response]', 'PDI');
    await page.waitForTimeout(700);
    if (!(await isOpen('#runsFold'))) throw new Error('an opened fold closed again when the response changed');
    if (await isOpen('#coefFold')) throw new Error('a fold nobody opened came open');
    await expectText(page, '#fitCard', /The fit of PDI/, 'the plots follow the selected response');
    // the demo PDI has real curvature and too few runs for the quadratic: the verdict says so first, and the
    // plot it points at (which terms pass) is the one left open beside it, whatever the fold below is doing
    await expectText(page, '#fitVerdict', /^Too many terms for 18 runs[\s\S]*predicted R² −\d\.\d\d\)[\s\S]*terms past the line/, 'an overfitted model is named for what it is');
    const lead = await page.evaluate(() => { const v = document.querySelector('#fitVerdict'); const f = document.querySelector(`#fitCard .fig[data-fig="${v.dataset.plot}"]`); return { plot: v.dataset.plot, outside: !!f && !f.closest('#plotsFold') }; });
    if (lead.plot !== 'effects' || !lead.outside) throw new Error(`the verdict should open "which terms are real" beside it, opened ${JSON.stringify(lead)}`);
    const [table] = await Promise.all([page.waitForEvent('download'), page.click('#expCsv')]);
    if (!/E4_design_table\.csv$/.test(table.suggestedFilename())) throw new Error(`run table export: ${table.suggestedFilename()}`);
    await page.click('#coefFold > summary');
    await expectText(page, '#coefFold', /Intercept[\s\S]*R² [\d.]+ · adjusted/, 'the coefficient table opens');
    await page.click('#exportFold > summary');
    const [rawCsv] = await Promise.all([page.waitForEvent('download'), page.click('#expRaw')]);
    if (!/E4_raw_data\.csv$/.test(rawCsv.suggestedFilename())) throw new Error(`measured data export: ${rawCsv.suggestedFilename()}`);
    // the response names in the summary switch the plots
    await page.click('#driversCard a:has-text("EE")');
    await page.waitForTimeout(700);
    await expectText(page, '#fitCard', /The fit of EE/, 'a response named in the summary opens its plots');

    // the optimizer: the answer first, the evidence folded under it
    await open('ml');
    await page.click('#runBtn');
    await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    if (!((await y('#makeExp')) < (await y('#modelFold')))) throw new Error('"What to run next" and its button should sit above the model report');
    // it sat 4,200 px down before cycle 2's fix; the smoke viewport is narrower than a desk screen, hence the slack
    if ((await y('#makeExp')) > 1600) throw new Error(`the button to make the suggested runs is ${Math.round(await y('#makeExp'))} px down the page`);
    await expectText(page, '#main', /What to run next[\s\S]*Beats best[\s\S]*Model quality[\s\S]*The map[\s\S]*What drives what/, 'the optimizer leads with what to run next');
    await expectText(page, '#modelFold > summary', /Model quality\s+(strong|good|fair|weak|worse than the average|not testable yet) for [^(]+\(Q² [−-]?[\d.]+\)/, 'the folded model report states its verdict');
    if (await isOpen('#modelFold')) throw new Error('the model report should be folded after a run');
    if (await page.locator('input[name=g_weight_0]').isVisible()) throw new Error('the goals should fold once a run has been made');
    await expectText(page, '#setupFold > summary', /Particle size target 80 nm[\s\S]*over [\s\S]*mL\/min/, 'the folded setup says what is being optimised over what');
    await expectNoText(page, '#setupFold > summary', /\d\.0(?!\d)/, 'ranges read as the bench sets them');
    await page.click('#setupFold > summary');
    if (!(await page.locator('input[name=g_weight_0]').isVisible())) throw new Error('the goals are not reachable from their fold');
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
}

scenarios.push(conclusionsLead);

// ---- Ids are never given out twice (usability cycle 3, recommendation A: C1) ----
scenarios.push(deletedNumberStaysTaken, orphanedResultsNoted);

/**
 * C1 as the session met it: an experiment with a result on one of its formulations is deleted and the next
 * experiment is created straight after. The new one gets a new number, so none of its formulations carries
 * the old result, and the Undo on the delete note still brings the old experiment back, result and all.
 */
export async function deletedNumberStaysTaken({ page, open }) {
  // An experiment's own page, drawn: its name in the heading, not the "Loading …" of the screen on its way.
  const onPage = (name) => page.waitForFunction((n) => (document.querySelector('#main h1')?.innerText || '').includes(n) && document.querySelector('#delExp'), name, { timeout: 4000 });
  const old = await newReference(page, open, 'Deleted with a result on it', 2);
  if (!old.id || old.forms.length !== 2) throw new Error(`the reference experiment was not created: ${JSON.stringify(old)}`);
  // One size on its first formulation, stored and its slot closed the way an import leaves them.
  await page.evaluate(async ({ expId, batchId }) => {
    const [exps, meas] = await Promise.all([lnpDb.read('experiments'), lnpDb.read('measurements')]);
    const slot = exps.find((e) => e.id === expId).expected.find((s) => s.batchId === batchId && s.test === 'dls');
    meas.push({ id: 'c1-result', batchId, experimentId: expId, test: 'dls', stage: slot.stage, slotId: slot.id, sampleName: slot.sampleName,
      date: slot.dueDate, values: { zave_nm: 123.4, pdi: 0.213 }, flags: [] });
    slot.status = 'done'; slot.measurementId = 'c1-result';
    await lnpDb.write('experiments', exps);
    await lnpDb.write('measurements', meas);
  }, { expId: old.id, batchId: old.forms[0] });
  await open('overview');
  await open(`experiments?id=${old.id}`);
  await onPage('Deleted with a result on it');
  await expectText(page, '#main', /123\.4/, 'the result shows on the experiment it was made for');

  await page.click('#delExp');
  await page.waitForFunction(() => location.hash === '#/experiments', null, { timeout: 3000 });
  const fresh = await newReference(page, open, 'Created after the delete', 2);
  if (fresh.id === old.id) throw new Error(`the new experiment was given the deleted one's number, ${old.id}`);
  if (!(Number(fresh.id.slice(1)) > Number(old.id.slice(1)))) throw new Error(`${fresh.id} should be numbered past the deleted ${old.id}`);
  if (fresh.forms.some((f) => old.forms.includes(f))) throw new Error(`the new formulations ${fresh.forms} reuse the deleted ones' ids`);
  await onPage('Created after the delete');
  await expectNoText(page, '#main', /123\.4/, 'the deleted experiment\'s result does not attach to the new one');
  const named = (await storedMeasurements(page)).filter((m) => fresh.forms.includes(m.batchId) || m.experimentId === fresh.id);
  if (named.length) throw new Error(`results name the new formulations: ${named.map((m) => m.id)}`);

  // The delete can still be undone from the trash (its note went once the list was left, usability cycle 6,
  // I3): nothing has taken the old number.
  if (await page.locator('#toast .note', { hasText: `Deleted Experiment ${old.id.slice(1)}` }).count()) throw new Error('the delete note followed the user to other screens');
  await open('settings');
  await page.locator('tr', { hasText: `Experiment ${old.id.slice(1)} · Deleted with a result on it` }).locator('button[data-restore]').click();
  await expectText(page, '#toast', new RegExp(`Restored Experiment ${old.id.slice(1)}`), 'the restore is confirmed, not refused');
  await page.click('#toast button[data-toast-action="Open"]');
  await page.waitForFunction((e) => location.hash === `#/experiments?id=${e}`, old.id, { timeout: 3000 })
    .catch(async () => { throw new Error(`Restore did not reopen ${old.id}: ${await page.evaluate(() => location.hash)} · ${await page.locator('#toast').innerText()}`); });
  await onPage('Deleted with a result on it');
  await expectText(page, '#main', /123\.4/, 'and the result is back on the experiment it was made for');
  const ids = (await readCol(page, 'experiments')).map((e) => e.id);
  if (!ids.includes(old.id) || !ids.includes(fresh.id)) throw new Error(`both experiments should be on record: ${ids}`);
}

/**
 * The start-up check: a result whose formulation is neither on record nor in the trash (its trash entry has
 * expired, say) is reported on the overview, linked to the Measurements screen filtered to it. Nothing is
 * deleted or moved. Hiding the note keeps it hidden across a restart. The store is put back afterwards.
 */
export async function orphanedResultsNoted({ page, open }) {
  const kept = await stored(page, 'measurements');
  const restart = async () => { await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 }); };
  await page.evaluate(async () => {
    const ms = await lnpDb.read('measurements');
    for (const [id, test, values] of [['c1-orphan-dls', 'dls', { zave_nm: 95.5, pdi: 0.12 }], ['c1-orphan-ee', 'ee', { ee_pct: 93.1 }]]) {
      ms.push({ id, batchId: 'E900-F1', experimentId: 'E900', test, stage: 'final', sampleName: 'E900-F1_final', date: '2026-09-01', values, flags: [] });
    }
    await lnpDb.write('measurements', ms); // stored before the restart below
  });
  try {
    await restart();
    await open('settings'); // the reload may have landed on the overview already; a change of hash redraws it
    await open('overview');
    await expectText(page, '#orphansMissing', /2 results belong to a formulation that no longer exists — E900-F1\. Nothing has been changed/, 'the overview names the results and their formulation');
    await page.click('#orphansMissing a[href="#/measurements?batch=E900-F1"]');
    await page.waitForFunction(() => location.hash === '#/measurements?batch=E900-F1' && /Results · E900-F1/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 4000 })
      .catch(async () => { throw new Error(`the note did not open the Measurements screen filtered to E900-F1: ${await page.evaluate(() => location.hash)}`); });
    await expectText(page, '#main', /Results · E900-F1[\s\S]*E900-F1_final[\s\S]*E900-F1_final/, 'filtered to the two results');
    const after = (await storedMeasurements(page)).filter((m) => m.id.startsWith('c1-orphan'));
    if (after.length !== 2 || after.some((m) => m.batchId !== 'E900-F1')) throw new Error('the check changed the results it found');

    await open('overview');
    await page.click('#orphansMissing [data-hide-orphans]');
    if (await page.locator('#orphansMissing').count()) throw new Error('Hide left the note on the overview');
    await restart();
    await open('settings');
    await open('overview');
    if (await page.locator('#orphansMissing').count()) throw new Error('a hidden note came back after a restart');
  } finally {
    await writeCol(page, 'measurements', JSON.parse(kept));
    await page.evaluate(() => localStorage.removeItem('lnp-lab.hidden.orphans')); // a preference, which stays in localStorage
    await restart();
  }
}

/**
 * Usability cycle 3, C2: a CCD on PEG mol% used to put "decide which lipid absorbs it" on every bench record,
 * because the factor set the PEG and nothing took the difference. Cholesterol now does, as in the optimizer,
 * and the record, the run table and the weigh-in all show the recipe that is actually weighed out.
 */
export async function pegDesignKeepsTheRecipeAt100({ page, open }) {
  await open('experiments?new=1&type=doe&factors=peg_pct,tfr&design=ccd_faced&model=quadratic&center=3');
  await page.selectOption('select[name=compositionId]', '1');
  await page.dispatchEvent('select[name=compositionId]', 'change');
  await page.waitForTimeout(300);
  await page.fill('input[name=name]', 'PEG balance CCD');
  await expectText(page, '#main', /11 runs: 4 factorial · 4 axial · 3 center[\s\S]*Formulations\s*11/, 'a face-centred CCD on PEG and flow');
  await page.click('#createExp');
  await page.waitForTimeout(600);

  const { expId, batchId } = await page.evaluate(async () => {
    const exp = (await lnpDb.read('experiments')).find((e) => e.name === 'PEG balance CCD');
    const b = (await lnpDb.read('batches'))
      .find((x) => x.experimentId === exp?.id && x.plan?.compositionOverride?.peg_pct === 2.5);
    return { expId: exp?.id, batchId: b?.id };
  });
  if (!expId || !batchId) throw new Error(`the CCD should have a run at PEG 2.5 mol% (experiment ${expId}, batch ${batchId})`);

  // the bench record: 100 mol%, cholesterol named as the lipid that took the difference, nothing to decide
  await open(`formulation?batch=${batchId}`);
  await page.waitForTimeout(500);
  await expectText(page, '#main', /Cholesterol 37\.50 \(absorbs the PEG change\)[\s\S]*DMG-PEG2000 2\.50/, 'the record names the lipid that balances the PEG');
  await expectText(page, '#main', /The total is 100 mol%/, 'and the recipe totals 100');
  await expectNoText(page, '#main', /decide which lipid/i, 'the operator no longer has a formulation decision to make');
  await expectNoText(page, '#main', /totals [\d.]+, not 100/, 'no run is off 100 mol%');

  // the run table shows the cholesterol of every run beside the PEG that set it
  await open(`doe?id=${expId}`);
  await page.waitForTimeout(600);
  await expectText(page, '#runsFold', /Cholesterol\s*mol% \(balance\)/i, 'the run table has the balancing lipid as a column');
  await expectText(page, '#runsFold', /Cholesterol absorbs the PEG change, so every run totals 100 mol%/, 'and says why it is there');
  const head = await page.$$eval('#runsFold table thead th', (th) => th.map((h) => h.innerText.replace(/\s+/g, ' ').trim()));
  const cells = await page.$$eval('#runsFold table tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.innerText.trim())));
  const peg = head.findIndex((h) => /^PEG mol%/.test(h)), chol = head.findIndex((h) => /^Cholesterol/i.test(h));
  if (peg < 0 || chol < 0 || !cells.length) throw new Error(`run table columns: ${head.join(' | ')}`);
  for (const c of cells) {
    if (Math.abs(Number(c[peg]) + Number(c[chol]) - 40) > 1e-6) throw new Error(`a run with PEG ${c[peg]} has cholesterol ${c[chol]}; together they should be the registry's 40 mol%`);
  }

  // and the weigh-in starts from that recipe, not from the registry's 38.5 / 1.5
  await open(`formulation?batch=${batchId}`);
  await page.waitForTimeout(400);
  await page.click('#main a:has-text("Weigh out a lipid stock of this recipe")');
  await page.waitForTimeout(600);
  await expectText(page, '#stockEditor', /recipe a formulation record handed over/, 'the weigh-in says where its recipe came from');
  // The mol% sits in each card's editable field now that every field shows (the advanced switch is gone).
  const pct = async (key) => Number(await page.locator(`#stockEditor input[name="pct_${key}"]`).inputValue());
  if (await pct('Chol') !== 37.5) throw new Error(`the cholesterol card weighs out ${await pct('Chol')} mol%, not the balanced 37.5`);
  if (await pct('DMG0PEG2000') !== 2.5) throw new Error(`the PEG card holds ${await pct('DMG0PEG2000')} mol%, not the design setting 2.5`);
  await expectNoText(page, '#stockEditor', /not 100 %/, 'the stock recipe totals 100');
}

scenarios.push(pegDesignKeepsTheRecipeAt100);


/**
 * Usability cycle 3, F1: the record's steps fold to a line that says where the step stands and its key number,
 * and the step the batch is at opens: step 1 for a batch just planned, the step after the last one written in
 * for a batch under way, none for a batch with its results. What the user opens or closes stays so through
 * the redraws every typed value causes.
 */
export async function benchRecordOpensOnItsStep({ page, open }) {
  const { forms } = await newReference(page, open, 'Steps fold', 1);
  const b = forms[0];
  await open(`formulation?batch=${b}`);
  const opened = () => page.$$eval('#batchForm details[data-step]', (ds) => ds.filter((d) => d.open).map((d) => Number(d.dataset.step)));
  const line = (n) => page.locator(`#step${n} > summary`).innerText();
  // A visit is a fresh render: by way of the list, because a hash that does not change does not navigate.
  const reopen = async () => { await open('formulation'); await open(`formulation?batch=${b}`); };
  if (String(await opened()) !== '1') throw new Error(`a planned batch should open on step 1 alone, opened: ${await opened()}`);
  for (const n of [2, 3, 4, 5, 6]) {
    if (!(await page.locator(`#step${n} > summary`).isVisible())) throw new Error(`step ${n}'s line is not on the screen`);
  }
  if (!/^Step 2 · LNP mixing — not started · pumps 56\.25 \/ 18\.75 \/ 37\.50 mL\/min/.test(await line(2))) throw new Error(`step 2's line: "${await line(2)}"`);
  if (!/^Step 3 · Dialysis — not started · start volume \d+\.\d\d mL/.test(await line(3))) throw new Error(`step 3's line: "${await line(3)}"`);
  if (!/^Step 4 · TFF concentration — skipped/.test(await line(4))) throw new Error(`step 4's line: "${await line(4)}"`);
  if (!/^Step 6 · Fill & finish — not started · \d+ × [\d.]+ mL/.test(await line(6))) throw new Error(`step 6's line: "${await line(6)}"`);
  // what a folded step holds is not read: the pump table is on step 2's line, not under it
  await expectNoText(page, '#main', /Pump 1 RNA \(mL\/min\)|End volume after dialysis/, 'a folded step keeps its table out of the page');
  // the line follows the inputs and agrees with the bench card
  await setInput(page, 'rna_stock_mg_mL', '1.02');
  if (!/— not started · 2\.941 mL stock \+ 4\.559 mL buffer$/.test(await line(1))) throw new Error(`step 1's line: "${await line(1)}"`);
  if (String(await opened()) !== '1') throw new Error(`a redraw changed the open steps: ${await opened()}`);

  // the user's own choice survives the redraws: step 1 folded, step 3 opened and typed in
  await page.click('#step1 > summary'); await page.click('#step3 > summary');
  await setInput(page, 'ds_dialysis_start_mL', '12');
  await setInput(page, 'rna_mass_mg', '2.5');
  if (String(await opened()) !== '3') throw new Error(`after typing, the steps open should be the user's (3), are: ${await opened()}`);
  if (!/start volume 12\.00 mL/.test(await line(3))) throw new Error(`step 3's line does not follow its start volume: "${await line(3)}"`);

  // signing off step 1 closes it: its line says so, and the next step opens below without folding the rest
  await page.click('#step1 > summary');
  await setInput(page, 'a_rna_date', '2026-10-17');
  if (!/^Step 1 · RNA dilution — done/.test(await line(1))) throw new Error(`step 1 signed off: "${await line(1)}"`);
  if (String(await opened()) !== '1,2,3') throw new Error(`step 2 should open once step 1 is done, with 1 and 3 left open: ${await opened()}`);
  await page.evaluate(() => window.lnpDb.flush()); // stored as typed: no Save button to press
  await reopen();
  if (String(await opened()) !== '2') throw new Error(`reopened, the record should be at step 2: ${await opened()}`);

  // a step further on written in means the ones before it were done: the record opens after it
  await page.click('#step3 > summary');
  await setInput(page, 'a_dialysis_end_mL', '13.5');
  await page.evaluate(() => window.lnpDb.flush());
  await reopen();
  if (String(await opened()) !== '5') throw new Error(`with dialysis recorded the record should open on step 5: ${await opened()}`);
  if (!/— not recorded/.test(await line(2)) || !/— done · start volume 12\.00 mL → 13\.5 mL after/.test(await line(3))) {
    throw new Error(`steps 2 and 3 after dialysis was recorded: "${await line(2)}" / "${await line(3)}"`);
  }

  // a batch with its results is not at any step
  await page.selectOption('#statusSel', 'measured'); await page.waitForTimeout(150);
  await reopen();
  if ((await opened()).length) throw new Error(`a measured batch should open no step: ${await opened()}`);
  // and the worksheet still prints every step
  const [sheet] = await Promise.all([page.context().waitForEvent('page', { timeout: 4000 }), page.click('#printBatch')]);
  await sheet.waitForLoadState();
  const printed = await sheet.locator('body').innerText();
  await page.waitForTimeout(400); await sheet.close();
  if (!/Step 1 · RNA dilution[\s\S]*Step 2 · LNP mixing[\s\S]*Step 3 · Dialysis[\s\S]*Step 5 · Final formulation[\s\S]*Step 6 · Fill & finish/.test(printed)) {
    throw new Error(`the worksheet lost a step: "${printed.slice(0, 300)}"`);
  }
}

/**
 * Usability cycle 3, F2: the results grid takes up to three DLS runs per sample, stored as runs with their mean
 * and SD as the manual form stores them, so a result typed into the grid has an SD on the Results card. A run
 * that cannot be a measurement is refused with its run named, and stays in the grid to correct.
 */
export async function gridKeepsDlsRuns({ page, open }) {
  const { id, forms } = await newReference(page, open, 'Grid runs', 1);
  const name = `${forms[0]}_final`;
  await open(`measurements?grid=1&waiting=${id}`);
  await page.waitForSelector('#resultGrid input.gcell', { timeout: 5000 });
  const cell = (key, run) => page.locator(`#resultGrid tr[data-sample="${name}"] input.gcell[data-key=${key}][data-run="${run}"]`);
  if (await cell('zave_nm', 2).isVisible()) throw new Error('the run columns should stay hidden until asked for');
  if (!(await page.locator(`#resultGrid tr[data-sample="${name}"] input.gcell[data-key=zave_nm]`).first().isVisible())) throw new Error('the single Z-ave cell is gone');
  await page.click('#gridRuns');
  if (!(await cell('zave_nm', 3).isVisible())) throw new Error('"+ runs" did not show the run columns');
  const runs = [['81.2', '0.081'], ['83.0', '5'], ['84.1', '0.093']];
  for (const [k, [z, p]] of runs.entries()) { await cell('zave_nm', k + 1).fill(z); await cell('pdi', k + 1).fill(p); }
  const before = (await storedMeasurements(page)).length;
  await page.click('#gridSave'); await page.waitForTimeout(500);
  if ((await storedMeasurements(page)).length !== before) throw new Error('a row with an impossible run was stored');
  await expectText(page, '#gridReport', /Not saved[\s\S]*run 2: PDI 5 is outside 0–1/, 'the refusal names the run');
  if (!(await page.locator('#resultGrid.runsOn').count())) throw new Error('the runs were hidden again by the redraw after saving');
  if (await cell('pdi', 2).inputValue() !== '5' || !(await cell('pdi', 2).getAttribute('class')).includes('invalid')) throw new Error('the refused run is not left marked in the grid');
  if ((await cell('pdi', 1).getAttribute('class')).includes('invalid')) throw new Error('a good run was marked as refused');
  // folding the runs away does not drop what is typed in them, and says so
  await page.click('#gridRuns');
  await expectText(page, '#gridHeld', /hidden runs still hold values for 1 sample/, 'hiding typed runs says they are kept');
  await page.click('#gridRuns');
  await cell('pdi', 2).fill('0.090');
  await page.click('#gridSave'); await page.waitForTimeout(500);
  const m = (await storedMeasurements(page)).find((x) => x.sampleName === name && x.test === 'dls');
  const v = m?.values || {};
  if (v.runs?.length !== 3 || v.runs[1].zave_nm !== 83 || v.runs[2].pdi !== 0.093) throw new Error(`the runs were not stored: ${JSON.stringify(v)}`);
  if (Math.abs(v.zave_nm - 82.7667) > 1e-3 || Math.abs(v.pdi - 0.088) > 1e-9 || Math.abs(v.zave_sd - 1.4640) > 1e-3) throw new Error(`mean and SD of the runs: ${JSON.stringify(v)}`);
  await open(`experiments?id=${id}`);
  await expectText(page, '#resultsCard', /82\.8 ± 1\.5/, 'the Results card shows the runs\' mean ± SD');
  // leave the grid as the other scenarios expect it
  await open('measurements?grid=1');
  if (await page.locator('#resultGrid.runsOn').count()) await page.click('#gridRuns');
}

scenarios.push(benchRecordOpensOnItsStep, gridKeepsDlsRuns);


/**
 * Cycle 3, F3: a printable report for the lab notebook, from the experiment page and from Design & results.
 * It opens in its own window, the print route the worksheet uses, and carries the data table, the statistics
 * in words and the figures inlined as SVG with their colours written in. The experiment is the comparison the
 * GraphPad scenario measured (a reference set if no comparison has results); the design is the demo surface.
 */
export async function reportForTheNotebook({ page, open, errors }) {
  const context = page.context();
  const report = async (button) => {
    const [pop] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }), page.click(button)]);
    pop.on('pageerror', (e) => errors.push(`report window: ${e.message}`));
    await pop.waitForLoadState();
    const out = {
      title: await pop.title(),
      text: await pop.locator('body').innerText(),
      figures: await pop.locator('figure svg').count(),
      // a chart that still reads var(--…) would print in whatever theme the screen happened to be in
      themed: await pop.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => /var\(--/.test(s.outerHTML)).length),
    };
    await page.waitForTimeout(400); await pop.close();
    return out;
  };

  const exp = await page.evaluate(async () => {
    const [ms, exps] = await Promise.all([lnpDb.read('measurements'), lnpDb.read('experiments')]);
    const measured = new Set(ms.map((m) => m.batchId));
    const pick = (t) => exps.filter((e) => e.type === t && /^E\d+$/.test(e.id) && e.batchIds.some((b) => measured.has(b)))
      .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0];
    const e = pick('comparison') || pick('reference');
    return e && { id: e.id, type: e.type };
  });
  if (!exp) throw new Error('the earlier scenarios should have left a comparison or a reference experiment with results');
  await open(`experiments?id=${exp.id}`);
  const r = await report('#reportExp');
  if (!r.title.startsWith(`${exp.id} report`)) throw new Error(`report window title: "${r.title}"`);
  const has = (re, what) => { if (!re.test(r.text)) throw new Error(`the experiment report should carry ${what}: ${re} not in "${r.text.slice(0, 600)}"`); };
  has(new RegExp(`Experiment ${exp.id.slice(1)} \\(${exp.id}\\)`), 'the experiment id');
  has(/Plan\s+[\s\S]*measured for/, 'the plan in a paragraph');
  has(/Data table[\s\S]*mean ± SD[\s\S]*\d ± \d[\s\S]*n = \d/, 'the data table with mean ± SD and n');
  has(exp.type === 'comparison' ? /against #\d+: Z-ave [+−]\d/ : /Batch to batch, over \d+ batches/, 'a statistics sentence from the Results card');
  has(/Figure 1\./, 'numbered figures');
  if (r.figures < 1) throw new Error('the experiment report has no inlined figure');
  if (r.themed) throw new Error(`${r.themed} figure(s) in the report still take their colours from the theme`);
  has(/Date \/ signature operator[\s\S]*Data: \d+ measurements, last result/, 'the signature line and the data footer');

  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  try {
    await open('doe?id=E4&response=particle_size_nm');
    const d = await report('#reportDoe');
    const hasD = (re, what) => { if (!re.test(d.text)) throw new Error(`the DoE report should carry ${what}: ${re} not in "${d.text.slice(0, 600)}"`); };
    hasD(/Recommended setting: the best balance of all responses[\s\S]*Overall score 0\.\d\d/, 'the balanced recommendation');
    hasD(/What drives each response[\s\S]*Size (falls|rises) with/, 'the "what drives" sentences');
    hasD(/Runs and results[\s\S]*R001[\s\S]*R018/, 'the run table');
    hasD(/Model for Size \(nm\)[\s\S]*Intercept[\s\S]*Model for PDI[\s\S]*Model for EE/, 'a coefficient table per response');
    hasD(/Data: 36 measurements, last result/, 'the data footer');
    if (d.figures < 12) throw new Error(`the DoE report should carry four diagnostic plots per response, found ${d.figures}`);
    if (d.themed) throw new Error(`${d.themed} diagnostic plot(s) still take their colours from the theme`);
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
}

scenarios.push(reportForTheNotebook);


// ---- Messy instrument files, Insights leads with its finding (usability cycle 3, recommendation E: F4, F5) ----
/**
 * F4: a Zetasizer export from a German install, as the instrument writes it: UTF-16 LE with a BOM, semicolons,
 * decimal commas, German column names, metadata lines above the header, the size and zeta records of each sample
 * as separate rows, and "Mittelwert"/"Standardabweichung" rows at the end (tests/fixtures/zetasizer_de.csv, with
 * the sample names of a fresh experiment put in). Dropped on the file input, it is read as DLS and zeta, every
 * sample matches, the statistics rows are not samples, and the sizes are stored with their three runs and the
 * date the file gives.
 */
export async function zetasizerGermanUtf16({ page, open }) {
  const exp = await newRepeats(page, open, 'Zetasizer export, German install');
  const names = [...new Set(exp.expected.filter((s) => s.test === 'dls').map((s) => s.sampleName))];
  if (names.length !== 3) throw new Error(`three repeats should be due DLS, ${names.length} are`);
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(new URL('./fixtures/zetasizer_de.csv', import.meta.url));
  if (bytes[0] !== 0xFF || bytes[1] !== 0xFE) throw new Error('the fixture should be UTF-16 LE with a BOM');
  let text = bytes.subarray(2).toString('utf16le');
  names.forEach((n, i) => { text = text.replaceAll(`E1-F${i + 1}_final`, n); });
  const file = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  await open('measurements');
  await page.setInputFiles('#csvFile', { name: 'E1_Freigabe.csv', mimeType: 'text/csv', buffer: file });
  await page.waitForTimeout(400);
  await expectText(page, '#importReadAs', /read as DLS \+ zeta · 18 rows → 3 samples/, 'the German UTF-16 export is read as size and zeta, the statistics rows left out');
  await expectText(page, '#importPreview', /3 matched[\s\S]*0 unmatched/, 'every sample in it matches');
  await expectNoText(page, '#importPreview', /Mittelwert|Standardabweichung|Could not parse/, 'no statistics row and no parse error');
  for (const [i, z] of ['82.8', '91.2', '87.3'].entries()) {
    await expectText(page, `#importPreview tr:has-text("${names[i]}")`, new RegExp(`${reEsc(names[i])}[\\s\\S]*${reEsc(z)}`), `${names[i]}: the size read with its decimal comma`);
  }
  await page.click('#doImport');
  await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
  const ms = (await storedMeasurements(page)).filter((m) => m.raw?.fileName === 'E1_Freigabe.csv');
  const want = { 0: [82.41, 83.07, 82.88], 1: [91.2, 90.85, 91.62], 2: [87.33, 86.9, 87.71] };
  for (const [i, n] of names.entries()) {
    const d = ms.filter((m) => m.sampleName === n && m.test === 'dls');
    if (d.length !== 1) throw new Error(`${n}: ${d.length} DLS results stored, expected one`);
    const runs = d[0].values.runs.map((r) => r.zave_nm);
    if (runs.join() !== want[i].join()) throw new Error(`${n}: runs ${runs.join(', ')}, expected ${want[i].join(', ')} (a zeta record read as a size run?)`);
    if (d[0].date !== '2026-10-27') throw new Error(`${n}: stored with date ${d[0].date}, the file says 27.10.2026`);
    // "Abschwächer" is the one header here outside ASCII: it is read only when the file's bytes are decoded as
    // UTF-16, not when File.text() has read them as UTF-8 (the rest survives that, so it alone tells the two apart)
    if (d[0].values.attenuator !== 7) throw new Error(`${n}: attenuator ${d[0].values.attenuator}, expected 7 from the "Abschwächer" column`);
    if (await slotStatus(page, n, 'dls') !== 'done') throw new Error(`the DLS slot of ${n} is still open`);
    const z = ms.find((m) => m.sampleName === n && m.test === 'zeta');
    if (!(z?.values.zeta_mV < 0)) throw new Error(`${n}: the zeta potential was not stored (${JSON.stringify(z?.values)})`);
  }
}

/**
 * F5: Insights opens on what it found. On the demo lab, coloured by experiment: the card sits above the filters,
 * says whether experiments can be compared at all (each demo experiment runs its own settings, so they cannot:
 * cycle 6, I1), whether the latest batches on the chart drift, and how many points sit outside the limits; the
 * chart says which batches it holds and can be widened to every batch. Short of batches or of a grouping, it
 * says so. The chart, the tables and the filters are all still there.
 */
export async function insightsSummaryLeads({ page, open }) {
  const y = (sel) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  try {
    await open('insights?colorBy=experimentId');
    await expectText(page, '#insightSummary', /What this shows/, 'the summary card');
    if (!((await y('#insightSummary')) < (await y('#filters')))) throw new Error('the summary should sit above the filters');
    const items = await page.$$eval('#insightSummary li', (li) => li.map((x) => x.textContent.trim()));
    if (items.length < 1 || items.length > 3) throw new Error(`one to three sentences, found ${items.length}`);
    if (!/^No two of the \d+ experiments have batches made at the same settings, so a difference between them cannot be told apart from what their settings do\.$/.test(items[0])) throw new Error(`the group sentence: "${items[0]}"`);
    if (!/^(No drift: the latest 5 batches on the chart are within [\d.]+ nm of the \d+ before them|The latest 5 batches on the chart drift (up|down): .*|Not enough batches on the chart to say whether the latest drift: \d+ so far, and it takes 8)\.$/.test(items[1])) throw new Error(`the drift sentence: "${items[1]}"`);
    if (!/^(\d+ of \d+ points on the chart sits? outside the control limits \([\d.]+–[\d.]+ nm\).*|All \d+ points on the chart sit inside the control limits .*)\.$/.test(items[2])) throw new Error(`the control-limit sentence: "${items[2]}"`);
    // the chart holds the reference set's setting and says so; the table under it counts the same batches
    await expectText(page, '#chartNote', /^\d+ batches made at the setting of the reference experiments: #1 · FRR 3 · flow 112\.5 mL\/min[\s\S]*?\. The other \d+ in view were made at other settings and are left off/, 'the chart says what it holds');
    const onChart = Number(/^(\d+) batches/.exec(await page.locator('#chartNote').innerText())[1]);
    const table = await page.$$eval('#main .card:has(h2:text-is("By experimentId")) tbody tr', (tr) => tr.map((r) => Number(r.cells[1].textContent)));
    if (table.reduce((a, b) => a + b, 0) !== onChart) throw new Error(`the table counts ${table.join('+')} batches, the chart ${onChart}`);
    await expectText(page, '#main', /Control chart[\s\S]*By experimentId[\s\S]*Correlation with[\s\S]*Formulations in this view/, 'the chart and the tables are kept');
    // widened, it holds every batch and says what that does to the limits
    await page.selectOption('select[name=chart]', 'all');
    await page.waitForTimeout(400);
    await expectText(page, '#chartNote', /^Every batch in view \(\d+\), whatever its settings\. Designed experiments change the settings on purpose/, 'every batch, with the warning');
    if (!/chart=all/.test(await page.evaluate(() => location.hash))) throw new Error('the choice travels in the address');
    // the demo records no stock lots, and has three zeta results: said, not compared
    await open('insights');
    await expectText(page, '#insightSummary', /No batch in this view has a stock lot recorded/, 'no grouping recorded');
    await open('insights?response=zeta_mV');
    await expectText(page, '#insightSummary', /Not enough batches on the chart to say whether the latest drift: 3 so far, and it takes 8/, 'too few for a drift');
    await open('insights?comp=999');
    await expectText(page, '#insightSummary', /Not enough batches to say yet: none with a size result in this view/, 'nothing in the view');
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
}

scenarios.push(zetasizerGermanUtf16, insightsSummaryLeads);

// ---- Numbers and backups (usability cycle 4, recommendation D: m1, m2) ----
scenarios.push(backupReminderOnOverview);

/**
 * m2: the overview asks for a backup when the last export is a week old and records have changed since.
 * "Export now" downloads the same file as Settings, and the line goes; "Remind me tomorrow" puts it away for
 * the day; demo mode never shows it. The export time is put back afterwards. (The export time and the snooze
 * are this browser's preferences, not data collections, so they are set where the app keeps them.)
 */
export async function backupReminderOnOverview({ page, open }) {
  const { readFile } = await import('node:fs/promises');
  const pref = (k, v) => page.evaluate(([key, val]) => { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, val); }, [k, v]);
  const prefOf = (k) => page.evaluate((key) => localStorage.getItem(key), k);
  const overview = async () => { await open('settings'); await open('overview'); }; // a change of hash redraws it
  const shown = () => page.locator('#backupDue').count();
  const kept = await prefOf('lnp-lab.lastExportAt');
  const now = await page.evaluate(() => Date.now()); // the smoke clock is fixed
  const tenDaysAgo = new Date(now - 10 * 864e5).toISOString();
  try {
    // Settings' own export button writes the time the reminder counts from (an earlier scenario pressed it).
    if (!kept || Math.abs(Date.parse(kept) - now) > 60e3) throw new Error(`Settings' export should have recorded its time: ${kept}`);
    const experiments = await readCol(page, 'experiments');
    if (!experiments.length) throw new Error('the scenarios before this one should have left records to back up');
    await overview();
    if (await shown()) throw new Error('a backup made today should keep the reminder away');

    await pref('lnp-lab.lastExportAt', tenDaysAgo);
    await pref('lnp-lab.snooze.backup', null);
    await overview();
    await expectText(page, '#backupDue', /No backup for 10 days \(last \d\d \w{3} 2026\), and records have changed since\. Everything is stored in this browser only\./, 'the overview asks for a backup');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#exportNow')]);
    if (!/^lnp-lab-export-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename())) throw new Error(`export file name: ${dl.suggestedFilename()}`);
    const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
    if ((data.collections?.experiments || []).length !== experiments.length) throw new Error(`the export holds ${(data.collections?.experiments || []).length} experiments, the store ${experiments.length}`);
    // m1: the id counters travel with the backup, at least as high as every experiment number in it.
    const top = (data.collections.counters || []).find((c) => c.id === 'experiment')?.top || 0;
    const highest = Math.max(...experiments.map((e) => Number(/^E(\d+)$/.exec(e.id)?.[1]) || 0));
    if (!(top >= highest)) throw new Error(`the backup's experiment counter is ${top}, below E${highest}`);
    await page.waitForTimeout(150);
    if (await shown()) throw new Error('the reminder stayed up after "Export now"');
    await expectText(page, '#toast', /Exported/, 'the export is confirmed');
    const at = await prefOf('lnp-lab.lastExportAt');
    if (Math.abs(Date.parse(at) - now) > 60e3) throw new Error(`"Export now" should record the time of the export: ${at}`);
    await open('settings');
    await expectNoText(page, '#main', /Last export: never/, 'Settings shows the export made from the overview');

    await pref('lnp-lab.lastExportAt', tenDaysAgo);
    await overview();
    if (!(await shown())) throw new Error('the reminder should be back with an old export');
    await page.click('#snoozeBackup');
    await page.waitForTimeout(150);
    if (await shown()) throw new Error('"Remind me tomorrow" left the line up');
    await overview();
    if (await shown()) throw new Error('the snooze did not outlast a redraw');

    // The demo lab has records and, with its export time taken away, no backup on record; it still never asks.
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    try {
      if (!(await readCol(page, 'experiments', 'lnp-demo')).length) throw new Error('the demo lab should have records');
      await pref('lnp-demo.lastExportAt', null);
      await pref('lnp-demo.snooze.backup', null);
      await overview();
      await expectText(page, '#main', /Needs attention/i, 'the overview is drawn');
      if (await shown()) throw new Error('demo mode asked for a backup');
    } finally {
      await open('overview');
      await page.click('#demoToggle');
      await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
      await page.waitForTimeout(500);
    }
  } finally {
    await pref('lnp-lab.lastExportAt', kept);
    await pref('lnp-lab.snooze.backup', null);
  }
}


/**
 * Cycle 4, S2: with hundreds of experiments the Formulations list draws its groups a page at a time and a
 * folded group as its header only. Selecting and "Mark selected produced" must still act on exactly what is
 * shown: "Select all" on the listed groups and not on the pages behind "Show more", a group's select-all on
 * its rows whether or not they are drawn, and a row ticked on a later page like any other.
 */
export async function formulationListPages({ page, open }) {
  const before = { experiments: await readCol(page, 'experiments'), batches: await readCol(page, 'batches') };
  const prefs = await page.evaluate(() => localStorage.getItem('lnp-lab.ui.formulations'));
  const iso = (d) => new Date(Date.UTC(2026, 9, 1) - d * 864e5).toISOString().slice(0, 10);
  const exps = [], forms = [];
  // 50 experiments still to make (newest first in the list) and 30 finished ones, five formulations each.
  for (let i = 0; i < 80; i++) {
    const id = `E${800 + i}`, todo = i < 50, ids = [];
    for (let f = 1; f <= 5; f++) {
      ids.push(`${id}-F${f}`);
      forms.push({ id: `${id}-F${f}`, experimentId: id, label: `F${f}`, compositionId: 1, status: todo ? 'planned' : 'measured', plannedDate: iso(i),
        plan: { rna: { mass_mg: 3, working_mg_mL: 0.4 }, mixing: { frr: 3, totalFlow: 112.5, quenchFactor: 2 }, factors: {} }, actual: {} });
    }
    exps.push({ id, type: 'comparison', name: `Paging run ${i + 1}`, startDate: iso(i), compositionId: 1, status: 'running', spec: {}, design: {}, batchIds: ids, expected: [] });
  }
  const statusOf = async (ids) => { const all = await readCol(page, 'batches'); return ids.map((x) => all.find((b) => b.id === x)?.status); };
  try {
    await writeCol(page, 'experiments', [...before.experiments, ...exps]);
    await writeCol(page, 'batches', [...before.batches, ...forms]);
    await page.evaluate(() => localStorage.removeItem('lnp-lab.ui.formulations'));
    await page.reload(); await page.waitForTimeout(400);
    await open('formulation');
    const total = before.batches.length + forms.length;
    await expectText(page, '#formShown', new RegExp(`^${total} formulations$`), 'every formulation is counted, listed or not');

    // "Still to make": the first 40 groups are listed, open, and the rest wait behind "Show more"
    await page.click('#formShow [data-show=todo]');
    const plannedTotal = [...before.batches, ...forms].filter((b) => b.status === 'planned').length;
    await expectText(page, '#formShown', new RegExp(`^${plannedTotal} of ${total} shown$`), 'the filter counts every page');
    if ((await page.locator('[data-group]').count()) !== 40) throw new Error(`expected 40 groups on the first page, found ${await page.locator('[data-group]').count()}`);
    await expectText(page, '.pager', /^40 of \d+ experiments listed\s*Show \d+ more$/, 'the list says how much it is showing');
    if (await page.locator('[data-group="E800"] tr[data-row]').count() !== 5) throw new Error('an open group on the first page draws its rows');
    if (await page.locator('[data-group="E849"]').count()) throw new Error('the 50th experiment should wait for "Show more"');

    // select all takes the listed groups only, never the pages behind "Show more"
    await page.check('#selAllForms');
    const drawn = await page.locator('input[data-sel]').count();
    await expectText(page, '#selCount', new RegExp(`^${drawn} selected$`), 'select all ticks the listed rows');
    if (drawn >= plannedTotal) throw new Error(`select all ticked ${drawn}, which should be fewer than the ${plannedTotal} planned`);
    await page.uncheck('#selAllForms');

    // the next page: the later groups are listed, and a row ticked there is marked like any other
    await page.click('#formMore');
    if (!(await page.locator('[data-group="E849"] tr[data-row]').count())) throw new Error('"Show more" did not list the later groups');
    await page.check('input[data-sel="E800-F1"]'); await page.check('input[data-sel="E849-F5"]');
    await expectText(page, '#selCount', /^2 selected$/, 'a row on the first page and one on the next');
    await page.click('#markSelectedProduced'); await page.waitForTimeout(250);
    let st = await statusOf(['E800-F1', 'E849-F5', 'E800-F2', 'E849-F4']);
    if (st.join() !== 'produced,produced,planned,planned') throw new Error(`Mark selected produced across pages: ${st.join(', ')}`);

    // a group folded by hand draws no rows, and its select-all still takes all of them
    await page.click('#formShow [data-show=all]');
    await page.click('[data-group="E801"] .fgToggle');
    if (await page.locator('[data-group="E801"] tr[data-row]').count()) throw new Error('a folded group should draw no rows');
    await page.check('input[data-selall="E801"]');
    await expectText(page, '#selCount', /^5 selected$/, 'a folded group\'s select-all takes its rows');
    await page.click('#markSelectedProduced'); await page.waitForTimeout(250);
    st = await statusOf(['E801-F1', 'E801-F2', 'E801-F3', 'E801-F4', 'E801-F5', 'E802-F1']);
    if (st.join() !== 'produced,produced,produced,produced,produced,planned') throw new Error(`a folded group's select-all marked ${st.join(', ')}`);

    // a finished group on a later page is folded until opened; opening it draws its five rows
    for (let guard = 0; guard < 5 && !(await page.locator('[data-group="E879"]').count()); guard++) await page.click('#formMore');
    if (await page.locator('[data-group="E879"] .fgBody').isVisible()) throw new Error('a finished group should start folded');
    await expectText(page, '[data-group="E879"] .fgCounts', /5 measured/, 'and its header still counts its formulations');
    await page.click('[data-group="E879"] .fgToggle');
    if (await page.locator('[data-group="E879"] tr[data-row]').count() !== 5) throw new Error('opening a folded group draws its rows');

    // the text filter looks past the first page: a formulation of the last experiment is found at once
    await open('overview'); await open('formulation');
    await page.fill('#formFilter', 'E879-F3');
    const shown = await page.$$eval('tr[data-row]', (trs) => trs.map((t) => t.dataset.row));
    if (shown.join() !== 'E879-F3') throw new Error(`filtering by an id on the last page shows ${shown.join(', ') || 'nothing'}`);
  } finally {
    await writeCol(page, 'experiments', before.experiments);
    await writeCol(page, 'batches', before.batches);
    await page.evaluate((p) => { if (p == null) localStorage.removeItem('lnp-lab.ui.formulations'); else localStorage.setItem('lnp-lab.ui.formulations', p); }, prefs);
    await page.reload(); await page.waitForTimeout(400);
  }
}

scenarios.push(formulationListPages);


// ---- Measurements leads with what is due (usability cycle 4, recommendation C: M1) ----

/** The browser's calendar date (the smoke run's clock is fixed), and a date n days from it. */
const pageToday = (page) => page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
const plusDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The Due card: one experiment alone in the store, with a timepoint overdue, one due today, one in two days and
 * one in twenty. The first three are lines under Overdue, Today and Coming, each with its own Copy, blank sheet
 * and grid acting on its own samples; the fourth is not shown until nothing nearer is left, and then the card
 * says when it is. The store is put back afterwards.
 */
export async function measurementsDueLeads({ page, open }) {
  const kept = { experiments: await readCol(page, 'experiments'), measurements: await readCol(page, 'measurements') };
  const today = await pageToday(page);
  const sample = (f, stage) => `E970-F${f}_4C_T${stage.slice(1).padStart(2, '0')}`;
  const slot = (f, stage, days, test) => ({ id: `E970-F${f}_${stage}_${test}_4C`, batchId: `E970-F${f}`, stage, test, dueDate: plusDays(today, days), status: 'open', measurementId: null,
    sampleName: sample(f, stage), condition: '4C', timepoint: Number(stage.slice(1)) });
  const plan = [['T7', -3, ['dls', 'ee']], ['T10', 0, ['dls']], ['T12', 2, ['dls', 'ee']], ['T30', 20, ['dls', 'ee']]];
  const exp = { id: 'E970', type: 'stability', name: 'Due check', startDate: plusDays(today, -10), status: 'planned', spec: {}, design: {}, batchIds: ['E970-F1', 'E970-F2'],
    expected: plan.flatMap(([stage, days, tests]) => [1, 2].flatMap((f) => tests.map((t) => slot(f, stage, days, t)))) };
  const names = (stage) => [1, 2].map((f) => sample(f, stage));
  const line = (group) => page.locator(`#dueCard .dueGroup.${group} .dueLine`, { hasText: 'E970' });
  try {
    await writeCol(page, 'experiments', [exp]);
    await open('overview');
    await open('measurements');
    if (await page.$eval('#main > .card', (c) => c.id) !== 'dueCard') throw new Error('the Due card is not the first card on Measurements');
    await expectText(page, '#dueCard .dueGroup.overdue', /Overdue[\s\S]*E970 · Due check — T7, 2 samples \(DLS, EE\) — 3 days overdue/i, 'the overdue timepoint, one line for the experiment and stage');
    await expectText(page, '#dueCard .dueGroup.today', /E970 · Due check — T10, 2 samples \(DLS\) — due today/, 'the one due today');
    await expectText(page, '#dueCard .dueGroup.coming', /Coming · next 7 days[\s\S]*E970 · Due check — T12, 2 samples \(DLS, EE\) — due \w{3} \d{1,2} \w{3}/i, 'the one in two days, with its weekday');
    await expectNoText(page, '#dueCard', /T30/, 'and not the one three weeks out');

    // the sample names wait behind the count, and Copy puts exactly that line's names on the clipboard
    if (await line('overdue').locator('[data-due-list]').isVisible()) throw new Error('the names of a due line should be folded');
    await line('overdue').locator('button.dueN').click();
    await expectText(page, '#dueCard .dueGroup.overdue [data-due-list]', new RegExp(names('T7').map(reEsc).join('\\s+')), 'the count opens the names');
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t) => { window.__copied = t; } }); });
    await line('overdue').locator('[data-due-copy]').click();
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => window.__copied);
    if (copied !== names('T7').join('\n')) throw new Error(`Copy names on the T7 line copied ${JSON.stringify(copied)}`);

    // the blank sheet of the line due today: its two samples, with the size columns only
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), line('today').locator('[data-due-sheet]').click()]);
    const { readFileSync } = await import('node:fs');
    const sheet = readFileSync(await dl.path(), 'utf8').trim().split(/\r?\n/);
    if (sheet[0] !== 'Sample Name,Z-Average (d.nm),PdI' || sheet.slice(1).map((l) => l.split(',')[0]).join() !== names('T10').join()) throw new Error(`the T10 sheet: ${sheet.join(' | ')}`);
    if (dl.suggestedFilename() !== 'E970_T10_samples.csv') throw new Error(`the sheet is named ${dl.suggestedFilename()}`);

    // the grid of the coming line holds that line's samples only, and saves into their slots
    await line('coming').locator('[data-due-grid]').click();
    await page.waitForSelector('#resultGrid input.gcell', { timeout: 5000 });
    const hash = await page.evaluate(() => location.hash);
    if (!/waiting=E970/.test(hash) || !/stage=T12/.test(hash) || !/due=coming/.test(hash) || !/grid=1/.test(hash)) throw new Error(`the line's grid opened ${hash}`);
    const rows = await page.$$eval('#resultGrid tbody tr', (tr) => tr.map((r) => r.dataset.sample));
    if (rows.join() !== names('T12').join()) throw new Error(`the T12 grid has rows ${rows.join(', ')}`);
    if (await page.inputValue('#waitExp') !== 'E970') throw new Error('the bar does not show the experiment the grid is for');
    await expectText(page, '#dueCard .waitScope', /T12 · next 7 days/, 'and says it is narrowed to the line');
    const row = `#resultGrid tr[data-sample="${names('T12')[0]}"]`;
    await page.fill(`${row} input.gcell[data-key=zave_nm][data-run="1"]`, '81.5');
    await page.fill(`${row} input.gcell[data-key=pdi][data-run="1"]`, '0.09');
    await page.fill(`${row} input.gcell[data-key=ee_pct]`, '93');
    await page.click('#gridSave');
    await page.waitForTimeout(500);
    const saved = (await readCol(page, 'measurements')).filter((m) => m.experimentId === 'E970');
    if (saved.length !== 2 || !saved.every((m) => m.sampleName === names('T12')[0] && m.stage === 'T12')) throw new Error(`the grid stored ${JSON.stringify(saved.map((m) => [m.sampleName, m.test]))}`);
    const left = await page.$$eval('#resultGrid tbody tr', (tr) => tr.map((r) => r.dataset.sample));
    if (left.join() !== names('T12')[1]) throw new Error(`after saving one sample the grid shows ${left.join(', ')}`);
    await page.click('#gridClose');
    await page.waitForFunction(() => !/grid=|stage=|due=/.test(location.hash), null, { timeout: 3000 })
      .catch(async () => { throw new Error(`closing the grid left ${await page.evaluate(() => location.hash)}`); });
    await page.waitForTimeout(200);
    if (await page.locator('#dueCard .waitScope').count()) throw new Error('the narrowing outlived the grid');

    // nothing within the week: one line saying so, and when the next thing is
    const later = await readCol(page, 'experiments');
    for (const s of later[0].expected) if (s.stage !== 'T30') s.status = 'done';
    await writeCol(page, 'experiments', later);
    await open('overview');
    await open('measurements');
    await expectText(page, '#dueCard', /Nothing is due in the next 7 days\. Next: E970 · Due check — T30, 2 samples, due \w{3} \d{1,2} \w{3} \(in 20 days\)\./, 'nothing due, and the next thing');
    for (const s of later[0].expected) s.status = 'done';
    await writeCol(page, 'experiments', later);
    await open('overview');
    await open('measurements');
    await expectText(page, '#dueCard', /Nothing is waiting for results/, 'and nothing open at all');
  } finally {
    await writeCol(page, 'experiments', kept.experiments);
    await writeCol(page, 'measurements', kept.measurements);
    await open('overview');
  }
}

/**
 * The results list: 50 to a page, newest first, filtered by experiment, test, sample name and QC flag. The
 * filters are in the address, so a reload keeps them, and the screen opened again from elsewhere starts
 * unfiltered. 120 results are added for it and taken out again.
 */
export async function measurementsResultsFilterAndPage({ page, open }) {
  const kept = await readCol(page, 'measurements');
  const seeded = [];
  for (let k = 1; k <= 60; k++) {
    seeded.push({ id: `c4c-d${k}`, batchId: `E971-F${k}`, experimentId: 'E971', test: 'dls', stage: 'final', sampleName: `E971-F${k}_final`, date: '2026-01-15',
      values: { zave_nm: 80 + (k % 10), pdi: k % 10 === 0 ? 0.31 : 0.1 }, flags: k % 10 === 0 ? [{ level: 'warn', text: 'PDI 0.31 > 0.2' }] : [] });
    seeded.push({ id: `c4c-e${k}`, batchId: `E972-F${k}`, experimentId: 'E972', test: 'ee', stage: 'final', sampleName: `E972-F${k}_final`, date: '2026-01-14', values: { ee_pct: 90 }, flags: [] });
  }
  const total = kept.length + seeded.length;
  const rows = () => page.locator('#resultsList tbody tr:has(a)').count();
  const sampleCol = () => page.$$eval('#resultsList tbody tr td:nth-child(2)', (td) => td.map((x) => x.textContent.trim()));
  try {
    await writeCol(page, 'measurements', [...kept, ...seeded]);
    await open('overview');
    await open('measurements');
    await openFolds(page); // the list is one line until opened
    if (await rows() !== 50) throw new Error(`the first page shows ${await rows()} results, expected 50`);
    await expectText(page, '#resultsList .resPager', new RegExp(`1–50 of ${total}\\b`), 'and says where it is in the list');
    await page.click('#resNext');
    await expectText(page, '#resultsList .resPager', new RegExp(`51–100 of ${total}\\b`), 'Older moves on a page');
    if (!/rpage=2/.test(await page.evaluate(() => location.hash))) throw new Error('the page is not in the address');

    await page.selectOption('#resExp', 'E971');
    await expectText(page, '#resultsList .resPager', new RegExp(`1–50 of 60 \\(${total} in all\\)`), 'a filter starts again at the first page');
    if ((await sampleCol()).some((n) => !n.startsWith('E971-'))) throw new Error('the experiment filter lets other experiments through');
    await page.click('#resNext');
    if (await rows() !== 10) throw new Error(`the second page of E971 shows ${await rows()} rows, expected 10`);
    await page.selectOption('#resTest', 'ee');
    await expectText(page, '#resultsList', /No result matches these filters/, 'E971 has no EE, and the list says so');
    await page.selectOption('#resExp', '');
    const tests = await page.$$eval('#resultsList tbody tr td:nth-child(4)', (td) => td.map((x) => x.textContent.trim()));
    if (!tests.length || tests.some((t) => t !== 'ee')) throw new Error(`the test filter shows ${[...new Set(tests)].join(', ')}`);
    await page.selectOption('#resTest', '');
    await page.selectOption('#resExp', 'E971');
    await page.check('#resFlag');
    if (await rows() !== 6) throw new Error(`E971 flagged only: ${await rows()} rows, expected 6`);

    // the address carries the filters through a reload
    await page.reload();
    await page.waitForFunction(() => window.__lnpStarted && document.querySelector('#resultsList'), null, { timeout: 15000 });
    if (await page.inputValue('#resExp') !== 'E971' || !(await page.isChecked('#resFlag')) || await rows() !== 6) throw new Error('a reload lost the filters');

    // a sample name typed loosely, filtering as it is typed without taking the cursor out of the box
    await page.selectOption('#resExp', '');
    await page.uncheck('#resFlag');
    await page.click('#resQ');
    await page.keyboard.type('e972 f7');
    if (await page.evaluate(() => document.activeElement?.id) !== 'resQ') throw new Error('typing a filter took the cursor out of the box');
    const found = await sampleCol();
    if (found.join() !== 'E972-F7_final') throw new Error(`"e972 f7" found ${found.join(', ')}`);

    // coming back from elsewhere: no filter, the first page
    await open('overview');
    await open('measurements');
    if (await page.inputValue('#resExp') !== '' || await page.inputValue('#resQ') !== '' || await rows() !== 50) throw new Error('the list opened again from the sidebar is still filtered');
  } finally {
    await writeCol(page, 'measurements', kept);
    await open('overview');
  }
}

/**
 * The import card and the manual form are one line each until used. Choosing the sample on the manual line
 * opens the form filled in for it; ?batch= and ?slot= open it from the start.
 */
export async function measurementsFoldedCards({ page, open }) {
  await open('overview');
  await open('measurements');
  const height = await page.locator('#importCard').evaluate((n) => n.getBoundingClientRect().height);
  if (height > 90) throw new Error(`the import card is ${Math.round(height)} px tall before anything is dropped in`);
  if (await page.locator('#pasteBox').isVisible()) throw new Error('the paste box shows before it is asked for');
  if (await page.locator('#importDate').count()) throw new Error('the import date shows before there is anything to import');
  if (!(await page.locator('select[name=slotId]').isVisible())) throw new Error('the manual line has no choice of sample');
  if (await page.locator('#saveManual').isVisible()) throw new Error('the manual form is open before it is used');

  const opt = page.locator('select[name=slotId] option:not([value=""])').first();
  const [value, text] = [await opt.getAttribute('value'), await opt.innerText()];
  await page.selectOption('select[name=slotId]', value);
  if (!(await page.locator('#saveManual').isVisible())) throw new Error('choosing a sample did not open the form');
  if (await page.inputValue('select[name=test]') !== text.split(' · ')[1]) throw new Error(`the form opened for test ${await page.inputValue('select[name=test]')}, the sample chosen was "${text}"`);

  await open('overview');
  await open('measurements');
  await page.click('#manualFree');
  if (!(await page.locator('select[name=batchId]').isVisible())) throw new Error('Free entry did not open the form');

  const batch = (await readCol(page, 'batches'))[0]?.id;
  await open(`measurements?batch=${encodeURIComponent(batch)}`);
  if (!(await page.locator('#saveManual').isVisible()) || await page.inputValue('select[name=batchId]') !== batch) throw new Error('?batch= did not open the form on its formulation');

  const s = (await readCol(page, 'experiments')).flatMap((e) => e.expected || []).find((x) => x.status === 'open' && x.test === 'ee');
  if (!s) throw new Error('no open EE measurement left to open the form on');
  await open(`measurements?slot=${encodeURIComponent(s.id)}`);
  if (!(await page.locator('#saveManual').isVisible())) throw new Error('?slot= did not open the form');
  if (await page.inputValue('select[name=slotId]') !== s.id || await page.inputValue('select[name=test]') !== 'ee' || await page.inputValue('input[name=stage]') !== s.stage) throw new Error('?slot= opened the form without its test and stage');
  await open('overview');
}

scenarios.push(measurementsDueLeads, measurementsResultsFilterAndPage, measurementsFoldedCards);


/**
 * Usability cycle 4, S1: storage that lasts. (1) A browser that ran an earlier version holds the lab in
 * localStorage; the first start moves it into IndexedDB, removes the old keys only once it is stored there,
 * and leaves the preferences where they are. (2) A save that cannot be stored (the backend made to fail as a
 * full disk would) is said in plain words on a note that stays, and nothing of it is half-written: not the
 * result without its slot, not the formulations without their experiment.
 */
export async function storageMovesAndFailsPlainly({ page, open, base, errors }) {
  // ---- 1 · the move, in a browser profile of its own: the lab as an earlier version left it
  const lab = {};
  for (const col of ['experiments', 'batches', 'measurements', 'stocks']) lab[col] = await readCol(page, col);
  const exp = lab.experiments.filter((e) => /^E\d+$/.test(e.id) && lab.measurements.some((m) => m.experimentId === e.id)).at(-1);
  if (!exp) throw new Error('the earlier scenarios should have left an experiment with results');
  const ctx2 = await page.context().browser().newContext({ timezoneId: 'Europe/Berlin' });
  try {
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errors.push(`storage move: pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`storage move: console: ${m.text()}`); });
    // A file on the same origin, so localStorage can be filled before the app has ever run there.
    await p2.goto(base + 'app/data/lipids.json');
    await p2.evaluate((lab) => {
      for (const [col, rows] of Object.entries(lab)) localStorage.setItem(`lnp-lab.${col}`, JSON.stringify(rows));
      localStorage.setItem('lnp-lab.theme', 'dark');
      localStorage.setItem('lnp-lab.schemaVersion', '2');
      localStorage.setItem('lnp-lab.ui.formulations', '{"filter":"all"}');
    }, lab);
    const start = async () => p2.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await p2.goto(`${base}#/experiments?id=${exp.id}`); await start();
    const h1 = await p2.locator('#main h1').first().innerText();
    if (!h1.includes(exp.name)) throw new Error(`after the move, ${exp.id} opens on "${h1}" instead of "${exp.name}"`);
    const after = await p2.evaluate(async () => ({
      engine: window.lnpDb.engine(),
      keys: Object.keys(localStorage).filter((k) => k.startsWith('lnp-lab.')).sort(),
      dbs: (await indexedDB.databases()).map((d) => d.name),
      counts: Object.fromEntries(await Promise.all(['experiments', 'batches', 'measurements', 'stocks'].map(async (c) => [c, (await window.lnpDb.read(c)).length]))),
    }));
    if (after.engine !== 'indexeddb' || !after.dbs.includes('lnp-lab')) throw new Error(`the records are not in IndexedDB: ${JSON.stringify(after)}`);
    for (const col of Object.keys(lab)) {
      if (after.keys.includes(`lnp-lab.${col}`)) throw new Error(`lnp-lab.${col} is still in localStorage after the move`);
      if (after.counts[col] !== lab[col].length) throw new Error(`${col}: ${lab[col].length} before the move, ${after.counts[col]} after`);
    }
    for (const k of ['lnp-lab.theme', 'lnp-lab.schemaVersion', 'lnp-lab.ui.formulations']) if (!after.keys.includes(k)) throw new Error(`the preference ${k} went with the data`);
    if ((await p2.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('the theme was not kept across the move');
    // and it is really stored there: a restart reads it back from IndexedDB alone
    await p2.reload(); await start();
    const back = await p2.evaluate(async () => (await window.lnpDb.read('measurements')).length);
    if (back !== lab.measurements.length) throw new Error(`after a restart ${back} measurements, expected ${lab.measurements.length}`);
  } finally { await ctx2.close(); }

  // ---- 2 · a save that cannot be stored
  await open('measurements');
  const opt = await page.locator('select[name=slotId] option', { hasText: ' · ee' }).first().getAttribute('value');
  if (!opt) throw new Error('no EE measurement is waiting');
  const slotOf = async () => {
    for (const e of await readCol(page, 'experiments')) { const s = (e.expected || []).find((x) => x.id === opt); if (s) return { ...s, experimentId: e.id }; }
    return null;
  };
  const slot = await slotOf();
  const before = { measurements: await stored(page, 'measurements'), batches: await stored(page, 'batches'), experiments: await stored(page, 'experiments') };
  const noteText = () => page.locator('#storageNote').innerText();
  await page.evaluate(() => window.lnpDb.failWrites('QuotaExceededError'));
  try {
    await page.selectOption('select[name=slotId]', opt);
    await page.fill('input[name=v_ee_pct]', '91.5');
    await page.click('#saveManual');
    await page.waitForSelector('#storageNote', { timeout: 3000 }).catch(() => { throw new Error('no note when the result could not be stored'); });
    const note = await noteText();
    if (!/^Not saved: this browser's storage is full\. The result for \S+ was undone, so nothing is half-saved\. Export a backup under Settings, then free space/.test(note)) throw new Error(`the note: "${note}"`);
    await expectNoText(page, '#toast', /Error:|Uncaught|QuotaExceeded|setItem/, 'no raw exception reaches the user');
    // Nothing half-written: the result, its slot and the formulation's status are all as they were.
    for (const col of ['measurements', 'batches', 'experiments']) {
      if ((await stored(page, col)) !== before[col]) throw new Error(`a result that could not be stored changed ${col}`);
    }
    if ((await slotOf()).status !== 'open') throw new Error('the slot reads as done for a result that was not stored');

    // A new experiment: formulations and experiment go together or not at all.
    await open('experiments?new=1&type=single');
    await page.fill('input[name=name]', 'Will not fit');
    await page.selectOption('select[name=compositionId]', '1');
    await page.waitForTimeout(150);
    await page.click('#createExp');
    await page.waitForTimeout(500);
    if (!/The new Experiment \d+ was undone, so nothing is half-saved/.test(await noteText())) throw new Error(`the note after creating: "${await noteText()}"`);
    if ((await readCol(page, 'experiments')).some((e) => e.name === 'Will not fit')) throw new Error('the experiment is on record although it was not stored');
    if ((await stored(page, 'batches')) !== before.batches) throw new Error('formulations were stored without their experiment');
    await expectNoText(page, '#main', /Will not fit/, 'the screen does not go on showing what was not stored');
  } finally {
    await page.evaluate(() => window.lnpDb.failWrites(null));
  }
  // Room again: the next write gets through and the note goes. Both changes were undone, so nothing is waiting
  // to be written, and nothing written is not a write that got through: the settings are written back as they are.
  await writeCol(page, 'settings', await readCol(page, 'settings')).catch(() => { throw new Error('writing again after the failure did not work'); });
  if (await page.locator('#storageNote').count()) throw new Error('the note stays after storage works again');
  await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  if ((await stored(page, 'measurements')) !== before.measurements) throw new Error('after a restart the stored results differ');
  if ((await slotOf()).status !== slot.status) throw new Error('after a restart the slot changed');
}

scenarios.push(storageMovesAndFailsPlainly);

/**
 * Step 5's own fields are stored. Their inputs are named ds_final_…, the record's field is finalFormulation, and
 * until the crawler of usability cycle 5 typed into them every keystroke threw ("Cannot set properties of
 * undefined") and nothing was kept: the measured RNA concentration, the final target and both dilution buffers.
 */
export async function finalFormulationFieldsStored({ page, open }) {
  const errs = [];
  const onErr = (e) => errs.push(e.message);
  page.on('pageerror', onErr);
  try {
    const { forms } = await newReference(page, open, 'Step 5 stores', 1);
    const b = forms[0];
    await open(`formulation?batch=${b}`);
    if (!(await page.locator('#step5').evaluate((d) => d.open))) await page.click('#step5 > summary');
    await setInput(page, 'ds_final_measured_mg_mL', '0.42');
    await setInput(page, 'ds_final_final_mg_mL', '0.1');
    const buffers = await page.$$eval('select[name=ds_final_buffer1] option', (os) => os.map((o) => o.value).filter(Boolean));
    if (buffers.length) await setInput(page, 'ds_final_buffer1', buffers[0]);
    await page.waitForTimeout(300);
    if (errs.length) throw new Error(`typing into step 5 threw: ${errs[0]}`);
    await page.evaluate(() => window.lnpDb.flush()); // stored as typed: no Save button to press
    const ff = (await readCol(page, 'batches')).find((x) => x.id === b)?.plan?.downstream?.finalFormulation;
    if (!ff) throw new Error('no finalFormulation on the stored record');
    if (Number(ff.measured_mg_mL) !== 0.42) throw new Error(`measured RNA conc. stored as ${ff.measured_mg_mL}, typed 0.42`);
    if (Number(ff.final_mg_mL) !== 0.1) throw new Error(`final target stored as ${ff.final_mg_mL}, typed 0.1`);
    if (buffers.length && ff.buffer1 !== buffers[0]) throw new Error(`1st dilution buffer stored as "${ff.buffer1}"`);
    if ('final' in (await readCol(page, 'batches')).find((x) => x.id === b).plan.downstream) throw new Error('a stray downstream.final was written');
  } finally {
    page.off('pageerror', onErr);
  }
}
scenarios.push(finalFormulationFieldsStored);

// ---- The long pages lead with what they found (usability cycle 5, agent D: m1) ----

/**
 * m1: the longest pages lead with what they found and fold the evidence under a line that says what it holds.
 * The stability page: the slope sentences, then size over time with the other figures folded under a line
 * that names their span and drift, the method folded under its one caveat, and the table as Z-ave / PDI until
 * asked for every value. An optimizer round: one line on how the predictions did, above the Results card.
 * Insights: the finding, then the correlations and the list of formulations folded. Measurements: the stored
 * results folded to a count and the last one stored. Every fold is still as it was left after a redraw.
 */
export async function longPagesLeadWithFindings({ page, open }) {
  const words = async () => (await page.locator('#main').innerText()).split(/\s+/).filter(Boolean).length;
  const top = (sel) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
  const isOpen = (sel) => page.locator(sel).first().evaluate((d) => d.open);
  const say = (sel) => page.locator(`${sel} > summary .fold-say`).first().innerText();
  // A chart inside a closed fold keeps its box (the fold hides it with content-visibility), so its size alone
  // does not say whether it is on the screen.
  const charts = () => page.$$eval('#resultsCard svg', (s) => s.filter((x) => { const r = x.getBoundingClientRect(); return r.width >= 160 && r.height >= 90 && x.checkVisibility(); }).map((x) => x.getAttribute('aria-label')));
  // A reload forgets the folds earlier scenarios opened, so each page is seen as it first opens.
  const fresh = async (hash, sel) => {
    await open(hash);
    await page.reload();
    await page.waitForFunction((s) => window.__lnpStarted && document.querySelector(s), sel, { timeout: 15000 });
    await page.waitForTimeout(150);
  };

  // ---- the stability study the earlier scenarios measured on four days (a later one was repeated from it, empty)
  const st = (await readCol(page, 'experiments')).filter((e) => e.type === 'stability')
    .map((e) => ({ id: e.id, done: (e.expected || []).filter((s) => s.status === 'done').length })).sort((a, b) => b.done - a.done)[0]?.id;
  await fresh(`experiments?id=${st}`, '#resultsCard');
  const lead = await page.$$eval('#resultsCard ul.res-stats li', (li) => li.map((x) => x.textContent.trim()));
  if (!/^At -?\d+ °C, E\d+-F\d+ (grows|shrinks|changes) [\d.]+ nm\/day \(95 % CI /.test(lead[0] || '')) throw new Error(`the card should open on a slope sentence, found "${lead[0]}"`);
  if (!lead.some((s) => /^Soonest to a QC limit: E\d+-F\d+ at /.test(s))) throw new Error('the sentences should say which shelf reaches a QC limit first');
  if (!((await top('#resultsCard ul.res-stats')) < (await top('#resultsCard .fig')))) throw new Error('the sentences should come before the figures');
  const shown = await charts();
  if (shown.join() !== 'Z-ave over time') throw new Error(`one figure open, size over time; open: ${shown.join(', ') || 'none'}`);
  if (await isOpen('#resultsCard .res-figfold')) throw new Error('the other figures should start folded');
  await expectText(page, '#resultsCard .res-figfold > summary', /^PDI (and EE )?over time/, 'the fold names the figures it holds');
  if (!/^PDI [\d.]+(–[\d.]+)?(, (no clear drift on any shelf|(rising|falling) on .+))?;.*(every day mean inside|\d+ day means? outside) the QC limits? for PDI \(≤ [\d.]+\)( and EE \(≥ [\d.]+ %\))?\.$/.test(await say('#resultsCard .res-figfold'))) {
    throw new Error(`the figure fold's line: "${await say('#resultsCard .res-figfold')}"`);
  }
  if (await isOpen('#resultsCard .res-method')) throw new Error('the method should start folded');
  await expectText(page, '#resultsCard .res-method > summary', /How the slopes are worked out[\s\S]*drift stays linear/, 'under its one caveat');
  // the table: Z-ave / PDI per day, the trend column (said in the sentences) with the full view
  await expectText(page, '#stabTable', /\d+\.\d \/ 0\.\d{3}/, 'each day reads Z-ave / PDI');
  await expectNoText(page, '#stabTable', /nm\/day|95 % CI|vs T0/, 'the compact table');
  if ((await page.getAttribute('#resultsCard [data-resview]', 'aria-pressed')) !== 'false') throw new Error('the table should open compact');
  const compact = await words();
  await openFolds(page);
  await showEveryValue(page);
  await expectText(page, '#stabTable', /[\d.]+ ± [\d.]+[\s\S]*PDI 0\.\d{3}[\s\S]*nm\/day\s*95 % CI/, 'every value is one click away');
  if ((await charts()).length < 2) throw new Error('opening the fold should show the other figures');
  const everything = await words();
  if (!(compact < everything * 0.8)) throw new Error(`folded, the page should read well under its full length: ${compact} words against ${everything}`);
  // a redraw (the page opened again) keeps what was opened
  await open('experiments');
  await open(`experiments?id=${st}`);
  if (!(await isOpen('#resultsCard .res-figfold')) || !(await isOpen('#resultsCard .res-method'))) throw new Error('a redraw closed the folds that were opened');
  if (!(await page.locator('#resultsCard .res-stab.res-full').count())) throw new Error('a redraw went back to the compact table');
  await page.click('#resultsCard [data-resview]');
  await expectNoText(page, '#stabTable', /95 % CI/, 'and the toggle goes back to the compact table');

  // ---- an optimizer round: the first run measured as predicted, the second well above its size interval
  const ml = (await readCol(page, 'experiments')).filter((e) => e.design?.ml && /^E\d+$/.test(e.id)).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).pop();
  if (!ml) throw new Error('no optimizer round left by the earlier scenarios');
  const runs = (await readCol(page, 'batches')).filter((b) => ml.batchIds.includes(b.id) && b.ml?.predicted);
  if (runs.length < 2) throw new Error(`the round should have two runs with predictions, has ${runs.length}`);
  const kept = await readCol(page, 'measurements');
  const ids = new Set(ml.batchIds);
  const pred = (b, name) => b.ml.predicted[name];
  const [r1, r2] = runs;
  const seeded = [r1, r2].map((b, i) => ({ id: `d5-ml-${i}`, batchId: b.id, experimentId: ml.id, test: 'dls', stage: 'final', sampleName: `${b.id}_final`, date: '2026-10-16',
    values: { zave_nm: pred(b, 'particle_size_nm').mean + (i ? 3 * 1.96 * pred(b, 'particle_size_nm').sd : 0), pdi: pred(b, 'PDI')?.mean ?? 0.1 }, flags: [] }));
  const measured = 2 + [r1, r2].filter((b) => pred(b, 'PDI')).length;
  const total = runs.reduce((n, b) => n + ['particle_size_nm', 'PDI', 'encapsulation_efficiency'].filter((k) => pred(b, k)).length, 0);
  const left = total - measured;
  try {
    await writeCol(page, 'measurements', [...kept.filter((m) => !ids.has(m.batchId)), ...seeded]);
    await open('experiments');
    await open(`experiments?id=${ml.id}`);
    if (await isOpen('#mlFold')) throw new Error('the predictions table should start folded');
    const line = await page.locator('#mlVerdict').innerText();
    const want = `${measured - 1} of ${measured} measured values fell inside the model’s 95 % interval${left ? `; ${left} still to measure` : ''}. Outside it: Z-ave on ${r2.id}, higher than predicted.`;
    if (line !== want) throw new Error(`how the predictions did: "${line}", expected "${want}"`);
    if (!((await top('#mlFold')) < (await top('#resultsCard')))) throw new Error('the line on the predictions should come before the Results card');
    await page.click('#mlFold > summary');
    await expectText(page, `#mlFold tr:has(a[href="#/formulation?batch=${r2.id}"])`, /outside the interval/, 'opened, the run that missed is marked');
    await expectNoText(page, `#mlFold tr:has(a[href="#/formulation?batch=${r1.id}"])`, /outside the interval/, 'and the one that did not is not');
    await open('experiments');
    await open(`experiments?id=${ml.id}`);
    if (!(await isOpen('#mlFold'))) throw new Error('a redraw closed the predictions table');
  } finally {
    await writeCol(page, 'measurements', kept);
  }

  // ---- Insights: the finding first, the correlations and the formulations one line each
  await fresh('insights', '#insightSummary');
  if (await page.$eval('#main > .card', (c) => c.id) !== 'insightSummary') throw new Error('Insights should open on what it found');
  for (const f of ['#corrFold', '#rowsFold']) if (await isOpen(f)) throw new Error(`${f} should start folded`);
  if (!/^(strongest: .+ r [−-]?[\d.]+ \(n \d+\)( and .+)?; direction only|no factor goes with it beyond r ±0\.3 across these \d+ batches|needs at least 3 batches with varying factors)$/.test(await say('#corrFold'))) throw new Error(`the correlation line: "${await say('#corrFold')}"`);
  if (!/^\d+ batch(es)?, newest first \(E\d+-F\d+, .+\), each with its stock, operator and settings$/.test(await say('#rowsFold'))) throw new Error(`the formulations line: "${await say('#rowsFold')}"`);
  await page.click('#rowsFold > summary');
  if (!(await page.locator('#insightRows tbody tr a').first().isVisible())) throw new Error('opened, the list shows its formulations');
  await page.selectOption('select[name=colorBy]', 'experimentId');
  await page.waitForTimeout(300);
  if (!(await isOpen('#rowsFold')) || (await isOpen('#corrFold'))) throw new Error('a filter redrew the folds other than they were left');

  // ---- Measurements: what is due leads; the stored results are one line naming the last one stored
  await open('overview');
  await open('measurements');
  if (await isOpen('#resultsList')) throw new Error('the stored results should start folded');
  if (!((await top('#dueCard')) < (await top('#resultsList')))) throw new Error('what is due should come first');
  const last = await page.locator('#resultsSay').innerText();
  if (!/^\d+ results? stored, (none|\d+) flagged by a QC check; the last added: \S+, .+$/.test(last)) throw new Error(`the results line: "${last}"`);
  const newest = (await readCol(page, 'measurements')).pop();
  if (!last.includes(`the last added: ${newest.sampleName || newest.batchId},`)) throw new Error(`the line should name the result added last, ${newest.sampleName}: "${last}"`);
  const folded = await words();
  await page.click('#resultsList > summary');
  if (!(await words() > folded)) throw new Error('opened, the list should add its rows');
  // opened by hand it stays open through a reload (the address carries it), and the sidebar opens it folded again
  await page.reload();
  await page.waitForFunction(() => window.__lnpStarted && document.querySelector('#resultsList'), null, { timeout: 15000 });
  if (!(await isOpen('#resultsList'))) throw new Error('a reload closed the list that was opened');
  await open('overview');
  await open('measurements');
  if (await isOpen('#resultsList')) throw new Error('opened afresh, the list should be folded again');
  const someBatch = kept.find((m) => m.batchId)?.batchId;
  if (someBatch) {
    await open(`measurements?batch=${encodeURIComponent(someBatch)}`);
    if (!(await isOpen('#resultsList'))) throw new Error('a formulation\'s "Measure" link should open its results');
  }
  await open('overview');
}
scenarios.push(longPagesLeadWithFindings);


// ---- The oldest Mac the app installs on (usability cycle 5, K5) ----
/**
 * The macOS app draws its window with the system's WKWebView, and on macOS 12.0, the oldest the app installs on
 * (src-tauri/tauri.conf.json), that is Safari 15.0. Chromium cannot be turned into it, but what Safari 15.0 lacks
 * can be taken out of it: in a browser profile of its own, every built-in that came with Safari 15.4 or later is
 * deleted before the app loads, and so are crypto.subtle, navigator.clipboard and navigator.storage, which a
 * tauri:// page may not have. On that page the lab is set up from nothing the way the first scenarios do it (a
 * stock, a buffer, lots, an experiment of each kind, the bench record, a result typed in, a CSV and a UTF-16
 * export imported), every screen and experiment page is opened, the storage meter is read, and the demo lab is
 * walked through with an optimizer run. Nothing may throw. CSS cannot be taken away like this; the static side,
 * CSS included, is tests/compat.test.mjs.
 */
export async function runsWithoutWhatSafari15Lacks({ page, base, errors }) {
  const where = 'without Safari 15.4+';
  const ctx2 = await page.context().browser().newContext({ timezoneId: 'Europe/Berlin', acceptDownloads: true });
  try {
    await ctx2.addInitScript(() => {
      const drop = (o, ...keys) => { for (const k of keys) { try { if (o) delete o[k]; } catch {} } };
      drop(Object, 'hasOwn', 'groupBy'); drop(Map, 'groupBy'); drop(Array, 'fromAsync'); drop(Promise, 'withResolvers', 'try');
      drop(globalThis, 'structuredClone', 'BroadcastChannel', 'OffscreenCanvas', 'CompressionStream', 'DecompressionStream', 'requestIdleCallback');
      const arrayLike = ['at', 'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'toSpliced', 'with'];
      drop(Array.prototype, ...arrayLike); drop(Object.getPrototypeOf(Int8Array.prototype), ...arrayLike);
      drop(String.prototype, 'at', 'isWellFormed', 'toWellFormed');
      drop(Set.prototype, 'union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom');
      drop(globalThis.Iterator?.prototype, 'map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find');
      drop(Intl, 'supportedValuesOf'); drop(Intl.NumberFormat.prototype, 'formatRange', 'formatRangeToParts'); drop(AbortSignal, 'timeout', 'any');
      drop(HTMLDialogElement.prototype, 'showModal'); drop(HTMLInputElement.prototype, 'showPicker'); drop(HTMLFormElement.prototype, 'requestSubmit');
      drop(HTMLElement.prototype, 'inert'); drop(Element.prototype, 'checkVisibility');
      drop(Crypto.prototype, 'randomUUID', 'subtle'); drop(Navigator.prototype, 'storage', 'clipboard', 'locks');
    });
    const p2 = await ctx2.newPage();
    await p2.clock.setFixedTime(new Date('2026-10-17T10:00:00+02:00'));
    p2.on('pageerror', (e) => errors.push(`${where}: pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`${where}: console: ${m.text()}`); });
    const open = async (hash) => {
      await p2.goto(base + '#/' + hash);
      await p2.waitForFunction(() => document.querySelector('#main h1, #main .note'), null, { timeout: 5000 }).catch(() => errors.push(`${where}: no heading on ${hash}`));
      await p2.waitForTimeout(150);
    };
    await open('overview');
    const left = await p2.evaluate(() => ({ 'Object.hasOwn': Object.hasOwn, structuredClone: globalThis.structuredClone, '[].at': [].at, 'crypto.subtle': crypto.subtle, 'navigator.storage': navigator.storage, 'navigator.clipboard': navigator.clipboard }));
    const still = Object.keys(left).filter((k) => left[k] !== undefined);
    if (still.length) throw new Error(`the page still has ${still.join(', ')}`);

    const screens = ['overview', 'advisor', 'designs', 'experiments', 'formulation', 'stocks', 'buffers', 'measurements', 'calendar', 'doe', 'ml', 'insights', 'materials', 'learn', 'settings'];
    for (const s of screens) await open(s);
    for (const sc of [stocksCreateAndSave, buffersDesignAndSave, materialsAddLots, experimentsStabilityAndSingle, batchRecordAndCalendar, measurementsManualAndImport, wizardOtherTypes, zetasizerGermanUtf16]) {
      try { await sc({ page: p2, open, base, errors }); } catch (e) { throw new Error(`${sc.name}: ${e.message}`); }
    }
    // Every import carries its file's SHA-256 although crypto.subtle is gone: it is worked out in JavaScript.
    const imports = await readCol(p2, 'imports');
    if (imports.length < 2 || !imports.every((i) => /^[0-9a-f]{64}$/.test(i.sha256 || ''))) throw new Error(`imports without their fingerprint: ${JSON.stringify(imports.map((i) => i.sha256))}`);
    // Settings without navigator.storage: the meter says where the records are and leaves out what it cannot know.
    await open('settings');
    await expectText(p2, '#storageFacts', /kept in this browser's database \(IndexedDB\)/, 'the storage meter says where the records are');
    await expectText(p2, '#storageVerdict', /Stored in this browser's database/, 'and, with no quota to compare against, what it can say');
    for (const s of screens) await open(s);
    for (const e of await readCol(p2, 'experiments')) await open(`experiments?id=${e.id}`);

    // The demo lab: the fits, figures and the optimizer, whose failures are said in a toast rather than thrown.
    await open('overview');
    await p2.click('#demoToggle');
    await p2.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    for (const e of await readCol(p2, 'experiments', 'lnp-demo')) {
      await open(`experiments?id=${e.id}`);
      if (e.type === 'doe') await open(`doe?id=${e.id}`);
    }
    for (const s of screens) await open(s);
    await open('ml');
    await p2.click('#runBtn');
    await p2.waitForTimeout(200);
    await p2.waitForFunction(() => document.querySelector('#runBtn') && !document.querySelector('#runBtn').disabled, null, { timeout: 30000 });
    const said = await p2.locator('#toast').count() ? await p2.locator('#toast').innerText() : '';
    if (/failed|Error:/i.test(said)) throw new Error(`the optimizer run: "${said}"`);
  } finally { await ctx2.close(); }
}
scenarios.push(runsWithoutWhatSafari15Lacks);

/**
 * The macOS app's window does nothing with a browser download, opens no print window and has no Notification, so
 * there the page goes through the Tauri plugins on window.__TAURI__ (app/ui/kit.js, app/ui/calendar.js). Tauri
 * cannot run here; this stands a recording stand-in for its dialog, fs and notification APIs in a browser profile
 * of its own, and checks what the page asks of them: the backup, a figure and a report each go through the save
 * dialog and are written with the bytes a browser would have saved, a cancelled dialog is no backup, nothing tries
 * window.open, and reminders are sent through the plugin. A save waits for the dialog there, so what is said about
 * it waits too: the overview's backup reminder goes once the backup is saved, and an export cancelled in the dialog
 * is not called exported. Whether Tauri itself then does its part is item 0 of the test plan in docs/MACOS.md.
 */
export async function inAppSavesThroughTauri({ page, base, errors }) {
  const where = 'in the app';
  const ctx2 = await page.context().browser().newContext({ timezoneId: 'Europe/Berlin' });
  try {
    await ctx2.addInitScript(() => {
      const calls = window.__tauriCalls = [];
      window.__TAURI__ = {
        dialog: { save: async (o) => { calls.push({ cmd: 'save', o }); return window.__cancelSave ? null : `/Users/lab/Downloads/${o.defaultPath}`; } },
        fs: { writeFile: async (path, bytes) => { calls.push({ cmd: 'write', path, size: bytes.length, head: [...bytes.slice(0, 4)], text: new TextDecoder().decode(bytes.slice(0, 400000)) }); } },
        notification: { isPermissionGranted: async () => true, requestPermission: async () => 'granted', sendNotification: (o) => { calls.push({ cmd: 'notify', o }); } },
      };
      window.open = () => { calls.push({ cmd: 'window.open' }); return null; };
      delete window.Notification; // WKWebView has none
    });
    const p2 = await ctx2.newPage();
    await p2.clock.setFixedTime(new Date('2026-10-17T10:00:00+02:00'));
    p2.on('pageerror', (e) => errors.push(`${where}: pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`${where}: console: ${m.text()}`); });
    const open = async (hash) => {
      await p2.goto(base + '#/' + hash);
      await p2.waitForFunction(() => document.querySelector('#main h1, #main .note'), null, { timeout: 5000 }).catch(() => errors.push(`${where}: no heading on ${hash}`));
      await p2.waitForTimeout(150);
    };
    const calls = () => p2.evaluate(() => window.__tauriCalls.splice(0));
    const written = async (what) => {
      await p2.waitForFunction(() => window.__tauriCalls.some((c) => c.cmd === 'write'), null, { timeout: 5000 }).catch(() => {});
      const cs = await calls(), save = cs.find((c) => c.cmd === 'save'), write = cs.find((c) => c.cmd === 'write');
      if (cs.some((c) => c.cmd === 'window.open')) throw new Error(`${what}: window.open was tried`);
      if (!save || !write) throw new Error(`${what}: ${save ? 'nothing written after the save dialog' : 'no save dialog'} (${JSON.stringify(cs.map((c) => c.cmd))})`);
      if (write.path !== `/Users/lab/Downloads/${save.o.defaultPath}`) throw new Error(`${what}: written to ${write.path}, the dialog chose ${save.o.defaultPath}`);
      return { save, write };
    };
    const toasts = () => p2.evaluate(() => document.querySelector('#toast')?.textContent || '');
    const noToasts = () => p2.evaluate(() => document.querySelectorAll('#toast > *').forEach((n) => n.remove()));

    // The overview's "Export now", in a lab with a record and no backup on record: the reminder goes once the
    // backup is saved. It was drawn again before the dialog had answered, and still said there was none.
    await open('overview');
    await writeCol(p2, 'stocks', [{ id: 'Stock-001', compositionId: 1, createdAt: '2026-10-16T09:00:00.000Z', updatedAt: '2026-10-16T09:00:00.000Z' }]);
    await p2.reload(); await p2.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await p2.waitForSelector('#exportNow', { timeout: 3000 }).catch(() => { throw new Error('no backup reminder on the overview of a lab never exported'); });
    await p2.click('#exportNow');
    await written('the backup from the overview');
    await p2.waitForFunction(() => !document.querySelector('#exportNow'), null, { timeout: 3000 })
      .catch(async () => { throw new Error(`the overview still asks for a backup after one was saved: "${await p2.locator('#backupDue').innerText()}"`); });

    await p2.click('#demoToggle');
    await p2.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });

    // The backup: a cancelled dialog writes nothing and is not counted as one; then the file, whole. This is the
    // demo lab, so its export is noted as the demo's (usability cycle 6, I9).
    await open('settings');
    await p2.evaluate(() => { localStorage.removeItem('lnp-demo.lastExport'); window.__cancelSave = true; });
    await p2.click('#exportAll'); await p2.waitForTimeout(300);
    if ((await calls()).some((c) => c.cmd === 'write')) throw new Error('a cancelled save dialog still wrote the backup');
    if (await p2.evaluate(() => localStorage.getItem('lnp-demo.lastExport'))) throw new Error('a cancelled save dialog counted as a backup');
    await p2.evaluate(() => { window.__cancelSave = false; });
    await p2.click('#exportAll');
    const backup = await written('the backup');
    if (!/^lnp-lab-export-\d{4}-\d\d-\d\d\.json$/.test(backup.save.o.defaultPath) || backup.save.o.filters?.[0]?.extensions?.[0] !== 'json') throw new Error(`the backup's dialog: ${JSON.stringify(backup.save.o)}`);
    const exported = JSON.parse(backup.write.text);
    if (!(exported.collections?.experiments?.length >= 7)) throw new Error('the backup written in the app does not hold the lab');
    await p2.waitForFunction(() => localStorage.getItem('lnp-demo.lastExport'), null, { timeout: 3000 }).catch(() => { throw new Error('the saved backup was not noted as the last export'); });

    // A figure as PNG: the first one drawn on the demo's experiment pages.
    let png = null;
    for (const id of ['E1', 'E2', 'E6', 'E4']) {
      await open(`experiments?id=${id}`);
      const clicked = await p2.evaluate(() => {
        const b = [...document.querySelectorAll('.fig [data-fig-dl="png"]')].find((x) => [...x.closest('.fig').querySelectorAll('svg')].some((s) => s.getBoundingClientRect().width > 0));
        if (b) b.click();
        return !!b;
      });
      if (clicked) { png = await written('a figure as PNG'); break; }
    }
    if (!png) throw new Error('no figure on the demo experiment pages to save');
    if (png.write.head.join() !== '137,80,78,71' || png.write.size < 2000) throw new Error(`the PNG written is not one (${png.write.head}, ${png.write.size} bytes)`);

    // The report: no print window there, so it is saved as a page to print from Safari.
    await open('experiments?id=E1');
    await p2.click('#reportExp');
    const report = await written('the report');
    if (!/\.html$/.test(report.save.o.defaultPath) || /[\\/:]/.test(report.save.o.defaultPath)) throw new Error(`the report's file name: ${report.save.o.defaultPath}`);
    if (!/^<!doctype html>[\s\S]*<svg[\s\S]*<\/html>$/.test(report.write.text)) throw new Error('the report saved is not the whole page with its figures');
    await expectText(p2, '#toast', /open it in Safari and print it/, 'the app says what to do with the saved report');

    // The calendar and the design's exports: one cancelled in the dialog is not called exported; one saved is.
    await open('calendar');
    await noToasts(); await p2.evaluate(() => { window.__cancelSave = true; });
    await p2.click('#exportIcs'); await p2.waitForTimeout(300);
    if (/exported/.test(await toasts())) throw new Error(`a calendar export cancelled in the dialog says "${await toasts()}"`);
    await p2.evaluate(() => { window.__cancelSave = false; }); await calls();
    await p2.click('#exportIcs');
    if ((await written('the calendar')).save.o.defaultPath !== 'lnp-lab.ics') throw new Error('the calendar is not saved as lnp-lab.ics');
    await expectText(p2, '#toast', /Calendar exported/, 'a saved calendar says so');
    await open('doe?id=E4');
    for (const id of ['expRaw', 'expDesign', 'expPdf', 'expCsv']) {
      await noToasts(); await p2.evaluate(() => { window.__cancelSave = true; });
      if (!(await p2.evaluate((id) => { const b = document.getElementById(id); b?.click(); return !!b; }, id))) throw new Error(`no #${id} on the demo's DoE`);
      await p2.waitForTimeout(300);
      if (/exported/.test(await toasts())) throw new Error(`#${id} cancelled in the dialog says "${await toasts()}"`);
    }
    await p2.evaluate(() => { window.__cancelSave = false; }); await calls();
    await p2.evaluate(() => document.getElementById('expCsv').click());
    await written('the design table');
    await expectText(p2, '#toast', /Design CSV exported/, 'a saved design table says so');

    // Reminders through the notification plugin, with no Notification in the window.
    await open('calendar');
    await p2.click('#remind'); await p2.waitForTimeout(300);
    await expectText(p2, '#toast', /Reminders on/, 'reminders are turned on through the plugin');
    const sent = (await calls()).filter((c) => c.cmd === 'notify');
    if (sent.some((c) => c.o.title !== 'LNP Lab: due today' || !c.o.body)) throw new Error(`a reminder sent as ${JSON.stringify(sent)}`);
  } finally { await ctx2.close(); }
}
scenarios.push(inAppSavesThroughTauri);


/**
 * The optimizer says when to stop, and which run to take forward (usability cycle 5, K2 and K3). Three rounds
 * that have closed in on the top of a smooth surface, with one lucky batch measured above what its setting
 * gives: the screen has to lead with "stop" and the number behind it, name the model's pick as the run to take
 * forward, say the best single result was made once, and offer the confirmation runs (a repeat of the pick, the
 * predicted optimum twice) as one experiment instead of another round. Everything else on the record is set
 * aside for the scenario and put back afterwards, so the verdict rests on these runs alone.
 */
export async function optimizerSaysWhenToStop({ page, open }) {
  const cols = ['experiments', 'batches', 'measurements', 'settings'];
  const before = Object.fromEntries(await Promise.all(cols.map(async (c) => [c, await readCol(page, c)])));
  let s = 12;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const truth = (frr, tfr) => ({
    zave_nm: 80 + 14 * (frr - 3.6) - 0.15 * (tfr - 80) + 4 * (frr - 3.6) ** 2,
    pdi: 0.06 + 0.03 * (frr - 3.6) ** 2 + 0.000015 * (tfr - 80) ** 2,
    ee_pct: 95 - 3 * (frr - 3.6) ** 2 - 0.0008 * (tfr - 80) ** 2,
  });
  const rounds = [
    ['E901', '2026-03-02', [[2.2, 45], [2.8, 130], [3.4, 60], [4.0, 110], [4.6, 50], [5.0, 95], [3.0, 85], [4.4, 140]]],
    ['E902', '2026-04-06', [[3.5, 75], [3.7, 88], [3.3, 95], [3.9, 70], [3.6, 80], [3.8, 100]]],
    ['E903', '2026-05-04', [[3.6, 72], [3.5, 85], [3.7, 78], [3.4, 82], [3.6, 90], [3.8, 76]]],
  ];
  const experiments = [], batches = [], measurements = [];
  for (const [exp, date, pts] of rounds) {
    const ids = [];
    pts.forEach(([frr, tfr], i) => {
      const id = `${exp}-F${i + 1}`, t = truth(frr, tfr), lucky = id === 'E902-F3';
      ids.push(id);
      const m = { zave_nm: lucky ? 80.5 : t.zave_nm + g() * 1.2, pdi: Math.max(0.03, t.pdi + g() * 0.004 - (lucky ? 0.025 : 0)), ee_pct: Math.min(99, t.ee_pct + g() * 0.6 + (lucky ? 2.5 : 0)) };
      batches.push({ id, experimentId: exp, label: `run ${i + 1}`, compositionId: 1, stockId: null, plannedDate: date, status: 'produced',
        plan: { rna: { working_mg_mL: 0.4, mass_mg: 3, np: 6 }, mixing: { frr, totalFlow: tfr, quenchFactor: 2, lipidStock_mM: 50, flows: null }, factors: {}, downstream: {} }, actual: {} });
      measurements.push({ id: `MS${id}d`, batchId: id, experimentId: exp, test: 'dls', stage: 'final', date, values: { zave_nm: m.zave_nm, pdi: m.pdi } });
      measurements.push({ id: `MS${id}e`, batchId: id, experimentId: exp, test: 'ee', stage: 'final', date, values: { ee_pct: m.ee_pct } });
    });
    experiments.push({ id: exp, type: 'single', name: `Closing in ${exp}`, startDate: date, compositionId: 1, status: 'done', spec: {}, design: {}, batchIds: ids, expected: [] });
  }
  try {
    await writeCol(page, 'experiments', experiments);
    await writeCol(page, 'batches', batches);
    await writeCol(page, 'measurements', measurements);
    await writeCol(page, 'settings', before.settings.filter((x) => x.id !== 'mlSetup')); // the default goals
    await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await open('ml?factors=frr,tfr');
    await page.click('#runBtn');
    await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });

    // the verdict leads, plainly, with its number and what to do instead
    const level = await page.locator('#roundVerdict').getAttribute('data-level');
    if (level !== 'stop') throw new Error(`three converged rounds and a lucky best should read as stop, read ${level}: "${await page.locator('#roundVerdict').innerText()}"`);
    await expectText(page, '#roundVerdict', /^Stop here and confirm the best candidates instead \(3 batches\): the best of these 4 suggestions has (less than a|only a) \d+ % chance of beating your best run, and your latest runs did not raise the model's pick\./, 'the stop sentence');
    await expectText(page, '#roundVerdict', /simulated-lab benchmark, \d+ % of \d+ rounds in this situation/, 'and the benchmark it rests on');
    const y = (sel) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
    if (!((await y('#roundVerdict')) < (await y('#makeExp')))) throw new Error('the verdict should sit above the suggestions');
    // the run to take forward is the model's pick, and "best so far" says how often it was made
    await expectText(page, '#mlLede', /Take forward\s*E90\d-F\d\s*the model's pick: predicted 0\.\d\d, made once/, 'the model\'s pick is the run to take forward');
    await expectText(page, '#mlLede', /Best so far\s*\d\.\d\d\s*E90\d-F\d, made once/, 'the best single result says it was made once');
    await expectNoText(page, '#mlLede', /Run next/, 'the card no longer leads with more runs');
    // one confirmation offer, in the lede, and the suggestions are still there for anyone who wants a round
    if ((await page.locator('#addConfirm').count()) !== 1 || !(await page.locator('#mlLede #addConfirm').count())) throw new Error('the confirmation should be offered once, in the lede');
    await expectText(page, '#mlLede', /Predicted optimum\s*0\.\d\d\s*Flow rate ratio \d(\.\d)?, Total flow rate \d+ mL\/min; never made/, 'the predicted optimum is the other setting to take forward');
    await expectText(page, '#confirmNote', /a repeat of E90\d-F\d \(the model's pick\) and the predicted optimum made twice/, 'the confirmation names both candidates');
    await expectText(page, '#addConfirm', /^Add the 3 confirmation runs$/, 'the button says what it adds');
    const primary = async (sel) => page.locator(sel).evaluate((b) => b.classList.contains('primary'));
    if (!(await primary('#addConfirm')) || (await primary('#makeExp'))) throw new Error('when the verdict is to stop, confirming is the primary button and another round is not');
    await expectText(page, '#main', /What to run next[\s\S]*Beats best/, 'the suggestions stay');

    const pick = /Take forward\s*(E90\d-F\d)/.exec(await page.locator('#mlLede').innerText())[1];
    await page.click('#addConfirm');
    await page.waitForTimeout(600);
    const exp = (await readCol(page, 'experiments')).find((e) => /^Confirm /.test(e.name));
    if (!exp) throw new Error('no confirmation experiment was created');
    if (exp.name !== `Confirm ${pick} and the optimum`) throw new Error(`the confirmation experiment is called "${exp.name}"`);
    const made = (await readCol(page, 'batches')).filter((b) => exp.batchIds.includes(b.id));
    if (made.map((b) => b.label).join(' | ') !== `repeat of ${pick} | predicted optimum 1 | predicted optimum 2`) throw new Error(`confirmation runs: ${made.map((b) => b.label).join(' | ')}`);
    const at = (b) => `${b.plan.mixing.frr}/${b.plan.mixing.totalFlow}`;
    const pickBatch = batches.find((b) => b.id === pick);
    if (at(made[0]) !== at(pickBatch)) throw new Error(`the repeat is made at ${at(made[0])}, the pick at ${at(pickBatch)}`);
    if (at(made[1]) !== at(made[2])) throw new Error('the optimum is made twice at one setting');
    if (!made.every((b) => b.ml?.purpose === 'confirm' && b.ml.predicted)) throw new Error('the confirmation runs carry their purpose and what the model expects of them');
    await expectText(page, '#main', new RegExp(`Confirm ${pick} and the optimum`), 'the new experiment opens');
  } finally {
    for (const c of cols) await writeCol(page, c, before[c]);
    await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  }
}
scenarios.push(optimizerSaysWhenToStop);

/**
 * Every recipe the optimizer proposes can be weighed out. In the demo lab, with its own factor choice, the
 * cholesterol is varied, so the helper lipid takes up the rest; before the search knew that, all four
 * suggestions needed it negative (−13.9 mol% for the first), the table did not show it, and accepting a
 * dialog stored it. Now the balance has its own column and stays in band, the runs are created without asking,
 * and ranges that leave no recipe at all are named for it. The demo lab is put back as it was afterwards.
 */
export async function optimizerRecipesCanBeMade({ page, open }) {
  const cols = ['experiments', 'batches', 'compositions', 'settings'];
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); };
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const before = Object.fromEntries(await Promise.all(cols.map(async (c) => [c, await readCol(page, c, 'lnp-demo')])));
  const restart = async () => { await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 }); };
  page.on('dialog', onDialog);
  try {
    await writeCol(page, 'settings', before.settings.filter((x) => x.id !== 'mlSetup'), 'lnp-demo'); // the demo's own factor choice
    await restart();
    await open('ml');
    await expectText(page, '#main', /Cholesterol \/ sterol/, 'the demo varies the cholesterol');
    await page.click('#runBtn');
    await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 60000 });
    const balance = (await page.$$eval('[data-balance]', (n) => n.map((x) => Number(x.dataset.balance))));
    if (!balance.length || balance.some((b) => !(b >= 5 && b <= 20))) throw new Error(`the helper lipid of the suggestions: ${balance.join(', ')} mol%`);
    await expectText(page, '#main', /keeps lipid mol% at 100 by adjusting helper phospholipid, which stays within 5–20 mol%/, 'the table says what keeps the recipe whole');
    await page.click('#makeExp');
    await page.waitForTimeout(800);
    if (dialogs.length) throw new Error(`creating the suggested runs asked: "${dialogs[0]}"`);
    const made = (await readCol(page, 'batches', 'lnp-demo')).filter((b) => b.ml && !before.batches.some((x) => x.id === b.id));
    if (made.length !== balance.length) throw new Error(`${made.length} formulations stored for ${balance.length} suggestions`);
    for (const b of made) {
      const c = b.plan.compositionOverride;
      if (!(c.helper >= 5 && c.helper <= 20)) throw new Error(`${b.id} stores the helper lipid at ${c.helper} mol%`);
    }

    // ranges that leave no recipe at all: nothing proposed, and the reason in words
    const setup = (await readCol(page, 'settings', 'lnp-demo')).find((x) => x.id === 'mlSetup');
    const tight = setup.value.space.map((f) => (f.key === 'ionizable_pct' ? { ...f, lo: 58 } : f.key === 'sterol_pct' ? { ...f, lo: 50 } : f));
    await writeCol(page, 'settings', [...before.settings.filter((x) => x.id !== 'mlSetup'), { ...setup, value: { ...setup.value, space: tight } }], 'lnp-demo');
    await restart();
    await open('ml');
    await page.click('#runBtn');
    await page.waitForFunction(() => /No suggestions yet/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 60000 });
    await expectText(page, '#mlRoot', /No recipe in these ranges can be weighed out\. With Ionizable lipid, PEG-lipid and Cholesterol \/ sterol varied, Helper phospholipid takes up the rest/, 'the screen says why there is nothing to run');
    if (!(await page.locator('#setupFold').evaluate((d) => d.open))) throw new Error('with nothing to run, the ranges to change should be open');
  } finally {
    page.off('dialog', onDialog);
    for (const c of cols) await writeCol(page, c, before[c], 'lnp-demo');
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(400);
  }
}
scenarios.push(optimizerRecipesCanBeMade);


// ---- Never lose what was typed, and no screen hangs (usability cycle 5, agent C: K4, K6, K7) ----

/**
 * K6: the formulation record stores each value as it is typed. A value typed and left by a click on the
 * sidebar is there when the record is opened again, and so is one left with the cursor still in the field
 * (the hash changed under it, as the browser's Back button does). There is no Save button to forget.
 */
export async function recordKeepsWhatIsTyped({ page, open }) {
  const { forms } = await newReference(page, open, 'Kept as typed', 1);
  const b = forms[0];
  const storedBatch = async () => (await readCol(page, 'batches')).find((x) => x.id === b);
  await open(`formulation?batch=${b}`);
  if (await page.locator('#saveBatch').count()) throw new Error('the record still has a Save button');
  if (!(await page.locator('#printBatch').count())) throw new Error('"Print worksheet" is gone');
  await page.fill('input[name=rna_stock_mg_mL]', '1.23'); // typed, not yet left
  await page.click('nav a.item[href="#/overview"]');
  await page.waitForFunction(() => location.hash === '#/overview' && /Overview|Home/.test(document.querySelector('#main .crumb')?.textContent || ''), null, { timeout: 3000 });
  await page.evaluate(() => window.lnpDb.flush());
  if ((await storedBatch())?.plan?.rna?.stock_mg_mL !== 1.23) throw new Error(`the RNA stock conc. typed before opening Overview was not stored: ${JSON.stringify((await storedBatch())?.plan?.rna)}`);
  await open(`formulation?batch=${b}`);
  if ((await page.inputValue('input[name=rna_stock_mg_mL]')) !== '1.23') throw new Error(`back on the record the RNA stock conc. reads "${await page.inputValue('input[name=rna_stock_mg_mL]')}"`);
  // the remarks, typed and left without leaving the box: the hash changes under the cursor
  await page.fill('textarea[name=notes]', 'Cassette changed at 14:00');
  await page.evaluate(() => { location.hash = '#/calendar'; });
  await page.waitForFunction(() => location.hash === '#/calendar');
  await page.evaluate(() => window.lnpDb.flush());
  if ((await storedBatch())?.notes !== 'Cassette changed at 14:00') throw new Error(`remarks left with the cursor in the box: stored "${(await storedBatch())?.notes}"`);
  await open(`formulation?batch=${b}`);
  if ((await page.inputValue('textarea[name=notes]')) !== 'Cassette changed at 14:00') throw new Error('the remarks are not back on the record');
  // a field left says so, quietly
  await page.fill('input[name=rna_mass_mg]', '2'); await page.dispatchEvent('input[name=rna_mass_mg]', 'change');
  await page.waitForFunction(() => /^Saved$/.test(document.querySelector('#saveState')?.textContent || ''), null, { timeout: 3000 })
    .catch(async () => { throw new Error(`the record does not say it is saved: "${await page.locator('#saveState').innerText().catch(() => '(no status)')}"`); });
  if ((await storedBatch())?.plan?.rna?.mass_mg !== 2) throw new Error('the RNA input was not stored on change');
}
scenarios.push(recordKeepsWhatIsTyped);

/**
 * K6: a new stock is not stored until "Create stock", but what was typed into it is kept as a draft and
 * offered back on the stocks screen: "Continue it" brings every value back; "Discard it" forgets it. A stock
 * on record is stored as it is edited.
 */
export async function newStockDraftOffered({ page, open }) {
  const before = (await readCol(page, 'stocks')).length;
  await open('stocks?new=1');
  await page.selectOption('select[name=compositionId]', '1');
  await page.waitForTimeout(150);
  await page.fill('input[name=molarity_mM]', '33.3'); await page.dispatchEvent('input[name=molarity_mM]', 'change');
  await page.waitForTimeout(150);
  await page.fill('input[name=actual_MC3]', '0.2101'); // typed, not left
  await open('overview');
  if ((await readCol(page, 'stocks')).length !== before) throw new Error('a stock was stored before "Create stock"');
  await open('stocks');
  await expectText(page, '#stockDraftNote', /not been created yet[\s\S]*#1[\s\S]*33\.3 mM[\s\S]*1 of 4 lipids weighed/, 'the stocks screen offers the draft back');
  await page.click('#stockDraftOpen');
  await page.waitForSelector('#stockDraftOn', { timeout: 3000 }).catch(() => { throw new Error('"Continue it" did not open the draft'); });
  for (const [sel, want] of [['input[name=molarity_mM]', '33.3'], ['input[name=actual_MC3]', '0.2101'], ['select[name=compositionId]', '1']]) {
    const got = await page.inputValue(sel);
    if (got !== want) throw new Error(`continued draft: ${sel} reads "${got}", typed "${want}"`);
  }
  // a fresh "New stock" offers it rather than overwriting it, and "Discard it" forgets it
  await open('stocks?new=1');
  if ((await page.inputValue('input[name=molarity_mM]')) === '33.3') throw new Error('"New stock" should open a fresh form, with the draft offered above it');
  await expectText(page, '#stockDraftNote', /33\.3 mM/, 'the draft offered above a fresh form');
  await page.click('#stockDraftDrop');
  if (await page.locator('#stockDraftNote').count()) throw new Error('"Discard it" left the note');
  await open('stocks');
  if (await page.locator('#stockDraftNote').count()) throw new Error('a discarded draft is offered again');

  // a stock on record: stored as it is edited, with no Save button
  const id = (await readCol(page, 'stocks'))[0]?.id;
  if (!id) return;
  await open(`stocks?id=${id}`);
  if (await page.locator('#saveStock').count()) throw new Error('a stock on record still has a Save button');
  await page.fill('textarea[name=notes]', 'Opened 27 Oct');
  await page.click('nav a.item[href="#/buffers"]');
  await page.waitForFunction(() => location.hash === '#/buffers');
  await page.evaluate(() => window.lnpDb.flush());
  if ((await readCol(page, 'stocks')).find((s) => s.id === id)?.notes !== 'Opened 27 Oct') throw new Error('a note typed into a stock on record was not stored');
}
scenarios.push(newStockDraftOffered);

/**
 * K4: a create the browser refuses (a full disk) leaves the wizard where it was, with what was typed into it,
 * and the note says to press "Create experiment" again; there is nothing to "Try again". With room again, the
 * same press creates it.
 */
export async function failedCreateKeepsWizard({ page, open }) {
  const name = 'Kept on a full disk';
  await open('experiments?new=1&type=single');
  await page.fill('input[name=name]', name);
  await page.fill('input[name=rna_mg]', '2.5'); await page.dispatchEvent('input[name=rna_mg]', 'change');
  await page.waitForTimeout(150);
  const wizard = await page.evaluate(() => location.hash);
  const count = (await readCol(page, 'experiments')).length;
  await page.evaluate(() => window.lnpDb.failWrites('QuotaExceededError'));
  try {
    await page.click('#createExp');
    await page.waitForSelector('#storageNote', { timeout: 3000 }).catch(() => { throw new Error('no note when the experiment could not be stored'); });
    await page.waitForTimeout(300);
    const note = await page.locator('#storageNote').innerText();
    if (!/^Not saved: this browser's storage is full\. The new Experiment \d+ was undone, so nothing is half-saved\. Everything on this screen is still here\./.test(note)) throw new Error(`the note: "${note}"`);
    if (!/press “Create experiment” again/.test(note)) throw new Error(`the note should say what to press: "${note}"`);
    if (await page.locator('#storageRetry').count()) throw new Error('"Try again" offered with nothing waiting to be written');
    if ((await page.evaluate(() => location.hash)) !== wizard) throw new Error(`the wizard moved on to ${await page.evaluate(() => location.hash)}`);
    await expectNoText(page, '#main', /No experiment/, 'no page for an experiment that was not stored');
    if ((await page.inputValue('input[name=name]')) !== name || (await page.inputValue('input[name=rna_mg]')) !== '2.5') throw new Error('what was typed into the wizard is gone');
    if ((await readCol(page, 'experiments')).length !== count) throw new Error('the experiment is on record although it was not stored');
    if (await page.locator('#createExp:disabled').count()) throw new Error('"Create experiment" stays disabled after the failure');
  } finally {
    await page.evaluate(() => window.lnpDb.failWrites(null));
  }
  // room again: the same button
  await page.click('#createExp');
  await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 3000 })
    .catch(async () => { throw new Error(`with room again, "Create experiment" did not open the new experiment: ${await page.evaluate(() => location.hash)}`); });
  if (await page.locator('#storageNote').count()) throw new Error('the note stays once the experiment is stored');
  const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
  await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  const e = (await readCol(page, 'experiments')).find((x) => x.id === id);
  if (e?.name !== name) throw new Error(`after a restart ${id} is ${e ? `"${e.name}"` : 'not on record'}`);
  if ((await readCol(page, 'batches')).filter((x) => x.experimentId === id).length !== 1) throw new Error('its formulation was not stored with it');
}
scenarios.push(failedCreateKeepsWizard);

/** K6: a wizard filled in and left is offered back on "New experiment", and comes back as it was typed. */
export async function wizardDraftOffered({ page, open }) {
  await open('experiments?new=1&type=ofat');
  await page.fill('input[name=name]', 'Left half-way');
  await page.fill('input[name=ofat_levelsText]', '4, 8, 16'); await page.dispatchEvent('input[name=ofat_levelsText]', 'change');
  await page.waitForTimeout(150);
  await open('overview');
  await open('experiments?new=1');
  await expectText(page, '[data-draft="ofat"]', /OFAT[\s\S]*“Left half-way”[\s\S]*did not create it/, 'the type picker offers the wizard back');
  await page.locator('[data-draft="ofat"]', { hasText: 'Left half-way' }).locator('a.btn').click();
  await page.waitForSelector('#draftOn', { timeout: 3000 }).catch(() => { throw new Error('"Continue it" did not open the draft'); });
  if ((await page.inputValue('input[name=name]')) !== 'Left half-way' || (await page.inputValue('input[name=ofat_levelsText]')) !== '4, 8, 16') throw new Error('the continued wizard lost what was typed');
  await page.click('#draftFresh');
  await page.waitForFunction(() => location.hash === '#/experiments?new=1&type=ofat');
  await page.waitForTimeout(150);
  if ((await page.inputValue('input[name=name]')) !== '' || (await page.locator('#draftOn').count()) || (await page.locator('[data-draft="ofat"]', { hasText: 'Left half-way' }).count())) throw new Error('"Start afresh" should open an empty wizard with nothing offered');
  await open('experiments?new=1');
  if (await page.locator('[data-draft="ofat"]', { hasText: 'Left half-way' }).count()) throw new Error('a draft started afresh is still offered');
}
scenarios.push(wizardDraftOffered);

/**
 * K7: a screen opened before is drawn in the same task as the hash change. The router used to await two
 * imports of modules long loaded, and for that moment the page showed "Loading …" under the new hash: the
 * "stuck Loading …" the search scenario read about one smoke run in five.
 */
export async function loadedScreenDrawsAtOnce({ page, open }) {
  await open('formulation?batch=E2-F1');
  await open('overview');
  const seen = await page.evaluate(() => new Promise((resolve) => {
    // Registered after the router's own listener, so this runs straight after it, in the same task.
    window.addEventListener('hashchange', () => {
      const main = document.getElementById('main');
      resolve({ record: !!main.querySelector('#batchForm'), loading: /Loading …/.test(main.textContent) });
    }, { once: true });
    location.hash = '#/formulation?batch=E2-F1';
  }));
  if (!seen.record || seen.loading) throw new Error(`a screen opened before should be drawn as the hash changes: ${JSON.stringify(seen)}`);
}
scenarios.push(loadedScreenDrawsAtOnce);

/**
 * The optimizer after the cycle 5 review, on the demo lab, which is put back as it was afterwards. An export
 * cancelled in the macOS app's save dialog does not say "exported". A typed recipe with the helper lipid below
 * its ordinary band is called unusual, not impossible. "Create an experiment" pressed again while the first is
 * still being written makes no second round, its buttons stay disabled through a redraw, and the runs it stores
 * carry the interval one batch should fall in, measurement noise included. Varying every lipid class leaves the
 * screen working: it used to throw on the map's text, and the fit button stayed disabled for good.
 */
export async function optimizerCreatesOnceAndSaysWhatItSaved({ page, open }) {
  const cols = ['experiments', 'batches', 'compositions', 'settings'];
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const before = Object.fromEntries(await Promise.all(cols.map(async (c) => [c, await readCol(page, c, 'lnp-demo')])));
  const restart = async () => { await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 }); };
  const fitted = () => page.waitForFunction(() => document.querySelector('#runBtn')?.textContent === 'Recalculate' && !document.querySelector('#runBtn').disabled, null, { timeout: 60000 });
  try {
    await writeCol(page, 'settings', before.settings.filter((x) => x.id !== 'mlSetup'), 'lnp-demo'); // the demo's own factor choice
    await restart();
    await open('ml');
    await page.click('#runBtn');
    await fitted();
    await expectText(page, '#main', /What to run next/, 'the demo lab gets suggestions');

    // the export: nothing said while the save dialog is cancelled, "exported" once a file is saved
    const exported = () => page.evaluate(() => !!document.querySelector('#toast [data-msg="Suggestions exported"]'));
    await page.evaluate(() => {
      window.__TAURI__ = { dialog: { save: async (o) => { await new Promise((r) => setTimeout(r, 200)); return window.__cancelSave ? null : `/Users/lab/${o.defaultPath}`; } }, fs: { writeFile: async () => {} } };
      window.__cancelSave = true;
    });
    try {
      await page.click('#exportCsv'); await page.waitForTimeout(500);
      if (await exported()) throw new Error('a cancelled save dialog still says "Suggestions exported"');
      await page.evaluate(() => { window.__cancelSave = false; });
      await page.click('#exportCsv');
      await page.waitForFunction(() => !!document.querySelector('#toast [data-msg="Suggestions exported"]'), null, { timeout: 3000 })
        .catch(() => { throw new Error('a saved export does not say so'); });
    } finally { await page.evaluate(() => { delete window.__TAURI__; delete window.__cancelSave; }); }

    // a typed recipe with the helper lipid at a few mol%: unusual, and a formulation all the same
    if (!(await page.locator('#mapFold').evaluate((d) => d.open))) await page.click('#mapFold > summary');
    const keys = await page.$$eval('#whatIfForm input', (xs) => xs.map((x) => x.name));
    for (const [k, v] of [['wi_ionizable_pct', '55'], ['wi_peg_pct', '2'], ['wi_sterol_pct', '39.5']]) {
      if (!keys.includes(k)) continue;
      await page.fill(`input[name=${k}]`, v);
      await page.dispatchEvent(`input[name=${k}]`, 'change');
      await page.waitForTimeout(300);
    }
    await expectText(page, '#mixNote', /^An unusual recipe: helper phospholipid would have to be [\d.]+ mol% to reach 100, outside the 5–20 mol% this module treats as ordinary\. That is a formulation/, 'a recipe below the band is unusual');
    await expectNoText(page, '#mlRoot', /cannot be weighed out|does not exist/, 'and nothing calls it impossible');

    // a second press while the first create is being written: hold the write, press, redraw, press again
    if ((await page.evaluate(() => window.lnpDb.engine())) === 'indexeddb') {
      await page.evaluate(() => {
        const orig = IDBDatabase.prototype.transaction;
        const held = [];
        window.__releaseWrites = () => { IDBDatabase.prototype.transaction = orig; held.splice(0).forEach((f) => f()); };
        IDBDatabase.prototype.transaction = function (...args) {
          const tx = orig.apply(this, args);
          if (args[1] !== 'readwrite') return tx;
          let fn = null;
          Object.defineProperty(tx, 'oncomplete', { configurable: true, get: () => fn, set: (f) => { fn = f; } });
          tx.addEventListener('complete', (e) => held.push(() => fn?.call(tx, e)));
          return tx;
        };
      });
      const rounds = async () => (await readCol(page, 'experiments', 'lnp-demo')).filter((e) => /^ML round/.test(e.name)).length;
      const was = await rounds();
      try {
        await page.click('#makeExp');
        await page.waitForTimeout(150);
        const disabled = () => page.$$eval('#makeExp, #addConfirm', (bs) => bs.map((b) => b.disabled));
        if ((await disabled()).some((d) => !d)) throw new Error('"Create an experiment" stays pressable while the first is being written');
        await page.selectOption('select[name=mode]', 'exploit'); // a redraw
        await page.waitForTimeout(400);
        if (!(await page.locator('#makeExp').count()) || (await disabled()).some((d) => !d)) throw new Error('a redraw during the write makes the create buttons pressable again');
        await page.evaluate(() => { const b = document.querySelector('#makeExp'); b.disabled = false; b.click(); }); // and if it were pressed all the same
      } finally { await page.evaluate(() => window.__releaseWrites()); }
      await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 5000 })
        .catch(async () => { throw new Error(`once stored, the new round did not open: ${await page.evaluate(() => location.hash)}`); });
      await page.evaluate(() => window.lnpDb.flush());
      if ((await rounds()) !== was + 1) throw new Error(`two presses during one write made ${(await rounds()) - was} rounds`);
      const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
      const runs = (await readCol(page, 'batches', 'lnp-demo')).filter((b) => b.experimentId === id);
      const preds = runs.flatMap((b) => Object.values(b.ml?.predicted || {}));
      if (!preds.length || preds.some((q) => !(q.noise > 0 && q.sd > q.noise))) throw new Error(`the runs should store the interval one batch falls in, noise included: ${JSON.stringify(preds.slice(0, 2))}`);
    }

    // every lipid class varied, the flow left out: no suggestions, the reason, and a screen that still works
    await open('ml'); // a fresh visit opens on the setup
    await page.check('input[name=s_on_helper_pct]'); await page.waitForTimeout(300);
    if (await page.locator('input[name=s_on_tfr]').isChecked()) { await page.uncheck('input[name=s_on_tfr]'); await page.waitForTimeout(300); }
    await page.click('#runBtn');
    await fitted().catch(() => { throw new Error('with every lipid class varied the fit never finishes: the button stays disabled'); });
    await expectText(page, '#mlRoot', /Every lipid class is varied/, 'the reason there is nothing to run');
    if (await page.locator('#mapFold').count()) {
      await page.click('#mapFold > summary');
      await expectText(page, '#mapFold', /Grey is where the lipids would not total 100 mol%/, 'the map says what its grey means');
    }
  } finally {
    await page.evaluate(() => { delete window.__TAURI__; }).catch(() => {});
    for (const c of cols) await writeCol(page, c, before[c], 'lnp-demo');
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(400);
  }
}
scenarios.push(optimizerCreatesOnceAndSaysWhatItSaved);


/**
 * Review of cycle 5: a QC limit emptied to be retyped, and the screen left for the results before the new one is
 * in, keeps the limit it had. It used to be stored as null, which every chart read as no limit while the stored
 * flags read "PDI 0.12 > null". A check is switched off with the box beside it, and then nothing is compared with it.
 */
export async function settingsLimitClearedToRetype({ page, open }) {
  const before = { settings: await readCol(page, 'settings'), measurements: await readCol(page, 'measurements'), batches: await readCol(page, 'batches') };
  const stored = async () => { await page.evaluate(() => window.lnpDb.flush()); return (await readCol(page, 'settings')).find((x) => x.id === 'default') || {}; };
  try {
    await open('settings');
    const limit = await page.inputValue('input[name=pdiMax]'), frr = await page.inputValue('input[name=defaultFRR]');
    for (const name of ['pdiMax', 'defaultFRR']) { await page.click(`input[name=${name}]`, { clickCount: 3 }); await page.keyboard.press('Backspace'); }
    await page.click('nav a.item[href="#/overview"]'); // to look at the recent PDIs before choosing the new limit
    await page.waitForTimeout(200);
    let s = await stored();
    if (String(s.qc?.pdiMax) !== limit || String(s.defaultFRR) !== frr) throw new Error(`fields emptied to be retyped should keep PDI max ${limit} and FRR ${frr}; stored ${s.qc?.pdiMax} and ${s.defaultFRR}`);
    await open('settings');
    await page.uncheck('[data-qcon=pdiMax]');
    await page.waitForTimeout(150);
    s = await stored();
    if (s.qc.pdiMax !== null) throw new Error(`the box should switch the PDI check off; stored ${s.qc.pdiMax}`);
    if (!(await page.isDisabled('input[name=pdiMax]')) || (await page.inputValue('input[name=pdiMax]')) !== '') throw new Error('a check switched off shows an empty field it does not take');
    // a result stored meanwhile is not compared with a limit that is off
    const batch = before.measurements.find((m) => m.batchId && m.test === 'dls')?.batchId;
    await open(`measurements?batch=${encodeURIComponent(batch)}`);
    await page.selectOption('select[name=test]', 'dls');
    await page.fill('input[name=run_z1]', '82'); await page.fill('input[name=run_p1]', '0.45');
    await page.click('#saveManual');
    await page.waitForTimeout(200);
    const flags = ((await readCol(page, 'measurements')).pop().flags || []).map((x) => x.text);
    if (flags.some((t) => /^PDI|null/.test(t))) throw new Error(`with the PDI check off, a PDI of 0.45 is flagged: ${flags.join('; ')}`);
    await open('settings');
    await page.check('[data-qcon=pdiMax]');
    await page.waitForTimeout(150);
    s = await stored();
    if (!Number.isFinite(s.qc.pdiMax) || String(s.qc.pdiMax) !== (await page.inputValue('input[name=pdiMax]'))) throw new Error(`switched back on, the field and the stored limit should agree on a number: ${s.qc.pdiMax}`);
  } finally {
    for (const [col, rows] of Object.entries(before)) await writeCol(page, col, rows);
  }
}
scenarios.push(settingsLimitClearedToRetype);

/**
 * Review of cycle 5: a link whose purpose is the results list ("show all" on a formulation's results, the
 * overview's "All results") opens it, and on a formulation's results a list closed by hand stays closed when a
 * save redraws the screen.
 */
export async function resultsListLinksOpenIt({ page, open }) {
  const before = { measurements: await readCol(page, 'measurements'), batches: await readCol(page, 'batches') };
  const isOpen = () => page.locator('#resultsList').evaluate((d) => d.open);
  try {
    const batch = before.measurements.find((m) => m.batchId)?.batchId;
    await open(`measurements?batch=${encodeURIComponent(batch)}`);
    if (!(await isOpen())) throw new Error('a formulation\'s results should open with the list open');
    await page.click('#resultsList > summary a:text("show all")');
    await page.waitForFunction(() => !/batch=/.test(location.hash));
    await page.waitForTimeout(150);
    if (!(await isOpen())) throw new Error(`"show all" should open every result, not a folded line (${await page.evaluate(() => location.hash)})`);
    await open('overview');
    if (await page.locator('#latestCard a:text("All results")').count()) {
      await page.click('#latestCard a:text("All results")');
      await page.waitForFunction(() => location.hash.startsWith('#/measurements'));
      await page.waitForTimeout(150);
      if (!(await isOpen())) throw new Error('the overview\'s "All results" should open the list');
    }
    await open(`measurements?batch=${encodeURIComponent(batch)}`);
    await page.click('#resultsList > summary h2');
    await page.waitForTimeout(100);
    if (await isOpen()) throw new Error('the list should close when its line is clicked');
    await page.selectOption('select[name=test]', 'dls');
    await page.fill('input[name=run_z1]', '82'); await page.fill('input[name=run_p1]', '0.1');
    await page.click('#saveManual');
    await page.waitForTimeout(200);
    if ((await readCol(page, 'measurements')).length !== before.measurements.length + 1) throw new Error('the result was not saved');
    if (await isOpen()) throw new Error('a list closed by hand opened again when the save redrew the screen');
  } finally {
    for (const [col, rows] of Object.entries(before)) await writeCol(page, col, rows);
  }
}
scenarios.push(resultsListLinksOpenIt);


/**
 * The page's own questions in the macOS app. tauri-plugin-dialog replaces window.confirm there with an async
 * function, so confirm() returned a promise, and `if (!confirm(…)) return` read it as yes: the lab deleted, a file
 * imported over it, the trash emptied, a result deleted, the settings reset, the demo rebuilt and a recipe not
 * summing to 100 % stored, before the question had even appeared and whatever was answered. This stands the
 * plugin's confirm, which answers a moment later, in a browser profile of its own, answers Cancel to each of those
 * and checks that nothing changed, then OK to one, which must go ahead. prompt(), which WKWebView answers with null
 * at once, is no longer what adding a lipid to a stock depends on.
 */
export async function questionsWaitForTheAnswer({ page, base, errors }) {
  const where = 'with the app\'s confirm';
  const ctx2 = await page.context().browser().newContext({ timezoneId: 'Europe/Berlin' });
  try {
    await ctx2.addInitScript(() => {
      localStorage.setItem('lnp-lab.demo', '1');
      // As tauri-plugin-dialog v2 has it (src/init-iife.js): async, resolving to the button pressed.
      window.__answer = false;
      window.confirm = async (m) => { (window.__asked ||= []).push(m); await new Promise((r) => setTimeout(r, 150)); return window.__answer; };
      window.prompt = () => null;
    });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errors.push(`${where}: pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`${where}: console: ${m.text()}`); });
    const NS = 'lnp-demo';
    const open = async (hash) => {
      await p2.goto(base + '#/' + hash);
      await p2.waitForFunction(() => window.__lnpStarted && document.querySelector('#main h1, #main .note'), null, { timeout: 15000 }).catch(() => errors.push(`${where}: no heading on ${hash}`));
      await p2.waitForTimeout(150);
    };
    const count = async (col) => (await readCol(p2, col, NS)).length;
    // The answer comes after 150 ms; by the end of this, whatever a yes does has had time to happen.
    const answered = async (question) => {
      await p2.waitForTimeout(600);
      const asked = await p2.evaluate(() => (window.__asked || []).splice(0));
      if (!asked.some((m) => question.test(m))) throw new Error(`${where}: ${question} was not asked (${JSON.stringify(asked)})`);
      return asked;
    };
    const same = (what, before, after) => {
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${where}: Cancel on "${what}" still went ahead: ${JSON.stringify(before)} became ${JSON.stringify(after)}`);
    };

    await open('settings');
    const pdiMax = async () => (await readCol(p2, 'settings', NS)).map((s) => s.qc?.pdiMax);
    await p2.fill('#pdiMax', '0.37'); await p2.dispatchEvent('#pdiMax', 'change'); await p2.waitForTimeout(300);
    const pdi0 = await pdiMax();
    await p2.click('#resetSettings'); await answered(/Reset all settings/);
    same('Reset to defaults', pdi0, await pdiMax());

    const exps = await readCol(p2, 'experiments', NS);
    await p2.check('#importReplace');
    await p2.setInputFiles('#importFile', { name: 'one.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ app: 'lnp-lab', version: 1, collections: { experiments: [exps[0]] } })) });
    await answered(/Replace all current data/);
    same('Replace all current data', exps.length, await count('experiments'));

    await p2.click('#clearAll');
    const asked = await answered(/Delete ALL data/);
    same('Delete ALL data', exps.length, await count('experiments'));
    if (asked.length !== 1) throw new Error(`${where}: after a No to "Delete ALL data" it went on to ask ${JSON.stringify(asked)}`);

    const m0 = (await readCol(p2, 'measurements', NS))[0];
    await open(`measurements?id=${m0.id}`);
    await p2.click('#del'); await answered(/Delete this result/);
    same('Delete this result', true, (await readCol(p2, 'measurements', NS)).some((m) => m.id === m0.id));

    await open('materials?tab=compositions');
    const comps = await count('compositions');
    const keys = await p2.evaluate(() => [...document.querySelectorAll('#compForm [name=k0] option')].map((o) => o.value).filter(Boolean).slice(0, 2));
    await p2.selectOption('#compForm [name=k0]', keys[0]); await p2.fill('#compForm [name=p0]', '40');
    await p2.selectOption('#compForm [name=k1]', keys[1]); await p2.fill('#compForm [name=p1]', '10');
    await p2.click('#addComp'); await answered(/Sum is 50\.0 %/);
    same('Save anyway', comps, await count('compositions'));

    // "Start over" rebuilds the demo by reloading the page; a flag set on this page is gone if it did.
    await p2.evaluate(() => { window.__notReloaded = true; });
    await p2.click('#demoReset'); await p2.waitForTimeout(1200);
    same('Start over', true, await p2.evaluate(() => window.__notReloaded === true).catch(() => false));
    await answered(/Throw away the demo lab/);

    await open('experiments?id=E1');
    await p2.click('#delExp'); await p2.waitForTimeout(300);
    const trash = await count('trash');
    if (!trash) throw new Error(`${where}: a deleted experiment did not go to the trash`);
    await open('settings');
    await p2.click('#emptyTrash'); await answered(/Erase the \d+ deleted item/);
    same('Empty trash', trash, await count('trash'));
    // And a yes is waited for too, and goes ahead.
    await p2.evaluate(() => { window.__answer = true; });
    await p2.click('#emptyTrash'); await answered(/Erase the \d+ deleted item/);
    if (await count('trash')) throw new Error(`${where}: OK on "Empty trash" did not empty it`);

    // Adding a lipid to a stock asked for its key through prompt(), which the app's window answers with null.
    await open('stocks?new=1');
    await p2.click('#saveStock');
    await p2.waitForFunction(() => /stocks\?id=/.test(location.hash), null, { timeout: 3000 }).catch(() => { throw new Error(`${where}: "Create stock" did not open the stock`); });
    await p2.waitForTimeout(300);
    const stock = (await readCol(p2, 'stocks', NS))[0];
    const free = await p2.evaluate(() => [...document.querySelectorAll('#addLipid option')].map((o) => o.value).filter(Boolean));
    if (!free.length) throw new Error(`${where}: no way to add a lipid to ${stock?.id} without prompt()`);
    await p2.selectOption('#addLipid', free[0]); await p2.waitForTimeout(500);
    const now = (await readCol(p2, 'stocks', NS)).find((s) => s.id === stock.id);
    if (!(free[0] in (now?.molPct || {}))) throw new Error(`${where}: ${free[0]}, chosen to add, is not in ${stock.id}'s recipe`);
  } finally { await ctx2.close(); }
}
scenarios.push(questionsWaitForTheAnswer);


/*
 * Review of cycle 5, records that store as typed: what a select, a second window, a second press or a full disk
 * did to what was typed, now that every change is stored at once.
 */

/** Dialogs answered `answer.now` ('accept' or 'dismiss') while `fn` runs; earlier scenarios' handlers set aside. */
async function answering(page, answer, fn) {
  const before = page.listeners('dialog');
  page.removeAllListeners('dialog');
  const asked = [];
  page.on('dialog', (d) => { asked.push(d.message()); (answer.now === 'accept' ? d.accept() : d.dismiss()).catch(() => {}); });
  try { return await fn(asked); } finally { page.removeAllListeners('dialog'); for (const l of before) page.on('dialog', l); }
}

/**
 * A select that would discard what was typed asks first. A made stock moved to another composition lost its
 * whole weigh-in, stored at once, and choosing the first composition again gave nothing back. Now the masses of
 * lipids in both recipes stay, and the others go only on a yes. On a formulation record, a lot chosen over a
 * concentration typed there replaced it unasked; now the lot is chosen and the typed value kept unless the
 * answer is yes.
 */
export async function selectsKeepWhatWasTyped({ page, open }) {
  const comps = await readCol(page, 'compositions'), batches = await readCol(page, 'batches');
  // a recipe without DSPC beside #1, for as long as this scenario runs
  await writeCol(page, 'compositions', [...comps, { id: 990, synonym: 'No helper', mol_pct: { MC3: 50, Chol: 48.5, DMG0PEG2000: 1.5 }, sum: 100 }]);
  const answer = { now: 'dismiss' };
  try {
    await answering(page, answer, async (asked) => {
      await open('stocks?new=1');
      await page.selectOption('select[name=compositionId]', '1');
      await page.waitForTimeout(150);
      const masses = { MC3: 0.3051, DSPC: 0.0744, Chol: 0.1415, DMG0PEG2000: 0.0359 };
      for (const [k, v] of Object.entries(masses)) await page.fill(`input[name=actual_${k}]`, String(v));
      await page.dispatchEvent('input[name=actual_DMG0PEG2000]', 'change');
      await page.click('#saveStock');
      await page.waitForFunction(() => /^#\/stocks\?id=/.test(location.hash), null, { timeout: 3000 });
      const id = await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('id'));
      const stock = async () => { await page.evaluate(() => window.lnpDb.flush()); return (await readCol(page, 'stocks')).find((s) => s.id === id); };
      if ((await stock())?.status !== 'made') throw new Error(`${id} should be made, every mass weighed`);

      await page.selectOption('select[name=compositionId]', '990');
      await page.waitForTimeout(300);
      if (!/^Composition #990 has no DSPC\. The mass weighed for this stock \(DSPC 0\.0744 g\) would be discarded\./.test(asked[0] || '')) throw new Error(`a composition without DSPC should ask before its mass goes: "${asked[0] || 'nothing asked'}"`);
      let s = await stock();
      if ((await page.inputValue('select[name=compositionId]')) !== '1' || s.compositionId !== 1 || s.status !== 'made' || s.actual.DSPC !== masses.DSPC) {
        throw new Error(`after "Cancel" the stock should be as it was: the select reads #${await page.inputValue('select[name=compositionId]')}, stored #${s.compositionId}, ${s.status}, ${JSON.stringify(s.actual)}`);
      }
      answer.now = 'accept';
      await page.selectOption('select[name=compositionId]', '990');
      await page.waitForTimeout(300);
      s = await stock();
      if (s.compositionId !== 990 || 'DSPC' in s.actual || s.actual.MC3 !== masses.MC3 || s.actual.Chol !== masses.Chol || s.actual.DMG0PEG2000 !== masses.DMG0PEG2000) {
        throw new Error(`after "OK" only DSPC's mass should go: #${s.compositionId}, ${JSON.stringify(s.actual)}`);
      }
      if ((await page.inputValue('input[name=actual_MC3]')) !== '0.3051') throw new Error('the weigh-in on the screen lost the masses that were kept');
      // and back to #1: nothing would be discarded, so nothing is asked, and DSPC is to be weighed again
      await page.selectOption('select[name=compositionId]', '1');
      await page.waitForTimeout(300);
      if (asked.length !== 2) throw new Error(`nothing was to be discarded, yet it asked: "${asked.at(-1)}"`);
      s = await stock();
      if (s.compositionId !== 1 || s.actual.MC3 !== masses.MC3 || s.actual.DSPC != null || s.status !== 'planned') throw new Error(`back on #1: ${s.compositionId}, ${s.status}, ${JSON.stringify(s.actual)}`);

      // a formulation record: an RNA concentration typed, then a lot chosen
      // one made by the full process: a quick one (the screens since the UX revision) has no RNA stock to dilute
      const b = batches.find((x) => x.status === 'planned' && x.plan?.mode !== 'quick' && !x.plan?.rna?.lotId && x.plan?.rna?.stock_mg_mL == null);
      if (!b) throw new Error('no planned formulation without an RNA lot to try the lot on');
      answer.now = 'dismiss';
      await open(`formulation?batch=${b.id}`);
      await setInput(page, 'rna_stock_mg_mL', '0.95');
      await setInput(page, 'rna_lotId', 'RNA-TEST-01');
      await page.waitForTimeout(300);
      if (!/^RNA stock conc\. on this record is 0\.95 mg\/mL, not RNA-TEST-01's 2\.06 mg\/mL\. Use 2\.06 mg\/mL\?$/.test(asked.at(-1))) throw new Error(`a lot chosen over a typed concentration should ask: "${asked.at(-1)}"`);
      await page.evaluate(() => window.lnpDb.flush());
      const r = (await readCol(page, 'batches')).find((x) => x.id === b.id);
      if (r.plan.rna.lotId !== 'RNA-TEST-01' || r.plan.rna.stock_mg_mL !== 0.95) throw new Error(`after "Cancel" the lot is chosen and the typed concentration kept: ${r.plan.rna.lotId} at ${r.plan.rna.stock_mg_mL} mg/mL`);
      if ((await page.inputValue('input[name=rna_stock_mg_mL]')) !== '0.95') throw new Error(`the record shows ${await page.inputValue('input[name=rna_stock_mg_mL]')} mg/mL`);
    });
  } finally {
    await writeCol(page, 'compositions', comps);
    await writeCol(page, 'batches', batches);
  }
}
scenarios.push(selectsKeepWhatWasTyped);

/**
 * One record open in two windows. Each auto-save wrote its window's whole copy, so the window opened first undid
 * what the other had stored, both said "Saved", and a stock moved to the trash in one came back with the other's
 * next keystroke. Since usability cycle 6 (W1) one window writes and the other only shows the records, until it
 * takes over; laying what was changed over the record as stored stays as a second line of defence. Here the two
 * windows hand the writing back and forth: each shows what the other stored, neither undoes it, and a record gone
 * to the trash stays there.
 */
export async function twoWindowsOnOneRecord({ page, open, base, errors }) {
  const batches = await readCol(page, 'batches'), stocks = await readCol(page, 'stocks'), trash = await readCol(page, 'trash');
  const b = batches.find((x) => x.status === 'planned' && x.plan?.mode !== 'quick'); // the full record, with its RNA input
  await open(`formulation?batch=${b.id}`);
  const p2 = await page.context().newPage();
  p2.on('pageerror', (e) => errors.push(`second window: ${e.message}`));
  // Who writes changes hands: each window draws its screen again, so the form is waited for after each change.
  const handOver = async (to, from) => {
    await to.click('#takeOver');
    await from.waitForSelector('#windowNote', { timeout: 6000 });
    await to.waitForSelector('#windowNote', { state: 'detached', timeout: 6000 });
    await to.waitForTimeout(150);
  };
  try {
    await p2.goto(base + `#/formulation?batch=${b.id}`);
    await p2.waitForFunction(() => window.__lnpStarted && document.querySelector('#batchForm'), null, { timeout: 15000 });
    await p2.waitForSelector('#windowNote', { timeout: 3000 }).catch(() => { throw new Error('the second window should open read-only'); });
    const stored = async (p = page) => (await readCol(p, 'batches')).find((x) => x.id === b.id);
    await setInput(page, 'rna_mass_mg', '4.2');
    await p2.waitForFunction(() => document.querySelector('input[name=rna_mass_mg]')?.value === '4.2', null, { timeout: 3000 })
      .catch(async () => { throw new Error(`the other window still shows an RNA input of ${await p2.inputValue('input[name=rna_mass_mg]')} mg after this one stored 4.2`); });
    if (!/another window/.test(await p2.locator('#saveState').innerText())) throw new Error(`the other window should say why its record changed: "${await p2.locator('#saveState').innerText()}"`);
    await handOver(p2, page);
    await p2.fill('textarea[name=notes]', 'from the second window'); await p2.dispatchEvent('textarea[name=notes]', 'change');
    await page.waitForFunction(() => document.querySelector('textarea[name=notes]')?.value === 'from the second window', null, { timeout: 3000 })
      .catch(() => { throw new Error('this window does not show the remark the other one stored'); });
    let s = await stored(p2);
    if (s.plan.rna.mass_mg !== 4.2 || s.notes !== 'from the second window') throw new Error(`the second window's save undid the first's: RNA input ${s.plan.rna.mass_mg} mg, remark "${s.notes}"`);
    await handOver(page, p2);
    await setInput(page, 'rna_working_mg_mL', '0.3');
    await page.evaluate(() => window.lnpDb.flush());
    s = await stored();
    if (s.notes !== 'from the second window' || s.plan.rna.mass_mg !== 4.2 || s.plan.rna.working_mg_mL !== 0.3) throw new Error(`this window's next change undid the other's: ${JSON.stringify({ notes: s.notes, rna: s.plan.rna })}`);

    // a stock open in both, moved to the trash in one: typing in the other does not bring it back
    const temp = { id: 'S-two-windows', compositionId: 1, molarity_mM: 50, volume_mL: 20, date: '2026-10-17', status: 'planned', molPct: { MC3: 50, DSPC: 10, Chol: 38.5, DMG0PEG2000: 1.5 }, actual: {}, lots: {}, notes: '' };
    await writeCol(page, 'stocks', [...stocks, temp]);
    await open(`stocks?id=${temp.id}`);
    await p2.evaluate((id) => { location.hash = `#/stocks?id=${id}`; }, temp.id);
    await p2.waitForSelector('#deleteStock', { timeout: 3000 });
    await handOver(p2, page);
    await p2.click('#deleteStock');
    await page.waitForFunction(() => /moved to the trash/.test(document.querySelector('#saveState')?.textContent || ''), null, { timeout: 3000 })
      .catch(async () => { throw new Error(`this window should say the stock is gone: "${await page.locator('#saveState').innerText()}"`); });
    // A window that only shows the records takes no typing into a record (main.js lockRecordFields).
    if (!(await page.locator('textarea[name=notes]').isDisabled())) throw new Error('a window that only shows the records should not take typing');
    await handOver(page, p2);
    await page.evaluate(() => window.lnpDb.flush());
    if ((await readCol(page, 'stocks')).some((x) => x.id === temp.id)) throw new Error('a stock moved to the trash in another window was stored again by this one');
  } finally {
    await p2.close();
    await page.waitForSelector('#windowNote', { state: 'detached', timeout: 6000 }).catch(() => {});
    await writeCol(page, 'batches', batches); await writeCol(page, 'stocks', stocks); await writeCol(page, 'trash', trash);
  }
}
scenarios.push(twoWindowsOnOneRecord);

/** IndexedDB writes reported stored `ms` later, as on a slow disk (0: at once). Gone with the next page load. */
const slowWrites = (page, ms) => page.evaluate((ms) => {
  window.__slowWrites = ms;
  if (window.__slowWritesOn) return;
  window.__slowWritesOn = true;
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (args[1] !== 'readwrite') return tx;
    let done = null;
    Object.defineProperty(tx, 'oncomplete', { configurable: true, get: () => done, set: (f) => { done = f; } });
    tx.addEventListener('complete', (e) => setTimeout(() => done?.call(tx, e), window.__slowWrites));
    return tx;
  };
}, ms);

/**
 * "Create experiment" pressed straight from a field, the common way: leaving the field redraws the form after the
 * click, and the redraw put back an enabled "Create experiment" while the first press was still being stored. A
 * second press made a second experiment. The button now says "Creating …" through the redraw; "Create stock",
 * which now also waits for its write, the same.
 */
export async function createPressedTwiceMakesOne({ page, open }) {
  const pressTwice = async (button, word, landed) => {
    await slowWrites(page, 400);
    try {
      await page.click(button);
      await page.waitForTimeout(150);
      const b = await page.evaluate((sel) => { const x = document.querySelector(sel); return x && { disabled: x.disabled, text: x.textContent }; }, button);
      if (b && (!b.disabled || !b.text.includes(word))) throw new Error(`while the write is stored, ${button} should read "${word}" and be disabled: ${JSON.stringify(b)}`);
      await page.waitForFunction(landed, null, { timeout: 4000 });
    } finally { await slowWrites(page, 0); }
    await page.evaluate(() => window.lnpDb.flush());
  };
  await open('experiments?new=1&type=single');
  await page.fill('input[name=name]', 'Pressed twice');
  await page.click('input[name=rna_mg]', { clickCount: 3 });
  await page.keyboard.type('2.5'); // still in the field: pressing the button is what leaves it
  await pressTwice('#createExp', 'Creating …', () => /^#\/experiments\?id=E\d+$/.test(location.hash));
  const n = (await readCol(page, 'experiments')).filter((e) => e.name === 'Pressed twice').length;
  if (n !== 1) throw new Error(`one press and a press during the write made ${n} experiments`);

  const before = (await readCol(page, 'stocks')).length;
  await open('stocks?new=1');
  await page.click('input[name=molarity_mM]', { clickCount: 3 });
  await page.keyboard.type('33');
  await pressTwice('#saveStock', 'Creating …', () => /^#\/stocks\?id=Stock-\d+$/.test(location.hash));
  if ((await readCol(page, 'stocks')).length !== before + 1) throw new Error('"Create stock" pressed during its write made a second stock');
}
scenarios.push(createPressedTwiceMakesOne);

/**
 * "Create stock" and "Save lot" on a full disk. They dropped the draft and opened the new record before the write
 * was known to be stored, so a reload lost both the record and the draft. Now they do as the wizard does: the
 * write is undone, the form stays with its draft, and the note names the button to press again.
 */
export async function failedCreateKeepsStockAndLot({ page, open }) {
  for (const { hash, field, value, button, col, draftKey, landed, what } of [
    { hash: 'stocks?new=1', field: 'molarity_mM', value: '21.5', button: '#saveStock', col: 'stocks', draftKey: 'lnp-lab.draft.stock', landed: /^#\/stocks\?id=Stock-\d+$/, what: /The new stock Stock-\d+ was undone[\s\S]*press “Create stock” again/ },
    { hash: 'buffers?new=1', field: 'conc_mM', value: '35', button: '#saveBuffer', col: 'buffers', draftKey: 'lnp-lab.draft.buffer', landed: /^#\/buffers\?id=Buffer-\d+$/, what: /The new lot Buffer-\d+ was undone[\s\S]*press “Save lot” again/ },
  ]) {
    const before = (await readCol(page, col)).length;
    await open(hash);
    await page.fill(`input[name=${field}]`, value); await page.dispatchEvent(`input[name=${field}]`, 'change');
    await page.waitForTimeout(150);
    const draft = () => page.evaluate((k) => sessionStorage.getItem(k), draftKey);
    if (!(await draft())) throw new Error(`${hash}: no draft kept of what was typed`);
    await page.evaluate(() => window.lnpDb.failWrites('QuotaExceededError'));
    try {
      await page.click(button);
      await page.waitForSelector('#storageNote', { timeout: 3000 }).catch(() => { throw new Error(`${hash}: no note when the record could not be stored`); });
      await page.waitForTimeout(300);
      const note = await page.locator('#storageNote').innerText();
      if (!what.test(note)) throw new Error(`${hash}: the note: "${note}"`);
      const at = await page.evaluate(() => location.hash);
      if (at !== '#/' + hash) throw new Error(`${hash}: the form moved on to ${at} with nothing stored`);
      if ((await page.inputValue(`input[name=${field}]`)) !== value) throw new Error(`${hash}: what was typed is gone`);
      if (!(await draft())) throw new Error(`${hash}: the draft went with a record that was not stored`);
      if ((await readCol(page, col)).length !== before) throw new Error(`${hash}: on record although it was not stored`);
      if (await page.locator(`${button}:disabled`).count()) throw new Error(`${hash}: ${button} stays disabled after the failure`);
    } finally {
      await page.evaluate(() => window.lnpDb.failWrites(null));
    }
    await page.click(button);
    await page.waitForFunction((re) => new RegExp(re).test(location.hash), landed.source, { timeout: 3000 })
      .catch(async () => { throw new Error(`${hash}: with room again, ${button} did not open the new record: ${await page.evaluate(() => location.hash)}`); });
    if (await draft()) throw new Error(`${hash}: the draft stays once the record is stored`);
  }
}
scenarios.push(failedCreateKeepsStockAndLot);

/**
 * A draft continued days later. It brought back the start date it was typed on, and the ids of what it named:
 * a stock deleted since read "— choose later —" in the select while the formulations were created with its id.
 * Now what is no longer on record is left out, a date that has passed is today, and the note says so.
 */
export async function continuedDraftIsMadeToday({ page, open }) {
  const stocks = await readCol(page, 'stocks');
  await writeCol(page, 'stocks', [...stocks, { id: 'S-drafted', compositionId: 1, molarity_mM: 50, status: 'planned' }]);
  await open('experiments?new=1&type=single');
  await page.fill('input[name=name]', 'Drafted a while ago');
  await page.selectOption('select[name=stockId]', 'S-drafted');
  await page.waitForTimeout(150);
  // the draft as it is some days later: started on a day that has passed, its stock gone meanwhile
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lnp-lab.draft.experiment.single') && JSON.parse(localStorage.getItem(x)).state?.name === 'Drafted a while ago');
    const d = JSON.parse(localStorage.getItem(k)); d.state.startDate = '2026-10-01'; localStorage.setItem(k, JSON.stringify(d));
  });
  await writeCol(page, 'stocks', stocks);
  await open('experiments?new=1');
  await page.locator('[data-draft="single"]', { hasText: 'Drafted a while ago' }).locator('a.btn').click();
  await page.waitForSelector('#draftOn', { timeout: 3000 });
  await expectText(page, '#draftOn', /It named lipid stock S-drafted, no longer on record, which the form below leaves out\. Its start date, 01 Oct 2026, has passed: it starts today\./, 'the note says what the continued draft left out');
  if ((await page.$eval('select[name=stockId]', (s) => s.value)) !== '') throw new Error('the stock select should be left to choose');
  if ((await page.inputValue('input[name=startDate]')) !== '2026-10-17') throw new Error(`a start date that has passed should be today: ${await page.inputValue('input[name=startDate]')}`);
  await page.click('#createExp');
  await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 3000 });
  await page.evaluate(() => window.lnpDb.flush());
  const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
  const e = (await readCol(page, 'experiments')).find((x) => x.id === id);
  const forms = (await readCol(page, 'batches')).filter((x) => x.experimentId === id);
  if (e.startDate !== '2026-10-17' || forms.some((x) => x.stockId) || forms.some((x) => x.plannedDate < '2026-10-17')) {
    throw new Error(`created from the draft: starts ${e.startDate}, formulations ${JSON.stringify(forms.map((x) => [x.stockId, x.plannedDate]))}`);
  }
}
scenarios.push(continuedDraftIsMadeToday);

/**
 * Creating without typing anything dropped whatever draft of that kind there was: the draft offered above a
 * "Repeat as new", or above a recipe handed over to a new stock, was gone once that was created untouched. Now
 * each form drops only the draft it continued or wrote.
 */
export async function createDropsOnlyItsOwnDraft({ page, open }) {
  const src = (await readCol(page, 'experiments')).find((x) => x.type === 'single');
  if (src) {
    await open('experiments?new=1&type=single');
    await page.fill('input[name=name]', 'My half-planned run'); await page.dispatchEvent('input[name=name]', 'change');
    await page.waitForTimeout(150);
    await open(`experiments?new=1&type=single&from=${src.id}`);
    // Its own draft, by name: an earlier scenario's undone create waits as a draft of the same type too.
    const mine = page.locator('[data-draft="single"]', { hasText: 'My half-planned run' });
    if (!(await mine.count())) throw new Error('the repeat does not offer the draft above it');
    if (!/Anything typed below is kept as a new one beside it/.test(await mine.first().innerText())) throw new Error(`the draft's note: ${await mine.first().innerText()}`);
    await page.click('#createExp');
    await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 3000 });
    await open('experiments?new=1');
    if (!(await page.locator('[data-draft="single"]', { hasText: 'My half-planned run' }).count())) throw new Error('a repeat created untouched should leave the draft that was offered above it');
    // the form that goes on with it takes it when it creates
    await page.locator('[data-draft="single"]', { hasText: 'My half-planned run' }).locator('a.btn').click();
    await page.waitForSelector('#draftOn', { timeout: 3000 });
    await page.click('#createExp');
    await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 3000 });
    await open('experiments?new=1');
    if (await page.locator('[data-draft="single"]', { hasText: 'My half-planned run' }).count()) throw new Error('a draft continued and created is still offered');
  }
  await open('stocks?new=1');
  await page.fill('input[name=molarity_mM]', '12.5'); await page.dispatchEvent('input[name=molarity_mM]', 'change');
  await page.waitForTimeout(150);
  await open(`stocks?new=1&compositionId=1&mol=${encodeURIComponent(JSON.stringify({ MC3: 50, DSPC: 10, Chol: 38, DMG0PEG2000: 2 }))}`);
  await page.click('#saveStock');
  await page.waitForFunction(() => /^#\/stocks\?id=Stock-\d+$/.test(location.hash), null, { timeout: 3000 });
  await open('stocks');
  await expectText(page, '#stockDraftNote', /12\.5 mM/, 'a handed-over recipe created untouched leaves the stock draft offered');
  await page.click('#stockDraftDrop');
}
scenarios.push(createDropsOnlyItsOwnDraft);

/*
 * Usability cycle 6, imports you can trust: runs grouped only where the names say so (I4), the same file caught
 * by its fingerprint (I5), what is kept of the file (I6), and QC limits switched off said as such (Q1).
 */

/**
 * "LNP-1", "LNP-2" and "LNP-3" were read as three runs of one sample "LNP" and averaged; the app's own names
 * with a run number after them are still grouped, and the preview shows both. A file imported once goes in a
 * second time only when the person answers that they mean it.
 */
export async function importsGroupOnlyRunsAndCatchRepeats({ page, open }) {
  const exp = await newRepeats(page, open, 'Runs and repeats', 2);
  const [a, b] = [...new Set(exp.expected.filter((s) => s.test === 'dls').map((s) => s.sampleName))];
  // Opening the screen already shown does not draw it again, so each paste starts from another one.
  const paste = async (lines) => {
    await open('overview'); await open('measurements');
    await page.click('#main details:has(#pasteBox) > summary');
    await page.fill('#pasteBox', lines.join('\n')); await page.click('#pasteGo'); await page.waitForTimeout(400);
  };
  const head = 'Sample Name\tZ-Average (d.nm)\tPdI';
  await paste([head, 'LNP-1\t80\t0.1', 'LNP-2\t120\t0.2', 'LNP-3\t160\t0.3', `${a} 1\t81.1\t0.08`, `${a} 2\t82.2\t0.09`, `${a} 3\t83.3\t0.10`, `${b} (1)\t90.0\t0.1`]);
  await expectText(page, '#importReadAs', /7 rows → 5 samples/, 'three formulations stay three samples, and the runs of the app\'s own samples are grouped');
  const firstCells = await page.evaluate(() => [...document.querySelectorAll('#importPreview tbody tr')].map((r) => r.cells[0].innerText.replace(/\s+/g, ' ').trim()));
  const want = ['LNP-1', 'LNP-2', 'LNP-3', `${a} from ${a} 1, ${a} 2, ${a} 3`, `${b} from ${b} (1)`];
  if (JSON.stringify(firstCells) !== JSON.stringify(want)) throw new Error(`the preview's samples: ${JSON.stringify(firstCells)}, expected ${JSON.stringify(want)}`);
  await expectText(page, '#importApart', /Read as separate samples: LNP-1, LNP-2, LNP-3\./, 'the names kept apart are named');
  await expectText(page, '#importKept', /SHA-256 of the pasted rows, not the rows themselves: keep the instrument’s file/, 'the preview says what is kept of what was imported');
  await expectNoText(page, '#importPreview', /kept by hash/, 'and no longer that the raw file is kept');

  // I5: the same rows twice
  const rows = [head, `${a} 1\t81.1\t0.08`, `${a} 2\t82.2\t0.09`, `${a} 3\t83.3\t0.10`, `${b}\t90.0\t0.1`];
  await paste(rows);
  if (await page.locator('#importDup').count()) throw new Error('rows never imported are called a repeat');
  await page.click('#doImport');
  await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
  const hash = (await latestImport(page)).sha256;
  const fromIt = async () => (await storedMeasurements(page)).filter((m) => m.raw?.sha256 === hash);
  const first = await fromIt();
  if (first.length !== 2 || first.find((m) => m.sampleName === a)?.values.runs?.length !== 3) throw new Error(`the first import: ${JSON.stringify(first.map((m) => [m.sampleName, m.values.runs?.length]))}`);
  const imports = (await readCol(page, 'imports')).length;
  await paste(rows);
  await expectText(page, '#importDup', /These rows were imported on \d{2} \w{3} \d{4} \(2 results\), so nothing below is ticked/, 'the preview says the rows were imported before');
  const ticks = () => page.evaluate(() => [...document.querySelectorAll('#importPreview [data-imp]')].map((x) => x.checked));
  if ((await ticks()).some(Boolean)) throw new Error('a repeat is ticked for import');
  await page.click('#doImport'); await page.waitForTimeout(300);
  await expectText(page, '#toast', /Nothing was imported: these rows were imported before/, 'Import selected with nothing ticked says why');
  await answering(page, { now: 'dismiss' }, async (asked) => {
    await page.check('#importPreview [data-imp="0"]');
    await page.click('#doImport'); await page.waitForTimeout(300);
    if (!/imported on .*2 results from them are stored\. Import them again\?/.test(asked.join(' '))) throw new Error(`a row ticked by hand was not asked about: ${JSON.stringify(asked)}`);
    await page.click('#importAgain'); await page.waitForTimeout(200);
  });
  if ((await fromIt()).length !== 2 || (await readCol(page, 'imports')).length !== imports) throw new Error('a repeat declined was stored');
  await answering(page, { now: 'accept' }, async (asked) => {
    await page.click('#importAgain'); await page.waitForTimeout(200);
    if (!(await ticks()).every(Boolean)) throw new Error('“Import them again” answered yes did not tick the rows');
    await expectText(page, '#importDup', /Importing them again/, 'and says what will happen');
    const n = asked.length;
    await page.click('#doImport');
    await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
    if (asked.length !== n) throw new Error('asked a second time after answering yes');
  });
  if ((await fromIt()).length !== 4) throw new Error(`imported again on purpose, ${(await fromIt()).length} results carry the fingerprint`);
}
scenarios.push(importsGroupOnlyRunsAndCatchRepeats);

/** Q1: with QC limits switched off, the import's evaluation and the Overview say only what was checked. */
export async function qcLimitsOffAreNotClaimed({ page, open }) {
  const before = await readCol(page, 'settings');
  const cur = before.find((s) => s.id === 'default') || { id: 'default' };
  const setQc = (qc) => writeCol(page, 'settings', [...before.filter((s) => s.id !== 'default'), { ...cur, qc: { ...(cur.qc || {}), ...qc } }]);
  try {
    const exp = await newRepeats(page, open, 'Limits off', 2);
    const name = exp.expected.find((s) => s.test === 'ee' && exp.expected.some((d) => d.test === 'dls' && d.sampleName === s.sampleName)).sampleName;
    await setQc({ eeMin: null });
    await open('measurements');
    await page.click('#main details:has(#pasteBox) > summary');
    // a size, a PDI and an EE of one vial, without a count rate
    await page.fill('#pasteBox', `Sample Name\tZ-Average (d.nm)\tPdI\tEE (%)\n${name}\t85.0\t0.10\t55.0`); await page.click('#pasteGo'); await page.waitForTimeout(400);
    await page.click('#doImport');
    await page.waitForFunction(() => /evaluated=/.test(location.hash) && document.querySelector('#importEval'), null, { timeout: 5000 });
    await expectText(page, '#importEval p', /every sample is inside the QC limits in Settings for size and PDI\./, 'the evaluation names the limits it checked, and no count rate the data does not have');
    await expectText(page, '#importEval p', /EE has no QC limit switched on in Settings, so it was not checked against one/, 'and says the EE was not checked');
    await setQc({ zaveMin: null, zaveMax: null, pdiMax: null, countRateMin: null, eeMin: null });
    await open('overview');
    await expectText(page, '#latestSentence', /^No QC limit for size or PDI is switched on in Settings/, 'the Overview judges nothing against limits that are off');
    await expectNoText(page, '#latestCard', /shaded band/, 'and its caption promises no band');
    await setQc({ zaveMin: 40, zaveMax: 150, pdiMax: null });
    await open('settings'); await open('overview');
    await expectText(page, '#latestSentence', /inside the QC limits for size[;.]/, 'with the PDI limit off, only size is named');
    await expectNoText(page, '#latestSentence', /PDI/, 'and the PDI not at all');
  } finally {
    await writeCol(page, 'settings', before);
  }
}
scenarios.push(qcLimitsOffAreNotClaimed);


// ---- Insights at matched settings (usability cycle 6, I1) ----

/**
 * I1: two stock lots made side by side at the reference recipe, three batches each, Stock-902 about 5 nm larger,
 * and a process screen on Stock-901 whose settings move the size from 58 to 124 nm. Judged against the spread of
 * every batch, the lot effect was "within the noise" (and reversed), and the screen's corners sat "outside the
 * control limits". Compared at the same settings it is found, with its interval and the scatter of the repeats,
 * and the control chart holds the reference batches until it is widened. The records sit under a composition of
 * their own, so the view holds nothing else, and the lab is put back afterwards.
 */
export async function insightsLotAtMatchedSettings({ page, open }) {
  const cols = ['experiments', 'batches', 'measurements'];
  const kept = {};
  for (const c of cols) kept[c] = await readCol(page, c);
  const plan = (frr, totalFlow) => ({ rna: { np: null, working_mg_mL: 0.4, mass_mg: 3 }, mixing: { frr, totalFlow, quenchFactor: 2, lipidStock_mM: 50 }, downstream: {}, factors: {} });
  const ref = [[80, 'Stock-901'], [81, 'Stock-901'], [79.5, 'Stock-901'], [85, 'Stock-902'], [86, 'Stock-902'], [85.5, 'Stock-902']];
  const screen = [[2, 60, 124], [4, 60, 71.5], [2, 120, 112], [4, 120, 58], [3, 60, 97], [3, 120, 83], [2, 90, 118], [4, 90, 66], [2.5, 75, 105], [3.5, 105, 74]];
  const batch = (exp, i, stockId, p, day) => ({ id: `${exp}-F${i + 1}`, experimentId: exp, compositionId: 901, stockId, status: 'produced', plannedDate: day, plan: p, actual: {}, notes: '' });
  const bs = [...ref.map(([, lot], i) => batch('E901', i, lot, plan(3, 112.5), `2026-03-0${i + 1}`)),
    ...screen.map(([frr, flow], i) => batch('E902', i, 'Stock-901', plan(frr, flow), `2026-02-${10 + i}`))];
  const sizes = [...ref.map(([v]) => v), ...screen.map(([, , v]) => v)];
  const ms = bs.map((b, i) => ({ id: `M-${b.id}`, batchId: b.id, test: 'dls', stage: 'final', sampleName: `${b.id}_final`, date: b.plannedDate, createdAt: `${b.plannedDate}T12:00:00Z`, values: { zave_nm: sizes[i], pdi: 0.1 } }));
  const exp = (id, type, name, list) => ({ id, type, name, status: 'done', startDate: list[0].plannedDate, compositionId: 901, batchIds: list.map((b) => b.id), expected: [], design: {}, spec: {} });
  try {
    await writeCol(page, 'experiments', [...kept.experiments, exp('E901', 'reference', 'Lots side by side', bs.slice(0, 6)), exp('E902', 'doe', 'Process screen', bs.slice(6))]);
    await writeCol(page, 'batches', [...kept.batches, ...bs]);
    await writeCol(page, 'measurements', [...kept.measurements, ...ms]);
    await open('insights?comp=901&colorBy=stockId');
    const items = await page.$$eval('#insightSummary li', (li) => li.map((x) => x.textContent.trim()));
    // by hand: 85.5 − 80.17 at the one setting both lots ran; SD from the two cells of repeats, 0.65 nm on 4 df
    if (items[0] !== 'At the same settings, Stock-902 batches are 5.3 nm larger than Stock-901 (n 3 vs 3; 95 % CI 3.9 to 6.8 nm), about 8.3 × the batch-to-batch SD of 0.6 nm.') throw new Error(`the lot sentence: "${items[0]}"`);
    if (!/^All 6 points on the chart sit inside the control limits/.test(items[2] || '')) throw new Error(`the limits sentence: "${items[2]}"`);
    await expectText(page, '#chartNote', /^6 batches made at the setting of the reference experiments: #901 · FRR 3 · flow 112\.5 mL\/min[\s\S]*The other 10 in view were made at other settings and are left off/, 'the chart says what it holds');
    const dots = () => page.locator('#main svg[aria-label$="per batch over time"] circle').count();
    if (await dots() !== 6) throw new Error(`the chart should hold the 6 reference batches, it has ${await dots()}`);
    // widened to every batch, the screen's corners are back, and the note says what they are
    await page.selectOption('select[name=chart]', 'all');
    await page.waitForTimeout(400);
    if (await dots() !== 16) throw new Error(`widened, the chart should hold all 16 batches, it has ${await dots()}`);
    await expectText(page, '#chartNote', /^Every batch in view \(16\), whatever its settings[\s\S]*a corner of a design rather than a bad batch/, 'widened, it says what the limits now are');
    await expectText(page, '#insightSummary', /^What this shows\s+At the same settings, Stock-902 batches are 5\.3 nm larger/, 'widening the chart does not change the lot comparison');
  } finally {
    for (const c of cols) await writeCol(page, c, kept[c]);
  }
}
scenarios.push(insightsLotAtMatchedSettings);

// ---- The DoE screen in lab words, and shorter at the top (usability cycle 6, I2 and L1) ----

/**
 * I2: the demo response surface names its factors FRR, flow_rate and PEG_mol_pct, the identifiers its CSV needs.
 * Everywhere a person reads them on Design & results (the recommendation, the drivers, the plots, the run table,
 * the coefficients and the one-response optimum) they are FRR, total flow and PEG mol%, as on the rest of the app.
 * L1: what leads the page (the design line, the recommendation, the drivers) is shorter, and none of the verdict,
 * the recommendation or the drivers is hidden for it.
 */
export async function doeInLabWords({ page, open }) {
  const words = (sel) => page.locator(sel).first().innerText().then((t) => t.split(/\s+/).filter(Boolean).length);
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  try {
    await open('doe?id=E4&response=particle_size_nm');
    for (const f of ['#plotsFold', '#runsFold', '#coefFold']) if (!(await page.locator(f).evaluate((d) => d.open))) await page.click(`${f} > summary`);
    await page.waitForTimeout(200);
    const codes = /flow_rate|PEG_mol_pct|NP_ratio|quench_factor/;
    for (const sel of ['#balanceCard', '#driversCard', '#fitCard', '#runsFold', '#coefFold']) await expectNoText(page, sel, codes, `${sel} names a factor by its identifier`);
    const options = await page.$$eval('#fitCard select[name=fa] option', (o) => o.map((x) => x.textContent));
    if (options.join('|') !== 'FRR|total flow|PEG mol%') throw new Error(`the surface's factor choices: ${options.join('|')}`);
    await expectText(page, '#driversCard', /Size (falls|rises) with [^;]*(total flow|PEG mol%)/, 'the drivers in the lab\'s words');
    await expectText(page, '#balanceCard', /total flow\s+\d+ mL\/min[\s\S]*PEG mol%\s+[\d.]+ mol%/, 'the recommended setting in the lab\'s words');
    await expectText(page, '#coefFold', /FRR × total flow[\s\S]*\(PEG mol%\)²/, 'the model terms in the lab\'s words');
    // the CSV that goes to doe-pipeline keeps the identifiers its columns need
    await page.click('#exportFold > summary');
    const { readFileSync } = await import('node:fs');
    const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#expDesign')]);
    const head = readFileSync(await csv.path(), 'utf8').split(/\r?\n/)[0];
    if (!/FRR,flow_rate,PEG_mol_pct/.test(head)) throw new Error(`the design CSV header: ${head}`);
    // L1: the design is one line once there are results; the recommendation and the drivers are shorter, and
    // all three of the verdict, the recommendation and a sentence per response are still on the page
    await open('doe?id=E4&response=particle_size_nm');
    const lead = (await words('#designLine')) + (await words('#balanceCard')) + (await words('#driversCard'));
    if (lead > 330) throw new Error(`the top of the page is ${lead} words (389 before cycle 6)`);
    await expectText(page, '#balanceCard', /Overall score\s*0\.\d\d/, 'the recommendation is there');
    if (await page.locator('#driversCard li').count() !== 3) throw new Error('a sentence per response');
    if (!(await page.locator('#fitVerdict').isVisible())) throw new Error('the verdict on the fit is there');
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(500);
  }
}
scenarios.push(doeInLabWords);


/**
 * Usability cycle 6, I7: "Prepare" on a common buffer opens the designer with that buffer's own system, pH,
 * concentration and additives. It used to fill in the name and roles only, so "Citrate 25 mM, pH 4.0" opened as
 * acetate pH 5.5, 50 mM. Histidine is offered in the simple view too, since two of the common buffers use it.
 */
export async function commonBufferOpensItsRecipe({ page, open }) {
  const form = () => page.evaluate(() => ({ system: document.querySelector('select[name=system]')?.value, pH: document.querySelector('input[name=targetPH]')?.value,
    mM: document.querySelector('input[name=conc_mM]')?.value, nacl: document.querySelector('input[name=nacl_mM]')?.value, sucrose: document.querySelector('input[name=sucrose_mM]')?.value,
    predicted: document.querySelector('#bufferResult .kpi .v')?.textContent }));
  await open('buffers');
  // The common buffers are grouped by role now; each link carries its place in the catalogue (from=i).
  const names = await page.$$eval('#catalogList a.bufPrep', (as) => { const out = []; for (const a of as) out[Number(a.dataset.from)] = a.textContent; return out; });
  const want = { 'Citrate 25 mM, pH 4.0': ['Citric acid', '4', '25', '0', '0'], 'HEPES 20 mM, 150 mM NaCl, pH 7.4': ['HEPES', '7.4', '20', '150', '0'],
    'Histidine 10 mM, 300 mM sucrose, pH 6.5': ['Histidine', '6.5', '10', '0', '300'] };
  for (const [name, [system, pH, mM, nacl, sucrose]] of Object.entries(want)) {
    const i = names.indexOf(name);
    if (i < 0) throw new Error(`"${name}" is not among the common buffers`);
    await open(`buffers?new=1&from=${i}`);
    const f = await form();
    if (f.system !== system || f.pH !== pH || f.mM !== mM || f.nacl !== nacl || f.sucrose !== sucrose) throw new Error(`"${name}" opened as ${JSON.stringify(f)}`);
    if (f.predicted !== Number(pH).toFixed(2)) throw new Error(`"${name}": the recipe comes to pH ${f.predicted}`);
  }
}
scenarios.push(commonBufferOpensItsRecipe);

/**
 * Usability cycle 6, I3: a "Deleted … Undo" note goes with the user to the screen the delete leads to, where its
 * Undo works, and no further: it used to follow them to every screen for its 10 s and sit over the charts there.
 * Plain notes that come after it do not push it out before its time.
 */
export async function undoNoteGoesWithOneScreen({ page, open }) {
  const before = { buffers: await readCol(page, 'buffers'), trash: await readCol(page, 'trash') };
  const lot = { id: 'Buffer-901', lot: 'Buffer-901', name: 'Undo note check', system: 'Acetic acid', method: 'auto', targetPH: 5, conc_mM: 25, volume_mL: 100, nacl_mM: 0, sucrose_mM: 0, activity: true, roles: [], date: '2026-10-17' };
  const undo = () => page.locator('#toast .note', { hasText: 'Deleted Buffer-901' });
  try {
    await writeCol(page, 'buffers', [...before.buffers, lot]);
    for (const leave of [true, false]) {
      await open('buffers?id=Buffer-901');
      await page.click('#deleteBuffer');
      await page.waitForFunction(() => location.hash === '#/buffers', null, { timeout: 3000 });
      if (!(await undo().count())) throw new Error('the Undo note did not reach the screen the delete led to');
      if (leave) {
        await open('calendar');
        if (await undo().count()) throw new Error('the Undo note followed the user to the next screen');
        await open('buffers');
        if (await undo().count()) throw new Error('the Undo note came back');
        await open('settings');
        await page.locator('tr', { hasText: 'Buffer-901 · Undo note check' }).locator('button[data-restore]').click();
        await page.waitForFunction(() => window.lnpDb.read('buffers').then((b) => b.some((x) => x.id === 'Buffer-901')), null, { timeout: 3000 });
      } else {
        await page.evaluate(async () => { const { toast } = await import('./app/ui/kit.js'); for (const m of ['one', 'two', 'three']) toast(m); });
        if (!(await undo().count())) throw new Error(`three plain notes pushed the Undo out: "${await page.locator('#toast').innerText()}"`);
        await undo().locator('button[data-toast-action="Undo"]').click();
        await page.waitForFunction(() => location.hash === '#/buffers?id=Buffer-901', null, { timeout: 3000 });
      }
    }
  } finally {
    await writeCol(page, 'buffers', before.buffers);
    await writeCol(page, 'trash', before.trash);
    await open('overview');
  }
}
scenarios.push(undoNoteGoesWithOneScreen);

/**
 * Usability cycle 6, I9: the wizard's sample-name example carries the number the experiment will get, not E0; the
 * correction form shows a mean of runs as a person would write it, not 83.14666667; a potency result has a value
 * in the Result column; and an export of the demo is not counted as the real lab's.
 */
export async function smallThingsOfCycle6({ page, open }) {
  await open('experiments?new=1&type=single');
  const example = await page.evaluate(() => [...document.querySelectorAll('#previewBody .kpi')].find((k) => /Sample name/i.test(k.textContent))?.querySelector('.v')?.textContent || '');
  const ids = (await readCol(page, 'experiments')).map((e) => Number(e.id.slice(1))).filter(Number.isFinite);
  if (!/^E[1-9]\d*-F1_/.test(example) || Number(/^E(\d+)/.exec(example)[1]) <= Math.max(0, ...ids)) {
    throw new Error(`the sample name example reads "${example}" with ${ids.length} experiments on record`);
  }

  const before = await readCol(page, 'measurements');
  const m = { id: 'm-c6-mean', batchId: 'E901-F1', sampleName: 'E901-F1_final', test: 'dls', stage: 'final', date: '2026-10-17', createdAt: '2026-10-17T10:00:00Z',
    values: { zave_nm: (83.1 + 83.2 + 83.14) / 3, pdi: (0.121 + 0.13 + 0.125) / 3, runs: [{ zave_nm: 83.1, pdi: 0.121 }, { zave_nm: 83.2, pdi: 0.13 }, { zave_nm: 83.14, pdi: 0.125 }] } };
  try {
    await writeCol(page, 'measurements', [...before, m]);
    await open('measurements?id=m-c6-mean');
    await page.click('#editResult');
    const shown = [await page.inputValue('input[name=e_zave_nm]'), await page.inputValue('input[name=e_pdi]')];
    if (shown[0] !== '83.147' || shown[1] !== '0.1253') throw new Error(`the correction form shows the means as ${shown.join(' and ')}`);
    await page.fill('input[name=er_2_zave_nm]', '83.2');
    await page.dispatchEvent('input[name=er_2_zave_nm]', 'input');
    if ((await page.inputValue('input[name=e_zave_nm]')) !== '83.17') throw new Error(`the mean follows the runs as ${await page.inputValue('input[name=e_zave_nm]')}`);
  } finally {
    await writeCol(page, 'measurements', before);
  }
  const said = await page.evaluate(async () => {
    const { summarize } = await import('./app/ui/measurements.js');
    return [summarize({ test: 'potency', values: { cellLine: 'HepG2', pctControl: 95 } }), summarize({ test: 'potency', values: { potency_pct: 88 } })];
  });
  if (said[0] !== 'HepG2 95 % of control' || !/potency_pct 88/.test(said[1])) throw new Error(`potency results read ${JSON.stringify(said)}`);

  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const real = await page.evaluate(() => [localStorage.getItem('lnp-lab.lastExport'), localStorage.getItem('lnp-lab.lastExportAt')]);
  try {
    const demoPotency = (await readCol(page, 'measurements', 'lnp-demo')).filter((x) => x.test === 'potency');
    if (!demoPotency.length || demoPotency.some((x) => x.values?.pctControl == null)) throw new Error(`the demo's potency results: ${JSON.stringify(demoPotency.map((x) => x.values))}`);
    await open('settings');
    await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#exportAll')]);
    await page.waitForFunction(() => localStorage.getItem('lnp-demo.lastExport'), null, { timeout: 3000 });
    const now = await page.evaluate(() => [localStorage.getItem('lnp-lab.lastExport'), localStorage.getItem('lnp-lab.lastExportAt')]);
    if (JSON.stringify(now) !== JSON.stringify(real)) throw new Error(`an export of the demo was noted as the real lab's: ${JSON.stringify(real)} became ${JSON.stringify(now)}`);
    const demoLast = await page.evaluate(() => localStorage.getItem('lnp-demo.lastExport'));
    if (!(await page.locator('#main').innerText()).includes(`Last export: ${demoLast}`)) throw new Error('Settings does not show the demo\'s own export');
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(400);
  }
}
scenarios.push(smallThingsOfCycle6);

/**
 * Usability cycle 6, I10: a lipid added to a stock with "Add lipid row" starts at 0 mol% and has nothing to weigh,
 * and it used to get no card at all, so its mol% could never be typed. Its card now holds the mol%, and once that
 * is above 0 the lipid is weighed like the others.
 */
export async function addedLipidCanBeWeighed({ page, open }) {
  await open('settings');
  try {
    await open('stocks?new=1');
    await page.selectOption('select[name=compositionId]', '1');
    await page.waitForTimeout(150);
    const key = await page.$$eval('#addLipid option', (o) => o.map((x) => x.value).filter(Boolean)[0]);
    await page.selectOption('#addLipid', key);
    await page.waitForSelector(`.weighCard[data-key="${key}"] input[name="pct_${key}"]`, { timeout: 3000 });
    if (await page.locator(`input[name="actual_${key}"]`).count()) throw new Error('a lipid at 0 mol% asks for a mass');
    await page.fill(`input[name="pct_${key}"]`, '5');
    await page.dispatchEvent(`input[name="pct_${key}"]`, 'change');
    await page.waitForSelector(`input[name="actual_${key}"]`, { timeout: 3000 });
    await expectText(page, `.weighCard[data-key="${key}"]`, /mmol/, 'the added lipid is weighed in with the others');
    await expectText(page, '#stockForm', /sums to 105\.00 %/, 'and the total says it is now over 100');
  } finally {
    await open('stocks');
    if (await page.locator('#stockDraftDrop').count()) await page.click('#stockDraftDrop');
    await open('settings');
  }
}
scenarios.push(addedLipidCanBeWeighed);

/**
 * Usability cycle 6, L1: the optimizer during a campaign was about 715 words. The opening card and its verdict now
 * lead, the setup follows as one line, and why each run was chosen and how to read the ± sit under a line that
 * says so. The demo lab's first fit reads in under 600 words.
 */
export async function optimizerLeadsWithItsVerdict({ page, open }) {
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  try {
    await open('ml');
    await page.click('#runBtn');
    await page.waitForSelector('#mlLede', { timeout: 60000 });
    const order = await page.evaluate(() => {
      const lede = document.querySelector('#mlLede'), setup = document.querySelector('#setupFold'), table = document.querySelector('#makeExp');
      return Boolean(lede && setup && table && (lede.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) && (table.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    if (!order) throw new Error('the verdict, then the runs, then the setup');
    await expectText(page, '#readingFold > summary', /Reading the table\s*why each run, what the ± means/, 'the fold says what it holds');
    await expectNoText(page, '#main', /mainly information|expected gain/, 'why each run was chosen is folded');
    const words = (await page.locator('#main').innerText()).trim().split(/\s+/).length;
    if (words > 600) throw new Error(`the optimizer after a fit reads ${words} words`);
    await page.click('#readingFold > summary');
    if ((await page.locator('#whyRuns li').count()) !== (await page.locator('#mlRoot .card:has(#makeExp) table').first().locator('tbody tr').count())) throw new Error('one reason per suggested run');
  } finally {
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(400);
  }
}
scenarios.push(optimizerLeadsWithItsVerdict);


// ---- One window writes (usability cycle 6, W1) ----

/** What IndexedDB itself holds: lnpDb.read gives a window's memory, and a window that only shows the records stores nothing. */
const storedCol = (page, col, ns = 'lnp-lab') => page.evaluate(([ns, col]) => new Promise((res, rej) => {
  const r = indexedDB.open('lnp-lab');
  r.onsuccess = () => { const db = r.result; const g = db.transaction('collections', 'readonly').objectStore('collections').get(`${ns}.${col}`); g.onsuccess = () => { db.close(); res(g.result ? JSON.parse(g.result) : []); }; g.onerror = () => rej(g.error); };
  r.onerror = () => rej(r.error);
}), [ns, col]);

/** Another tab on the app, as a person opens one: the same browser, so the same lab. */
async function anotherWindow(page, base, errors, hash = 'overview', { context = page.context(), demo = false } = {}) {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(`another window: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`another window: ${m.text()}`); });
  p.on('dialog', (d) => d.accept().catch(() => {}));
  if (demo) await p.addInitScript(() => localStorage.setItem('lnp-lab.demo', '1'));
  await p.goto(base + '#/' + hash);
  await p.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await p.waitForTimeout(150);
  return p;
}
const readOnly = (p) => p.evaluate(() => !!document.getElementById('windowNote'));
const writesAgain = (p, ms = 6000) => p.waitForSelector('#windowNote', { state: 'detached', timeout: ms });
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = '#/' + h; }, hash); await p.waitForTimeout(200); };
const savedSays = (p) => p.waitForFunction(() => document.getElementById('saveState')?.textContent === 'Saved', null, { timeout: 3000 })
  .catch(async () => { throw new Error(`the screen should say "Saved", not "${await p.locator('#saveState').innerText()}"`); });

/**
 * A second window on the same lab opens read-only and says so at the head of every screen, and nothing tried in
 * it changes anything: a QC limit typed in Settings, a formulation's status, the bench buttons of an experiment,
 * a delete, "Delete all data". Each is refused whole, without an error; the banner says it was not saved, the
 * screen shows what is stored again, and nothing says "Saved" or offers to undo.
 */
export async function secondWindowOnlyShows({ page, open, base, errors }) {
  await open('overview');
  if (await readOnly(page)) throw new Error('the first window on the lab should write');
  const p2 = await anotherWindow(page, base, errors);
  try {
    await expectText(p2, '#windowNote', /^LNP Lab is open in another window\. This one only shows your records, so the two cannot write over each other\.\s*Use this window instead$/, 'the second window says it only shows the records');
    for (const s of ['experiments', 'formulation', 'calendar', 'stocks', 'buffers', 'measurements', 'doe', 'insights', 'ml', 'materials', 'learn', 'settings', 'experiments?new=1']) {
      await go(p2, s);
      const head = await p2.evaluate(() => { const n = document.getElementById('windowNote'); return !!n && document.getElementById('main').firstChild === n && !n.classList.contains('warn'); });
      if (!head) throw new Error(`#/${s}: the banner should lead the screen, and say nothing was refused while it was only looked at`);
    }
    const cols = ['settings', 'experiments', 'batches', 'measurements', 'trash'];
    const before = Object.fromEntries(await Promise.all(cols.map(async (c) => [c, JSON.stringify(await storedCol(page, c))])));
    const notSaved = async (what) => {
      await p2.waitForFunction(() => document.getElementById('windowNote')?.classList.contains('warn'), null, { timeout: 3000 })
        .catch(() => { throw new Error(`${what}: the banner should say it was not saved`); });
      await expectText(p2, '#windowNote', /^Not saved: LNP Lab is open in another window\. This one only shows your records/, what);
      await p2.waitForTimeout(250);
      const said = await p2.evaluate(() => [document.getElementById('saveState')?.textContent || '', document.getElementById('toast')?.textContent || '']);
      if (said.some((t) => /\bSaved\b|All data deleted|Marked|Deleted/.test(t))) throw new Error(`${what}: something says it was done: ${JSON.stringify(said)}`);
    };

    await go(p2, 'settings');
    const pdi = await p2.inputValue('#pdiMax');
    // Its fields cannot be typed into: typing there could only be refused and then wiped (usability cycle 6).
    if (!(await p2.locator('#pdiMax').isDisabled())) throw new Error('Settings in a window that only shows the records should not take typing');
    if ((await p2.inputValue('#pdiMax')) !== pdi) throw new Error(`Settings should show the stored limit, ${pdi}, not ${await p2.inputValue('#pdiMax')}`);

    const exps = await readCol(page, 'experiments'), forms = await readCol(page, 'batches');
    const f = forms.find((x) => x.status === 'planned') || forms[0];
    await go(p2, `formulation?batch=${f.id}`);
    if (!/not saved in this window/.test(await p2.locator('#saveState').innerText())) throw new Error(`the record should not promise to save: "${await p2.locator('#saveState').innerText()}"`);
    if (!(await p2.locator('#statusSel').isDisabled())) throw new Error('a record in a window that only shows the records should not take changes');
    if ((await p2.inputValue('#statusSel')) !== f.status) throw new Error('the record should show its stored status');

    const e = exps.find((x) => x.id === f.experimentId);
    if (e) {
      await go(p2, `experiments?id=${e.id}`);
      if (await p2.locator('#markAllProduced:not([disabled])').count()) { await p2.click('#markAllProduced'); await notSaved('"Mark all produced"'); }
      await p2.click('#setStatus'); await notSaved('"Mark done"');
      await p2.click('#delExp'); await notSaved('a delete');
      if (await p2.locator('#toast [data-toast-action]').count()) throw new Error('a delete that did not happen offers an Undo');
    }
    await go(p2, 'settings');
    await p2.evaluate(() => document.getElementById('clearAll').click()); // both questions answered yes
    await notSaved('"Delete all data"');

    for (const c of cols) if (JSON.stringify(await storedCol(page, c)) !== before[c]) throw new Error(`the read-only window changed the stored ${c}`);
    if (await readOnly(page)) throw new Error('the first window should still write');
  } finally { await p2.close(); }
}
scenarios.push(secondWindowOnlyShows);

/**
 * "Use this window instead" works both ways. The window that wrote first stores what it still had waiting (here
 * initials typed and not yet paused on), then only shows the records; the other one writes, and gives it back.
 */
export async function takeOverBothWays({ page, open, base, errors }) {
  await open('settings');
  const settings = await readCol(page, 'settings');
  const p2 = await anotherWindow(page, base, errors, 'settings');
  const stored = () => storedCol(page, 'settings').then((r) => r.find((x) => x.id === 'default') || {});
  try {
    await page.fill('#operator', 'TK'); // stored once the typing pauses, which the takeover does not wait for
    await p2.click('#takeOver');
    await page.waitForSelector('#windowNote', { timeout: 6000 });
    await writesAgain(p2); await p2.waitForTimeout(150);
    if ((await stored()).operator !== 'TK') throw new Error(`what the first window still had waiting should be stored before it hands over, not "${(await stored()).operator}"`);
    await p2.waitForFunction(() => document.querySelector('#operator')?.value === 'TK', null, { timeout: 3000 })
      .catch(async () => { throw new Error(`the window that took over should show what the other one stored: operator "${await p2.inputValue('#operator')}"`); });
    await p2.fill('#pdiMax', '0.21'); await p2.press('#pdiMax', 'Tab');
    await savedSays(p2);
    await page.waitForSelector('#windowNote', { timeout: 3000 });
    await page.waitForFunction(() => document.querySelector('#pdiMax')?.disabled, null, { timeout: 3000 })
      .catch(() => { throw new Error('the window that handed over should not take typing'); });
    if ((await stored()).qc?.pdiMax !== 0.21) throw new Error(`the window that handed over should store nothing: PDI max ${(await stored()).qc?.pdiMax}`);
    await page.click('#takeOver');
    await p2.waitForSelector('#windowNote', { timeout: 6000 });
    await writesAgain(page); await page.waitForTimeout(150);
    await page.fill('#operator', 'GM'); await page.press('#operator', 'Tab');
    await savedSays(page);
    const s = await stored();
    if (s.operator !== 'GM' || s.qc?.pdiMax !== 0.21) throw new Error(`and back: operator ${s.operator}, PDI max ${s.qc?.pdiMax}`);
  } finally {
    await p2.close();
    await writesAgain(page).catch(() => {});
    await writeCol(page, 'settings', settings);
  }
}
scenarios.push(takeOverBothWays);

/** The window that writes closes: the one left open writes again within a few seconds, with nothing pressed. */
export async function closingTheWriterFreesTheRole({ page, open, base, errors }) {
  await open('settings');
  const settings = await readCol(page, 'settings');
  const p2 = await anotherWindow(page, base, errors);
  try {
    await p2.click('#takeOver');
    await page.waitForSelector('#windowNote', { timeout: 6000 });
    await writesAgain(p2);
  } finally { await p2.close(); }
  const t0 = Date.now();
  await writesAgain(page).catch(() => { throw new Error('the window left open should write again once the other one has closed'); });
  if (Date.now() - t0 > 5000) throw new Error(`the role came free after ${Date.now() - t0} ms`);
  await page.waitForTimeout(200);
  try {
    await page.fill('#operator', 'CW'); await page.press('#operator', 'Tab');
    await savedSays(page);
  } finally { await writeCol(page, 'settings', settings); }
}
scenarios.push(closingTheWriterFreesTheRole);

/** The real lab and the demo are separate namespaces: a window on each writes, each in its own lab. */
export async function demoAndLabSideBySide({ page, open, base, errors }) {
  await open('settings');
  const settings = await readCol(page, 'settings');
  const p2 = await anotherWindow(page, base, errors, 'settings', { demo: true });
  // The demo switch is the browser's: the first window must not come back from a later reload in the demo.
  await p2.evaluate(() => localStorage.removeItem('lnp-lab.demo'));
  const demoSettings = await readCol(p2, 'settings', 'lnp-demo');
  try {
    if (!(await p2.evaluate(() => document.body.classList.contains('demo')))) throw new Error('the second window should be on the demo');
    if (await readOnly(p2) || await readOnly(page)) throw new Error('a window on the demo and one on the real lab should both write');
    await p2.fill('#operator', 'DM'); await p2.press('#operator', 'Tab');
    await page.fill('#operator', 'RL'); await page.press('#operator', 'Tab');
    await savedSays(p2); await savedSays(page);
    const op = async (ns) => (await storedCol(page, 'settings', ns)).find((x) => x.id === 'default')?.operator;
    if ((await op('lnp-lab')) !== 'RL' || (await op('lnp-demo')) !== 'DM') throw new Error(`each window stores in its own lab: real ${await op('lnp-lab')}, demo ${await op('lnp-demo')}`);
  } finally {
    await writeCol(p2, 'settings', demoSettings, 'lnp-demo');
    await p2.close();
    await writeCol(page, 'settings', settings);
  }
}
scenarios.push(demoAndLabSideBySide);

/**
 * Safari 15.0, the floor of the macOS app's window, has no BroadcastChannel, and the windows then talk through
 * localStorage's storage event. In a browser profile of its own, so the lab is a fresh one.
 */
export async function windowsWithoutBroadcastChannel({ page, base, errors }) {
  const context = await page.context().browser().newContext({ timezoneId: 'Europe/Berlin' });
  await context.addInitScript(() => { delete window.BroadcastChannel; });
  try {
    const a = await anotherWindow(page, base, errors, 'settings', { context });
    if (await a.evaluate(() => 'BroadcastChannel' in window)) throw new Error('the stand-in for Safari 15.0 still has a BroadcastChannel');
    const b = await anotherWindow(page, base, errors, 'settings', { context });
    if (await readOnly(a) || !(await readOnly(b))) throw new Error('the first window should write and the second only show the records');
    await a.fill('#operator', 'AA'); await a.press('#operator', 'Tab');
    await savedSays(a);
    await b.waitForFunction(async () => (await window.lnpDb.read('settings')).some((s) => s.operator === 'AA'), null, { timeout: 3000 })
      .catch(() => { throw new Error('the second window should read back what the first stored'); });
    await b.click('#takeOver');
    await a.waitForSelector('#windowNote', { timeout: 6000 });
    await writesAgain(b);
    await b.close();
    await writesAgain(a).catch(() => { throw new Error('closing the writer should free the role without a BroadcastChannel too'); });
  } finally { await context.close(); }
}
scenarios.push(windowsWithoutBroadcastChannel);


/** What IndexedDB itself holds, rather than the page's memory: whether a change was stored is the question. */
const storedRows = (page, col, ns = 'lnp-lab') => page.evaluate(([ns, col]) => new Promise((resolve, reject) => {
  const r = indexedDB.open('lnp-lab');
  r.onsuccess = () => {
    const db = r.result, g = db.transaction('collections', 'readonly').objectStore('collections').get(`${ns}.${col}`);
    g.onsuccess = () => { db.close(); resolve(g.result ? JSON.parse(g.result) : []); };
    g.onerror = () => reject(g.error);
  };
  r.onerror = () => reject(r.error);
}), [ns, col]);

/**
 * Writes that fail on a full disk (usability cycle 6, W2, W4, W5). Assigning an inbox result undid the result
 * but removed the inbox row beside it, which the next write stored: the result was then nowhere. A failed import
 * left its import record and its inbox rows, and importing again added the rows twice. An undone "Save lot"
 * still used up its number, so the lot stored was not the one the form and the printed recipe showed. And the
 * note followed the user to Settings saying everything "on this screen" was still there.
 */
export async function aFailedActionIsUndoneWhole({ page, open }) {
  const cols = ['experiments', 'batches', 'measurements', 'inbox', 'imports', 'buffers', 'counters'];
  const was = {};
  for (const c of cols) was[c] = await readCol(page, c);
  const marks = await page.evaluate(() => ['experiment', 'buffer'].map((k) => [k, localStorage.getItem(`lnp-lab.counter.${k}`)]));
  const go = async (hash) => { await page.evaluate((h) => { location.hash = '#/' + h; }, hash); await page.waitForTimeout(250); };
  const failing = async (what, act) => {
    await page.evaluate(() => window.lnpDb.failWrites('QuotaExceededError'));
    try {
      await act();
      await page.waitForSelector('#storageNote', { timeout: 3000 }).catch(() => { throw new Error(`${what}: no note when it could not be stored`); });
      await page.waitForTimeout(250);
    } finally { await page.evaluate(() => window.lnpDb.failWrites(null)); }
  };
  const slot = (f) => ({ id: `E990-${f}_final_dls`, batchId: `E990-${f}`, experimentId: 'E990', stage: 'final', test: 'dls', sampleName: `E990-${f}_final`, dueDate: '2026-10-17', status: 'open', measurementId: null });
  try {
    // Three formulations, so that with E990-F1 in the sheet two are missing, and the row that matches nothing
    // is not taken for the only one left.
    const forms = ['F1', 'F2', 'F3'];
    await writeCol(page, 'experiments', [...was.experiments, { id: 'E990', type: 'single', name: 'Full disk', status: 'running', startDate: '2026-10-16', compositionId: 1, batchIds: forms.map((f) => `E990-${f}`), expected: forms.map(slot) }]);
    await writeCol(page, 'batches', [...was.batches, ...forms.map((f) => ({ id: `E990-${f}`, experimentId: 'E990', compositionId: 1, status: 'produced', plannedDate: '2026-10-16' }))]);
    await writeCol(page, 'inbox', [...was.inbox, { id: 'ib-stray', sampleName: 'stray_final', test: 'dls', values: { zave_nm: 77.7, pdi: 0.12 }, date: '2026-10-17', operator: 'GM', raw: { fileName: 'run.csv', sha256: 'abc' } }]);
    await open('measurements');

    // An import: E990-F1's size, and a row that matches nothing and goes to the inbox.
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { if (d.querySelector('#pasteBox')) d.open = true; }));
    await page.fill('#pasteBox', 'Sample Name,Z-Average (d.nm),PdI\nE990-F1_final,81.5,0.09\nnobody_knows_this,90.1,0.12');
    await page.click('#pasteGo');
    await page.waitForSelector('#doImport', { timeout: 3000 });
    await failing('the import', () => page.click('#doImport'));
    const said = await page.locator('#storageNote').innerText();
    if (!/The import of the pasted block was undone[\s\S]*press “Import selected” again/.test(said)) throw new Error(`the note after a failed import: "${said}"`);
    if ((await readCol(page, 'imports')).length !== was.imports.length || (await readCol(page, 'inbox')).some((r) => r.sampleName === 'nobody_knows_this')) {
      throw new Error('a failed import left its record or its inbox rows behind, to be stored by the next write');
    }
    if (!(await page.locator('#doImport:enabled').count())) throw new Error('the preview should stay, to import again');
    await page.click('#doImport');
    await page.waitForFunction(() => /evaluated=/.test(location.hash), null, { timeout: 3000 });
    await page.evaluate(() => window.lnpDb.flush());
    const [imports, inbox, results] = [await storedRows(page, 'imports'), await storedRows(page, 'inbox'), await storedRows(page, 'measurements')];
    if (imports.length !== was.imports.length + 1 || inbox.filter((r) => r.sampleName === 'nobody_knows_this').length !== 1 || !results.some((m) => m.sampleName === 'E990-F1_final')) {
      throw new Error(`imported again with room: ${imports.length - was.imports.length} import records, ${inbox.filter((r) => r.sampleName === 'nobody_knows_this').length} inbox rows, ${results.filter((m) => m.sampleName === 'E990-F1_final').length} results stored`);
    }

    // An inbox result assigned to E990-F2.
    await go('measurements');
    await page.selectOption('[data-assign="ib-stray"]', 'E990-F2_final_dls');
    await failing('the assignment', () => page.click('[data-assignbtn="ib-stray"]'));
    await page.waitForSelector('[data-assignbtn="ib-stray"]', { timeout: 3000 }).catch(() => { throw new Error('the result whose assignment was undone is gone from the inbox'); });
    if (!(await readCol(page, 'inbox')).some((r) => r.id === 'ib-stray')) throw new Error('a backup taken now would not hold the result');
    await page.selectOption('[data-assign="ib-stray"]', 'E990-F2_final_dls');
    await page.click('[data-assignbtn="ib-stray"]');
    await page.waitForTimeout(250);
    await page.evaluate(() => window.lnpDb.flush());
    if ((await storedRows(page, 'inbox')).some((r) => r.id === 'ib-stray') || !(await storedRows(page, 'measurements')).some((m) => m.values?.zave_nm === 77.7)) {
      throw new Error('assigned with room again, the result should be stored and out of the inbox');
    }

    // A new buffer lot: the number the form shows is the number stored, after a press that was undone.
    await go('buffers?new=1');
    await page.waitForSelector('#saveBuffer', { timeout: 3000 });
    const lot = (await page.locator('#bufferForm').innerText()).match(/Lot:\s*(Buffer-\d+)/)?.[1];
    await failing('the lot', () => page.click('#saveBuffer'));
    await go('settings'); // where the note sends the user
    const there = await page.locator('#storageNote').innerText();
    if (/this screen|Save lot/.test(there)) throw new Error(`on Settings the note still speaks of the buffer form: "${there}"`);
    await go('buffers?new=1');
    const again = (await page.locator('#bufferForm').innerText()).match(/Lot:\s*(Buffer-\d+)/)?.[1];
    if (again !== lot) throw new Error(`the form showed ${lot}, and after the undone press it shows ${again}`);
    await page.click('#saveBuffer');
    await page.waitForFunction(() => /^#\/buffers\?id=Buffer-\d+$/.test(location.hash), null, { timeout: 3000 });
    const stored = await page.evaluate(() => location.hash.split('id=')[1]);
    if (stored !== lot) throw new Error(`the form showed ${lot}; the lot stored is ${stored}`);
  } finally {
    await page.evaluate(() => window.lnpDb.failWrites(null));
    for (const c of cols) await writeCol(page, c, was[c]);
    await page.evaluate((marks) => { for (const [k, v] of marks) { if (v == null) localStorage.removeItem(`lnp-lab.counter.${k}`); else localStorage.setItem(`lnp-lab.counter.${k}`, v); } sessionStorage.removeItem('lnp-lab.draft.buffer'); }, marks);
  }
}
scenarios.push(aFailedActionIsUndoneWhole);

/**
 * Creates that take long (usability cycle 6, W5, W6). While "Create experiment" was being stored, the wizard
 * offered it back as one not created, and going on with it stored a second experiment; once stored, it pulled the
 * user off whatever screen they had moved to. A create that failed slowly stayed in the Experiments list and the
 * sidebar the user had opened meanwhile.
 */
export async function aSlowCreateIsNotADraft({ page, open }) {
  const cols = ['experiments', 'batches', 'counters'];
  const was = {};
  for (const c of cols) was[c] = await readCol(page, c);
  const mark = await page.evaluate(() => localStorage.getItem('lnp-lab.counter.experiment'));
  const go = async (hash) => { await page.evaluate((h) => { location.hash = '#/' + h; }, hash); await page.waitForTimeout(200); };
  // IndexedDB writes refused `ms` after they start (null: as they come), as a database that gives up would.
  const refuseWrites = (ms) => page.evaluate((ms) => {
    window.__refuseAfter = ms;
    if (window.__refuseOn) return;
    window.__refuseOn = true;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] !== 'readwrite' || window.__refuseAfter == null) return tx;
      const until = performance.now() + window.__refuseAfter, st = tx.objectStore('collections');
      tx.commit = () => {}; // kept open, and busy, until it is aborted
      const spin = () => { if (performance.now() >= until) { try { tx.abort(); } catch {} return; } st.count().onsuccess = spin; };
      spin();
      return tx;
    };
  }, ms);
  try {
    await open('experiments?new=1&type=single');
    await page.fill('input[name=name]', 'Stored slowly'); await page.dispatchEvent('input[name=name]', 'change');
    await page.waitForTimeout(150);
    await slowWrites(page, 1500);
    try {
      await page.click('#createExp');
      await page.waitForTimeout(100);
      await page.click('a.btn[href="#/experiments?new=1"]'); // the wizard's Back, while it is being stored
      await page.waitForTimeout(200);
      if (await page.locator('[data-draft="single"]', { hasText: 'Stored slowly' }).count()) throw new Error(`an experiment being created is offered back as a draft: "${await page.locator('[data-draft="single"]', { hasText: 'Stored slowly' }).innerText()}"`);
      await go('calendar');
      await page.waitForFunction(() => [...document.querySelectorAll('#toast .note')].some((n) => /Created Experiment \d+/.test(n.textContent) && n.querySelector('[data-toast-action="Open"]')), null, { timeout: 5000 })
        .catch(() => { throw new Error('once stored, no note saying where the new experiment is'); });
      const at = await page.evaluate(() => location.hash);
      if (at !== '#/calendar') throw new Error(`the stored write pulled the user off the calendar, to ${at}`);
    } finally { await slowWrites(page, 0); }
    if ((await readCol(page, 'experiments')).filter((e) => e.name === 'Stored slowly').length !== 1) throw new Error('one press should make one experiment');
    await page.click('#toast [data-toast-action="Open"]');
    await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 3000 });

    await go('experiments?new=1&type=single');
    await page.fill('input[name=name]', 'Refused slowly'); await page.dispatchEvent('input[name=name]', 'change');
    await page.waitForTimeout(150);
    await refuseWrites(600);
    try {
      await page.click('#createExp');
      await page.waitForTimeout(100);
      await go('experiments'); // the list, while it is being stored
      await page.waitForSelector('#storageNote', { timeout: 5000 }).catch(() => { throw new Error('no note when the slow create was refused'); });
      await page.waitForTimeout(300);
    } finally { await refuseWrites(null); }
    // Undone, it is an experiment not created: listed as one, with what was typed, not as an experiment.
    for (const g of await page.locator('#expAccordion details.xgroup:not(.xpending)').all()) await expectNoText(page, `#expAccordion details.xgroup[data-group="${await g.getAttribute('data-group')}"]`, /Refused slowly/, 'the list the user moved to stops showing the experiment that was undone');
    await expectText(page, '#expAccordion details.xpending', /Refused slowly/, 'what was typed waits under "Not created yet"');
    if (await page.locator('#nav a.item.sub:not(.navDraft)', { hasText: 'Refused slowly' }).count()) throw new Error('the sidebar still lists the undone experiment as one');
    await expectNoText(page, '#storageNote', /this screen/, 'the note is not about the wizard, which is no longer showing');
  } finally {
    await slowWrites(page, 0); await refuseWrites(null);
    for (const c of cols) await writeCol(page, c, was[c]);
    await page.evaluate((mark) => {
      if (mark == null) localStorage.removeItem('lnp-lab.counter.experiment'); else localStorage.setItem('lnp-lab.counter.experiment', mark);
      for (const k of Object.keys(localStorage)) if (k.startsWith('lnp-lab.draft.experiment.') && /(Stored|Refused) slowly/.test(localStorage.getItem(k))) localStorage.removeItem(k);
    }, mark);
  }
}
scenarios.push(aSlowCreateIsNotADraft);

// ---- Results without the round trip (UX revision 2026-10) ----
// The user typed results on Measurements, then had to go back into the experiment and scroll down to see what
// they did. Design & results now lists every experiment, not only designs, and holds the experiment's data sheet
// beside its figures: type, save, and the statistics and the pinned figure redraw on the same screen.
export async function resultsWorkspace({ page, open }) {
  await open('experiments?new=1&type=reference');
  await page.fill('input[name=name]', 'Workspace repeats');
  await page.selectOption('select[name=compositionId]', '1');
  await page.waitForTimeout(150);
  await page.click('#createExp');
  await page.waitForTimeout(400);
  const id = await page.evaluate(() => /[?&]id=([^&]+)/.exec(location.hash)?.[1]);
  if (!id) throw new Error('the wizard did not open the new experiment');
  await open(`doe?id=${id}`);
  await expectText(page, '#expSel', /Workspace repeats/, 'a reference experiment is in the Design & results list');
  await expectText(page, '#dataCard', /still due/, 'the data sheet opens on what is due');
  const z = page.locator('#dataCard input.gcell[data-key=zave_nm]:not([data-run="2"]):not([data-run="3"])');
  const n = await z.count();
  if (n < 2) throw new Error(`expected a Z-ave cell per repeat, found ${n}`);
  const zs = ['81.2', '84.0', '79.5'];
  for (let i = 0; i < n; i++) await z.nth(i).fill(zs[i % zs.length]);
  const p = page.locator('#dataCard input.gcell[data-key=pdi]:not([data-run="2"]):not([data-run="3"])');
  for (let i = 0; i < await p.count(); i++) await p.nth(i).fill('0.09');
  await page.click('#gridSave');
  await page.waitForTimeout(500);
  if (!/#\/doe/.test(await page.evaluate(() => location.hash))) throw new Error('saving left Design & results');
  await expectText(page, '#resultsCard', /Batch to batch|Z-ave/, 'the statistics are drawn beside the sheet after the save');
  await expectText(page, '#pinned', /Z-ave/, 'the pinned figure shows the first response');
  await expectText(page, '#dataCard', /8[0-4]\.\d/, 'the stored values sit in the sheet');
  // The run of repeats is the reference type, so the catalogue of types is complete here: 7 of 7 in the demo.
}
scenarios.push(resultsWorkspace);
// ---- Materials: everything corrected in place (lots, compositions, devices, dialysis) ----
// Each scenario puts back the collections it touched, so the scenarios after it see the lab as it was.

/** Answer the app's yes/no questions (ask() in kit.js) with yes, and keep what they said. */
const answerYes = (page) => page.evaluate(() => { window.__asked = []; window.__confirm ||= window.confirm; window.confirm = (msg) => { window.__asked.push(msg); return true; }; });
/** The same, answering No: the delete that asks first must then leave everything as it was. */
const answerNo = (page) => page.evaluate(() => { window.__asked = []; window.__confirm ||= window.confirm; window.confirm = (msg) => { window.__asked.push(msg); return false; }; });
const stopAnswering = (page) => page.evaluate(() => { if (window.__confirm) window.confirm = window.__confirm; delete window.__confirm; return window.__asked || []; });
const toastText = (page) => page.evaluate(() => document.getElementById('toast')?.innerText || '');

export async function materialsEditLot({ page, open }) {
  const was = { lipidLots: await readCol(page, 'lipidLots'), stocks: await readCol(page, 'stocks'), trash: await readCol(page, 'trash') };
  try {
    await open('materials?tab=lipids');
    // "+ lot" on the cholesterol row opens a new lot under that row
    await page.click('#tabBody button[data-act=addlot][data-key=Chol]');
    await page.fill('[data-editor] [name=e_lot]', 'CH-EDIT-1');
    await page.fill('[data-editor] [name=e_supplier]', 'supplier B');
    await page.fill('[data-editor] [name=e_purityPct]', '99.1');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    await expectText(page, '#tabBody', /CH-EDIT-1/, 'the lot added from its row is listed');
    const lot = (await readCol(page, 'lipidLots')).find((l) => l.lot === 'CH-EDIT-1');
    if (!lot || lot.lipidKey !== 'Chol' || lot.purityPct !== 99.1) throw new Error(`lot stored as ${JSON.stringify(lot)}`);

    // A stock weighed from it: the stock names the lot by id, so a corrected number shows there and nothing breaks.
    await writeCol(page, 'stocks', [...was.stocks, { id: 'Stock-990', compositionId: 1, molPct: { Chol: 100 }, lots: { Chol: lot.id }, rows: [{ key: 'Chol', lotId: lot.id }] }]);
    await open('materials?tab=lipids');
    await page.click(`#tabBody button[data-act=lot][data-id="${lot.id}"]`);
    await expectText(page, '[data-editor]', /Weighed into Stock-990/, 'the editor says which stock uses the lot');
    if (!(await page.locator('[data-editor] [name=e_lipidKey]').isDisabled())) throw new Error('a used lot can still be moved to another lipid');
    await page.fill('[data-editor] [name=e_lot]', 'CH-EDIT-1b');
    await page.fill('[data-editor] [name=e_coa]', 'CoA/CH-EDIT-1b.pdf');
    await page.press('[data-editor] [name=e_coa]', 'Enter'); // Enter saves
    await page.waitForTimeout(150);
    const after = (await readCol(page, 'lipidLots')).find((l) => l.id === lot.id);
    if (after?.lot !== 'CH-EDIT-1b' || after.coa !== 'CoA/CH-EDIT-1b.pdf' || after.purityPct !== 99.1) throw new Error(`edited lot stored as ${JSON.stringify(after)}`);
    if ((await readCol(page, 'lipidLots')).length !== was.lipidLots.length + 1) throw new Error('editing a lot made a second one');
    await expectText(page, '#tabBody', /CH-EDIT-1b/, 'the corrected number is listed');
    // Deleting it asks first while a stock was weighed from it, naming the stock; No leaves it as it is.
    await page.click(`#tabBody button[data-act=lot][data-id="${lot.id}"]`);
    await answerNo(page);
    await page.click('[data-editor] [data-act=delete]');
    await page.waitForTimeout(100);
    const askedLot = await stopAnswering(page);
    if (!askedLot.some((q) => /Stock-990/.test(q))) throw new Error(`deleting a used lot did not ask, naming the stock: ${JSON.stringify(askedLot)}`);
    if (!(await readCol(page, 'lipidLots')).some((l) => l.id === lot.id)) throw new Error('a used lot was deleted after No');
    // Escape closes the editor without saving.
    await page.fill('[data-editor] [name=e_lot]', 'NOT SAVED');
    await page.press('[data-editor] [name=e_lot]', 'Escape');
    await page.waitForTimeout(100);
    if (await page.locator('[data-editor]').count()) throw new Error('Escape left the lot editor open');
    if ((await readCol(page, 'lipidLots')).some((l) => l.lot === 'NOT SAVED')) throw new Error('Cancel saved the lot');
  } finally {
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}

export async function materialsEditComposition({ page, open }) {
  const was = { compositions: await readCol(page, 'compositions'), batches: await readCol(page, 'batches'), trash: await readCol(page, 'trash') };
  try {
    await open('materials?tab=compositions');
    await expectText(page, '#tabBody', /I · ionizable/, 'the classes are named on the legend, not only coloured');
    if (!(await page.locator('#tabBody .lc-bar .lc-seg.lc-sterol').count())) throw new Error('no class-coloured bar in the registry');
    // The shipped reference is read-only; "Edit a copy" opens a copy with the next number.
    await page.click('#tabBody tr.mat-row[data-open="1"]');
    await expectText(page, '#tabBody .mat-editor', /read-only/, 'the shipped recipe says it is read-only');
    await page.click('#tabBody [data-act=copy]');
    await expectText(page, '[data-editor]', /a copy of #1/, 'the copy opens');
    const keys = await page.$$eval('[data-editor] select[name^=c_k]', (s) => s.map((x) => x.value));
    const iPeg = keys.indexOf('DMG0PEG2000'), iChol = keys.indexOf('Chol');
    await page.fill(`[data-editor] [name=c_p${iPeg}]`, '2.5');
    await page.fill(`[data-editor] [name=c_p${iChol}]`, '37.5');
    await page.fill('[data-editor] [name=c_synonym]', 'MC3 2.5 % PEG');
    await expectText(page, '#compEditPreview', /sum 100\.0 %/, 'the sum follows the typing');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    const copy = (await readCol(page, 'compositions')).find((c) => c.synonym === 'MC3 2.5 % PEG');
    if (!copy || copy.mol_pct.DMG0PEG2000 !== 2.5 || copy.copiedFrom !== 1) throw new Error(`copy stored as ${JSON.stringify(copy)}`);

    // A formulation made from it: changing the recipe says what happens to it before saving.
    await writeCol(page, 'batches', [...was.batches, { id: 'E990-F1', experimentId: 'E990', compositionId: copy.id, status: 'made', plan: {} }]);
    await open('materials?tab=compositions');
    await page.click(`#tabBody tr.mat-row[data-open="${copy.id}"]`);
    await expectText(page, '[data-editor]', /1 formulation \(in E990\) reads its recipe/, 'the editor says which records use the recipe');
    await page.fill(`[data-editor] [name=c_p${iPeg}]`, '3');
    await page.fill(`[data-editor] [name=c_p${iChol}]`, '37');
    await answerYes(page);
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    const asked = await stopAnswering(page);
    if (!asked.some((q) => /Change the recipe of composition #\d+[\s\S]*already made[\s\S]*Save as new composition/.test(q))) throw new Error(`no question before changing a used recipe: ${JSON.stringify(asked)}`);
    const edited = (await readCol(page, 'compositions')).find((c) => c.id === copy.id);
    if (edited.mol_pct.DMG0PEG2000 !== 3 || edited.history?.[0]?.mol_pct?.DMG0PEG2000 !== 2.5) throw new Error(`edited composition stored as ${JSON.stringify(edited)}`);
    // Deleting a recipe a formulation uses is refused.
    await page.click(`#tabBody tr.mat-row[data-open="${copy.id}"]`);
    await page.click('[data-editor] [data-act=delete]');
    await page.waitForTimeout(100);
    if (!(await readCol(page, 'compositions')).some((c) => c.id === copy.id)) throw new Error('a used composition was deleted');
    // "Save as new" leaves the original as it was.
    await page.fill(`[data-editor] [name=c_p${iPeg}]`, '1');
    await page.fill(`[data-editor] [name=c_p${iChol}]`, '39');
    await page.click('[data-editor] [data-act=savenew]');
    await page.waitForTimeout(150);
    const all = await readCol(page, 'compositions');
    if (all.find((c) => c.id === copy.id).mol_pct.DMG0PEG2000 !== 3) throw new Error('"Save as new" changed the original');
    if (!all.some((c) => c.copiedFrom === copy.id && c.mol_pct.DMG0PEG2000 === 1)) throw new Error('"Save as new" stored no new composition');
  } finally {
    await stopAnswering(page).catch(() => {});
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}

export async function materialsDevicesAndDialysis({ page, open }) {
  const was = { devices: await readCol(page, 'devices'), mixers: await readCol(page, 'mixers'), dialysis: await readCol(page, 'dialysis'), tffModules: await readCol(page, 'tffModules'), trash: await readCol(page, 'trash') };
  try {
    await open('materials?tab=devices');
    await expectText(page, '#instrumentList', /NanoScaler/, 'the shipped instruments are listed');
    await expectText(page, '#mixerList', /Impinging jet mixer/, 'and the mixers');
    // Edit a shipped instrument: stored as the user's own version under the same id.
    await page.click('#instrumentList tr.mat-row[data-open="nanoscaler"]');
    await page.fill('[data-editor] [name=e_notes]', 'Ours is in room 2.14.');
    await page.check('[data-editor] [name=e_mixer_herringbone]');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    const own = (await readCol(page, 'devices')).find((d) => d.id === 'nanoscaler');
    if (own?.notes !== 'Ours is in room 2.14.' || !own.mixers.includes('herringbone')) throw new Error(`edited instrument stored as ${JSON.stringify(own)}`);
    await expectText(page, '#instrumentList', /shipped, edited/, 'the edit is marked as the user\'s version');
    // Add an instrument of one's own, then hide a shipped one and undo it.
    await page.click('#instrumentList [data-act=new]');
    await page.fill('[data-editor] [name=e_name]', 'Bench syringe rig');
    await page.check('[data-editor] [name=e_mixer_t-mixer]');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    if (!(await readCol(page, 'devices')).some((d) => d.name === 'Bench syringe rig' && d.mixers.includes('t-mixer'))) throw new Error('the new instrument was not stored');
    await page.click('#instrumentList tr.mat-row[data-open="ignite"]');
    await page.click('[data-editor] [data-act=hide]');
    await page.waitForTimeout(100);
    await expectText(page, '#instrumentList', /Hidden: NanoAssemblr Ignite/, 'a hidden instrument can be shown again');
    await page.click('#toast button[data-toast-action="Undo"]');
    await page.waitForTimeout(100);
    if ((await readCol(page, 'devices')).some((d) => d.id === 'ignite')) throw new Error('Undo of the hide left a record behind');
    await expectNoText(page, '#instrumentList', /Hidden:/, 'Undo shows it again');

    // Dialysis: the examples, one of one's own, deleted and brought back.
    await open('materials?tab=dialysis');
    await expectText(page, '#dialysisList', /Dialysis cassette 10K, 3–12 mL/, 'the example dialysis devices are listed');
    await page.click('#dialysisList [data-act=new]');
    await page.fill('[data-editor] [name=e_name]', 'Mini dialysis 3.5K');
    await page.fill('[data-editor] [name=e_mwco_kDa]', '3.5');
    await page.fill('[data-editor] [name=e_volume_min_mL]', '0.1');
    await page.fill('[data-editor] [name=e_volume_max_mL]', '0.5');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    const mine = (await readCol(page, 'dialysis')).find((d) => d.name === 'Mini dialysis 3.5K');
    if (!mine || mine.mwco_kDa !== 3.5) throw new Error(`dialysis device stored as ${JSON.stringify(mine)}`);
    await page.click(`#dialysisList tr.mat-row[data-open="${mine.id}"]`);
    await page.click('[data-editor] [data-act=delete]');
    await page.waitForTimeout(100);
    if ((await readCol(page, 'dialysis')).some((d) => d.id === mine.id)) throw new Error('deleting one\'s own dialysis device did not');
    await page.click('#toast button[data-toast-action="Undo"]');
    await page.waitForTimeout(100);
    if (!(await readCol(page, 'dialysis')).some((d) => d.id === mine.id)) throw new Error('Undo did not bring the dialysis device back');

    // TFF: the one representative module, and one of one's own.
    await open('materials?tab=tff');
    await expectText(page, '#tffList', /D02-E100-05-N/, 'the representative TFF module is listed');
    await page.click('#tffList [data-act=new]');
    await page.fill('[data-editor] [name=e_part]', 'MY-TFF-1');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(100);
    if (!/Surface area required/.test(await toastText(page))) throw new Error('a module without a surface area was not refused');
    await page.fill('[data-editor] [name=e_surface_cm2]', '20');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    await expectText(page, '#tffList', /MY-TFF-1[\s\S]*4\.0 – 6\.3/, 'the own module is listed with its load window');
  } finally {
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}
scenarios.push(materialsEditLot, materialsEditComposition, materialsDevicesAndDialysis);
/*
 * Quick mode and the process designer (UX revision). A screening experiment opens in quick mode: the wizard asks
 * for the volume to formulate and says the mRNA it holds; the process is set once in the wizard (device, mixer,
 * quench, buffers) and copied onto every formulation; a record can change its own volume; and "Finish
 * formulation" at the bottom of a record marks it produced and leads on to the next one still to make.
 */
let quickExp = null;
export async function wizardQuickModeAndProcess({ page, open }) {
  await open('experiments?new=1&type=ofat');
  if (!(await page.locator('[data-wmode=quick].on').count())) throw new Error('an OFAT screen should open in quick mode');
  if (await page.locator('input[name=rna_mg]').count()) throw new Error('quick mode asks for a volume, not an RNA mass');
  await expectText(page, '#wizForm', /= 1\.000 mg mRNA per formulation/, 'the default 5 mL at 0.4 mg/mL, FRR 3, quench 2 holds 1 mg');
  await setInput(page, 'name', 'Quick screen on the Ignite');
  await setInput(page, 'ofat_levelsText', '3, 6');
  // the device decides the mixer and the quench: the Ignite takes its cartridge and has no quench pump
  await setInput(page, 'pr_deviceId', 'ignite');
  const mixers = await page.$$eval('select[name=pr_mixerId] option', (os) => os.map((o) => o.value));
  if (mixers.join() !== 'nxgen') throw new Error(`the Ignite should offer its NxGen cartridge only, got ${mixers}`);
  if (await page.locator('input[name=pr_quench]').count()) throw new Error('a device without a quench pump offers no quench');
  await expectText(page, '#wizProcess', /NanoAssemblr Ignite[\s\S]*no quench/, 'the summary names the device and says there is no quench');
  const aria = await page.getAttribute('#wizProcess svg.processViz', 'aria-label');
  if (!/NanoAssemblr Ignite, NxGen cartridge/.test(aria || '')) throw new Error(`the drawing should be of the Ignite with its cartridge: "${aria}"`);
  if (await page.locator('#wizProcess svg.processViz path[stroke="var(--s3)"]').count()) throw new Error('no quench line is drawn without a quench');
  // a catalogue buffer fills in its pH, its concentration and the ionic strength worked out from them
  await setInput(page, 'pr_aq_buffer', 'Acetate 25 mM, pH 5.0');
  if ((await page.inputValue('input[name=pr_aq_pH]')) !== '5' || (await page.inputValue('input[name=pr_aq_mM]')) !== '25' || !(Number(await page.inputValue('input[name=pr_aq_ionicStrength_mM]')) > 0))
    throw new Error('a catalogue buffer should fill pH, mM and the ionic strength');
  // the full process plans the downstream; back to quick, it is kept but not asked for
  await page.click('[data-wmode=full]'); await page.waitForTimeout(150);
  if (!(await page.locator('input[name=rna_mg]').count())) throw new Error('the full process asks for the RNA per batch');
  await page.click('[data-pr-add=tff]'); await page.waitForTimeout(150);
  await expectText(page, '#wizProcess', /1 · Dialysis[\s\S]*2 · TFF/, 'a TFF step after the dialysis');
  await page.click('[data-wmode=quick]'); await page.waitForTimeout(150);
  await setInput(page, 'volume_mL', '4');
  // no quench: 4 mL × 0.4 mg/mL × 3/4
  await expectText(page, '#wizForm', /= 1\.200 mg mRNA per formulation: volume × RNA working conc\. × FRR ÷ \(FRR \+ 1\)/, 'without quench the whole volume is aqueous + lipid');
  await expectText(page, '#previewBody', /mRNA per formulation\s*1\.200 mg/, 'the preview says the mRNA per formulation');
  await page.click('#createExp');
  await page.waitForFunction(() => /#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 4000 });
  quickExp = await page.evaluate(() => location.hash.split('id=')[1]);
  const bs = (await readCol(page, 'batches')).filter((b) => b.experimentId === quickExp);
  if (bs.length !== 2) throw new Error(`expected 2 formulations, got ${bs.length}`);
  for (const b of bs) {
    const p = b.plan;
    if (p.mode !== 'quick' || p.volume_mL !== 4 || Math.abs(p.rna.mass_mg - 1.2) > 1e-6) throw new Error(`quick plan not stored as set: ${JSON.stringify({ mode: p.mode, v: p.volume_mL, m: p.rna.mass_mg })}`);
    if (p.process?.deviceId !== 'ignite' || p.process.mixerId !== 'nxgen' || p.process.quench !== false || p.process.aqueous.pH !== 5) throw new Error(`process not copied onto ${b.id}: ${JSON.stringify(p.process)}`);
    if (p.mixing.flows.p3 !== 0) throw new Error('no quench pump runs without a quench');
    if (p.process.downstream.map((s) => s.step).join() !== 'dialysis,tff') throw new Error('the downstream planned is kept for a switch to the full process');
  }
  await expectText(page, '#processCard', /Quick: mixing only, 4\.00 mL each[\s\S]*NanoAssemblr Ignite/, 'the experiment page shows the mode and the process');
}

export async function quickVolumeOverriddenOnARecord({ page, open }) {
  if (!quickExp) throw new Error('needs the quick experiment of the scenario before');
  await open(`formulation?batch=${quickExp}-F1`);
  if (await page.locator('#step1').count()) throw new Error('quick mode has no RNA dilution step');
  await expectText(page, '#atBench', /mRNA\s*1\.200\s*mg/, 'the bench card starts with the mRNA the volume holds');
  await setInput(page, 'quick_volume_mL', '2');
  await expectText(page, '#atBench', /mRNA\s*0\.600\s*mg/, 'a record\'s own volume, and the mRNA follows');
  await expectText(page, '#inputsCard', /= 0\.600 mg mRNA[\s\S]*the experiment plans 4 mL/, 'the hint says the formula and the experiment\'s volume');
  await page.waitForTimeout(900);
  const bs = (await readCol(page, 'batches')).filter((b) => b.experimentId === quickExp);
  const f1 = bs.find((b) => b.id.endsWith('-F1')), f2 = bs.find((b) => b.id.endsWith('-F2'));
  if (f1.plan.volume_mL !== 2 || Math.abs(f1.plan.rna.mass_mg - 0.6) > 1e-6) throw new Error(`the override is not stored: ${f1.plan.volume_mL} mL, ${f1.plan.rna.mass_mg} mg`);
  if (f2.plan.volume_mL !== 4) throw new Error('the other formulation keeps the experiment\'s volume');
  // the process is the record's own too: change the aqueous pH here and only here
  if (!(await page.locator('#processEdit[open]').count())) await page.click('#processEdit > summary');
  await setInput(page, 'pr_aq_pH', '5.5');
  await page.waitForTimeout(900);
  const again = (await readCol(page, 'batches')).filter((b) => b.experimentId === quickExp);
  if (again.find((b) => b.id.endsWith('-F1')).plan.process.aqueous.pH !== 5.5 || again.find((b) => b.id.endsWith('-F2')).plan.process.aqueous.pH !== 5) throw new Error('a record\'s process change should stay on that record');
  // the full process keeps the mRNA quick mode worked out, as the RNA input
  await page.click('[data-mode=full]'); await page.waitForTimeout(250);
  if ((await page.inputValue('input[name=rna_mass_mg]')) !== '0.6') throw new Error(`switching to the full process should keep 0.6 mg, got ${await page.inputValue('input[name=rna_mass_mg]')}`);
  if (!(await page.locator('#step3').count())) throw new Error('the full process has its six steps');
  await page.click('[data-mode=quick]'); await page.waitForTimeout(250);
  if ((await page.inputValue('input[name=quick_volume_mL]')) !== '2') throw new Error('and back to quick, the volume it had');
}

export async function finishFormulationLeadsOn({ page, open }) {
  if (!quickExp) throw new Error('needs the quick experiment of the scenario before');
  await open(`formulation?batch=${quickExp}-F1`);
  await page.click('#finishBatch');
  await page.waitForTimeout(400);
  const f1 = (await readCol(page, 'batches')).find((b) => b.id === `${quickExp}-F1`);
  if (f1.status !== 'produced') throw new Error(`"Finish formulation" should mark it produced, it is ${f1.status}`);
  if ((await page.inputValue('#statusSel')) !== 'produced') throw new Error('the status at the top says the same');
  await expectText(page, '#finishCard', new RegExp(`${quickExp}-F1 is produced\\.[\\s\\S]*Next still to make: ${quickExp}-F2`), 'the card says what is next');
  if ((await page.getAttribute('#finishBack', 'href')) !== `#/experiments?id=${quickExp}`) throw new Error('and offers the way back to the experiment');
  await page.click('#finishNext');
  await page.waitForFunction((id) => location.hash === `#/formulation?batch=${id}-F2`, quickExp, { timeout: 3000 });
  await page.waitForSelector('#finishBatch');
  await page.click('#finishBatch'); await page.waitForTimeout(400);
  await expectText(page, '#finishCard', /Every formulation of this experiment is made/, 'the last one leads back to the experiment only');
  if (await page.locator('#finishNext').count()) throw new Error('nothing left to go to');
}
scenarios.push(wizardQuickModeAndProcess, quickVolumeOverriddenOnARecord, finishFormulationLeadsOn);

// ---- 3D surface, the optimizer's data, the insights explorer and custom parameters (user review, October 2026) ----

/** Switch the demo lab on, run `fn`, put the demo's collections back and switch it off again. */
async function inDemo(page, open, cols, fn) {
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const before = Object.fromEntries(await Promise.all(cols.map(async (c) => [c, await readCol(page, c, 'lnp-demo')])));
  try { await fn(before); } finally {
    for (const c of cols) await writeCol(page, c, before[c], 'lnp-demo');
    await open('overview');
    await page.click('#demoToggle');
    await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await page.waitForTimeout(400);
  }
}

/**
 * "3D should be a real 3D plot with a 3D response surface." On the demo's response surface the pinned panel
 * switches to 3D: a shaded solid with a z axis in the response's unit, a colour legend, the runs at their
 * measured value; dragging turns it, Reset view turns it back, the diagnostics figure follows the same switch,
 * and the choice holds on the next visit. SVG export still saves the picture shown.
 */
export async function surface3dIsARealSurface({ page, open }) {
  await inDemo(page, open, [], async () => {
    await page.evaluate(() => { try { localStorage.removeItem('lnp-lab.surfaceMode'); } catch {} });
    await open('doe?id=E4');
    const pin = '[data-surfbox=pin]';
    await page.waitForSelector(`${pin} .surfFlat svg`);
    if (await page.locator(`${pin} .surfSolid svg`).count()) throw new Error('the contour comes first');
    await page.click(`${pin} [data-surf=solid]`);
    const svg = page.locator(`${pin} .surfSolid svg`);
    await svg.waitFor();
    if (!(await page.locator(`${pin} .surfFlat`).isHidden())) throw new Error('3D replaces the contour');
    const faces = await svg.locator('polygon').count();
    if (faces < 400) throw new Error(`a meshed surface has hundreds of faces, found ${faces}`);
    const shades = await svg.locator('polygon').evaluateAll((ps) => new Set(ps.map((p) => p.getAttribute('fill'))).size);
    if (shades < 100) throw new Error(`shaded by height and light, the faces should differ: ${shades} fills`);
    const text = await svg.evaluate((s) => s.textContent);
    if (!/Size \(nm\)/.test(text) || !/FRR/.test(text) || !/total flow \(mL\/min\)/i.test(text)) throw new Error(`the axes are named with units: "${text.slice(0, 300)}"`);
    if ((await svg.locator('g.run3d').count()) < 3) throw new Error('the runs on this slice stand at their measured value');
    if (!/measured \d+(\.\d+)?, the surface \d+(\.\d+)? \((above|below)/.test(await svg.locator('g.run3d title').first().textContent())) throw new Error('a run says how far it is from the surface');
    if (!(await svg.locator('.legend3d rect').count())) throw new Error('a colour legend');
    // dragging turns it; Reset view turns it back
    const yaw0 = await svg.getAttribute('data-yaw');
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 20, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(150);
    const yaw1 = await page.locator(`${pin} .surfSolid svg`).getAttribute('data-yaw');
    if (yaw1 === yaw0) throw new Error('dragging should turn the surface');
    await page.click(`${pin} .surfReset`); await page.waitForTimeout(100);
    if ((await page.locator(`${pin} .surfSolid svg`).getAttribute('data-yaw')) !== yaw0) throw new Error('Reset view goes back to the opening angle');
    // the diagnostics figure shows the same view
    await page.click('#plotsFold > summary');
    if (await page.locator('[data-surfbox=main] .surfSolid').isHidden()) throw new Error('the figure in the diagnostics follows the pinned switch');
    // the floor contours can be switched off
    await page.uncheck(`${pin} .surfContours`); await page.waitForTimeout(100);
    if (await page.locator('[data-surfbox=main] .surfContours').isChecked()) throw new Error('both boxes share the floor setting');
    // SVG export saves the 3D picture
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-fig=pinned-surface] [data-fig-dl=svg]')]);
    const saved = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
    if (!/3D response surface/.test(saved)) throw new Error('the export is the picture on screen');
    // remembered on the next visit; put back to the contour for the scenarios after this one
    await open('doe?id=E3');
    await page.waitForSelector(`${pin} .surfSolid svg`);
    await page.click(`${pin} [data-surf=flat]`);
  });
}

/**
 * "It's not clear where the optimizer gets the data." The Data used card lists every experiment with the
 * formulations it gives and its results, and every formulation left out with the reason; the header says
 * "N formulations from M experiments". Switching an experiment off takes its formulations out of the count
 * and the fit, is remembered, and "Use every experiment again" brings them back.
 */
export async function optimizerSaysWhereItsDataComesFrom({ page, open }) {
  await inDemo(page, open, ['settings'], async (before) => {
    await writeCol(page, 'settings', before.settings.filter((x) => x.id !== 'mlSetup'), 'lnp-demo');
    await open('ml');
    const chip = async () => /^(\d+) formulations from (\d+) experiments$/.exec((await page.locator('#mlSourceChip').innerText()).trim());
    const [, n0, m0] = (await chip()) || [];
    if (!n0) throw new Error(`the header says how many formulations from how many experiments: "${await page.locator('#mlSourceChip').innerText()}"`);
    if (!(await page.locator('#sourceFold').evaluate((d) => d.open))) throw new Error('before a fit the Data used card is open');
    await expectText(page, '#sourceFold', /Data used[\s\S]*E4\s*Response surface FRR x flow x PEG[\s\S]*18 of 18[\s\S]*Size 18/, 'each experiment with what it gives');
    await expectText(page, '#mlLeftOut', /No result yet for a response switched on as a goal \(1\): E7-F1 \(1 not made yet\)/, 'what is left out and why');
    if (!(await page.locator('#sourceFold a[href="#/experiments?id=E4"]').count()) || !(await page.locator('#sourceFold a[href="#/doe?id=E4"]').count())) throw new Error('links to the experiment and its results');
    // switch E4 off
    await page.uncheck('input[name=x_exp_E4]');
    await page.waitForTimeout(300);
    const [, n1, m1] = await chip();
    if (Number(n1) !== Number(n0) - 18 || Number(m1) !== Number(m0) - 1) throw new Error(`E4 switched off: ${n1} from ${m1}, was ${n0} from ${m0}`);
    await expectText(page, '#mlLeftOut', /In an experiment you switched off \(18\): E4-F1/, 'its formulations are listed as left out');
    const setup = (await readCol(page, 'settings', 'lnp-demo')).find((x) => x.id === 'mlSetup');
    if (!setup?.value?.excluded?.includes('E4')) throw new Error('the choice is kept with the setup');
    await page.click('#runBtn');
    await page.waitForSelector('#mlLede', { timeout: 60000 });
    if (!new RegExp(`^fitted on ${n1} formulations from ${m1} experiments$`).test((await page.locator('#mlSourceChip').innerText()).trim())) throw new Error(`after the fit: "${await page.locator('#mlSourceChip').innerText()}"`);
    if (await page.locator('#sourceFold').evaluate((d) => d.open)) throw new Error('after a fit the card folds to its line');
    await expectText(page, '#sourceFold > summary', new RegExp(`fitted on ${n1} formulations from ${m1} experiments · 19 left out · 1 experiment switched off`), 'the line says what the fit used');
    // the header's count opens the card
    await page.click('#mlSourceChip');
    if (!(await page.locator('#sourceFold').evaluate((d) => d.open))) throw new Error('the count in the header opens the card');
    // remembered on the next visit, and undone in one click
    await open('ml');
    if (await page.locator('input[name=x_exp_E4]').isChecked()) throw new Error('E4 stays off on the next visit');
    await page.click('#mlUseAll');
    await page.waitForTimeout(300);
    const [, n2] = await chip();
    if (n2 !== n0) throw new Error(`every experiment used again: ${n2}, was ${n0}`);
  });
}

/**
 * "Insights is very limited." The explorer plots any result against any parameter: a number gives a scatter
 * with its trend line and a sentence, a category a strip per group with mean ± SD and a comparison table with
 * its test, a date a time series; the choice travels in the address. The correlation map plots a cell when it
 * is clicked, the control chart's batches get a process capability against the QC limits, and the CSV export
 * holds the lots and the other fields.
 */
export async function insightsExplorer({ page, open }) {
  await inDemo(page, open, [], async () => {
    await open('insights?y=ee_pct&x=np');
    await expectText(page, '#explorer', /Explore/, 'the explorer');
    const kindOf = () => page.locator('#explorer svg').getAttribute('aria-label');
    if (!/Encapsulation efficiency \(%\) against N\/P ratio/.test(await kindOf())) throw new Error(`EE against N/P: ${await kindOf()}`);
    if (!(await page.locator('#explorer svg line[stroke-dasharray="6 4"]').count())) throw new Error('a number on X gets its trend line');
    await expectText(page, '#exSay', /(rises|falls) by [\d.]+ points for each unit of N\/P ratio \(r [−-]?[\d.]+, p [<\d. ]+\)|No clear trend of Encapsulation efficiency with N\/P ratio/, 'the trend in a sentence');
    // a category: strips with mean ± SD and the comparison table
    await page.selectOption('#ex_x', 'experimentId');
    await page.waitForFunction(() => /x=experimentId/.test(location.hash));
    await page.waitForSelector('#groupTable');
    await expectText(page, '#exSay', /(differs between|No clear difference in Encapsulation efficiency between) the \d+ experiment groups \(one-way ANOVA, p [<\d. ]+, n \d+\)/, 'the test in a sentence');
    const groups = await page.locator('#groupTable tbody tr').count();
    if (groups < 4) throw new Error(`one row per experiment, found ${groups}`);
    await expectText(page, '#groupTable', /Mean ± SD[\s\S]*vs the others[\s\S]*one-way ANOVA, F [\d.]+ on \d+ and \d+ df/, 'the table with its test');
    // a date: the course over time
    await page.selectOption('#ex_x', 'date');
    await page.waitForFunction(() => /x=date/.test(location.hash));
    await page.waitForTimeout(300);
    if (!/against Date/.test(await kindOf())) throw new Error('a date is drawn over time');
    // colour by a category: the weekday
    await page.selectOption('#ex_x', 'frr');
    await page.waitForTimeout(400);
    await page.selectOption('#ex_g', 'weekday');
    await page.waitForTimeout(400);
    if (!(await page.locator('#exLegend span').count())) throw new Error('coloured by weekday, with a legend');
    // the correlation map plots a cell when clicked
    await page.click('#heatFold > summary');
    await page.click('#heatTable td[data-x="ionizable_pct"][data-y="ee_pct"]');
    await page.waitForFunction(() => /x=ionizable_pct/.test(location.hash) && /y=ee_pct/.test(location.hash));
    // capability against the QC limits, on the batches of the control chart
    await expectText(page, '#capCard', /Cpk\s*[\d.−-]+\s*(capable|marginal|not capable)/, 'process capability');
    // the export holds the lots and the other fields
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
    const csv = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
    const head = csv.split('\n')[0].split(',');
    for (const c of ['batchId', 'stockId', 'lot_ionizable', 'rnaLot', 'mixerId', 'weekday', 'aq_pH', 'zave_nm', 'size_drift']) if (!head.includes(c)) throw new Error(`the CSV has no ${c} column: ${head.join(',').slice(0, 300)}`);
  });
}

/**
 * Custom parameters, end to end: defined on Insights, filled in for a whole experiment in its grid (a column
 * pasted fills down), on a formulation record as well, and then plotted in the explorer as a category with
 * its comparison.
 */
export async function customParameterEndToEnd({ page, open }) {
  await inDemo(page, open, ['settings', 'batches'], async () => {
    await open('insights?custom=1&cpExp=E4');
    if (!(await page.locator('#customFold').evaluate((d) => d.open))) throw new Error('?custom=1 opens the card');
    await page.fill('#cpName', 'Lipid mix no.');
    await page.click('#cpAdd');
    await page.waitForSelector('#cpGrid');
    const defs = (await readCol(page, 'settings', 'lnp-demo')).find((x) => x.id === 'customParams')?.value;
    if (defs?.[0]?.name !== 'Lipid mix no.' || defs[0].kind !== 'category') throw new Error(`stored: ${JSON.stringify(defs)}`);
    // paste a column into the first box: it fills down
    await page.evaluate(() => {
      const t = document.querySelector('#cpGrid input');
      const dt = new DataTransfer(); dt.setData('text', Array.from({ length: 18 }, (_, i) => `Mix-${1 + (i % 3)}`).join('\n'));
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(400);
    await expectText(page, '#cpSaved', /Saved 18 values pasted/, 'the paste is stored');
    const e4 = (await readCol(page, 'batches', 'lnp-demo')).filter((b) => b.experimentId === 'E4');
    const second = (await page.locator('#cpGrid tbody tr').nth(1).locator('a').innerText()).trim();
    if (e4.filter((b) => b.custom?.cp1).length !== 18 || e4.find((b) => b.id === second).custom.cp1 !== 'Mix-2') throw new Error('every E4 formulation has its mix number, in the order of the grid');
    // a numeric one, typed on a formulation record
    await page.fill('#cpName', 'Room temperature'); await page.fill('#cpUnit', '°C'); await page.selectOption('#cpKind', 'numeric');
    await page.click('#cpAdd'); await page.waitForTimeout(300);
    await open('formulation?batch=E4-F1');
    await expectText(page, '#customCard', /Custom parameters[\s\S]*Lipid mix no\.[\s\S]*Room temperature \(°C\)/, 'the record has a box for each');
    await page.fill('input[name=cp_cp2]', '21,5');
    await page.locator('input[name=cp_cp2]').press('Tab');
    await page.waitForTimeout(900);
    if ((await readCol(page, 'batches', 'lnp-demo')).find((b) => b.id === 'E4-F1').custom.cp2 !== 21.5) throw new Error('21,5 is stored as the number 21.5');
    // plotted: the mix number as a category, with its comparison
    await open('insights?y=zave_nm&x=cp_cp1');
    await page.waitForSelector('#groupTable');
    await expectText(page, '#groupTable', /Z-average size by lipid mix no\.[\s\S]*Mix-1[\s\S]*Mix-2[\s\S]*Mix-3/i, 'one row per mix');
    await expectText(page, '#exSay', /(differs between|No clear difference in Z-average size between) the 3 lipid mix no\. groups/, 'and the test');
    const opts = await page.locator('#ex_x optgroup[label="Your custom parameters"] option').allTextContents();
    if (!opts.some((o) => /Room temperature \(°C\)/.test(o))) throw new Error(`the numeric one is offered too: ${opts.join(' | ')}`);
  });
}
scenarios.push(surface3dIsARealSurface, optimizerSaysWhereItsDataComesFrom, insightsExplorer, customParameterEndToEnd);
/* ---- UX revision 2: the catalogue fold, pending experiments, the mixer as a process variable ---- */

/**
 * The catalogue's "More" fold: its arrow on the left of its label at the tile's left edge, the opened text
 * across the full width of the catalogue, kept open while the factor count changes, closed on the next visit.
 */
export async function catalogueFoldClosedOnReentry({ page, open }) {
  await open('designs');
  const tile = page.locator('article.dc-item[data-entry=bbd]');
  await tile.locator('details.dc-more > summary').click(); await page.waitForTimeout(150);
  if (!(await tile.locator('details.dc-more[open]').count())) throw new Error('"More" did not open');
  const [t, s, grid] = await Promise.all([tile.boundingBox(), tile.locator('details.dc-more > summary').boundingBox(), page.locator('article.dc-item[data-entry=bbd]').locator('xpath=..').boundingBox()]);
  if (s.x - t.x > 30) throw new Error(`the fold's arrow should sit at the left edge of the tile: ${Math.round(s.x - t.x)} px in`);
  if (t.width < grid.width - 4) throw new Error(`the opened tile should take the catalogue's width: ${Math.round(t.width)} of ${Math.round(grid.width)} px`);
  const arrow = await tile.locator('details.dc-more > summary').evaluate((n) => { const b = getComputedStyle(n, '::before'); return { content: b.content, marker: getComputedStyle(n).listStyleType }; });
  if (arrow.content === 'none' || arrow.marker !== 'none') throw new Error(`the arrow should be drawn before the label: ${JSON.stringify(arrow)}`);
  await expectText(page, 'article.dc-item[data-entry=bbd] .dc-cols', /Gives:[\s\S]*Will not tell you:[\s\S]*Use it when:/, 'the opened text');
  await page.click('#kSeg button[data-k="4"]'); await page.waitForTimeout(400);
  if (!(await page.locator('article.dc-item[data-entry=bbd] details.dc-more[open]').count())) throw new Error('changing the factor count closed the fold someone had open');
  await page.click('#nav a.item[href="#/overview"]'); await page.waitForTimeout(250);
  await page.click('#nav a.item[href="#/designs"]'); await page.waitForTimeout(400);
  const still = await page.locator('details.dc-more[open]').count();
  if (still) throw new Error(`coming back to the catalogue, ${still} fold${still === 1 ? ' is' : 's are'} still open`);
}

/**
 * An experiment started and left is pending: under "Not created yet" at the top of Experiments, in the sidebar
 * and on the overview, whichever way the wizard was left (the sidebar, the back button, a closed tab). Continue
 * opens it as it was; Discard takes it away with an Undo; creating it takes it off every list.
 */
export async function pendingExperimentDraft({ page, open, base }) {
  const name = 'Pending mixer DoE';
  await open('experiments?new=1&type=doe');
  await page.fill('input[name=name]', name);
  await page.waitForTimeout(150);
  // in the sidebar at once, while the wizard is still open
  await page.waitForSelector(`#nav a.navDraft:has-text("${name}")`, { timeout: 2000 }).catch(() => { throw new Error('the sidebar does not show the experiment being started'); });
  // left by the sidebar
  await page.click('#nav a.item[href="#/experiments"]'); await page.waitForTimeout(300);
  const row = page.locator('#expAccordion details.xpending .xpend', { hasText: name });
  if (!(await row.count())) throw new Error('the list has no "Not created yet" line for it');
  await expectText(page, '#expAccordion details.xpending', /Not created yet[\s\S]*Pending mixer DoE[\s\S]*Optimization · DoE[\s\S]*2-level full factorial over FRR, total flow[\s\S]*started today at/, 'the line says what it is, what it holds and when it was started');
  await expectText(page, '#nav', /Pending mixer DoE[\s\S]*draft/, 'the sidebar marks it a draft');
  await open('overview');
  await expectText(page, '#main', /Optimization · DoE \(2 to n factors\) “Pending mixer DoE” was started and not created yet/, 'the overview names it under needs attention');
  // a closed tab: a new one in the same browser still has it
  const other = await page.context().newPage();
  try {
    await other.goto(base + '#/experiments');
    await other.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
    await other.waitForTimeout(300);
    if (!(await other.locator('#expAccordion details.xpending', { hasText: name }).count())) throw new Error('a new tab does not list the experiment not created');
  } finally { await other.close(); }
  // Continue opens it as it was left, then the back button leaves it, and it is still there
  await open('experiments');
  await page.locator('#expAccordion .xpend', { hasText: name }).locator('a.btn', { hasText: 'Continue' }).click();
  await page.waitForSelector('#draftOn', { timeout: 3000 }).catch(() => { throw new Error('"Continue" did not open the wizard with the draft'); });
  if ((await page.inputValue('input[name=name]')) !== name) throw new Error('the continued wizard lost the name');
  if (!(await page.locator(`#nav a.navDraft.active:has-text("${name}")`).count())) throw new Error('the sidebar does not mark the draft being worked on');
  await page.fill('input[name=name]', name + ' 2'); await page.waitForTimeout(100);
  await page.goBack(); await page.waitForTimeout(300);
  await open('experiments');
  if (!(await page.locator('#expAccordion .xpend', { hasText: name + ' 2' }).count())) throw new Error('leaving by the back button lost what was typed');
  // Discard, Undo, Discard
  await page.locator('#expAccordion .xpend', { hasText: name }).locator('button', { hasText: 'Discard' }).click(); await page.waitForTimeout(150);
  if (await page.locator('#expAccordion .xpend', { hasText: name }).count()) throw new Error('Discard left the line');
  await page.click('#toast button[data-toast-action="Undo"]'); await page.waitForTimeout(200);
  if (!(await page.locator('#expAccordion .xpend', { hasText: name }).count())) throw new Error('Undo did not bring the draft back');
  if (!(await page.locator(`#nav a.navDraft:has-text("${name}")`).count())) throw new Error('Undo did not bring it back to the sidebar');
  // creating it takes it off every list
  await page.locator('#expAccordion .xpend', { hasText: name }).locator('a.btn', { hasText: 'Continue' }).click();
  await page.waitForSelector('#draftOn', { timeout: 3000 });
  await page.click('#createExp');
  await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 4000 });
  const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
  if (await page.locator(`#nav a.navDraft:has-text("${name}")`).count()) throw new Error('the created experiment is still a draft in the sidebar');
  await open('experiments');
  if (await page.locator('#expAccordion .xpend', { hasText: name }).count()) throw new Error('the created experiment is still under "Not created yet"');
  // tidy: the experiment goes, so the scenarios after this one see the lab as it was
  const rest = (await readCol(page, 'experiments')).filter((e) => e.id !== id);
  await writeCol(page, 'experiments', rest);
  await writeCol(page, 'batches', (await readCol(page, 'batches')).filter((b) => b.experimentId !== id));
}

/** OFAT over three KNAUER IJM sizes: tick the mixers, one formulation each, results by mixer name. */
export async function ofatOverThreeIJMs({ page, open }) {
  await open('experiments?new=1&type=ofat');
  await page.fill('input[name=name]', 'IJM 1, 3 and 5');
  await page.selectOption('select[name=pr_deviceId]', 'nanoscaler'); await page.waitForTimeout(300);
  await page.selectOption('select[name=ofat_factor]', 'mixer'); await page.waitForTimeout(300);
  await expectText(page, '#ofatMixers', /Mixers to compare[\s\S]*NanoScaler[\s\S]*KNAUER IJM 1[\s\S]*KNAUER IJM 5/, 'the NanoScaler offers the IJM sizes to tick');
  const using = await page.$eval('select[name=pr_mixerId]', (s) => s.value);
  if (!(await page.isChecked(`input[name="ofat_mix_${using}"]`))) throw new Error(`the mixer the process uses (${using}) should start ticked`);
  if (using !== 'knauer-ijm-1') { await page.uncheck(`input[name="ofat_mix_${using}"]`); await page.waitForTimeout(250); }
  for (const i of [1, 3, 5]) { await page.check(`input[name="ofat_mix_knauer-ijm-${i}"]`); await page.waitForTimeout(250); }
  await expectText(page, '#previewBody', /Formulations\s*3/, 'one formulation per ticked mixer');
  await page.click('#createExp');
  await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 4000 });
  await page.evaluate(() => window.lnpDb.flush());
  const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
  const forms = (await readCol(page, 'batches')).filter((b) => b.experimentId === id).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const got = forms.map((b) => [b.label, b.plan.process?.mixerId]);
  if (JSON.stringify(got) !== JSON.stringify([1, 3, 5].map((i) => [`Mixer KNAUER IJM ${i}`, `knauer-ijm-${i}`]))) throw new Error(`formulations: ${JSON.stringify(got)}`);
  // results by mixer name, as bars
  await page.evaluate(async (fs) => {
    const m = await lnpDb.read('measurements');
    fs.forEach((b, i) => {
      m.push({ id: `IJM-DLS-${b}`, batchId: b, test: 'dls', stage: 'final', date: '2026-10-17', values: { zave_nm: 70 + 15 * i, pdi: 0.1 } });
      m.push({ id: `IJM-EE-${b}`, batchId: b, test: 'ee', stage: 'final', date: '2026-10-17', values: { ee_pct: 95 - i } });
    });
    await lnpDb.write('measurements', m);
  }, forms.map((b) => b.id));
  await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await open(`doe?id=${id}`);
  await expectText(page, '#main', /KNAUER IJM 1[\s\S]*KNAUER IJM 3[\s\S]*KNAUER IJM 5/, 'Design & results names the mixers');
  await expectText(page, '#resultsCard', /lowest at Mixer KNAUER IJM 1[\s\S]*highest at Mixer KNAUER IJM 5/, 'the results say which mixer');
  await expectNoText(page, '#main', /knauer-ijm/, 'never the id');
  if (!(await page.locator('#resultsCard svg rect').count())) throw new Error('the mixers should be compared as bars');
  await open(`experiments?id=${id}`);
  await expectNoText(page, '#main', /knauer-ijm/, 'the experiment page never shows a mixer id');
  await open('experiments');
  await page.locator(`details.xrow[data-exp="${id}"] > summary`).click(); await page.waitForTimeout(200);
  await expectText(page, `details.xrow[data-exp="${id}"] .xr-body`, /mixer KNAUER IJM 3/, 'the list names the mixer of each formulation');
}

/**
 * A DoE with the mixer as a factor: added, it steps a 3-level design down to the 2-level factorial and says
 * why; low and high are two mixers; the centre points are split between them; the read-out names the mixers,
 * the surface is drawn at one mixer, and the effect plot is split by the mixer.
 */
export async function doeWithMixerFactor({ page, open }) {
  await open('experiments?new=1&type=doe');
  await page.fill('input[name=name]', 'Two IJMs');
  await page.selectOption('select[name=pr_deviceId]', 'nanoscaler'); await page.waitForTimeout(300);
  await page.selectOption('select[name=doe_designType]', 'ccd_faced'); await page.waitForTimeout(300);
  await page.click('[data-addf="mixer"]'); await page.waitForTimeout(300);
  if ((await page.$eval('select[name=doe_designType]', (s) => s.value)) !== 'full_factorial') throw new Error('adding the mixer should step the design down to the 2-level factorial');
  await expectText(page, '#toast', /2-level full factorial: a mixer has no setting in between/, 'and say why');
  const i = await page.$$eval('input[name^="doe_f_name_"]', (xs) => xs.findIndex((x) => x.value === 'mixer'));
  if (i < 0) throw new Error('no mixer row');
  await page.selectOption(`select[name=doe_f_level1_${i}]`, 'knauer-ijm-3'); await page.waitForTimeout(300);
  await expectText(page, '#wizForm', /none · split[\s\S]*centre points are split between the two mixers/, 'no centre for a mixer, and why');
  await expectText(page, '#doeSummary', /11 runs[\s\S]*8 factorial · 3 center/, 'eight corners and three centre points');
  await page.click('#createExp');
  await page.waitForFunction(() => /^#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 4000 });
  await page.evaluate(() => window.lnpDb.flush());
  const id = await page.evaluate(() => location.hash.match(/E\d+/)[0]);
  const exp = (await readCol(page, 'experiments')).find((e) => e.id === id);
  const forms = (await readCol(page, 'batches')).filter((b) => b.experimentId === id);
  const mixers = forms.map((b) => b.plan.process?.mixerId);
  if (new Set(mixers).size !== 2 || !mixers.includes('knauer-ijm-1') || !mixers.includes('knauer-ijm-3')) throw new Error(`the runs should be made on the two mixers: ${mixers.join(', ')}`);
  const centres = exp.design.doe.runs.filter((r) => r.point_type === 'center').map((r) => r.coded.mixer).sort();
  if (JSON.stringify(centres) !== '[-1,-1,1]') throw new Error(`centre points should be split between the mixers: ${JSON.stringify(centres)}`);
  // results with a clear mixer effect, a clear FRR effect and an FRR × mixer interaction
  await page.evaluate(async (runs) => {
    const m = await lnpDb.read('measurements');
    runs.forEach((r, k) => {
      const c = r.coded, wob = [0.4, -0.3, 0.2, -0.1, 0.3, -0.4, 0.1, 0.2, -0.2, 0.3, -0.1][k % 11];
      m.push({ id: `MIX-DLS-${r.batchId}`, batchId: r.batchId, test: 'dls', stage: 'final', date: '2026-10-17', values: { zave_nm: 90 - 8 * c.FRR + 12 * c.mixer + 4 * c.FRR * c.mixer + wob, pdi: 0.12 + 0.03 * c.mixer + wob / 100 } });
      m.push({ id: `MIX-EE-${r.batchId}`, batchId: r.batchId, test: 'ee', stage: 'final', date: '2026-10-17', values: { ee_pct: 92 + 2 * c.FRR - 1.5 * c.mixer + wob } });
    });
    await lnpDb.write('measurements', m);
  }, exp.design.doe.runs);
  await page.reload(); await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await open(`doe?id=${id}`);
  await expectText(page, '#driversCard', /mixer[^.]*from KNAUER IJM 1 to KNAUER IJM 3/, 'the drivers name the two mixers');
  await expectText(page, '#balanceCard', /mixer\s+KNAUER IJM [13]/, 'the recommended setting names a mixer');
  await expectNoText(page, '#balanceCard', /mixer sits at the edge/, 'a mixer is never "at the edge of the range"');
  await openFolds(page);
  await expectText(page, '#runsFold', /KNAUER IJM 1[\s\S]*KNAUER IJM 3/, 'the run table names the mixers');
  const axes = await page.$$eval('select[name=fa] option', (os) => os.map((o) => o.value));
  if (axes.includes('mixer')) throw new Error('the mixer should not be a surface axis');
  if (!(await page.locator('select[name=at]').count())) throw new Error('the surface should be drawn at one mixer, with a choice of which');
  await expectText(page, '[data-fig="surface"]', /with mixer KNAUER IJM 1/, 'the surface says which mixer it is drawn at');
  await expectText(page, '[data-fig="effect-of-one-factor"]', /mixer: KNAUER IJM 1 \/ KNAUER IJM 3/, 'the effect plot is split by the mixer, a line each');
  await page.selectOption('select[name=at]', '1'); await page.waitForTimeout(500);
  await openFolds(page);
  await expectText(page, '[data-fig="surface"]', /with mixer KNAUER IJM 3/, 'the other mixer');
  await expectNoText(page, '#main', /knauer-ijm/, 'never the id');
}
scenarios.push(catalogueFoldClosedOnReentry, pendingExperimentDraft, ofatOverThreeIJMs, doeWithMixerFactor);

/*
 * Cargo, freeze–thaw, deleting materials, buffers (UX revision 2). Each scenario puts back what it changed.
 */

/**
 * siRNA end to end: an siRNA lot under Materials, an experiment from it (the wizard's cargo follows the lot, and
 * says "siRNA" where it said mRNA), its header, a formulation record, and search.
 */
export async function siRNAExperimentEndToEnd({ page, open }) {
  const was = { rnaLots: await readCol(page, 'rnaLots'), experiments: await readCol(page, 'experiments'), batches: await readCol(page, 'batches'), counters: await readCol(page, 'counters') };
  try {
    await open('materials?tab=rna');
    await page.click('#tabBody [data-act=new]');
    await page.fill('[data-editor] [name=e_id]', 'SI-TTR-77');
    await page.selectOption('[data-editor] [name=e_cargo]', 'siRNA');
    if ((await page.getAttribute('[data-editor] [name=e_massPerPhosphate]', 'placeholder')) !== '333') throw new Error('the mass per phosphate should default to the siRNA value');
    await page.fill('[data-editor] [name=e_construct]', 'TTR');
    await page.fill('[data-editor] [name=e_conc_mg_mL]', '2');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    const lot = (await readCol(page, 'rnaLots')).find((r) => r.id === 'SI-TTR-77');
    if (lot?.cargo !== 'siRNA' || lot.conc_mg_mL !== 2) throw new Error(`siRNA lot stored as ${JSON.stringify(lot)}`);
    await expectText(page, '#tabBody', /SI-TTR-77\s*siRNA/, 'the lot is listed with its cargo');

    await open('experiments?new=1&type=single');
    await page.fill('input[name=name]', 'siRNA knockdown');
    await page.selectOption('select[name=rnaLotId]', 'SI-TTR-77');
    await page.waitForTimeout(400);
    if ((await page.inputValue('select[name=cargo]')) !== 'siRNA') throw new Error('choosing an siRNA lot should make the experiment siRNA');
    await expectText(page, '#wizForm', /siRNA lot/, 'the lot field is named for the cargo');
    await expectText(page, '#previewBody', /siRNA per formulation/, 'the preview says siRNA, not mRNA');
    await page.click('#createExp');
    await page.waitForFunction(() => /#\/experiments\?id=E\d+$/.test(location.hash), null, { timeout: 4000 });
    const id = (await page.evaluate(() => location.hash)).split('=')[1];
    await expectText(page, '#expCargo', /siRNA/, 'the experiment header names the cargo');
    await expectText(page, '#main', /RNA · siRNA[\s\S]*SI-TTR-77/, 'and its RNA lot');
    const bs = (await readCol(page, 'batches')).filter((b) => b.experimentId === id);
    if (!bs.length || !bs.every((b) => b.plan.rna.cargo === 'siRNA' && b.plan.rna.lotId === 'SI-TTR-77')) throw new Error(`the formulations do not carry siRNA: ${JSON.stringify(bs.map((b) => b.plan.rna))}`);
    await open(`formulation?batch=${bs[0].id}`);
    await expectText(page, '.cargoChip', /siRNA/, 'the formulation record names the cargo');
    await expectText(page, '#inputsCard', /RNA lot · siRNA/, 'beside its RNA lot');
  } finally {
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}

/**
 * Freeze–thaw: "Thawed today" on a stock, the count beside it wherever it is chosen (the formulation record's
 * picker, "· 2 F/T"), the warning past the threshold in Settings, the thaw logged for a formulation, and a
 * tracked lipid's lot counting its own.
 */
export async function freezeThawLoggedAndCounted({ page, open }) {
  const was = { stocks: await readCol(page, 'stocks'), batches: await readCol(page, 'batches'), experiments: await readCol(page, 'experiments'), settings: await readCol(page, 'settings'), lipids: await readCol(page, 'lipids'), lipidLots: await readCol(page, 'lipidLots') };
  try {
    const stock = { id: 'Stock-981', compositionId: 1, molPct: { MC3: 50, DSPC: 10, Chol: 38.5, DMG0PEG2000: 1.5 }, molarity_mM: 50, volume_mL: 20, date: '2026-10-01', status: 'made', actual: {}, lots: {}, rows: [] };
    const batch = await page.evaluate(async () => {
      const { buildExperiment } = await import('./app/calc/experiment.js');
      const { DEFAULT_SETTINGS } = await import('./app/refdata.js');
      return buildExperiment({ type: 'single', name: 'thaw check', startDate: '2026-10-17', compositionId: 1, stockId: 'Stock-981', tests: ['dls'] }, { settings: DEFAULT_SETTINGS, experimentId: 'E981', takenFormulations: [] });
    });
    await writeCol(page, 'stocks', [...was.stocks, stock]);
    await writeCol(page, 'experiments', [...was.experiments, batch.experiment]);
    await writeCol(page, 'batches', [...was.batches, ...batch.batches]);
    await writeCol(page, 'settings', [{ ...(was.settings.find((s) => s.id === 'default') || { id: 'default' }), ftWarnCycles: 2 }]);

    await open('stocks');
    await page.click('[data-thaw-stock="Stock-981"]');
    await page.waitForTimeout(200);
    await expectText(page, 'tr[data-stock="Stock-981"]', /1 F\/T[\s\S]*thawed today/, 'the list counts the thaw and says it is done today');
    await open('stocks?id=Stock-981');
    await expectText(page, '.thawPanel', /1 freeze–thaw cycle\b/, 'the stock shows its count');
    await page.click('.thawPanel [data-thaw-act=today]');
    await page.waitForTimeout(900);
    const s2 = (await readCol(page, 'stocks')).find((s) => s.id === 'Stock-981');
    if (s2.thaws?.length !== 2) throw new Error(`a second thaw should be stored on the stock: ${JSON.stringify(s2.thaws)}`);

    const f = batch.batches[0].id;
    await open(`formulation?batch=${f}`);
    const label = await page.$eval('select[name=stockId]', (s) => s.selectedOptions[0]?.textContent || '');
    if (!/Stock-981.*2 F\/T/.test(label)) throw new Error(`the stock picker should show the count: "${label}"`);
    await page.click('#stockThawToday');
    await page.waitForTimeout(300);
    const s3 = (await readCol(page, 'stocks')).find((s) => s.id === 'Stock-981');
    if (s3.thaws.length !== 3 || s3.thaws[2].batchId !== f) throw new Error(`the thaw for the formulation should name it: ${JSON.stringify(s3.thaws)}`);
    await expectText(page, '#stockThaw', /3 freeze–thaw cycles[\s\S]*more than 2: check it before use[\s\S]*thaw for .* is logged/, 'past the threshold it warns, and the offer is done');
    const after = await page.$eval('select[name=stockId]', (s) => s.selectedOptions[0]?.textContent || '');
    if (!/3 F\/T ⚠/.test(after)) throw new Error(`past the threshold the picker warns: "${after}"`);

    // A tracked lipid's lot counts its own thaws.
    await open('materials?tab=lipids');
    await page.click('#tabBody input[data-act=track][data-key=Chol]');
    await page.waitForTimeout(200);
    if (!(await readCol(page, 'lipids')).some((l) => l.key === 'Chol' && l.trackFT === true)) throw new Error('"track" should be stored on cholesterol');
    await page.click('#tabBody button[data-act=addlot][data-key=Chol]');
    await page.fill('[data-editor] [name=e_lot]', 'CH-FT-1');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(150);
    await expectText(page, 'tr[data-key=Chol]', /CH-FT-1[\s\S]*0 F\/T/, 'a tracked lipid\'s lot shows its count');
    const lot = (await readCol(page, 'lipidLots')).find((l) => l.lot === 'CH-FT-1');
    await page.click(`#tabBody button[data-act=lot][data-id="${lot.id}"]`);
    await page.click('[data-editor] .thawPanel [data-thaw-act=today]');
    await page.waitForTimeout(200);
    if ((await readCol(page, 'lipidLots')).find((l) => l.id === lot.id)?.thaws?.length !== 1) throw new Error('the lot\'s thaw was not stored');
    await expectText(page, 'tr[data-key=Chol]', /CH-FT-1[\s\S]*1 F\/T/, 'and the count follows');
  } finally {
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}

/**
 * Deleting an RNA lot a formulation names: the question names the formulation, the formulation keeps the lot's
 * concentration and cargo (so its numbers stay) and shows the lot as deleted, and Undo brings the lot back.
 */
export async function deleteReferencedRnaLot({ page, open }) {
  const was = { rnaLots: await readCol(page, 'rnaLots'), batches: await readCol(page, 'batches'), experiments: await readCol(page, 'experiments'), trash: await readCol(page, 'trash') };
  try {
    const built = await page.evaluate(async () => {
      const { buildExperiment } = await import('./app/calc/experiment.js');
      const { DEFAULT_SETTINGS } = await import('./app/refdata.js');
      return buildExperiment({ type: 'single', name: 'delete check', startDate: '2026-10-17', compositionId: 1, rnaLotId: 'RNA-DEL-1', tests: ['dls'] }, { settings: DEFAULT_SETTINGS, experimentId: 'E982', takenFormulations: [] });
    });
    const f = built.batches[0].id;
    await writeCol(page, 'rnaLots', [...was.rnaLots, { id: 'RNA-DEL-1', cargo: 'siRNA', construct: 'TTR', conc_mg_mL: 1.5 }]);
    await writeCol(page, 'experiments', [...was.experiments, built.experiment]);
    await writeCol(page, 'batches', [...was.batches, ...built.batches]);
    if (built.batches[0].plan.rna.stock_mg_mL != null) throw new Error('the check needs a record that takes its concentration from the lot');

    await open('materials?tab=rna');
    await expectText(page, 'tr[data-open="RNA-DEL-1"]', /1 formulation/, 'the list says the lot is used');
    await page.click('#tabBody tr.mat-row[data-open="RNA-DEL-1"]');
    await answerYes(page);
    await page.click('[data-editor] [data-act=delete]');
    await page.waitForTimeout(250);
    const asked = await stopAnswering(page);
    if (!asked.some((q) => q.includes(f) && /1\.50 mg\/mL/.test(q))) throw new Error(`the question should name ${f} and what it keeps: ${JSON.stringify(asked)}`);
    if ((await readCol(page, 'rnaLots')).some((r) => r.id === 'RNA-DEL-1')) throw new Error('the lot was not deleted');
    const b = (await readCol(page, 'batches')).find((x) => x.id === f);
    if (b.plan.rna.lotId !== 'RNA-DEL-1' || b.plan.rna.stock_mg_mL !== 1.5 || b.plan.rna.cargo !== 'mRNA') throw new Error(`the formulation should keep the lot's number and concentration, and its own cargo: ${JSON.stringify(b.plan.rna)}`);
    await page.click('#toast button[data-toast-action="Undo"]');
    await page.waitForTimeout(200);
    if (!(await readCol(page, 'rnaLots')).some((r) => r.id === 'RNA-DEL-1')) throw new Error('Undo did not bring the lot back');

    // Deleted again (from Settings' restore list the same entry would come back): the record says so.
    await page.click('#tabBody tr.mat-row[data-open="RNA-DEL-1"]');
    await answerYes(page);
    await page.click('[data-editor] [data-act=delete]');
    await page.waitForTimeout(250);
    await stopAnswering(page);
    await open(`formulation?batch=${f}`);
    const label = await page.$eval('select[name=rna_lotId]', (s) => s.selectedOptions[0]?.textContent || '');
    if (label !== 'RNA-DEL-1 (deleted)') throw new Error(`the record should name the deleted lot: "${label}"`);
    await expectText(page, '#atBench', /RNA stock to pipette[\s\S]*RNA-DEL-1 · 1\.5 mg\/mL/, 'and go on calculating with its concentration');
  } finally {
    await stopAnswering(page).catch(() => {});
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}

/**
 * One ionic strength: the Buffers screen and the process designer give the same number for citrate 50 mM pH 4.0
 * (they said 76.6 and 58 mM), and a prepared lot is offered in the process designer's buffer menu.
 */
export async function bufferIonicStrengthAgrees({ page, open }) {
  const was = { buffers: await readCol(page, 'buffers') };
  try {
    const names = await (async () => { await open('buffers'); return page.$$eval('#catalogList a.bufPrep', (as) => as.map((a) => [a.textContent, a.dataset.from])); })();
    const from = names.find(([n]) => n === 'Citrate 50 mM, pH 4.0')?.[1];
    await open(`buffers?new=1&from=${from}`);
    const shown = await page.$$eval('#bufferResult .kpi', (ks) => ks.map((k) => k.innerText));
    const I = Number(/Ionic strength\s*([\d.]+) mM/.exec(shown.join('\n'))?.[1]);
    if (!(I > 65 && I < 75)) throw new Error(`the designer's ionic strength for citrate 50 mM pH 4.0: ${shown.join(' | ')}`);
    await expectText(page, '#bufferResult', /what the meter reads/, 'the predicted pH says which scale it is');
    await page.click('#saveBuffer');
    await page.waitForFunction(() => /#\/buffers\?id=Buffer-\d+$/.test(location.hash), null, { timeout: 4000 });
    const lot = (await page.evaluate(() => location.hash)).split('=')[1];

    await open('experiments?new=1&type=single');
    const proc = Number(await page.inputValue('input[name=pr_aq_ionicStrength_mM]'));
    if (proc !== Math.round(I)) throw new Error(`the process designer says ${proc} mM where the Buffers screen says ${I} mM`);
    const offered = await page.$$eval('#wizProcess datalist option', (os) => os.map((o) => o.value));
    if (!offered.includes(lot)) throw new Error(`the prepared lot ${lot} is not offered in the process designer: ${offered.join(', ')}`);
    await page.fill('input[name=pr_aq_buffer]', lot);
    await page.dispatchEvent('input[name=pr_aq_buffer]', 'change');
    await page.waitForTimeout(400);
    if (Number(await page.inputValue('input[name=pr_aq_ionicStrength_mM]')) !== Math.round(I)) throw new Error('the lot gives the same ionic strength as its recipe');
  } finally {
    for (const c of Object.keys(was)) await writeCol(page, c, was[c]);
  }
}
scenarios.push(siRNAExperimentEndToEnd, freezeThawLoggedAndCounted, deleteReferencedRnaLot, bufferIonicStrengthAgrees);

// ---- Feedback (October 2026): the sidebar's foot and Settings open a pre-filled GitHub issue ----
export async function feedbackOpensAnIssue({ page, open }) {
  await open('doe');
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click('#feedbackBox > summary');
  await page.click('#feedbackBox [data-feedback="bug"]');
  let opened = await page.evaluate(() => window.__opened);
  if (opened.length !== 1) throw new Error(`the feedback button opened ${opened.length} pages`);
  const u = new URL(opened[0]);
  if (!/github\.com\/.+\/issues\/new$/.test(u.origin + u.pathname)) throw new Error(`feedback goes to ${u.origin + u.pathname}`);
  if (u.searchParams.get('title') !== 'Problem: Design & results') throw new Error(`the issue is titled "${u.searchParams.get('title')}"`);
  if (!/LNP Lab v\d+\.\d+\.\d+ \(browser\)/.test(u.searchParams.get('body'))) throw new Error('the issue does not carry the version');
  await open('settings');
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click('#feedbackCard [data-fb="idea"]');
  opened = await page.evaluate(() => window.__opened);
  if (!opened.length || new URL(opened[0]).searchParams.get('labels') !== 'enhancement') throw new Error('Settings › Feedback does not open an idea');
}
scenarios.push(feedbackOpensAnIssue);
