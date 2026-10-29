// Date helpers must give the same calendar arithmetic in every timezone (the wizard froze east of UTC on weekends).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { addDays, nextWorkday, shiftWeekend, toISODate, parseISO } from '../app/calc/dates.js';

test('addDays, weekend shift and parsing in the current timezone', () => {
  assert.equal(addDays('2026-10-17', 1), '2026-10-18');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30'); // DST change in Europe
  assert.equal(nextWorkday('2026-10-17'), '2026-10-19'); // Saturday -> Monday
  assert.equal(shiftWeekend('2026-10-18'), '2026-10-19');
  assert.equal(nextWorkday('2026-10-20'), '2026-10-20');
  assert.equal(toISODate(parseISO('2026-02-28')), '2026-02-28');
  assert.equal(toISODate(parseISO('garbage')), toISODate(new Date()));
});

test('the same results under Europe/Berlin, Pacific/Auckland and America/Los_Angeles, including a Saturday experiment start', () => {
  const script = `import('./app/calc/experiment.js').then((m) => {
    const r = m.buildExperiment({ type: 'single', name: 's', startDate: '2026-10-17', compositionId: 363 }, { settings: {}, experimentId: 'E1', takenFormulations: [] });
    console.log(JSON.stringify([m.addDaysISO('2026-10-17', 1), m.nextWorkday('2026-10-17'), r.batches[0].plannedDate, r.experiment.expected[0].dueDate]));
  })`;
  for (const TZ of ['Europe/Berlin', 'Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, cwd: new URL('..', import.meta.url).pathname, timeout: 10000 }).toString().trim();
    assert.deepEqual(JSON.parse(out), ['2026-10-18', '2026-10-19', '2026-10-19', '2026-10-20'], TZ);
  }
});
