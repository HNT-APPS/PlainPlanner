// Run: node --test tests/*.test.cjs  (main.js is copied to a .cjs file so it loads as CommonJS even inside a "type": "module" package)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-planner-'));
fs.copyFileSync(path.join(__dirname, '../main.js'), path.join(tmp, 'main.cjs'));
const { core } = require(path.join(tmp, 'main.cjs'));

const WEEKLY = '## PONIEDZIAŁEK\nnauka\n## WTOREK\ntrening\n## ŚRODA\nodkurzanie\n## CZWARTEK\n## PIĄTEK\n## SOBOTA\nzakupy\n## NIEDZIELA\nbieganie\n';
const MONTHLY = '- [x] 01 Faktura\n- [ ] 14 Kopia zapasowa\n- [ ] 28 Kopia zapasowa\n- [ ] 31 Koniec miesiąca\n';
const YEARLY = '**LISTOPAD:**\n- [ ] 05.11 Urodziny\n- [ ] Lekarz\n**GRUDZIEŃ:**\n- [ ] 24.12 Wigilia\n- [ ] Cele\n**CZERWIEC:**\n- [ ] Hasła\n- [x] Zrobione\n';
const src = () => core.parseSources(WEEKLY, MONTHLY, YEARLY);
const T = { y: 2026, m: 11, d: 12 };

test('round trip keeps content and fixes missing weekday', () => {
  const text = '### 12.11 CZWARTEK\nfoo\n\n### 13.11\nbar\n\n## **GRUDZIEŃ**\n### 03.12 \nbaz\n';
  const out = core.serializeDaily(core.parseDaily(text, T));
  assert.equal(out, '### 12.11 CZWARTEK\nfoo\n\n### 13.11 PIĄTEK\nbar\n\n## **GRUDZIEŃ**\n### 03.12 CZWARTEK\nbaz\n');
});

test('CRLF input is handled', () => {
  const out = core.serializeDaily(core.parseDaily('### 12.11 CZWARTEK\r\nfoo\r\n', T));
  assert.equal(out, '### 12.11 CZWARTEK\nfoo\n');
});

