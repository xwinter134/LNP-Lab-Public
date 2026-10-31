// The process variables a formulation records, along the process, each with its role (spec 4.1, 4.2).
//
// A variable is either a *factor*, which the optimizer may vary once the user frees it for a campaign, or
// *context*, which is stored, filtered on and used to choose the data a model is fitted to, but never varied by
// it. The ten factors of ml/space.js stay as they are and keep their own definitions there.
//
// One answer per question. Much of spec 4.1 is already on the record in 0.15: the process designer holds the
// loading buffer with its pH and strength, the mixer, the downstream steps and their buffers (plan.process,
// calc/process.js), the RNA lot holds the cargo (calc/cargo.js), and the composition holds the lipids. Those are
// read from there (`from: 'process' | 'cargo' | 'composition'`), never typed a second time. What 0.15 does not
// record (ethanol share, temperature at mixing, cryoprotectant and its concentration, the final RNA
// concentration) is kept on `plan.conditions` and typed on the formulation's "Process conditions" card. A record
// without a process (imported history, scripts/import-tidy.mjs) may carry any of them on plan.conditions; it is
// read there when the process says nothing.
//
// Categories carry their options here so the form, the data overview and the importer agree on the words.
import { cargoOf } from './cargo.js';

export const ROLES = { factor: 'Factor', context: 'Context' };

export const VARIABLE_STEPS = ['Aqueous phase', 'Organic phase', 'Mixing', 'Downstream', 'Composition', 'Cargo'];

export const BUFFER_SYSTEMS = ['Acetate', 'Citrate', 'Malate', 'Phosphate', 'HEPES', 'Tris', 'Histidine', 'MES', 'Other'];
// The kinds of the mixer records (app/data/devices.json, Materials › Devices): a mixer's type is its kind.
export const MIXER_TYPES = ['T-mixer', 'IJM', 'Microfluidic chip', 'Other'];
export const POST_METHODS = ['Dilution', 'Dialysis', 'TFF'];
export const TARGET_BUFFERS = ['PBS', 'HEPES', 'Tris', 'Histidine', 'Other'];
export const CRYOPROTECTANTS = ['None', 'Sucrose', 'Trehalose'];
export const RNA_TYPES = ['mRNA', 'siRNA', 'saRNA', 'Other'];

/**
 * The registry. `key` is the field on plan.conditions (and the column name in exports and imports), `role` the
 * default role, `filter: true` the ones the optimizer filters on by default because they change the physics.
 * `lo`/`hi`/`stepSize` on a numeric factor are its default search range, in the structure of ml/space.js.
 * `from` says where 0.15 already records it; such a variable is shown on the conditions card, not typed there.
 */
export const VARIABLES = [
  { key: 'bufferSystem', step: 'Aqueous phase', name: 'Buffer system', kind: 'category', options: BUFFER_SYSTEMS, role: 'context', from: 'process' },
  { key: 'loadingPH', step: 'Aqueous phase', name: 'Loading buffer pH', kind: 'number', unit: 'pH', role: 'factor', lo: 3, hi: 6.5, stepSize: 0.1, min: 0, max: 14, from: 'process' },
  { key: 'bufferMolarity_mM', step: 'Aqueous phase', name: 'Buffer molarity', kind: 'number', unit: 'mM', role: 'factor', lo: 10, hi: 100, stepSize: 5, min: 0, max: 1000, from: 'process' },
  { key: 'ethanolPct', step: 'Organic phase', name: 'Ethanol in lipid phase', kind: 'number', unit: '% v/v', role: 'context', min: 0, max: 100 },
  { key: 'mixTemp_C', step: 'Organic phase', name: 'Temperature at mixing', kind: 'number', unit: '°C', role: 'context', min: -20, max: 100 },
  { key: 'mixerType', step: 'Mixing', name: 'Mixer type', kind: 'category', options: MIXER_TYPES, role: 'context', filter: true, from: 'process' },
  { key: 'mixer', step: 'Mixing', name: 'Mixer', kind: 'text', role: 'context', from: 'process' },
  { key: 'postMethod', step: 'Downstream', name: 'Downstream method', kind: 'category', options: POST_METHODS, role: 'context', from: 'process' },
  { key: 'targetBuffer', step: 'Downstream', name: 'Target buffer', kind: 'category', options: TARGET_BUFFERS, role: 'context', from: 'process' },
  { key: 'targetPH', step: 'Downstream', name: 'Target buffer pH', kind: 'number', unit: 'pH', role: 'context', min: 0, max: 14, from: 'process' },
  { key: 'finalRna_mg_mL', step: 'Downstream', name: 'Final RNA concentration', kind: 'number', unit: 'mg/mL', role: 'context', min: 0, max: 20 },
  { key: 'cryoprotectant', step: 'Downstream', name: 'Cryoprotectant', kind: 'category', options: CRYOPROTECTANTS, role: 'context' },
  { key: 'cryo_pct', step: 'Downstream', name: 'Cryoprotectant concentration', kind: 'number', unit: '% w/v', role: 'context', min: 0, max: 50 },
  { key: 'sterileFiltered', step: 'Downstream', name: 'Sterile filtered', kind: 'bool', role: 'context', from: 'process' },
  { key: 'ionizableLipid', step: 'Composition', name: 'Ionizable lipid', kind: 'derived', role: 'context', filter: true, from: 'composition' },
  { key: 'pegFree', step: 'Composition', name: 'PEG-free', kind: 'derived', role: 'context', from: 'composition' },
  { key: 'rnaType', step: 'Cargo', name: 'RNA type', kind: 'category', options: RNA_TYPES, role: 'context', from: 'cargo' },
];
export const VARIABLE_BY_KEY = Object.fromEntries(VARIABLES.map((v) => [v.key, v]));
/** Variables typed on the conditions card: those 0.15 does not record anywhere else. */
export const TYPED_VARIABLES = VARIABLES.filter((v) => !v.from);

