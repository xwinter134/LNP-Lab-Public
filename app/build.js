// Which build this is. The public build ships with PERSONAL_BUILD false; `node scripts/dist.mjs --personal`
// writes a copy with it true into dist/, for Gholan's own app (spec 10: Insights with Claude is not part of the
// public beta). Only the personal build offers the setting "Claude insights"; with it off, or in the public
// build, nothing of that module is shown.
//
// For trying the module in a browser without a personal build: localStorage 'lnp-lab.build.personal' = '1'
// (a developer switch, not a setting; tests/scenarios.mjs uses it).
export const PERSONAL_BUILD = false;

/** Whether this copy offers the personal modules at all. */
export function personalBuildAvailable() {
  if (PERSONAL_BUILD) return true;
  try { return globalThis.localStorage?.getItem('lnp-lab.build.personal') === '1'; } catch { return false; }
}

/** Whether Claude insights are on: offered by this build and switched on in Settings. */
export const insightsOn = (settings) => personalBuildAvailable() && settings?.personalBuild === true;
