// Spec 11.1: what the code cites is cited in NOTICE.md and docs/LEARN.md too, and every place the licence check
// names is a file that exists. A source added to docs/LICENSE-CHECK.md without the other two fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const check = read('docs/LICENSE-CHECK.md'), notice = read('NOTICE.md'), learn = read('docs/LEARN.md');
const rows = check.split('\n').filter((l) => /^\| [^-|]/.test(l) && !/^\| Paper \|/.test(l) && !/Gholan's list/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

test('every place the licence check names exists', () => {
  assert.ok(rows.length >= 20);
  for (const [paper, where] of rows) for (const [, p] of where.matchAll(/`([^`]+\.(?:js|mjs|json|md))`/g)) assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `${paper}: ${p}`);
  for (const [paper, , , licence] of rows) assert.ok(licence, `${paper} has a licence column`);
});

test('the sources of the licence check are cited in NOTICE.md and docs/LEARN.md', () => {
  // The first author (or the tool's name) of each row; InVivoPLOT is the one not built, so not in NOTICE.
  const keys = ['CurTiPot', 'Hvarfner', 'Binois', 'Rasmussen', 'Ginsbourger', 'Snoek', 'Letham', 'Eriksson', 'Derringer', 'Plackett', 'Ryan', 'Maharjan', 'Sato', 'labdataranger', 'radianceQuantifier', 'Otsu', 'Welch', 'Holm', 'Šidák', 'Bland', 'S-BIAD3647'];
  for (const k of keys) {
    assert.ok(rows.some((r) => r[0].includes(k)), `${k} has a row in LICENSE-CHECK`);
    assert.ok(notice.includes(k), `${k} in NOTICE.md`);
    assert.ok(learn.includes(k), `${k} in docs/LEARN.md`);
  }
  assert.ok(rows.every((r) => keys.some((k) => r[0].includes(k)) || /Klose/.test(r[0])), 'a new row needs its key here, and its citations');
  assert.match(notice, /Copyright \(c\) 2024 KI Preclinical Imaging and Testing/);
  assert.match(check, /radianceQuantifier[^\n]*\*\*Idea only\*\*[^\n]*GPL-3\.0/);
  assert.match(check, /S-BIAD3647[^\n]*CC0/);
});