/**
 * The ionizable lipid(s) of a composition: the keys whose lipid class is "ionizable", in mol% order. A list,
 * because a composition may hold two (spec 4.4); empty when the composition is unknown or holds none.
 */
export function ionizableLipids(composition, lipidByKey = {}) {
  if (!composition?.mol_pct) return [];
  return Object.entries(composition.mol_pct)
    .filter(([k, v]) => v > 0 && lipidByKey[k]?.class === 'ionizable')
    .sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** PEG-free: no lipid of the PEG class above 0 mol%. Null when the composition is unknown. */
export function isPegFree(composition, lipidByKey = {}) {
  if (!composition?.mol_pct) return null;
  return !Object.entries(composition.mol_pct).some(([k, v]) => v > 0 && lipidByKey[k]?.class === 'peg');
}

const SYSTEM_WORD = { 'Acetic acid': 'Acetate', 'Citric acid': 'Citrate', 'Malic acid': 'Malate', 'Phosphoric acid': 'Phosphate', HEPES: 'HEPES',
  'Tris(hydroxymethyl)- aminomethane (tris)': 'Tris', Histidine: 'Histidine', '2-(N-morpholino)ethanesulfonic acid - MES': 'MES' };
const finite = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A buffer the app knows by its lot, id or name: a lot made on the Buffers screen, else a catalogue entry. */
const knownBuffer = (name, ref) => {
  const s = String(name || '').trim();
  if (!s) return null;
  return (ref?.buffers || []).find((b) => b.lot === s || b.id === s || b.name === s)
    || (ref?.buffersCatalog || []).find((b) => b.name === s || s.startsWith(`${b.name} (`)) || null;
};

/** A buffer's system in the category's words, from a lot or catalogue entry the app knows, or from its name. */
function systemWord(name, ref) {
  const s = String(name || '').trim();
  if (!s) return null;
  const known = knownBuffer(s, ref);
  if (known?.system) return SYSTEM_WORD[known.system] || 'Other';
  if (/\bPBS\b/i.test(s)) return 'Phosphate';
  for (const w of BUFFER_SYSTEMS) if (w !== 'Other' && new RegExp(`\\b${w}`, 'i').test(s)) return w;
  return null;
}
const targetWord = (name) => {
  const s = String(name || '');
  if (!s.trim()) return null;
  return /\bPBS\b/i.test(s) ? 'PBS' : /HEPES/i.test(s) ? 'HEPES' : /\bTris\b/i.test(s) ? 'Tris' : /Histidine/i.test(s) ? 'Histidine' : 'Other';
};

/**
 * What the process designer recorded for a variable, or null: only what is on the record (plan.process, or the
 * older fields processOf reads), never the lab layout a record without a process would be drawn with.
 */
function fromProcess(plan, key, ref) {
  const p = plan?.process;
  const aq = p?.aqueous?.buffer ? p.aqueous : plan?.rna?.diluent ? { buffer: plan.rna.diluent } : null;
  if (key === 'bufferSystem') return aq ? systemWord(aq.buffer, ref) : null;
  if (key === 'loadingPH') return aq ? finite(aq.pH) ?? finite(knownBuffer(aq.buffer, ref)?.targetPH) : null;
  if (key === 'bufferMolarity_mM') return aq ? finite(aq.mM) ?? finite(knownBuffer(aq.buffer, ref)?.conc_mM) : null;
  const mixerId = p?.mixerId || plan?.mixing?.mixer || null;
  const mixer = mixerId ? (ref?.mixers || []).find((m) => m.id === mixerId) || p?.mixerRecord || { id: mixerId, name: mixerId } : null;
  if (key === 'mixer') return mixer ? mixer.name || mixer.id : null;
  if (key === 'mixerType') {
    if (!mixer) return null;
    if (mixer.kind) return MIXER_TYPES.includes(mixer.kind) ? mixer.kind : 'Other';
    const s = `${mixer.id} ${mixer.name}`;
    return /t-?mixer|\btee\b|t-junction/i.test(s) ? 'T-mixer' : /ijm|impinging/i.test(s) ? 'IJM' : /chip|herringbone|nxgen|cartridge/i.test(s) ? 'Microfluidic chip' : 'Other';
  }
  const steps = Array.isArray(p?.downstream) ? p.downstream : null;
  if (key === 'postMethod') {
    if (steps) { const s = steps.find((x) => ['dialysis', 'tff', 'dilution'].includes(x.step)); return s ? { dialysis: 'Dialysis', tff: 'TFF', dilution: 'Dilution' }[s.step] : null; }
    return plan?.downstream?.tff?.enabled ? 'TFF' : plan?.downstream?.dialysis?.buffer ? 'Dialysis' : null;
  }
  const last = steps ? [...steps].reverse().find((x) => x.buffer) : plan?.downstream?.dialysis?.buffer ? { buffer: plan.downstream.dialysis.buffer } : null;
  if (key === 'targetBuffer') return last ? targetWord(last.buffer) : null;
  if (key === 'targetPH') return last ? finite(last.pH) ?? finite(knownBuffer(last.buffer, ref)?.targetPH) : null;
  if (key === 'sterileFiltered') {
    if (steps) return steps.some((x) => x.step === 'filtration') ? true : null;
    const f = plan?.downstream?.filtration?.sterile;
    return f && f !== 'None' ? true : null;
  }
  return null;
}

/**
 * One variable's value on a batch. `ref` is getRef's ({compositionById, lipidByKey, buffers, buffersCatalog,
 * mixers}); without it the composition is unknown and buffers are read by name only. A batch whose composition
 * was changed for this run (plan.compositionOverride with full mol_pct) is read with that override. Missing is
 * null, never a guess. The final RNA concentration falls back to the final formulation step's target.
 */
export function readVariable(batch, key, ref = {}) {
  const v = VARIABLE_BY_KEY[key];
  if (!v) throw new Error(`readVariable: no variable "${key}"`);
  const plan = batch?.plan;
  if (v.from === 'composition') {
    const base = ref.compositionById?.[batch?.compositionId];
    const ov = plan?.compositionOverride;
    const comp = ov?.mol_pct ? { ...base, mol_pct: ov.mol_pct } : base;
    if (key === 'ionizableLipid') { const l = ionizableLipids(comp, ref.lipidByKey); return l.length ? l : null; }
    return isPegFree(comp, ref.lipidByKey);
  }
  const typed = plan?.conditions?.[key];
  const own = typed === undefined || typed === '' ? null : typed;
  if (v.from === 'cargo') return plan?.rna?.cargo || plan?.rna?.lotId ? cargoOf(plan) : own;
  if (v.from === 'process') { const p = fromProcess(plan, key, ref); return p ?? own; }
  if (key === 'finalRna_mg_mL' && own == null) return finite(plan?.downstream?.finalFormulation?.final_mg_mL);
  return own;
}

/** Where a variable's value on this batch comes from: 'process', 'cargo', 'composition', 'conditions' or null. */
export function sourceOf(batch, key, ref = {}) {
  const v = VARIABLE_BY_KEY[key];
  if (!v) return null;
  if (v.from === 'composition') return 'composition';
  if (v.from === 'cargo' && (batch?.plan?.rna?.cargo || batch?.plan?.rna?.lotId)) return 'cargo';
  if (v.from === 'process' && fromProcess(batch?.plan, key, ref) != null) return 'process';
  return batch?.plan?.conditions?.[key] != null ? 'conditions' : null;
}

/**
 * Check one value against its variable: [] when fine, otherwise the problems, in words. The same check the form,
 * the importer and the MCP server apply (spec 6.1), so the three can never accept different things.
 */
export function checkVariable(key, value) {
  const v = VARIABLE_BY_KEY[key];
  if (!v) return [`unknown variable "${key}"`];
  if (value == null || value === '') return [];
  if (v.kind === 'derived') return [`${v.name} is worked out from the composition and cannot be set`];
  if (v.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return [`${v.name}: "${value}" is not a number`];
    if (v.min != null && n < v.min) return [`${v.name} ${n} ${v.unit || ''} is below ${v.min}`.trim()];
    if (v.max != null && n > v.max) return [`${v.name} ${n} ${v.unit || ''} is above ${v.max}`.trim()];
  }
  if (v.kind === 'bool' && typeof value !== 'boolean') return [`${v.name}: expected yes or no, got "${value}"`];
  if (v.kind === 'category' && !v.options.includes(value)) return [`${v.name}: "${value}" is not one of ${v.options.join(', ')}`];
  return [];
}

/** The role a variable plays in a campaign: the campaign's own choice, else the variable's default. */
export const roleOf = (key, campaign = {}) => campaign.roles?.[key] || VARIABLE_BY_KEY[key]?.role || 'context';

/** "With k free factors about 5 × k runs are needed for a model worth trusting; n are on file." (spec 4.2) */
export function runsNeeded(k, n) {
  const need = 5 * Math.max(0, k);
  return { need, have: n, enough: n >= need,
    sentence: `With ${k} free factor${k === 1 ? '' : 's'}, about ${need} runs are needed for a model worth trusting; ${n} ${n === 1 ? 'is' : 'are'} on file.` };
}