test('generate: weekly, monthly (clamped 31->30), yearly dated past -> today, undated -> BEZ DATY', () => {
  const model = core.parseDaily('### 12.11 CZWARTEK\nmoje\n', T);
  const st = core.newState();
  core.generateMonth(model, src(), 2026, 11, T, st);
  const out = core.serializeDaily(model);
  assert.match(out, /### 12\.11 CZWARTEK\nmoje\n- \[ \] Urodziny %%rutyna:R:2026:11%%/);
  assert.match(out, /### 14\.11 SOBOTA\n- \[ \] Kopia zapasowa %%rutyna:M:2026-11:14%%\nzakupy/);
  assert.match(out, /### 30\.11 PONIEDZIAŁEK\n- \[ \] Koniec miesiąca %%rutyna:M:2026-11:31%%\nnauka/);
  assert.match(out, /### BEZ DATY\n- \[ \] Lekarz %%rutyna:R:2026:11%%/);
  assert.doesNotMatch(out, /Faktura/);
  assert.doesNotMatch(out, /### 11\.11/);
});

test('generate is idempotent and respects deleted weekly lines', () => {
  const model = core.parseDaily('', T);
  const st = core.newState();
  core.generateMonth(model, src(), 2026, 11, T, st);
  model.months.get('2026-11').days.get(14).lines = model.months.get('2026-11').days.get(14).lines.filter((l) => l !== 'zakupy');
  const before = core.serializeDaily(model);
  const r = core.generateMonth(model, src(), 2026, 11, T, st);
  assert.deepEqual(r, { added: 0, days: 0 });
  assert.equal(core.serializeDaily(model), before);
});

test('next month ignores this month checked state, new section gets header', () => {
  const model = core.parseDaily('### 12.11 CZWARTEK\n', T);
  core.generateMonth(model, src(), 2026, 12, T, core.newState());
  const out = core.serializeDaily(model);
  assert.match(out, /## \*\*GRUDZIEŃ\*\*\n### 01\.12 WTOREK\n- \[ \] Faktura %%rutyna:M:2026-12:01%%/);
  assert.match(out, /### 24\.12 CZWARTEK\n- \[ \] Wigilia/);
});

test('yearly rest fills only later months, once', () => {
  const model = core.parseDaily('', T);
  const st = core.newState();
  const s = Object.assign(src(), { tradingSundays: false });
  assert.equal(core.generateYearlyRest(model, s, T, st), 2);
  assert.equal(core.generateYearlyRest(model, s, T, st), 0);
  const full = core.generateMonth(model, src(), 2026, 12, T, st);
  assert.equal((core.serializeDaily(model).match(/Wigilia/g) || []).length, 1);
  assert.ok(full.added > 0);
});

test('review defaults and apply: move, delete, close heading, keep', () => {
  const text = [
    '### 10.11 WTOREK',
    'moje zadanie',
    '- [ ] Kopia zapasowa %%rutyna:M:2026-11:14%%',
    '- [x] Zrobione %%rutyna:M:2026-11:01%%',
    'trening',
    '### 11.11 ŚRODA',
    'zostawiam',
    '### 12.11 CZWARTEK',
    'dzisiejsze',
  ].join('\n');
  const model = core.parseDaily(text, T);
  const review = core.collectReview(model, src(), T, core.newState());
  const b10 = review.blocks.find((b) => b.d === 10);
  assert.deepEqual(b10.items.map((i) => [i.type, i.default]), [['own', 'keep'], ['routine', 'today'], ['done', 'delete'], ['weekly', 'delete']]);
  const decisions = new Map([[b10.items[0].id, { action: 'date', date: '2026-11-20' }]]);
  const r = core.applyReview(model, review, decisions, T);
  const out = core.serializeDaily(model);
  assert.equal(r.removedBlocks, 1);
  assert.doesNotMatch(out, /### 10\.11/);
  assert.match(out, /### 11\.11 ŚRODA\nzostawiam/);
  assert.match(out, /### 12\.11 CZWARTEK\ndzisiejsze\n- \[ \] Kopia zapasowa %%rutyna:M:2026-11:14%%/);
  assert.match(out, /### 20\.11 PIĄTEK\nmoje zadanie/);
  assert.doesNotMatch(out, /Zrobione|trening/);
});

test('date action without a date leaves the item in place', () => {
  const model = core.parseDaily('### 10.11 WTOREK\nmoje\n', T);
  const review = core.collectReview(model, src(), T, core.newState());
  core.applyReview(model, review, new Map([[review.blocks[0].items[0].id, { action: 'date', date: '' }]]), T);
  assert.match(core.serializeDaily(model), /### 10\.11 WTOREK\nmoje/);
});

test('overdue yearly: listed, skip remembered, present ones not listed', () => {
  const model = core.parseDaily('', T);
  const st = core.newState();
  let review = core.collectReview(model, src(), T, st);
  assert.deepEqual(review.overdue.map((o) => o.text), ['Hasła']);
  const r = core.applyReview(model, review, new Map([[review.overdue[0].id, { action: 'skip' }]]), T);
  r.skipped.forEach((k) => st.skippedYearly.add(k));
  review = core.collectReview(model, src(), T, st);
  assert.equal(review.overdue.length, 0);
  assert.equal(core.reviewNeeded(review), false);
});

test('past month section with BEZ DATY is reviewed and removed when empty', () => {
  const D = { y: 2026, m: 12, d: 2 };
  const model = core.parseDaily('### BEZ DATY\n', D);
  const m2 = core.parseDaily('## **LISTOPAD**\n### BEZ DATY\n- [ ] Lekarz %%rutyna:R:2026:11%%\n## **GRUDZIEŃ**\n### 02.12 ŚRODA\n', D);
  const review = core.collectReview(m2, src(), D, core.newState());
  assert.equal(review.blocks[0].kind, 'extra');
  core.applyReview(m2, review, new Map(), D);
  const out = core.serializeDaily(m2);
  assert.doesNotMatch(out, /LISTOPAD/);
  assert.match(out, /### 02\.12 ŚRODA\n- \[ \] Lekarz/);
  assert.ok(model);
});

test('sync: only flipped items, matched by day for duplicate texts, current period only', () => {
  const before = core.checkboxStates('- [ ] Kopia zapasowa %%rutyna:M:2026-11:14%%\n- [ ] Kopia zapasowa %%rutyna:M:2026-11:28%%\n- [ ] Stare %%rutyna:M:2026-10:05%%\n- [ ] Lekarz %%rutyna:R:2026:11%%');
  const after = core.checkboxStates('- [ ] Kopia zapasowa %%rutyna:M:2026-11:14%%\n- [x] Kopia zapasowa %%rutyna:M:2026-11:28%%\n- [x] Stare %%rutyna:M:2026-10:05%%\n- [x] Lekarz %%rutyna:R:2026:11%%');
  const changes = core.diffStates(before, after);
  assert.equal(changes.length, 3);
  const monthly = core.applySyncMonthly(MONTHLY + '- [ ] 05 Stare\n', changes, T);
  assert.match(monthly, /- \[ \] 14 Kopia zapasowa\n- \[x\] 28 Kopia zapasowa/);
  assert.match(monthly, /- \[ \] 05 Stare/);
  assert.match(core.applySyncYearly(YEARLY, changes, T), /- \[x\] Lekarz/);
  const undo = core.diffStates(after, before);
  assert.match(core.applySyncMonthly(monthly, undo, T), /- \[ \] 28 Kopia zapasowa/);
});

test('uncheckAll resets routine files', () => {
  assert.equal(core.uncheckAll('- [x] 01 A\n- [X] B\n- [ ] C'), '- [ ] 01 A\n- [ ] B\n- [ ] C');
});

test('year resolution: December stays last year in January', () => {
  assert.equal(core.resolveYear(12, 30, { y: 2027, m: 1, d: 3 }), 2026);
  assert.equal(core.resolveYear(1, 5, { y: 2026, m: 12, d: 20 }), 2027);
});

test('review: nextMonth action moves to BEZ DATY of the month after today', () => {
  const model = core.parseDaily('### 10.11 WTOREK\nmoje\n### 12.11 CZWARTEK\n', T);
  const review = core.collectReview(model, src(), T, core.newState());
  core.applyReview(model, review, new Map([[review.blocks[0].items[0].id, { action: 'nextMonth' }]]), T);
  assert.equal(core.serializeDaily(model), '### 12.11 CZWARTEK\n\n## **GRUDZIEŃ**\n### BEZ DATY\nmoje\n');
});

test('review: nextMonth in December goes to January next year', () => {
  const D = { y: 2026, m: 12, d: 20 };
  const model = core.parseDaily('## **GRUDZIEŃ**\n### 10.12 CZWARTEK\nmoje\n', D);
  const review = core.collectReview(model, src(), D, core.newState());
  core.applyReview(model, review, new Map([[review.blocks[0].items[0].id, { action: 'nextMonth' }]]), D);
  assert.equal(core.serializeDaily(model), '## **GRUDZIEŃ**\n\n## **STYCZEŃ**\n### BEZ DATY\nmoje\n');
});

test('editor move: selected lines jump to next month after their own month, headings skipped', () => {
  const text = '### 13.11 PIĄTEK\njeden\ndwa\n\n## **GRUDZIEŃ**\n### 05.12 SOBOTA\ngrudniowe\n### BEZ DATY\nstare\n';
  // lines 0..2 = heading + jeden + dwa -> December BEZ DATY, after "stare"
  const r1 = core.moveLinesToNextMonth(text, 0, 2, T);
  assert.equal(r1.count, 2);
  assert.deepEqual(r1.target, { y: 2026, m: 12 });
  assert.equal(r1.text, '### 13.11 PIĄTEK\n\n## **GRUDZIEŃ**\n### 05.12 SOBOTA\ngrudniowe\n\n### BEZ DATY\nstare\njeden\ndwa\n');
  // a December line goes to January
  const r2 = core.moveLinesToNextMonth(text, 6, 6, T);
  assert.deepEqual(r2.target, { y: 2027, m: 1 });
  assert.match(r2.text, /## \*\*STYCZEŃ\*\*\n### BEZ DATY\ngrudniowe\n$/);
  // only a heading / blank selected -> nothing
  assert.equal(core.moveLinesToNextMonth(text, 3, 4, T), null);
});

test('editor move: a line in a past day still goes to the month after today', () => {
  const r = core.moveLinesToNextMonth('### 10.11 WTOREK\nstare\n', 1, 1, T);
  assert.deepEqual(r.target, { y: 2026, m: 12 });
  const rOct = core.moveLinesToNextMonth('## **PAŹDZIERNIK**\n### 20.10 WTOREK\nbardzo stare\n', 2, 2, T);
  assert.deepEqual(rOct.target, { y: 2026, m: 12 });
});

// --- ŚWIĘTA ---------------------------------------------------------------

const HOLIDAYS = [
  '## STAŁE',
  '11.11 Święto Niepodległości #wolne',
  '25.12 Boże Narodzenie #wolne #nakazane',
  '01.01 Nowy Rok #wolne',
  '## RUCHOME',
  'WIELKANOC Wielkanoc #wolne',
  'WIELKANOC+60 Boże Ciało #wolne',
  'ADWENT I Niedziela Adwentu',
  '- 13.11 Urodziny Ani',
  '- [ ] 25.12-24 Kup prezenty',
  '- [ ] 01.01-3 Zaplanuj sylwestra',
  'tekst bez daty',
].join('\n');
const srcH = () => core.parseSources(WEEKLY, MONTHLY, YEARLY, HOLIDAYS);

test('Easter and Advent dates', () => {
  assert.deepEqual(core.easterOf(2025), { y: 2025, m: 4, d: 20 });
  assert.deepEqual(core.easterOf(2026), { y: 2026, m: 4, d: 5 });
  assert.deepEqual(core.easterOf(2027), { y: 2027, m: 3, d: 28 });
  assert.deepEqual(core.easterOf(2038), { y: 2038, m: 4, d: 25 });
  assert.deepEqual(core.adventOf(2026), { y: 2026, m: 11, d: 29 });
  assert.deepEqual(core.adventOf(2025), { y: 2025, m: 11, d: 30 });
  assert.deepEqual(core.adventOf(2027), { y: 2027, m: 11, d: 28 });
});

test('shopping Sundays 2025 and 2026', () => {
  const iso = (y) => core.tradingSundays(y, new Set([core.toIso(core.easterOf(y))])).map(core.toIso).sort();
  assert.deepEqual(iso(2025), ['2025-01-26', '2025-04-13', '2025-04-27', '2025-06-29', '2025-08-31', '2025-12-07', '2025-12-14', '2025-12-21']);
  assert.deepEqual(iso(2026), ['2026-01-25', '2026-03-29', '2026-04-26', '2026-06-28', '2026-08-30', '2026-12-06', '2026-12-13', '2026-12-20']);
  // a holiday on the last Sunday pushes it a week earlier
  assert.deepEqual(core.tradingSundays(2026, new Set(['2026-04-26'])).map(core.toIso)[1], '2026-04-19');
});

test('holiday file parsing: tasks, offsets, bullets, junk ignored', () => {
  const h = core.parseHolidays(HOLIDAYS);
  assert.equal(h.length, 9);
  assert.deepEqual(h.find((x) => x.text === 'Boże Ciało'), undefined);
  assert.deepEqual(h.find((x) => x.text.startsWith('Boże Ciało')).base, { kind: 'easter' });
  assert.equal(h.find((x) => x.text.startsWith('Boże Ciało')).offset, 60);
  assert.equal(h.find((x) => x.text === 'Kup prezenty').task, true);
  assert.equal(h.find((x) => x.text === 'Urodziny Ani').task, false);
});

test('labels: WOLNE from #wolne, HANDLOWA for shopping Sundays', () => {
  const cal = core.computeCalendar(2026, core.parseHolidays(HOLIDAYS), true);
  assert.equal(cal.labels.get('2026-11-11'), 'WOLNE');
  assert.equal(cal.labels.get('2026-04-05'), 'WOLNE');
  assert.equal(cal.labels.get('2026-06-04'), 'WOLNE');
  assert.equal(cal.labels.get('2026-12-20'), 'HANDLOWA');
  assert.equal(core.computeCalendar(2026, [], false).labels.size, 0);
});

test('generate with holidays: info on top, tasks at bottom, labels in headings, past holidays skipped', () => {
  const model = core.parseDaily('### 13.11 PIĄTEK\nmoje\n', T);
  const st = core.newState();
  core.generateMonth(model, srcH(), 2026, 11, T, st);
  core.generateYearlyRest(model, srcH(), T, st);
  const out = core.serializeDaily(model);
  assert.doesNotMatch(out, /Niepodległości/); // 11.11 already passed
  assert.match(out, /### 13\.11 PIĄTEK\nUrodziny Ani %%rutyna:S:2026:11-13%%\nmoje\n/);
  assert.match(out, /### 29\.11 NIEDZIELA\nI Niedziela Adwentu %%rutyna:S:2026:11-29%%\nbieganie/);
  assert.match(out, /### 01\.12 WTOREK\n- \[ \] Kup prezenty %%rutyna:S:2026:12-01%%/);
  assert.match(out, /### 06\.12 NIEDZIELA - HANDLOWA\n/);
  assert.match(out, /### 25\.12 PIĄTEK - WOLNE\nBoże Narodzenie #wolne #nakazane %%rutyna:S:2026:12-25%%/);
  assert.match(out, /### 29\.12 WTOREK\n- \[ \] Zaplanuj sylwestra %%rutyna:S:2026:12-29%%/);
  // idempotent, and labels survive a round trip
  const again = core.parseDaily(out, T);
  core.generateYearlyRest(again, srcH(), T, st);
  assert.equal(core.serializeDaily(again), out);
  core.generateMonth(again, srcH(), 2026, 12, T, st);
  const full = core.serializeDaily(again);
  assert.equal((full.match(/Boże Narodzenie/g) || []).length, 1);
  assert.match(full, /### 25\.12 PIĄTEK - WOLNE/);
  assert.match(full, /### 20\.12 NIEDZIELA - HANDLOWA/);
});

test('full month generation labels new days, keeps user labels', () => {
  const model = core.parseDaily('## **GRUDZIEŃ**\n### 13.12 NIEDZIELA - moja notatka\n', T);
  core.generateMonth(model, srcH(), 2026, 12, T, core.newState());
  const out = core.serializeDaily(model);
  assert.match(out, /### 13\.12 NIEDZIELA - moja notatka\n/);
  assert.match(out, /### 20\.12 NIEDZIELA - HANDLOWA\n/);
  assert.match(out, /### 26\.12 SOBOTA\n/);
});

test('review: past holiday info defaults to delete, holiday task to today', () => {
  const model = core.parseDaily('### 10.11 WTOREK - WOLNE\nŚwięto %%rutyna:S:2026:11-10%%\n- [ ] Prezent %%rutyna:S:2026:11-10%%\n', T);
  const review = core.collectReview(model, srcH(), T, core.newState());
  assert.deepEqual(review.blocks[0].items.map((i) => [i.type, i.default]), [['holiday', 'delete'], ['routine', 'today']]);
});

// --- work tag, ranges, late additions -----------------------------------------

const WEEKLY_WORK = '## PONIEDZIAŁEK\nPraca #praca\nZakupy\nPraca #praca\nObiad\nPraca #praca\n## WTOREK\nPraca #praca\n## ŚRODA\nPraca #praca\nTrening\n## CZWARTEK\nPraca #praca\n## PIĄTEK\nPraca #praca\n## SOBOTA\n## NIEDZIELA\n';
const srcW = (hol) => core.parseSources(WEEKLY_WORK, '', '', hol || '11.11 Niepodległości #wolne');

test('repeated weekly lines are all kept, in order', () => {
  const model = core.parseDaily('', T);
  core.generateMonth(model, srcW(), 2026, 11, T, core.newState());
  assert.match(core.serializeDaily(model), /### 16\.11 PONIEDZIAŁEK\nPraca #praca\nZakupy\nPraca #praca\nObiad\nPraca #praca\n/);
});

test('work-tagged weekly lines are skipped on days off, other lines stay', () => {
  const D = { y: 2026, m: 11, d: 1 };
  const model = core.parseDaily('', D);
  core.generateMonth(model, srcW(), 2026, 11, D, core.newState());
  const out = core.serializeDaily(model);
  assert.match(out, /### 11\.11 ŚRODA - WOLNE\nNiepodległości #wolne %%rutyna:S:2026:11-11%%\nTrening\n\n### 12\.11/);
  assert.match(out, /### 18\.11 ŚRODA\nPraca #praca\nTrening\n/);
});

test('empty work tag setting disables skipping', () => {
  const D = { y: 2026, m: 11, d: 1 };
  const model = core.parseDaily('', D);
  core.generateMonth(model, Object.assign(srcW(), { workTag: '' }), 2026, 11, D, core.newState());
  assert.match(core.serializeDaily(model), /### 11\.11 ŚRODA - WOLNE\n[\s\S]*?Praca #praca\nTrening/);
});

test('leave range added later: future days get WOLNE and lose work lines, once; past days untouched', () => {
  const st = core.newState();
  const model = core.parseDaily('', T);
  core.generateMonth(model, srcW(), 2026, 11, T, st);
  const leave = srcW('11.11 Niepodległości #wolne\n10.11-18.11 Urlop #wolne');
  core.generateMonth(model, leave, 2026, 11, T, st);
  core.generateYearlyRest(model, leave, T, st);
  let out = core.serializeDaily(model);
  assert.match(out, /### 16\.11 PONIEDZIAŁEK - WOLNE\nZakupy\nObiad\n/);
  assert.match(out, /### 18\.11 ŚRODA - WOLNE\nTrening\n/);
  assert.match(out, /### 19\.11 CZWARTEK\nPraca #praca\n/);
  assert.doesNotMatch(out, /Urlop/); // starts 10.11, already past
  // a work line put back by hand on a day off is left alone
  model.months.get('2026-11').days.get(16).lines.push('Praca #praca');
  core.generateYearlyRest(model, leave, T, st);
  out = core.serializeDaily(model);
  assert.match(out, /### 16\.11 PONIEDZIAŁEK - WOLNE\nZakupy\nObiad\nPraca #praca\n/);
});

test('a heading marked "- WOLNE" by hand also drops work lines', () => {
  const st = core.newState();
  const model = core.parseDaily('', T);
  core.generateMonth(model, srcW(''), 2026, 11, T, st);
  model.months.get('2026-11').days.get(17).label = 'WOLNE';
  core.generateMonth(model, srcW(''), 2026, 11, T, st);
  assert.match(core.serializeDaily(model), /### 17\.11 WTOREK - WOLNE\n### 18\.11/);
});

test('ranges: year-specific, crossing New Year, offsets still work', () => {
  const h = core.parseHolidays('10.08.2027-20.08.2027 Urlop #wolne\n28.12-03.01 Przerwa #wolne\n25.12-24 Prezenty\n05.05.2026 Jednorazowe');
  assert.deepEqual(h[0].base, { kind: 'fixed', d: 10, m: 8, year: 2027 });
  assert.deepEqual(h[0].end, { d: 20, m: 8, year: 2027 });
  assert.equal(h[2].end, null);
  assert.equal(h[2].offset, -24);
  const c26 = core.computeCalendar(2026, h, false);
  assert.equal([...c26.labels.keys()].filter((k) => k.startsWith('2027-08')).length, 0);
  assert.ok(c26.labels.has('2026-12-28') && c26.labels.has('2027-01-03') && !c26.labels.has('2027-01-04'));
  assert.ok(c26.events.some((e) => e.text === 'Jednorazowe'));
  const c27 = core.computeCalendar(2027, h, false);
  assert.equal([...c27.labels.keys()].filter((k) => k.startsWith('2027-08')).length, 11);
  assert.equal(c27.events.filter((e) => e.text === 'Urlop #wolne').length, 1);
  assert.ok(!c27.events.some((e) => e.text === 'Jednorazowe'));
});

test('holiday added to the file later shows up; a deleted one does not come back', () => {
  const st = core.newState();
  const model = core.parseDaily('', T);
  core.generateYearlyRest(model, srcW('25.12 Boże Narodzenie #wolne'), T, st);
  const dec = model.months.get('2026-12');
  dec.days.get(25).lines = [];
  core.generateYearlyRest(model, srcW('25.12 Boże Narodzenie #wolne\n20.12 Urodziny Ani'), T, st);
  const out = core.serializeDaily(model);
  assert.doesNotMatch(out, /Boże Narodzenie/);
  assert.match(out, /### 20\.12 NIEDZIELA - HANDLOWA\nUrodziny Ani/);
});

test('migration from the old per-month gate marks those months as placed', () => {
  const st = core.newState();
  core.migrateFilledHolidays(srcW('25.12 Boże Narodzenie #wolne'), ['2026-12'], st);
  const model = core.parseDaily('', T);
  core.generateYearlyRest(model, srcW('25.12 Boże Narodzenie #wolne'), T, st);
  assert.doesNotMatch(core.serializeDaily(model), /Boże Narodzenie|WOLNE|HANDLOWA/);
});

// --- applying routine edits to filled days ------------------------------------

test('weekly edit: replaced in filled days from start, own lines and deletions respected', () => {
  const oldW = '## PONIEDZIAŁEK\nnauka\npraca\nsprzątanie\n## WTOREK\ntrening\n';
  const newW = '## PONIEDZIAŁEK\nnauka jazdy\npraca #praca\nsprzątanie\nnowe\n## WTOREK\ntrening\n';
  const st = core.newState();
  const model = core.parseDaily('### 16.11 PONIEDZIAŁEK\nmoje\n', T);
  const oldSrc = core.parseSources(oldW, '', '', '');
  core.generateMonth(model, oldSrc, 2026, 11, T, st);
  // done & deleted "sprzątanie" on 23.11
  const d23 = model.months.get('2026-11').days.get(23);
  d23.lines = d23.lines.filter((l) => l !== 'sprzątanie');
  const snap = core.weeklySnapshot(oldSrc.weekly);
  const newSrc = core.parseSources(newW, '', '', '');
  assert.deepEqual(core.routinesChanged(newSrc, snap, []), { weekly: true, monthly: false });
  core.applyWeeklyChange(model, newSrc, snap, st, { y: 2026, m: 11, d: 17 });
  const out = core.serializeDaily(model);
  assert.match(out, /### 16\.11 PONIEDZIAŁEK\nmoje\nnauka\npraca\nsprzątanie\n/); // before start: untouched
  assert.match(out, /### 23\.11 PONIEDZIAŁEK\nnauka jazdy\npraca #praca\nnowe\n/);
  assert.match(out, /### 30\.11 PONIEDZIAŁEK\nnauka jazdy\npraca #praca\nsprzątanie\nnowe\n/);
  assert.match(out, /### 24\.11 WTOREK\ntrening\n/);
});

test('weekly edit: own lines in between stay in place, day off drops work line', () => {
  const st = core.newState();
  const model = core.parseDaily('', T);
  const oldSrc = core.parseSources('## PONIEDZIAŁEK\nA\nB\n', '', '', '');
  core.generateMonth(model, oldSrc, 2026, 11, T, st);
  const d16 = model.months.get('2026-11').days.get(16);
  d16.lines = ['moje 1', 'A', 'B', 'moje 2'];
  model.months.get('2026-11').days.get(23).label = 'WOLNE';
  const newSrc = core.parseSources('## PONIEDZIAŁEK\nA\nPraca #praca\nB\n', '', '', '');
  core.applyWeeklyChange(model, newSrc, core.weeklySnapshot(oldSrc.weekly), st, T);
  assert.deepEqual(d16.lines, ['moje 1', 'A', 'Praca #praca', 'B', 'moje 2']);
  assert.deepEqual(model.months.get('2026-11').days.get(23).lines, ['A', 'B']);
});

test('weekly: line that only gained a tag is replaced in place; split line works', () => {
  const st = core.newState();
  const model = core.parseDaily('', T);
  const oldSrc = core.parseSources('## PIĄTEK\nnauka\npraca / projekty\nkoronka\n', '', '', '');
  core.generateMonth(model, oldSrc, 2026, 11, T, st);
  model.months.get('2026-11').days.get(13).lines.splice(1, 0, 'moje');
  const snap = core.weeklySnapshot(oldSrc.weekly);
  const split = core.parseSources('## PIĄTEK\nnauka\npraca #praca\nwłasne projekty\nkoronka\n', '', '', '');
  core.applyWeeklyChange(model, split, snap, st, T);
  const out = core.serializeDaily(model);
  assert.match(out, /### 13\.11 PIĄTEK\nnauka\nmoje\npraca #praca\nwłasne projekty\nkoronka\n/);
  assert.doesNotMatch(out, /praca \/ projekty/);
  const tagged = core.parseSources('## PIĄTEK\nnauka\npraca / projekty #praca\nkoronka\n', '', '', '');
  const m2 = core.parseDaily('', T);
  const st2 = core.newState();
  core.generateMonth(m2, oldSrc, 2026, 11, T, st2);
  core.applyWeeklyChange(m2, tagged, snap, st2, T);
  assert.match(core.serializeDaily(m2), /### 20\.11 PIĄTEK\nnauka\npraca \/ projekty #praca\nkoronka\n/);
});

test('monthly edit: removed, added, day moved, ticked kept, past day goes to start', () => {
  const oldM = '- [ ] 14 Kopia\n- [ ] 20 Czynsz\n- [ ] 28 Telefon\n- [ ] 25 Usunięte\n';
  const newM = '- [ ] 14 Kopia\n- [ ] 21 Czynsz\n- [ ] 27 Telefon\n- [ ] 05 Nowe\n- [ ] 18 Też nowe\n';
  const st = core.newState();
  const model = core.parseDaily('', T);
  const oldSrc = core.parseSources('', oldM, '', '');
  core.generateMonth(model, oldSrc, 2026, 11, T, st);
  // "Telefon" ticked already
  const d28 = model.months.get('2026-11').days.get(28);
  d28.lines = d28.lines.map((l) => l.replace('- [ ] Telefon', '- [x] Telefon'));
  const snap = core.monthlySnapshot(oldSrc.monthly);
  const newSrc = core.parseSources('', newM, '', '');
  assert.equal(core.routinesChanged(newSrc, [], snap).monthly, true);
  core.applyMonthlyChange(model, newSrc, snap, st, T, T);
  const out = core.serializeDaily(model);
  assert.match(out, /### 14\.11 SOBOTA\n- \[ \] Kopia %%rutyna:M:2026-11:14%%/);
  assert.doesNotMatch(out, /Czynsz %%rutyna:M:2026-11:20%%/);
  assert.match(out, /### 21\.11 SOBOTA\n- \[ \] Czynsz %%rutyna:M:2026-11:21%%/);
  assert.match(out, /- \[x\] Telefon %%rutyna:M:2026-11:28%%/);
  assert.doesNotMatch(out, /Telefon %%rutyna:M:2026-11:27%%/);
  assert.doesNotMatch(out, /Usunięte/);
  assert.match(out, /### 12\.11 CZWARTEK\n- \[ \] Nowe %%rutyna:M:2026-11:05%%/);
  assert.match(out, /### 18\.11 ŚRODA\n- \[ \] Też nowe %%rutyna:M:2026-11:18%%/);
});

test('no change -> nothing reported', () => {
  const src0 = core.parseSources(WEEKLY, MONTHLY, '', '');
  assert.deepEqual(core.routinesChanged(src0, core.weeklySnapshot(src0.weekly), core.monthlySnapshot(src0.monthly)), { weekly: false, monthly: false });
});

// --- week alert ---------------------------------------------------------------

test('week alert: today..Sunday, events without tags, labels, tasks', () => {
  const s = core.parseSources('', '', '', '19.11 Święto X #wolne\n- [ ] 21.11 Kup kwiaty\n17.11 Urodziny Ani\n23.11 Za daleko');
  const MON = { y: 2026, m: 11, d: 16 };
  const days = core.weekAhead(s, MON);
  assert.deepEqual(days.map((d) => [d.iso, d.label, d.events.map((e) => [e.text, e.task])]), [
    ['2026-11-17', '', [['Urodziny Ani', false]]],
    ['2026-11-19', 'WOLNE', [['Święto X', false]]],
    ['2026-11-21', '', [['Kup kwiaty', true]]],
  ]);
  // Sunday: only Sunday itself; shopping Sunday label across a month boundary
  const days2 = core.weekAhead(core.parseSources('', '', '', ''), { y: 2026, m: 12, d: 20 });
  assert.deepEqual(days2.map((d) => [d.iso, d.label]), [['2026-12-20', 'HANDLOWA']]);
  const days3 = core.weekAhead(core.parseSources('', '', '', '01.12 Grudzień'), { y: 2026, m: 11, d: 30 });
  assert.deepEqual(days3.map((d) => d.iso), ['2026-12-01', '2026-12-06']);
});

test('week alert: OK silences the week until entries change, snooze until tomorrow', () => {
  const s = core.parseSources('', '', '', '19.11 Święto X #wolne');
  const MON = { y: 2026, m: 11, d: 16 };
  const TUE = { y: 2026, m: 11, d: 17 };
  const days = core.weekAhead(s, MON);
  assert.equal(core.shouldShowWeekAlert(days, null, MON), true);
  assert.equal(core.shouldShowWeekAlert([], null, MON), false);
  const base = { week: '2026-11-16', sig: core.weekSignature(days) };
  assert.equal(core.shouldShowWeekAlert(days, { ...base, ok: true }, MON), false);
  // entries change (tuesday sees same list here, so still silent)
  assert.equal(core.shouldShowWeekAlert(core.weekAhead(s, TUE), { ...base, ok: true }, TUE), false);
  const more = core.weekAhead(core.parseSources('', '', '', '19.11 Święto X #wolne\n18.11 Nowe'), MON);
  assert.equal(core.shouldShowWeekAlert(more, { ...base, ok: true }, MON), true);
  const snoozed = { ...base, ok: false, snoozeUntil: '2026-11-17' };
  assert.equal(core.shouldShowWeekAlert(days, snoozed, MON), false);
  assert.equal(core.shouldShowWeekAlert(core.weekAhead(s, TUE), { ...snoozed, sig: core.weekSignature(core.weekAhead(s, TUE)) }, TUE), true);
  // next week -> shows again
  const nextMon = { y: 2026, m: 11, d: 23 };
  assert.equal(core.shouldShowWeekAlert(core.weekAhead(core.parseSources('', '', '', '25.11 Y'), nextMon), { ...base, ok: true }, nextMon), true);
  assert.equal(core.toIso(core.weekStart({ y: 2026, m: 11, d: 22 })), '2026-11-16');
});

// --- long absence -------------------------------------------------------------

test('missed days of the current month: unticked monthly tasks go to today, once', () => {
  const D = { y: 2026, m: 12, d: 3 };
  const s = core.parseSources('', '- [ ] 01 Faktura\n- [x] 02 Zrobione\n- [ ] 05 Później\n', '', '');
  const st = core.newState();
  const model = core.parseDaily('', D);
  core.generateMonth(model, s, 2026, 12, D, st);
  let out = core.serializeDaily(model);
  assert.match(out, /### 03\.12 CZWARTEK\n- \[ \] Faktura %%rutyna:M:2026-12:01%%\n\n/);
  assert.doesNotMatch(out, /Zrobione/);
  assert.match(out, /### 05\.12 SOBOTA\n- \[ \] Później/);
  // done & deleted -> does not come back
  model.months.get('2026-12').days.get(3).lines = [];
  core.generateMonth(model, s, 2026, 12, D, st);
  out = core.serializeDaily(model);
  assert.doesNotMatch(out, /Faktura/);
  // days that were written out normally are not touched
  const st2 = core.newState();
  const m2 = core.parseDaily('', { y: 2026, m: 12, d: 1 });
  core.generateMonth(m2, s, 2026, 12, { y: 2026, m: 12, d: 1 }, st2);
  m2.months.get('2026-12').days.get(1).lines = [];
  core.generateMonth(m2, s, 2026, 12, D, st2);
  assert.doesNotMatch(core.serializeDaily(m2), /Faktura/);
});

test('spread: items dealt round-robin over N days from today', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'].map((x) => `- [ ] ${x} %%rutyna:M:2026-11:0${'abcde'.indexOf(x) + 1}%%`);
  const model = core.parseDaily('### 10.11 WTOREK\n' + lines.join('\n') + '\n', T);
  const review = core.collectReview(model, core.parseSources('', '', '', ''), T, core.newState());
  const dec = new Map(review.blocks[0].items.map((it) => [it.id, { action: 'spread' }]));
  core.applyReview(model, review, dec, T, { spreadDays: 3 });
  const out = core.serializeDaily(model);
  assert.match(out, /### 12\.11 CZWARTEK\n- \[ \] a [^\n]*\n- \[ \] d /);
  assert.match(out, /### 13\.11 PIĄTEK\n- \[ \] b [^\n]*\n- \[ \] e /);
  assert.match(out, /### 14\.11 SOBOTA\n- \[ \] c /);
  assert.doesNotMatch(out, /### 10\.11/);
});

test('undo marks: snapshot then restore brings back the written-out memory', () => {
  const st = core.newState();
  st.filledDays.add('2026-11-12');
  st.skippedYearly.add('R|2026|x');
  const marks = core.snapshotMarks(st);
  core.generateMonth(core.parseDaily('', T), src(), 2026, 11, T, st);
  st.filledYearly.add('2026-12');
  assert.ok(st.filledDays.has('2026-11-30'));
  core.restoreMarks(st, JSON.parse(JSON.stringify(marks)));
  assert.deepEqual([...st.filledDays], ['2026-11-12']);
  assert.deepEqual([...st.filledYearly], []);
  assert.deepEqual([...st.skippedYearly], ['R|2026|x']);
  assert.ok(st.placedHolidays instanceof Set && st.placedHolidays.size === 0);
  const fresh = core.generateMonth(core.parseDaily('', T), src(), 2026, 11, T, st);
  assert.ok(fresh.days > 0, 'month can be written out again after restore');
});

test('cleanSetting: trims text, bounds numbers, coerces toggles', () => {
  const num = { type: 'number', min: 1, max: 31 };
  assert.equal(core.cleanSetting({ type: 'text' }, '  #praca '), '#praca');
  assert.equal(core.cleanSetting({ type: 'file' }, null), '');
  assert.equal(core.cleanSetting(num, '7'), 7);
  assert.equal(core.cleanSetting(num, 31), 31);
  assert.equal(core.cleanSetting(num, '0'), null);
  assert.equal(core.cleanSetting(num, 'abc'), null);
  assert.equal(core.cleanSetting(num, 2.5), null);
  assert.equal(core.cleanSetting({ type: 'toggle' }, 1), true);
});

// --- English note format ----------------------------------------------------

const WEEKLY_EN = '## MONDAY\nstudy\n## TUESDAY\nworkout\n## WEDNESDAY\n## THURSDAY\nemails #work\n## FRIDAY\n## SATURDAY\nshopping\n## SUNDAY\nrun\n';
const YEARLY_EN = '**NOVEMBER:**\n- [ ] 20.11 Car service\n- [ ] Doctor\n**DECEMBER:**\n- [ ] Goals\n';
const HOLIDAYS_EN = '19.11 Founders Day #dayoff\nEASTER Easter Sunday\nADVENT-1 Before Advent\n';
const srcEn = () => {
  const s = core.parseSources(WEEKLY_EN, '- [ ] 14 Backup\n', YEARLY_EN, HOLIDAYS_EN);
  s.workTag = '#work';
  return s;
};

test('English sources: weekday, month, EASTER and ADVENT keywords are read', () => {
  const s = srcEn();
  assert.deepEqual(s.weekly.get(1), ['study']);
  assert.deepEqual(s.weekly.get(4), ['emails #work']);
  assert.deepEqual(s.yearly.map((y) => [y.month, y.text]), [[11, 'Car service'], [11, 'Doctor'], [12, 'Goals']]);
  assert.deepEqual(s.holidays.map((h) => h.base.kind), ['fixed', 'easter', 'advent']);
});

test('generate in English: headings, NO DATE, routine marker, DAY OFF skips #work', () => {
  const model = core.parseDaily('', T, 'en');
  core.generateMonth(model, srcEn(), 2026, 11, T, core.newState());
  const out = core.serializeDaily(model);
  assert.match(out, /^## \*\*NOVEMBER\*\*\n### 12\.11 THURSDAY\nemails #work\n/m);
  assert.match(out, /### 14\.11 SATURDAY\n- \[ \] Backup %%routine:M:2026-11:14%%\nshopping/);
  assert.match(out, /### 19\.11 THURSDAY - DAY OFF\nFounders Day #dayoff %%routine:S:2026:11-19%%\n\n### 20/);
  assert.match(out, /### 20\.11 FRIDAY\n- \[ \] Car service %%routine:R:2026:11%%/);
  assert.match(out, /### NO DATE\n- \[ \] Doctor %%routine:R:2026:11%%/);
  assert.doesNotMatch(out, /rutyna|BEZ DATY|CZWARTEK/);
});

test('switching a Polish note to English translates headings and known labels only', () => {
  const pl = '### 12.11 CZWARTEK\nfoo\n- [ ] Lekarz %%rutyna:R:2026:11%%\n### 13.11 PIĄTEK - WOLNE - HANDLOWA\n### 14.11 SOBOTA - wyjazd\n### BEZ DATY\nbar\n\n## **GRUDZIEŃ**\n### 05.12 SOBOTA\n';
  const out = core.serializeDaily(core.parseDaily(pl, T, 'en'));
  assert.equal(out, '### 12.11 THURSDAY\nfoo\n- [ ] Lekarz %%rutyna:R:2026:11%%\n\n### 13.11 FRIDAY - DAY OFF - SHOPPING SUNDAY\n### 14.11 SATURDAY - wyjazd\n### NO DATE\nbar\n\n## **DECEMBER**\n### 05.12 SATURDAY\n');
  // ...and back: the round trip ends where it started (old markers kept).
  const back = core.serializeDaily(core.parseDaily(out, T, 'pl'));
  assert.match(back, /### 13\.11 PIĄTEK - WOLNE - HANDLOWA\n### 14\.11 SOBOTA - wyjazd\n### BEZ DATY\nbar\n\n## \*\*GRUDZIEŃ\*\*/);
});

test('old "rutyna" markers still count as present when writing in English', () => {
  const model = core.parseDaily('### 12.11\n- [ ] Doctor %%rutyna:R:2026:11%%\n', T, 'en');
  const st = core.newState();
  core.generateMonth(model, srcEn(), 2026, 11, T, st);
  const out = core.serializeDaily(model);
  assert.equal(out.match(/Doctor/g).length, 1);
  assert.doesNotMatch(out, /### NO DATE/);
});

test('moving to next month reuses an existing BEZ DATY block in an English note', () => {
  const text = '### 12.11 THURSDAY\nidea\n\n## DECEMBER\n### BEZ DATY\nold\n';
  const res = core.moveLinesToNextMonth(text, 1, 1, T, 'en');
  assert.equal(res.text, '### 12.11 THURSDAY\n\n## DECEMBER\n### NO DATE\nold\nidea\n');
});

test('labelText maps canonical and translated labels, keeps custom ones', () => {
  assert.equal(core.labelText('WOLNE - HANDLOWA', 'en'), 'DAY OFF - SHOPPING SUNDAY');
  assert.equal(core.labelText('DAY OFF', 'pl'), 'WOLNE');
  assert.equal(core.labelText('wyjazd', 'en'), 'wyjazd');
  assert.equal(core.labelText('', 'en'), '');
});

test('ui: every language has the same keys and the same {placeholders}', () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  const keys = Object.keys(core.UI.en).sort();
  for (const [lang, dict] of Object.entries(core.UI)) {
    assert.deepEqual(Object.keys(dict).sort(), keys, lang);
    // Date formats pick different fields ({dd}.{mm} vs {mon} {d}).
    for (const k of keys) if (!['dayHead', 'dateTime'].includes(k)) assert.equal(ph(dict[k]), ph(core.UI.en[k]), `${lang}.${k}`);
  }
});

test('ui: texts, language choice and dates', () => {
  assert.equal(core.uiText('en', 'monthFilled', { month: 'May', days: 3, added: 5 }), 'May – new days: 3, tasks added: 5.');
  assert.equal(core.uiText('pl', 'fileNotFound', { path: 'a.md' }), 'nie znaleziono pliku a.md');
  assert.equal(core.uiText('de', 'ok'), 'OK'); // unknown language -> English
  assert.equal(core.resolveUiLang('auto', 'pl'), 'pl');
  assert.equal(core.resolveUiLang('auto', 'de'), 'en');
  assert.equal(core.resolveUiLang('pl', 'en'), 'pl');
  assert.equal(core.uiMonth('pl', 11), 'listopad');
  assert.equal(core.uiMonth('en', 11), 'November');
  assert.equal(core.uiDayHead('pl', T, 'today'), 'Czwartek 12.11 (dziś)');
  assert.equal(core.uiDayHead('en', T, null), 'Thursday, Nov 12');
  assert.equal(core.uiDayHead('en', T, 'tomorrow'), 'Thursday, Nov 12 (tomorrow)');
});

test('daily note: text above the plan and under an own # / ## heading below it is kept', () => {
  const text = 'My notes\n- [ ] not a plan task\n\n## **LISTOPAD**\n### 12.11 CZWARTEK\nfoo\n\n## Ideas\n### 13.11 kept as is\n- idea\n\n# Archive\nold\n';
  const model = core.parseDaily(text, T);
  assert.deepEqual(model.tail, ['## Ideas', '### 13.11 kept as is', '- idea', '', '# Archive', 'old', '']);
  assert.equal(model.months.get('2026-11').days.size, 1);
  assert.equal(core.serializeDaily(model), text);
  // A new month goes under the plan, above the tail.
  const r = core.generateMonth(model, src(), 2026, 12, T, core.newState());
  assert.ok(r.days > 0);
  const out = core.serializeDaily(model);
  assert.ok(out.indexOf('GRUDZIEŃ') < out.indexOf('## Ideas'));
  assert.ok(out.startsWith('My notes\n'));
  assert.ok(out.endsWith('# Archive\nold\n'));
  // Before any plan, own headings are just text above it.
  assert.deepEqual(core.parseDaily('# Title\n## Notes\nx\n', T).preamble, ['# Title', '## Notes', 'x', '']);
});

test('cheat sheet: a collapsed callout with hotkeys, kept above the plan', () => {
  const hk = { 'plain-planner:generate-month': [{ modifiers: ['Shift', 'Mod'], key: 'm' }] };
  const sheet = core.buildCheatSheet('pl', 'pl', hk, false);
  const lines = sheet.split('\n');
  assert.equal(lines[0], '> [!plain-planner]- Plain Planner – ściąga komend');
  assert.ok(lines[1].startsWith('> Możesz ją usunąć'));
  assert.equal(lines[2], '> - Paleta komend: Ctrl + P, potem wpisz „Plain Planner”');
  assert.equal(lines[3], '> - Rozpisz miesiąc: Ctrl + Shift + M');
  assert.ok(lines.includes('> - Przenieś na następny miesiąc (BEZ DATY): brak skrótu'));
  assert.deepEqual(lines.slice(-4), ['> Skróty ustawisz w: Ustawienia → Skróty klawiszowe, wyszukaj „Plain Planner”.', '', '---', '']);
  assert.equal(core.formatHotkey({ modifiers: ['Mod', 'Alt'], key: 'F5' }, true), 'Cmd + Option + F5');
  const model = core.parseDaily(sheet, T);
  assert.equal(core.serializeDaily(model), sheet);
  core.generateMonth(model, src(), 2026, 11, T, core.newState());
  assert.ok(core.serializeDaily(model).startsWith(sheet));
});

test('cheat sheet: updated in place, deleted lines stay deleted, no sheet -> no change', () => {
  const sheet = core.buildCheatSheet('pl', 'pl', {}, false).replace(']-', ']+'); // user keeps it expanded
  const kept = sheet.split('\n').filter((l) => !l.startsWith('> - Cofnij')).join('\n') + 'moje\n';
  const hk = { 'plain-planner:review': [{ modifiers: ['Alt'], key: 'R' }], 'command-palette:open': [] };
  const out = core.updateCheatSheet(kept, 'pl', 'pl', hk, false);
  assert.ok(out.includes('> - Przegląd zaległych dni: Alt + R'));
  assert.ok(out.includes('> - Paleta komend: brak skrótu, potem wpisz „Plain Planner”'));
  assert.ok(out.startsWith('> [!plain-planner]+ '));
  assert.ok(!out.includes('Cofnij ostatnie'));
  assert.ok(out.endsWith('moje\n'));
  assert.equal(core.updateCheatSheet(out, 'pl', 'pl', hk, false), out);
  // Language switch rewrites labels, title, note and hint.
  const en = core.updateCheatSheet(out, 'en', 'en', hk, false);
  assert.ok(en.includes('> - Review past days: Alt + R'));
  assert.ok(en.includes('> - Move to next month (NO DATE): no hotkey'));
  assert.ok(en.includes('> Set hotkeys in: Settings → Hotkeys'));
  assert.ok(!/[ąęółśżźćń]/.test(en.split('---')[0]));
  // Below the plan, or no sheet at all: untouched.
  const below = '## **LISTOPAD**\n> [!plain-planner]- x\n> - Przegląd zaległych dni: a\n';
  assert.equal(core.updateCheatSheet(below, 'pl', 'pl', hk, false), below);
  assert.equal(core.updateCheatSheet('notes\n', 'pl', 'pl', hk, false), 'notes\n');
});

test('fill in a month again after its section was removed (e.g. Ctrl+Z)', () => {
  const holidays = '## GRUDZIEŃ\n- 24.12 Wigilia #wolne\n';
  const s2 = core.parseSources(WEEKLY, MONTHLY, YEARLY, holidays);
  const state = core.newState();
  const model = core.parseDaily('', T);
  core.generateMonth(model, s2, 2026, 12, T, state);
  const filled = core.serializeDaily(model);
  // Undone: the note is empty again, but the memory says December is done.
  const again = core.parseDaily('', T);
  assert.equal(core.generateMonth(again, s2, 2026, 12, T, state).days, 0);
  assert.equal(core.forgetMonthIfAbsent(again, 2026, 12, state), true);
  core.generateMonth(again, s2, 2026, 12, T, state);
  assert.equal(core.serializeDaily(again), filled);
  // Still there: nothing forgotten.
  assert.equal(core.forgetMonthIfAbsent(again, 2026, 12, state), false);
  assert.ok(state.filledDays.has('2026-12-01'));
});

test('note file name from the setup dialog', () => {
  assert.equal(core.noteFileName(' TODO DAILY '), 'TODO DAILY.md');
  assert.equal(core.noteFileName('Plan.md'), 'Plan.md');
  for (const bad of ['', '   ', 'a/b', 'a:b', '#x', '.hidden', 'a[1]']) assert.equal(core.noteFileName(bad), null, bad);
});
