'use strict';

/*
 * Plain Planner - fills the daily plan note with weekly / monthly / yearly routines,
 * mirrors checkbox state back to the routine files and reviews past days.
 *
 * Plain CommonJS, no build step. The pure logic lives in `core` (exported for
 * tests); the Obsidian glue is only defined when the `obsidian` module exists.
 *
 * Copyright (C) 2026 HNT Apps
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The body is wrapped in a function so its declarations stay module-local
// for linters too (Obsidian already gives it a function scope). Not indented
// to keep the diff small.
(function () {

let obsidian = null;
try {
  obsidian = require('obsidian');
} catch (_e) {
  obsidian = null;
}

// ---------------------------------------------------------------------------
// Core (pure functions, no Obsidian API)
// ---------------------------------------------------------------------------

// Keywords of the note format. Reading accepts every language at once (a
// note may mix them); writing uses the language chosen in the settings, kept
// on the parsed model as `model.lang`.
const LANGS = {
  pl: {
    months: [
      'STYCZEŃ', 'LUTY', 'MARZEC', 'KWIECIEŃ', 'MAJ', 'CZERWIEC',
      'LIPIEC', 'SIERPIEŃ', 'WRZESIEŃ', 'PAŹDZIERNIK', 'LISTOPAD', 'GRUDZIEŃ',
    ],
    // Indexed like Date#getDay(): 0 = Sunday.
    weekdays: ['NIEDZIELA', 'PONIEDZIAŁEK', 'WTOREK', 'ŚRODA', 'CZWARTEK', 'PIĄTEK', 'SOBOTA'],
    undated: 'BEZ DATY',
    labels: { WOLNE: 'WOLNE', HANDLOWA: 'HANDLOWA' },
    marker: 'rutyna',
  },
  en: {
    months: [
      'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
      'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
    ],
    weekdays: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
    undated: 'NO DATE',
    labels: { WOLNE: 'DAY OFF', HANDLOWA: 'SHOPPING SUNDAY' },
    marker: 'routine',
  },
};
const DEFAULT_LANG = 'pl';
const langOf = (code) => LANGS[code] || LANGS[DEFAULT_LANG];
const ALL_LANGS = Object.values(LANGS);
// Polish names, still used by the (Polish-only, for now) user interface.
const MONTHS = LANGS.pl.months;
const WEEKDAYS = LANGS.pl.weekdays;
const UNDATED = LANGS.pl.undated;
const UNDATED_NAMES = new Set(ALL_LANGS.map((l) => l.undated));
const DAY_OFF_RE = new RegExp(`(^|[\\s-])(${ALL_LANGS.map((l) => l.labels.WOLNE).join('|')})(?=$|[\\s-])`, 'i');
// Day labels are kept in their canonical (Polish) form in the plugin state and
// written to the note in the note language: 'WOLNE - HANDLOWA' -> 'DAY OFF - SHOPPING SUNDAY'.
// Also translates labels already written in another language; the user's own
// labels ("- wyjazd") pass through unchanged.
function labelText(code, lang) {
  const l = langOf(lang).labels;
  const canon = (part) => {
    const up = part.trim().toUpperCase();
    for (const other of ALL_LANGS) {
      for (const k of Object.keys(other.labels)) if (other.labels[k] === up) return k;
    }
    return null;
  };
  return code.split(' - ').map((c) => {
    const k = canon(c);
    return k ? l[k] : c;
  }).join(' - ');
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateNum = (y, m, d) => y * 10000 + m * 100 + d;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const weekdayOf = (y, m, d) => new Date(y, m - 1, d).getDay();
const monthKey = (y, m) => `${y}-${pad2(m)}`;

function fromDate(x) {
  return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
}
function addDays(t, n) {
  return fromDate(new Date(t.y, t.m - 1, t.d + n));
}
function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
function toIso(t) {
  return `${t.y}-${pad2(t.m)}-${pad2(t.d)}`;
}
function normName(s) {
  return s.replace(/[*_:#]/g, '').trim().toUpperCase();
}
function nameIndex(s, list) {
  const n = normName(s);
  for (const l of ALL_LANGS) {
    const i = l[list].indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}
function monthFromName(s) {
  return nameIndex(s, 'months') + 1;
}
function weekdayFromName(s) {
  return nameIndex(s, 'weekdays');
}
function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}
function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}
function appendLine(lines, line) {
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(line);
}

// The TODO DAILY file has no year in it, so a DD.MM date belongs to whichever
// year puts it closest to today (a rolling +/- 6 month window).
function resolveYear(m, d, today) {
  const t = new Date(today.y, today.m - 1, today.d).getTime();
  let best = today.y;
  let bestDiff = Infinity;
  for (const y of [today.y - 1, today.y, today.y + 1]) {
    const diff = Math.abs(new Date(y, m - 1, d).getTime() - t);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = y;
    }
  }
  return best;
}

// --- routine lines inside TODO DAILY ---------------------------------------

const CHECKBOX_RE = /^\s*[-*+]\s+\[([^\]])\]\s*/;
// Kinds: M = monthly routine, R = yearly routine, S = holiday file (ŚWIĘTA).
// The marker word follows the note language (rutyna / routine); both are read.
const MARKER_RE = /\s*%%(?:rutyna|routine):([MRS]):([^:%]+):([^%]+)%%\s*$/;

function makeMarker(kind, period, ref, lang) {
  return `%%${langOf(lang).marker}:${kind}:${period}:${ref}%%`;
}
function makeRoutineLine(kind, period, ref, text, lang) {
  return `- [ ] ${text} ${makeMarker(kind, period, ref, lang)}`;
}
function routineKey(kind, period, ref, text) {
  return [kind, period, ref, text].join('|');
}
function parseRoutineLine(line) {
  const cb = CHECKBOX_RE.exec(line);
  if (!cb) return null;
  const mk = MARKER_RE.exec(line);
  if (!mk) return null;
  const text = line.slice(cb[0].length, mk.index).trim();
  return {
    checked: cb[1].toLowerCase() === 'x',
    kind: mk[1],
    period: mk[2],
    ref: mk[3],
    text,
    key: routineKey(mk[1], mk[2], mk[3], text),
  };
}
// Any line carrying a routine marker, checkbox or not (holidays are plain text).
function parseMarkedLine(line) {
  const r = parseRoutineLine(line);
  if (r) return r;
  const mk = MARKER_RE.exec(line);
  if (!mk) return null;
  const text = line.slice(0, mk.index).trim();
  return { checked: null, kind: mk[1], period: mk[2], ref: mk[3], text, key: routineKey(mk[1], mk[2], mk[3], text) };
}
function isDoneCheckbox(line) {
  const cb = CHECKBOX_RE.exec(line);
  return !!cb && cb[1].toLowerCase() === 'x';
}
function displayText(line) {
  return line.replace(MARKER_RE, '').replace(CHECKBOX_RE, '').trim();
}

// --- routine source files ----------------------------------------------------

const SRC_ITEM_RE = /^(\s*[-*+]\s+\[)([^\]])(\]\s+)(.*)$/;

function headingText(line) {
  const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
  if (h) return h[1];
  const b = /^\s*\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
  return b ? b[1] : null;
}
function stripBullet(line) {
  return line.replace(/^\s*[-*+]\s+(\[[^\]]\]\s+)?/, '').trim();
}

function parseWeekly(text) {
  const map = new Map();
  let cur = -1;
  for (const line of splitLines(text)) {
    const h = headingText(line);
    if (h !== null) {
      cur = weekdayFromName(h);
      if (cur >= 0 && !map.has(cur)) map.set(cur, []);
      continue;
    }
    if (cur < 0) continue;
    const item = stripBullet(line);
    if (item) map.get(cur).push(item);
  }
  return map;
}

function parseMonthly(text) {
  const items = [];
  splitLines(text).forEach((line, i) => {
    const m = SRC_ITEM_RE.exec(line);
    if (!m) return;
    const dm = /^(\d{1,2})\.?\s+(.*)$/.exec(m[4]);
    if (!dm) return;
    const day = +dm[1];
    if (day < 1 || day > 31) return;
    items.push({ line: i, checked: m[2].toLowerCase() === 'x', day, text: dm[2].trim() });
  });
  return items;
}

function parseYearly(text) {
  const items = [];
  let cur = 0;
  splitLines(text).forEach((line, i) => {
    const h = headingText(line);
    if (h !== null) {
      cur = monthFromName(h);
      return;
    }
    if (!cur) return;
    const m = SRC_ITEM_RE.exec(line);
    if (!m) return;
    const dm = /^(\d{1,2})\.(\d{1,2})\.?\s+(.*)$/.exec(m[4]);
    let date = null;
    let body = m[4].trim();
    if (dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[1] >= 1 && +dm[1] <= 31) {
      date = { d: +dm[1], m: +dm[2] };
      body = dm[3].trim();
    }
    items.push({ line: i, checked: m[2].toLowerCase() === 'x', month: cur, date, text: body });
  });
  return items;
}

// ŚWIĘTA file: one entry per line, `<date>[+/-days] text`, where <date> is
//   DD.MM            every year
//   DD.MM.RRRR       only that year
//   DD.MM-DD.MM      a range (e.g. holiday leave), optionally with years
//   WIELKANOC / ADWENT  Easter Sunday / first Sunday of Advent
//   (EASTER / ADVENT in English)
// A `- [ ]` line is a task (checkbox in TODO DAILY), anything else is info.
// Headings and lines without a date are ignored.
const HOLIDAY_RE = new RegExp(
  '^(?:(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}))?\\.?' +
  '(?:\\s*-\\s*(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}))?\\.?)?' +
  '|(WIELKANOC|ADWENT|EASTER|ADVENT))\\s*([+-]\\s*\\d+)?\\s+(.+)$', 'i');
const validDM = (d, m) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

function parseHolidays(text) {
  const items = [];
  for (const raw of splitLines(text)) {
    if (headingText(raw) !== null) continue;
    const task = /^\s*[-*+]\s+\[[^\]]\]\s+/.test(raw);
    const m = HOLIDAY_RE.exec(stripBullet(raw));
    if (!m) continue;
    let base;
    let end = null;
    if (m[7]) {
      base = { kind: /^(WIELKANOC|EASTER)$/i.test(m[7]) ? 'easter' : 'advent' };
    } else if (validDM(m[1], m[2])) {
      base = { kind: 'fixed', d: +m[1], m: +m[2], year: m[3] ? +m[3] : null };
      if (m[4]) {
        if (!validDM(m[4], m[5])) continue;
        end = { d: +m[4], m: +m[5], year: m[6] ? +m[6] : null };
      }
    } else {
      continue;
    }
    items.push({ base, end, offset: m[8] ? +m[8].replace(/\s/g, '') : 0, text: m[9].trim(), task });
  }
  return items;
}

// Easter Sunday (Gregorian, anonymous algorithm).
function easterOf(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y, m: month, d: day };
}
// First Sunday of Advent: the fourth Sunday before Christmas.
function adventOf(y) {
  const w = weekdayOf(y, 12, 25);
  return addDays({ y, m: 12, d: 25 }, -(w === 0 ? 7 : w) - 21);
}

// Polish shopping Sundays (rules as of 2025): last Sunday of January, April,
// June and August (moved a week earlier if it is a holiday), the Sunday before
// Easter and the three Sundays before Christmas Eve.
function tradingSundays(y, offIso) {
  const out = [];
  for (const m of [1, 4, 6, 8]) {
    let d = daysInMonth(y, m);
    while (weekdayOf(y, m, d) !== 0) d--;
    let t = { y, m, d };
    while (offIso.has(toIso(t))) t = addDays(t, -7);
    out.push(t);
  }
  out.push(addDays(easterOf(y), -7));
  let t = { y, m: 12, d: 23 };
  while (weekdayOf(t.y, t.m, t.d) !== 0) t = addDays(t, -1);
  for (let i = 0; i < 3; i++) out.push(addDays(t, -7 * i));
  return out;
}

// All holiday entries and heading labels (WOLNE / HANDLOWA) of year y.
function computeCalendar(y, holidays, withTrading) {
  const events = [];
  const off = new Set();
  for (const h of holidays) {
    if (h.base.year && h.base.year !== y) continue;
    let base;
    if (h.base.kind === 'easter') base = easterOf(y);
    else if (h.base.kind === 'advent') base = adventOf(y);
    else base = { y, m: h.base.m, d: Math.min(h.base.d, daysInMonth(y, h.base.m)) };
    const t = addDays(base, h.offset);
    // A range is shown on its first day; with #wolne / #dayoff every day of it is off.
    const days = [t];
    if (h.end) {
      let ey = h.end.year || y;
      if (!h.end.year && dateNum(ey, h.end.m, h.end.d) < dateNum(t.y, t.m, t.d)) ey++;
      const endN = dateNum(ey, h.end.m, Math.min(h.end.d, daysInMonth(ey, h.end.m)));
      let x = addDays(t, 1);
      while (dateNum(x.y, x.m, x.d) <= endN && days.length < 366) {
        days.push(x);
        x = addDays(x, 1);
      }
    }
    events.push({ t, text: h.text, task: h.task });
    if (!h.task && /(^|\s)#(wolne|dayoff)(?=\s|$)/i.test(h.text)) days.forEach((x) => off.add(toIso(x)));
  }
  const labels = new Map();
  for (const iso of off) labels.set(iso, 'WOLNE');
  if (withTrading) {
    off.add(toIso(easterOf(y)));
    for (const t of tradingSundays(y, off)) {
      const iso = toIso(t);
      labels.set(iso, labels.has(iso) ? `${labels.get(iso)} - HANDLOWA` : 'HANDLOWA');
    }
  }
  return { events, labels };
}

// Holiday events and labels falling into month m of year y. Offsets can push
// an entry across New Year, so neighbouring years are computed too.
function calendarForMonth(src, y, m) {
  const events = [];
  const labels = new Map();
  for (const yy of [y - 1, y, y + 1]) {
    const cal = computeCalendar(yy, src.holidays || [], src.tradingSundays !== false);
    for (const e of cal.events) if (e.t.y === y && e.t.m === m) events.push(e);
    for (const [iso, l] of cal.labels) if (iso.startsWith(monthKey(y, m))) labels.set(iso, l);
  }
  return { events, labels };
}

function parseSources(weeklyText, monthlyText, yearlyText, holidaysText) {
  return {
    weekly: parseWeekly(weeklyText || ''),
    monthly: parseMonthly(monthlyText || ''),
    yearly: parseYearly(yearlyText || ''),
    holidays: parseHolidays(holidaysText || ''),
    tradingSundays: true,
    workTag: '#praca',
  };
}

function setLineChecked(text, lineIdx, checked) {
  const lines = splitLines(text);
  const m = SRC_ITEM_RE.exec(lines[lineIdx] || '');
  if (!m) return text;
  lines[lineIdx] = m[1] + (checked ? 'x' : ' ') + m[3] + m[4];
  return lines.join('\n');
}
function uncheckAll(text) {
  return splitLines(text)
    .map((l) => l.replace(/^(\s*[-*+]\s+\[)[xX](\])/, '$1 $2'))
    .join('\n');
}

// --- TODO DAILY model -------------------------------------------------------

function getSection(model, y, m, create) {
  const k = monthKey(y, m);
  let s = model.months.get(k);
  if (!s && create) {
    s = { y, m, header: null, intro: [], days: new Map(), extras: [] };
    model.months.set(k, s);
  }
  return s || null;
}
function ensureSection(model, y, m) {
  let s = getSection(model, y, m, false);
  if (!s) {
    s = getSection(model, y, m, true);
    s.header = `## **${langOf(model.lang).months[m - 1]}**`;
  }
  return s;
}
function ensureDay(model, y, m, d) {
  const s = ensureSection(model, y, m);
  let day = s.days.get(d);
  if (!day) {
    day = { lines: [], label: '' };
    s.days.set(d, day);
  }
  return day;
}
function ensureExtra(sec, name) {
  let e = sec.extras.find((x) => x.name === name);
  if (!e) {
    e = { heading: `### ${name}`, name, lines: [] };
    sec.extras.push(e);
  }
  return e;
}

// The month's "BEZ DATY" / "NO DATE" block, whichever language it is in.
function undatedExtra(model, y, m) {
  const sec = ensureSection(model, y, m);
  return sec.extras.find((x) => UNDATED_NAMES.has(x.name)) || ensureExtra(sec, langOf(model.lang).undated);
}

function parseDaily(text, today, lang) {
  const model = { preamble: [], months: new Map(), lang: lang || DEFAULT_LANG };
  let target = model.preamble;
  let curSec = null;
  for (const line of splitLines(text)) {
    const mh = /^##(?!#)\s*(.*)$/.exec(line);
    if (mh && monthFromName(mh[1])) {
      const m = monthFromName(mh[1]);
      const sec = getSection(model, resolveYear(m, 15, today), m, true);
      if (!sec.header) sec.header = line;
      curSec = sec;
      target = sec.intro;
      continue;
    }
    const dh = /^###(?!#)\s*(\d{1,2})\.(\d{1,2})\.?(\s.*)?$/.exec(line);
    if (dh) {
      const d = +dh[1];
      const m = +dh[2];
      if (m >= 1 && m <= 12 && d >= 1) {
        const y = resolveYear(m, d, today);
        if (d <= daysInMonth(y, m)) {
          const sec = getSection(model, y, m, true);
          let day = sec.days.get(d);
          if (!day) {
            day = { lines: [], label: headingLabel(dh[3] || '') };
            sec.days.set(d, day);
          }
          curSec = sec;
          target = day.lines;
          continue;
        }
      }
    }
    const oh = /^###(?!#)\s*(.*)$/.exec(line);
    if (oh && curSec) {
      const name = normName(oh[1]);
      let e = curSec.extras.find((x) => x.name === name);
      if (!e) {
        e = { heading: line, name, lines: [] };
        curSec.extras.push(e);
      }
      target = e.lines;
      continue;
    }
    target.push(line);
  }
  return model;
}

// Whatever follows the weekday in a day heading ("- WOLNE", "- HANDLOWA" or
// the user's own note) is kept as the day's label.
function headingLabel(rest) {
  let r = rest.trim();
  const first = r.split(/\s+/)[0] || '';
  if (first && weekdayFromName(first) >= 0) r = r.slice(first.length).trim();
  return r.replace(/^[-–—]\s*/, '').trim();
}

function dayHeading(y, m, d, label, lang) {
  const base = `### ${pad2(d)}.${pad2(m)} ${langOf(lang).weekdays[weekdayOf(y, m, d)]}`;
  return label ? `${base} - ${label}` : base;
}

// A month header written in another language is rewritten in the note
// language; one already in it is kept exactly as the user wrote it.
function monthHeader(sec, lang) {
  const name = langOf(lang).months[sec.m - 1];
  const text = sec.header.replace(/^##\s*/, '');
  if (normName(text) === name) return sec.header;
  return text.includes('**') ? `## **${name}**` : `## ${name}`;
}

function serializeDaily(model) {
  const out = [];
  const block = (lines) => {
    const c = trimBlank(lines);
    if (c.length) out.push(...c, '');
  };
  block(model.preamble);
  for (const k of [...model.months.keys()].sort()) {
    const s = model.months.get(k);
    if (s.header) {
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(monthHeader(s, model.lang));
    }
    block(s.intro);
    for (const d of [...s.days.keys()].sort((a, b) => a - b)) {
      out.push(dayHeading(s.y, s.m, d, labelText(s.days.get(d).label, model.lang), model.lang));
      block(s.days.get(d).lines);
    }
    for (const e of s.extras) {
      const undated = langOf(model.lang).undated;
      out.push(UNDATED_NAMES.has(e.name) && e.name !== undated ? `### ${undated}` : e.heading);
      block(e.lines);
    }
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n') + '\n';
}

function forEachLine(model, fn) {
  model.preamble.forEach(fn);
  for (const s of model.months.values()) {
    s.intro.forEach(fn);
    for (const d of s.days.values()) d.lines.forEach(fn);
    s.extras.forEach((e) => e.lines.forEach(fn));
  }
}
function routinePresence(model) {
  const keys = new Set();
  forEachLine(model, (l) => {
    const r = parseMarkedLine(l);
    if (r) keys.add(r.key);
  });
  return keys;
}

// --- generation -------------------------------------------------------------

function newState() {
  return {
    filledDays: new Set(), filledYearly: new Set(), skippedYearly: new Set(),
    placedHolidays: new Set(), labeledDays: new Set(), strippedDays: new Set(),
  };
}

// The "already written out" memory, saved before a run so "Cofnij ostatnie
// rozpisanie" can put it back together with the file. Routine snapshots and
// the week alert are left alone on purpose (undo must not re-ask about them).
const MARK_KEYS = ['filledDays', 'filledYearly', 'placedHolidays', 'labeledDays', 'strippedDays', 'skippedYearly'];
function snapshotMarks(state) {
  const o = {};
  for (const k of MARK_KEYS) o[k] = [...state[k]].sort();
  return o;
}
function restoreMarks(state, marks) {
  for (const k of MARK_KEYS) state[k] = new Set(marks[k] || []);
}

// Yearly items of month m (in year y): dated ones go under their day, undated
// ones under "### BEZ DATY" at the end of the month. Runs once per month.
function fillYearly(model, src, y, m, today, state, present) {
  const ymk = monthKey(y, m);
  if (state.filledYearly.has(ymk)) return 0;
  const todayN = dateNum(today.y, today.m, today.d);
  if (dateNum(y, m, daysInMonth(y, m)) < todayN) return 0;
  let added = 0;
  for (const it of src.yearly) {
    if (it.month !== m) continue;
    if (it.checked && y === today.y) continue; // already done this year
    const period = String(y);
    const ref = pad2(m);
    const key = routineKey('R', period, ref, it.text);
    if (present.has(key)) continue;
    const line = makeRoutineLine('R', period, ref, it.text, model.lang);
    if (it.date) {
      let t = { y, m: it.date.m, d: Math.min(it.date.d, daysInMonth(y, it.date.m)) };
      if (dateNum(t.y, t.m, t.d) < todayN) t = today; // date already passed: do it today
      appendLine(ensureDay(model, t.y, t.m, t.d).lines, line);
    } else {
      appendLine(undatedExtra(model, y, m).lines, line);
    }
    present.add(key);
    added++;
  }
  state.filledYearly.add(ymk);
  return added;
}

function prependLine(lines, line) {
  while (lines.length && !lines[0].trim()) lines.shift();
  lines.unshift(line);
}

const holidayKey = (ev) => routineKey('S', String(ev.t.y), `${pad2(ev.t.m)}-${pad2(ev.t.d)}`, ev.text);

// Holidays of month m (in year y) from the ŚWIĘTA file: info lines go to the
// top of their day, task lines (checkboxes) to the bottom; days off and
// shopping Sundays get a heading label. Every entry and label is placed only
// once (state.placedHolidays / state.labeledDays), so entries added to the
// file later still show up, while ones you delete never come back.
function fillHolidays(model, src, y, m, today, state, present) {
  const todayN = dateNum(today.y, today.m, today.d);
  if (dateNum(y, m, daysInMonth(y, m)) < todayN) return 0;
  const cal = calendarForMonth(src, y, m);
  let added = 0;
  for (const ev of cal.events) {
    let t = ev.t;
    if (dateNum(t.y, t.m, t.d) < todayN) {
      if (!ev.task) continue; // a holiday that already passed is not worth adding
      t = today;
    }
    const period = String(ev.t.y);
    const ref = `${pad2(ev.t.m)}-${pad2(ev.t.d)}`;
    const key = holidayKey(ev);
    if (present.has(key) || state.placedHolidays.has(key)) continue;
    const marker = makeMarker('S', period, ref, model.lang);
    const lines = ensureDay(model, t.y, t.m, t.d).lines;
    if (ev.task) appendLine(lines, `- [ ] ${ev.text} ${marker}`);
    else prependLine(lines, `${ev.text} ${marker}`);
    present.add(key);
    state.placedHolidays.add(key);
    added++;
  }
  for (const [iso, label] of cal.labels) {
    const t = parseIso(iso);
    if (dateNum(t.y, t.m, t.d) < todayN) continue;
    const lk = `${iso}|${label}`;
    if (state.labeledDays.has(lk)) continue;
    state.labeledDays.add(lk);
    const day = ensureDay(model, t.y, t.m, t.d);
    if (!day.label) {
      day.label = labelText(label, model.lang);
      added++;
    }
  }
  return added;
}

// Upgrade from the old per-month gate: everything those months would have
// received counts as already placed.
function migrateFilledHolidays(src, months, state) {
  for (const ymk of months) {
    const [y, m] = ymk.split('-').map(Number);
    const cal = calendarForMonth(src, y, m);
    for (const ev of cal.events) state.placedHolidays.add(holidayKey(ev));
    for (const [iso, label] of cal.labels) state.labeledDays.add(`${iso}|${label}`);
  }
}

const isDayOff = (day) => DAY_OFF_RE.test(day.label || '');
function hasTag(line, tag) {
  if (!tag) return false;
  const esc = tag.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc !== '' && new RegExp(`(^|\\s)${esc}(?=\\s|$)`, 'i').test(line);
}

// Days off from today on: removes weekly-routine lines carrying the work tag.
// Each day is checked once (state.strippedDays), so a work line you put back
// by hand on a day off stays there.
function stripWorkOnDaysOff(model, src, today, state) {
  if (!src.workTag) return 0;
  const todayN = dateNum(today.y, today.m, today.d);
  let removed = 0;
  for (const s of model.months.values()) {
    for (const [d, day] of s.days) {
      if (dateNum(s.y, s.m, d) < todayN || !isDayOff(day)) continue;
      const iso = toIso({ y: s.y, m: s.m, d });
      if (state.strippedDays.has(iso)) continue;
      state.strippedDays.add(iso);
      const work = new Set((src.weekly.get(weekdayOf(s.y, s.m, d)) || []).filter((w) => hasTag(w, src.workTag)));
      const before = day.lines.length;
      day.lines = day.lines.filter((l) => !work.has(l.trim()));
      removed += before - day.lines.length;
    }
  }
  return removed;
}

// Writes out every remaining day of month m (today onwards) with its weekly,
// monthly and yearly routines. Each day is filled only once (state.filledDays),
// so routine lines you delete after doing them never come back.
function generateMonth(model, src, y, m, today, state) {
  const todayN = dateNum(today.y, today.m, today.d);
  const last = daysInMonth(y, m);
  const result = { added: 0, days: 0 };
  if (dateNum(y, m, last) < todayN) return result;
  const present = routinePresence(model);
  const isCurrent = y === today.y && m === today.m;
  result.added += fillHolidays(model, src, y, m, today, state, present);
  result.added += fillYearly(model, src, y, m, today, state, present);
  const labels = calendarForMonth(src, y, m).labels;
  for (let d = 1; d <= last; d++) {
    if (dateNum(y, m, d) < todayN) {
      // A day of this month that passed before it was ever written out (first
      // install, or Obsidian not opened for a while): its monthly tasks that
      // are still unticked go to today instead of being lost.
      const dk = `${monthKey(y, m)}-${pad2(d)}`;
      if (!isCurrent || state.filledDays.has(dk)) continue;
      for (const it of src.monthly) {
        if (Math.min(it.day, last) !== d || it.checked) continue;
        const period = monthKey(y, m);
        const ref = pad2(it.day);
        const key = routineKey('M', period, ref, it.text);
        if (present.has(key)) continue;
        appendLine(ensureDay(model, today.y, today.m, today.d).lines, makeRoutineLine('M', period, ref, it.text, model.lang));
        present.add(key);
        result.added++;
      }
      state.filledDays.add(dk);
      continue;
    }
    const dk = `${monthKey(y, m)}-${pad2(d)}`;
    if (state.filledDays.has(dk)) continue;
    const sec = ensureSection(model, y, m);
    if (!sec.days.has(d)) result.days++;
    const day = ensureDay(model, y, m, d);
    if (!day.label && labels.has(toIso({ y, m, d }))) day.label = labelText(labels.get(toIso({ y, m, d })), model.lang);
    for (const it of src.monthly) {
      if (Math.min(it.day, last) !== d) continue;
      if (it.checked && isCurrent) continue; // already done this month
      const period = monthKey(y, m);
      const ref = pad2(it.day);
      const key = routineKey('M', period, ref, it.text);
      if (present.has(key)) continue;
      appendLine(day.lines, makeRoutineLine('M', period, ref, it.text, model.lang));
      present.add(key);
      result.added++;
    }
    // Repeated lines (Praca / Zakupy / Praca) are kept: count, don't dedupe.
    const seen = new Map();
    for (const w of src.weekly.get(weekdayOf(y, m, d)) || []) {
      if (isDayOff(day) && hasTag(w, src.workTag)) continue;
      const want = (seen.get(w) || 0) + 1;
      seen.set(w, want);
      if (day.lines.filter((l) => l.trim() === w).length >= want) continue;
      appendLine(day.lines, w);
      result.added++;
    }
    state.filledDays.add(dk);
  }
  result.added += stripWorkOnDaysOff(model, src, today, state);
  return result;
}

// Yearly routines for every month after the current one, up to December.
function generateYearlyRest(model, src, today, state) {
  const present = routinePresence(model);
  let added = fillHolidays(model, src, today.y, today.m, today, state, present);
  for (let m = today.m + 1; m <= 12; m++) {
    added += fillHolidays(model, src, today.y, m, today, state, present);
    added += fillYearly(model, src, today.y, m, today, state, present);
  }
  added += stripWorkOnDaysOff(model, src, today, state);
  return added;
}

// --- applying routine edits to days already written out ----------------------

// Snapshots of the weekly / monthly routine as last used, kept in data.json.
function stripTags(s) {
  return s.replace(/(^|\s)#[^\s#]+/g, '').replace(/\s+/g, ' ').trim();
}
const normText = (s) => stripTags(s).toLowerCase();

function weeklySnapshot(weekly) {
  const o = {};
  for (let i = 0; i < 7; i++) o[i] = (weekly.get(i) || []).slice();
  return o;
}
function monthlySnapshot(monthly) {
  return monthly.map((it) => [it.day, it.text]);
}
function routinesChanged(src, snapW, snapM) {
  return {
    weekly: JSON.stringify(weeklySnapshot(src.weekly)) !== JSON.stringify(Object.assign(weeklySnapshot(new Map()), snapW)),
    monthly: JSON.stringify(monthlySnapshot(src.monthly)) !== JSON.stringify(snapM),
  };
}

// For every new entry: index of the old entry it continues (same text, then
// same text without tags/case), or null for a brand-new entry.
function pairLists(oldL, newL, passes) {
  const used = new Set();
  const origin = newL.map(() => null);
  for (const same of passes) {
    newL.forEach((n, i) => {
      if (origin[i] !== null) return;
      const j = oldL.findIndex((o, k) => !used.has(k) && same(o, n));
      if (j >= 0) {
        used.add(j);
        origin[i] = j;
      }
    });
  }
  return origin;
}

// Replaces old weekly lines with the new routine in every day already filled
// from `start` on. Lines you deleted (done) are not brought back, your own
// lines are never touched, work-tagged lines stay out of days off.
function applyWeeklyChange(model, src, oldSnap, state, start) {
  const startN = dateNum(start.y, start.m, start.d);
  let changed = 0;
  for (const s of model.months.values()) {
    for (const [d, day] of s.days) {
      if (dateNum(s.y, s.m, d) < startN) continue;
      if (!state.filledDays.has(`${monthKey(s.y, s.m)}-${pad2(d)}`)) continue;
      const wd = weekdayOf(s.y, s.m, d);
      const oldL = oldSnap[wd] || [];
      const newL = src.weekly.get(wd) || [];
      if (JSON.stringify(oldL) === JSON.stringify(newL)) continue;
      const origin = pairLists(oldL, newL, [(a, b) => a === b, (a, b) => normText(a) === normText(b)]);
      const consumed = new Set();
      const present = oldL.map((o) => {
        const idx = day.lines.findIndex((l, i) => !consumed.has(i) && l.trim() === o);
        if (idx >= 0) consumed.add(idx);
        return idx >= 0;
      });
      const off = isDayOff(day);
      // Each new line takes the place of the old line it continues; a brand
      // new line sits right after its predecessor in the routine.
      const lineOfOld = new Map();
      oldL.forEach((o, k) => {
        if (!present[k]) return;
        const idx = day.lines.findIndex((l, i) => consumed.has(i) && l.trim() === o && ![...lineOfOld.values()].includes(i));
        lineOfOld.set(k, idx);
      });
      // Old lines with no continuation in the new routine (removed / rewritten):
      // a brand-new line takes the place of the next such line after its
      // predecessor, so a rewritten line stays where it was.
      const paired = new Set(origin.filter((o) => o !== null));
      const anchors = [];
      let prev = null;
      let prevOld = -1;
      newL.forEach((n, i) => {
        const o = origin[i];
        if (o !== null && !present[o]) {
          anchors.push(null); // deleted (done) in this day: stays out
          prevOld = o;
          return;
        }
        let a;
        if (o !== null) {
          a = lineOfOld.get(o);
          prevOld = o;
        } else {
          const j = oldL.findIndex((_, k) => k > prevOld && !paired.has(k) && present[k]);
          a = j >= 0 ? lineOfOld.get(j) : prev;
          if (j >= 0) prevOld = j;
        }
        anchors.push(off && hasTag(n, src.workTag) ? null : a === null ? 'end' : a);
        if (a !== null && a !== undefined) prev = a;
      });
      // brand-new lines at the top of the routine: anchor to the first kept line
      const firstAnchor = anchors.find((a) => typeof a === 'number');
      const at = (a) => (a === 'end' && firstAnchor !== undefined && newL.length ? firstAnchor : a);
      const next = [];
      day.lines.forEach((l, i) => {
        if (!consumed.has(i)) next.push(l);
        newL.forEach((n, j) => {
          if (at(anchors[j]) === i) next.push(n);
        });
      });
      const tail = newL.filter((n, j) => at(anchors[j]) === 'end');
      if (tail.length) {
        while (next.length && !next[next.length - 1].trim()) next.pop();
        next.push(...tail);
      }
      if (JSON.stringify(next) !== JSON.stringify(day.lines)) {
        day.lines = next;
        changed++;
      }
    }
  }
  return changed;
}

function findMarkedLine(model, key) {
  let found = null;
  const scan = (holder) => {
    holder.lines.forEach((l, i) => {
      const r = parseRoutineLine(l);
      if (r && r.key === key && !found) found = { holder, index: i, checked: r.checked };
    });
  };
  for (const s of model.months.values()) {
    for (const day of s.days.values()) scan(day);
    s.extras.forEach(scan);
  }
  return found;
}

// Monthly routine edits for every month with days filled from `start` on:
// removed entries disappear (unless already ticked), new ones are added
// (a day that already passed goes to `start`), an edited entry (other day or
// text) moves only if its old line is still there and not ticked.
function applyMonthlyChange(model, src, oldSnap, state, start, today) {
  const startN = dateNum(start.y, start.m, start.d);
  const months = new Set();
  for (const dk of state.filledDays) {
    const [y, m, d] = dk.split('-').map(Number);
    if (dateNum(y, m, d) >= startN) months.add(monthKey(y, m));
  }
  const oldL = oldSnap.map(([day, text]) => ({ day, text }));
  const newL = src.monthly;
  const origin = pairLists(oldL, newL, [
    (a, b) => a.day === b.day && a.text === b.text,
    (a, b) => a.text === b.text,
    (a, b) => normText(a.text) === normText(b.text),
  ]);
  const unchangedOld = new Set();
  newL.forEach((n, i) => {
    const o = origin[i];
    if (o !== null && oldL[o].day === n.day && oldL[o].text === n.text) unchangedOld.add(o);
  });
  let changed = 0;
  for (const mk of [...months].sort()) {
    const [y, m] = mk.split('-').map(Number);
    const last = daysInMonth(y, m);
    const isCurrent = y === today.y && m === today.m;
    const loc = oldL.map((o) => findMarkedLine(model, routineKey('M', mk, pad2(o.day), o.text)));
    // removals: old entries that were dropped or edited
    const toRemove = [];
    oldL.forEach((o, k) => {
      if (unchangedOld.has(k) || !loc[k] || loc[k].checked) return;
      toRemove.push(loc[k]);
    });
    for (const r of toRemove.sort((a, b) => b.index - a.index)) {
      r.holder.lines.splice(r.index, 1);
      changed++;
    }
    const present = routinePresence(model);
    newL.forEach((n, i) => {
      const o = origin[i];
      if (o !== null && unchangedOld.has(o)) return;
      if (o !== null && (!loc[o] || loc[o].checked)) return; // done or deleted
      if (o === null && n.checked && isCurrent) return; // already done this month
      const key = routineKey('M', mk, pad2(n.day), n.text);
      if (present.has(key)) return;
      let t = { y, m, d: Math.min(n.day, last) };
      if (dateNum(t.y, t.m, t.d) < startN) {
        if (start.y !== y || start.m !== m) return;
        t = start;
      }
      appendLine(ensureDay(model, t.y, t.m, t.d).lines, makeRoutineLine('M', mk, pad2(n.day), n.text, model.lang));
      changed++;
    });
  }
  return changed;
}

// --- this week's holidays alert -----------------------------------------------

// Monday of the week `t` falls in.
function weekStart(t) {
  return addDays(t, -((weekdayOf(t.y, t.m, t.d) + 6) % 7));
}

// Entries from the ŚWIĘTA file and WOLNE / HANDLOWA days from today up to
// Sunday, one record per day that has anything.
function weekAhead(src, today) {
  const wd = weekdayOf(today.y, today.m, today.d);
  const toSunday = (7 - wd) % 7;
  const cache = new Map();
  const days = [];
  for (let i = 0; i <= toSunday; i++) {
    const t = addDays(today, i);
    const mk = monthKey(t.y, t.m);
    if (!cache.has(mk)) cache.set(mk, calendarForMonth(src, t.y, t.m));
    const cal = cache.get(mk);
    const iso = toIso(t);
    const events = cal.events
      .filter((e) => toIso(e.t) === iso)
      .map((e) => ({ text: stripTags(e.text) || e.text, task: e.task }));
    const label = cal.labels.get(iso) || '';
    if (events.length || label) days.push({ t, iso, label, events });
  }
  return days;
}

// Short fingerprint of the alert content: an "OK" holds only while the week's
// entries stay the same.
function weekSignature(days) {
  const str = JSON.stringify(days.map((d) => [d.iso, d.label, d.events.map((e) => e.text)]));
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// alertState: { week, sig, ok, snoozeUntil } from data.json (or null).
function shouldShowWeekAlert(days, alertState, today) {
  if (!days.length) return false;
  const a = alertState;
  if (!a || a.week !== toIso(weekStart(today)) || a.sig !== weekSignature(days)) return true;
  if (a.ok) return false;
  return !(a.snoozeUntil && toIso(today) < a.snoozeUntil);
}

// --- review of past days ------------------------------------------------------

const ACTIONS = {
  today: 'Na dziś',
  tomorrow: 'Na jutro',
  date: 'Na wybrany dzień',
  spread: 'Rozłóż na najbliższe dni',
  nextMonth: 'Na następny miesiąc (BEZ DATY)',
  delete: 'Usuń',
  keep: 'Zostaw (zdecyduję później)',
};
const DEFAULT_ACTION = { routine: 'today', holiday: 'delete', weekly: 'delete', own: 'keep' };

function classifyLine(line, weeklyAll) {
  if (!line.trim()) return null;
  if (isDoneCheckbox(line)) return 'done';
  if (parseRoutineLine(line)) return 'routine';
  if (parseMarkedLine(line)) return 'holiday';
  if (weeklyAll.has(line.trim())) return 'weekly';
  return 'own';
}

function collectReview(model, src, today, state) {
  const todayN = dateNum(today.y, today.m, today.d);
  const weeklyAll = new Set([].concat(...src.weekly.values()));
  const blocks = [];
  const mkBlock = (meta, lines) => {
    const items = [];
    lines.forEach((line) => {
      const type = classifyLine(line, weeklyAll);
      if (!type) return;
      items.push({ id: `${meta.id}#${line}`, line, type, text: displayText(line), default: type === 'done' ? 'delete' : DEFAULT_ACTION[type] });
    });
    blocks.push(Object.assign(meta, { items }));
  };
  for (const k of [...model.months.keys()].sort()) {
    const s = model.months.get(k);
    for (const d of [...s.days.keys()].sort((a, b) => a - b)) {
      if (dateNum(s.y, s.m, d) >= todayN) continue;
      mkBlock({ id: `d:${k}-${pad2(d)}`, kind: 'day', secKey: k, d, label: `${pad2(d)}.${pad2(s.m)} ${langOf(model.lang).weekdays[weekdayOf(s.y, s.m, d)]}` }, s.days.get(d).lines);
    }
    if (dateNum(s.y, s.m, daysInMonth(s.y, s.m)) < todayN) {
      for (const e of s.extras) {
        mkBlock({ id: `e:${k}:${e.name}`, kind: 'extra', secKey: k, name: e.name, label: `${langOf(model.lang).months[s.m - 1]} – ${e.heading.replace(/^#+\s*/, '')}` }, e.lines);
      }
    }
  }
  // Yearly routines from earlier months of this year that were never done and
  // are not sitting anywhere in TODO DAILY.
  const present = routinePresence(model);
  const overdue = [];
  for (const it of src.yearly) {
    if (it.checked || it.month >= today.m) continue;
    const period = String(today.y);
    const ref = pad2(it.month);
    const key = routineKey('R', period, ref, it.text);
    if (present.has(key) || state.skippedYearly.has(key)) continue;
    overdue.push({ id: `o#${key}`, key, month: it.month, text: it.text, line: makeRoutineLine('R', period, ref, it.text, model.lang) });
  }
  return { blocks, overdue };
}

function reviewNeeded(review) {
  return review.blocks.length > 0 || review.overdue.length > 0;
}

function resolveTarget(action, dateStr, today) {
  if (action === 'today') return today;
  if (action === 'tomorrow') return addDays(today, 1);
  if (action === 'date') return parseIso(dateStr);
  if (action === 'nextMonth') return Object.assign(nextMonthOf(today.y, today.m), { undated: true });
  return null;
}

function nextMonthOf(y, m) {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

// Appends a line to the target of a move: a day, or the "BEZ DATY" block of
// a month when `t.undated` is set.
function placeLine(model, t, line) {
  if (t.undated) appendLine(undatedExtra(model, t.y, t.m).lines, line);
  else appendLine(ensureDay(model, t.y, t.m, t.d).lines, line);
}

// Month (y, m) that line `idx` of TODO DAILY belongs to: the nearest day
// heading or month header above it, or null when there is none.
function monthAtLine(lines, idx, today) {
  for (let i = Math.min(idx, lines.length - 1); i >= 0; i--) {
    const dh = /^###(?!#)\s*(\d{1,2})\.(\d{1,2})\.?(?:\s.*)?$/.exec(lines[i]);
    if (dh && +dh[2] >= 1 && +dh[2] <= 12) return { y: resolveYear(+dh[2], +dh[1], today), m: +dh[2] };
    const mh = /^##(?!#)\s*(.*)$/.exec(lines[i]);
    if (mh && monthFromName(mh[1])) {
      const m = monthFromName(mh[1]);
      return { y: resolveYear(m, 15, today), m };
    }
  }
  return null;
}

// Moves lines from..to (inclusive, headings and blank lines skipped) to the
// "BEZ DATY" block of the month after the one they sit in (never earlier than
// the month after today). Returns the new text, or null when nothing moved.
function moveLinesToNextMonth(text, from, to, today, lang) {
  const lines = splitLines(text);
  const picked = [];
  for (let i = from; i <= to && i < lines.length; i++) {
    if (lines[i].trim() && !/^\s*#/.test(lines[i])) picked.push(i);
  }
  if (!picked.length) return null;
  let base = monthAtLine(lines, from, today) || { y: today.y, m: today.m };
  if (dateNum(base.y, base.m, 1) < dateNum(today.y, today.m, 1)) base = { y: today.y, m: today.m };
  const target = nextMonthOf(base.y, base.m);
  const moved = picked.map((i) => lines[i]);
  const drop = new Set(picked);
  const model = parseDaily(lines.filter((_, i) => !drop.has(i)).join('\n'), today, lang);
  for (const line of moved) placeLine(model, Object.assign({ undated: true }, target), line);
  return { text: serializeDaily(model), count: moved.length, target };
}

// decisions: Map itemId -> { action, date }. Missing items use their default.
// opts.spreadDays: how many days (from today) "spread" items are dealt over.
function applyReview(model, review, decisions, today, opts) {
  const todayN = dateNum(today.y, today.m, today.d);
  const spreadDays = Math.max(1, Math.min(31, Math.floor((opts && opts.spreadDays) || 7)));
  let spreadIdx = 0;
  const target = (action, date) => {
    if (action === 'spread') return addDays(today, spreadIdx++ % spreadDays);
    return resolveTarget(action, date, today);
  };
  const moves = [];
  const result = { moved: 0, deleted: 0, removedBlocks: 0, skipped: [] };
  for (const b of review.blocks) {
    const sec = model.months.get(b.secKey);
    if (!sec) continue;
    const holder = b.kind === 'day' ? sec.days.get(b.d) : sec.extras.find((e) => e.name === b.name);
    if (!holder) continue;
    const drop = new Set();
    for (const it of b.items) {
      const dec = decisions.get(it.id) || { action: it.default };
      const action = it.type === 'done' ? 'delete' : dec.action;
      if (action === 'keep') continue;
      if (action === 'delete') {
        drop.add(it.line);
        result.deleted++;
        continue;
      }
      const t = target(action, dec.date);
      if (!t) continue; // no date picked: leave it where it is
      drop.add(it.line);
      moves.push({ t, line: it.line });
    }
    holder.lines = holder.lines.filter((l) => !drop.has(l));
    if (!holder.lines.some((l) => l.trim())) {
      if (b.kind === 'day') sec.days.delete(b.d);
      else sec.extras = sec.extras.filter((e) => e !== holder);
      result.removedBlocks++;
    }
  }
  for (const o of review.overdue) {
    const dec = decisions.get(o.id) || { action: 'later' };
    if (dec.action === 'skip') {
      result.skipped.push(o.key);
      continue;
    }
    const t = target(dec.action, dec.date);
    if (t) moves.push({ t, line: o.line });
  }
  for (const mv of moves) {
    placeLine(model, mv.t, mv.line);
    result.moved++;
  }
  for (const [k, s] of [...model.months.entries()]) {
    const ended = dateNum(s.y, s.m, daysInMonth(s.y, s.m)) < todayN;
    if (ended && s.days.size === 0 && s.extras.length === 0 && !s.intro.some((l) => l.trim())) {
      model.months.delete(k);
    }
  }
  return result;
}

// --- checkbox sync TODO DAILY -> routine files --------------------------------

function checkboxStates(text) {
  const map = new Map();
  for (const line of splitLines(text)) {
    const r = parseRoutineLine(line);
    if (r) map.set(r.key, r);
  }
  return map;
}
// Only items whose state flipped since the last snapshot are synced, so a
// checkbox ticked by hand in a routine file is never overwritten.
function diffStates(prev, next) {
  const changes = [];
  for (const [k, r] of next) {
    const p = prev.get(k);
    if (p && p.checked !== r.checked) changes.push(r);
  }
  return changes;
}
function applySyncMonthly(text, changes, today) {
  const period = monthKey(today.y, today.m);
  let out = text;
  for (const c of changes) {
    if (c.kind !== 'M' || c.period !== period) continue;
    const it = parseMonthly(out).find((x) => x.day === +c.ref && x.text === c.text);
    if (it && it.checked !== c.checked) out = setLineChecked(out, it.line, c.checked);
  }
  return out;
}
function applySyncYearly(text, changes, today) {
  const period = String(today.y);
  let out = text;
  for (const c of changes) {
    if (c.kind !== 'R' || c.period !== period) continue;
    const it = parseYearly(out).find((x) => x.month === +c.ref && x.text === c.text);
    if (it && it.checked !== c.checked) out = setLineChecked(out, it.line, c.checked);
  }
  return out;
}

// Settings input -> stored value (null when not acceptable).
function cleanSetting(item, value) {
  if (item.type === 'toggle') return !!value;
  if (item.type === 'dropdown') return Object.prototype.hasOwnProperty.call(item.options, value) ? value : null;
  if (item.type === 'number') {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isInteger(n) && n >= item.min && n <= item.max ? n : null;
  }
  return String(value == null ? '' : value).trim();
}

const core = {
  LANGS, MONTHS, WEEKDAYS, UNDATED, ACTIONS, labelText,
  pad2, monthKey, addDays, toIso, parseIso, resolveYear,
  parseWeekly, parseMonthly, parseYearly, parseHolidays, parseSources,
  easterOf, adventOf, tradingSundays, computeCalendar, migrateFilledHolidays, stripWorkOnDaysOff, setLineChecked, uncheckAll,
  parseDaily, serializeDaily, parseRoutineLine, routinePresence,
  newState, snapshotMarks, restoreMarks, generateMonth, generateYearlyRest,
  collectReview, reviewNeeded, applyReview, moveLinesToNextMonth,
  weeklySnapshot, monthlySnapshot, weekStart, weekAhead, weekSignature, shouldShowWeekAlert, routinesChanged, applyWeeklyChange, applyMonthlyChange,
  checkboxStates, diffStates, applySyncMonthly, applySyncYearly,
  cleanSetting,
};

// ---------------------------------------------------------------------------
// Obsidian plugin
// ---------------------------------------------------------------------------

if (obsidian) {
  const { Plugin, PluginSettingTab, Setting, Modal, SuggestModal, Notice, TFile, normalizePath } = obsidian;

  // Note language for a fresh install: Polish when Obsidian runs in Polish
  // (getLanguage exists since 1.8.7), English otherwise.
  const appLanguage = () => (typeof obsidian.getLanguage === 'function' ? obsidian.getLanguage() : 'en');

  const DEFAULT_SETTINGS = {
    noteLanguage: 'en',
    dailyPath: 'TODO DAILY.md',
    weeklyPath: 'RUTYNY/RUTYNA TYGODNIOWA.md',
    monthlyPath: 'RUTYNY/RUTYNA MIESIĘCZNA.md',
    yearlyPath: 'RUTYNY/RUTYNA ROCZNA.md',
    holidaysPath: 'RUTYNY/ŚWIĘTA.md',
    tradingSundays: true,
    workTag: '#praca',
    autoGenerate: true,
    autoReview: true,
    weekAlert: true,
    spreadDays: 7,
  };
  const MAX_BACKUPS = 20;

  const todayNow = () => fromDate(new Date());
  const notify = (msg) => new Notice(`Plain Planner: ${msg}`);

  class PlainPlannerPlugin extends Plugin {
    async onload() {
      await this.loadState();
      this.cache = new Map();
      this.lastRunDay = null;
      this.busy = false;
      this.undoOpen = null;

      this.addSettingTab(new PlainPlannerSettingTab(this.app, this));

      this.addCommand({
        id: 'generate-month',
        name: 'Rozpisz miesiąc',
        callback: () => new MonthPickModal(this.app, this).open(),
      });
      this.addCommand({
        id: 'yearly-rest',
        name: 'Dodaj rutyny roczne do końca roku',
        callback: () => this.runYearlyRest(true),
      });
      this.addCommand({
        id: 'review',
        name: 'Przegląd zaległych dni',
        callback: () => this.openReview(true),
      });
      this.addCommand({
        id: 'move-next-month',
        name: 'Przenieś na następny miesiąc (BEZ DATY)',
        editorCheckCallback: (checking, editor, view) => {
          if (!this.isDailyView(view)) return false;
          if (!checking) this.moveSelectionToNextMonth(editor);
          return true;
        },
      });
      // Same action in the right-click / long-press menu of the editor.
      this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
        if (!this.isDailyView(view)) return;
        menu.addItem((item) => item
          .setTitle('Przenieś na następny miesiąc (BEZ DATY)')
          .setIcon('calendar-plus')
          .onClick(() => this.moveSelectionToNextMonth(editor)));
      }));
      this.addCommand({
        id: 'week-alert',
        name: 'Pokaż święta w tym tygodniu',
        callback: () => this.showWeekAlert(todayNow(), true),
      });
      this.addCommand({
        id: 'run-now',
        name: 'Uruchom teraz (jak przy starcie Obsidiana)',
        callback: async () => {
          await this.withUndo('Uruchom teraz', () => this.dailyRun(false));
          await this.openReview(true);
        },
      });
      this.addCommand({
        id: 'undo-last',
        name: 'Cofnij ostatnie rozpisanie',
        callback: () => this.undoLast(),
      });
      this.addCommand({
        id: 'forget-filled',
        name: 'Zapomnij rozpisane dni (rozpisz od nowa)',
        callback: async () => {
          this.state.filledDays = new Set();
          this.state.filledYearly = new Set();
          this.state.placedHolidays = new Set();
          this.state.labeledDays = new Set();
          this.state.strippedDays = new Set();
          await this.saveState();
          notify('wtyczka zapomniała, które dni rozpisała.');
        },
      });

      this.app.workspace.onLayoutReady(async () => {
        await this.refreshCache();
        this.registerEvent(this.app.vault.on('modify', (f) => this.onModify(f)));
        await this.withUndo('start Obsidiana', () => this.dailyRun(true));
      });
      // Obsidian left open overnight: run again once the date changes.
      this.registerInterval(window.setInterval(() => {
        if (toIso(todayNow()) !== this.lastRunDay) this.withUndo('nowy dzień', () => this.dailyRun(true));
      }, 10 * 60 * 1000));
    }

    // --- state --------------------------------------------------------------

    async loadState() {
      const raw = (await this.loadData()) || {};
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
      if (!LANGS[this.settings.noteLanguage] || !(raw.settings && raw.settings.noteLanguage)) {
        // Settings saved before the option existed come from the Polish-only
        // version, so their notes are in Polish.
        this.settings.noteLanguage = raw.settings ? 'pl' : appLanguage() === 'pl' ? 'pl' : 'en';
      }
      this.state = {
        filledDays: new Set(raw.filledDays || []),
        filledYearly: new Set(raw.filledYearly || []),
        placedHolidays: new Set(raw.placedHolidays || []),
        labeledDays: new Set(raw.labeledDays || []),
        strippedDays: new Set(raw.strippedDays || []),
        // Pre-0.2 data.json kept a per-month gate for holidays.
        legacyHolidayMonths: raw.placedHolidays ? [] : raw.filledHolidays || [],
        skippedYearly: new Set(raw.skippedYearly || []),
        lastMonthly: raw.lastMonthly || null,
        lastYearly: raw.lastYearly || null,
        weeklySnapshot: raw.weeklySnapshot || null,
        weekAlert: raw.weekAlert || null,
        monthlySnapshot: raw.monthlySnapshot || null,
        undo: raw.undo || null,
      };
    }

    async saveState() {
      // Keep only recent "filled day" marks so data.json stays small.
      const cutoff = toIso(addDays(todayNow(), -62));
      const keep = (set, isoOf) => {
        const list = [...set].filter((v) => isoOf(v) >= cutoff).sort();
        return new Set(list);
      };
      // S|YYYY|MM-DD|text -> YYYY-MM-DD
      const holidayIso = (k) => {
        const [, y, md] = k.split('|');
        return `${y}-${md}`;
      };
      this.state.filledDays = keep(this.state.filledDays, (v) => v);
      this.state.placedHolidays = keep(this.state.placedHolidays, holidayIso);
      this.state.labeledDays = keep(this.state.labeledDays, (v) => v.slice(0, 10));
      this.state.strippedDays = keep(this.state.strippedDays, (v) => v);
      const filledDays = [...this.state.filledDays];
      await this.saveData({
        settings: this.settings,
        filledDays,
        filledYearly: [...this.state.filledYearly].sort(),
        placedHolidays: [...this.state.placedHolidays],
        labeledDays: [...this.state.labeledDays],
        strippedDays: [...this.state.strippedDays],
        skippedYearly: [...this.state.skippedYearly],
        lastMonthly: this.state.lastMonthly,
        lastYearly: this.state.lastYearly,
        weeklySnapshot: this.state.weeklySnapshot,
        weekAlert: this.state.weekAlert,
        monthlySnapshot: this.state.monthlySnapshot,
        undo: this.state.undo,
      });
    }

    // --- files --------------------------------------------------------------

    file(path) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      return f instanceof TFile ? f : null;
    }

    async readSources() {
      const read = async (p, optional) => {
        const f = this.file(p);
        if (!f) {
          if (!optional) notify(`nie znaleziono pliku ${p}`);
          return '';
        }
        return this.app.vault.read(f);
      };
      const src = parseSources(
        await read(this.settings.weeklyPath),
        await read(this.settings.monthlyPath),
        await read(this.settings.yearlyPath),
        await read(this.settings.holidaysPath, true),
      );
      src.tradingSundays = this.settings.tradingSundays;
      src.workTag = (this.settings.workTag || '').trim();
      return src;
    }

    async backup(text) {
      const dir = normalizePath(`${this.manifest.dir}/backups`);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const f = this.file(this.settings.dailyPath);
      const base = (f ? f.basename : 'daily').replace(/[\\/:*?"<>|]/g, '_');
      await adapter.write(`${dir}/${base} ${stamp}.md`, text);
      const list = await adapter.list(dir);
      const files = list.files.slice().sort();
      for (const old of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
        await adapter.remove(old);
      }
    }

    // Parses the daily note, lets `fn` change the model and writes it back
    // (after a backup) only when `fn` reports a change. The write goes through
    // vault.process and only lands if the note is still what `fn` saw; if the
    // user edited it in between, the marks `fn` set are rolled back and the
    // whole step runs again on the new text.
    async editDaily(fn) {
      const f = this.file(this.settings.dailyPath);
      if (!f) {
        notify(`nie znaleziono pliku ${this.settings.dailyPath}`);
        return null;
      }
      const today = todayNow();
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await this.app.vault.read(f);
        const marks = snapshotMarks(this.state);
        const model = parseDaily(before, today, this.settings.noteLanguage);
        const res = fn(model, today);
        if (!res || !res.changed) return res;
        const after = serializeDaily(model);
        await this.backup(before);
        let written = false;
        await this.app.vault.process(f, (current) => {
          if (current !== before) return current;
          written = true;
          return after;
        });
        if (written) {
          const op = this.undoOpen;
          if (op) {
            if (op.before === null) op.before = before;
            op.after = after;
          }
          return res;
        }
        restoreMarks(this.state, marks);
      }
      notify('plik zmieniał się w trakcie zapisu, nic nie zmieniono. Spróbuj ponownie.');
      return null;
    }

    // --- undo ---------------------------------------------------------------

    // Groups everything one action writes (e.g. the whole start-up run) into
    // a single undo step: the file before the first write + the memory of
    // written-out days from before the action. Nested calls join the group.
    async withUndo(label, fn) {
      if (this.undoOpen) return fn();
      const op = { label, before: null, after: null, marks: snapshotMarks(this.state) };
      this.undoOpen = op;
      try {
        return await fn();
      } finally {
        this.undoOpen = null;
        if (op.after !== null) {
          this.state.undo = { label, at: new Date().toISOString(), before: op.before, after: op.after, marks: op.marks };
          await this.saveState();
        }
      }
    }

    async undoLast() {
      const u = this.state.undo;
      if (!u) {
        notify('nie ma czego cofać.');
        return;
      }
      const f = this.file(this.settings.dailyPath);
      if (!f) {
        notify(`nie znaleziono pliku ${this.settings.dailyPath}`);
        return;
      }
      const current = await this.app.vault.read(f);
      const ok = await new Promise((resolve) => new UndoConfirmModal(this.app, u, current !== u.after, resolve).open());
      if (!ok) return;
      await this.backup(current);
      await this.app.vault.process(f, () => u.before);
      restoreMarks(this.state, u.marks);
      this.state.undo = null;
      await this.saveState();
      notify(`cofnięto „${u.label}”. Możesz rozpisać jeszcze raz.`);
    }

    // --- daily run ----------------------------------------------------------

    async dailyRun(showReview) {
      if (this.busy) return;
      this.busy = true;
      try {
        const today = todayNow();
        this.lastRunDay = toIso(today);
        if (this.settings.weekAlert) await this.showWeekAlert(today, false);
        if (this.state.legacyHolidayMonths.length) {
          migrateFilledHolidays(await this.readSources(), this.state.legacyHolidayMonths, this.state);
          this.state.legacyHolidayMonths = [];
          await this.saveState();
        }
        await this.resetIfNeeded(today);
        await this.checkRoutineChanges(today);
        if (this.settings.autoGenerate) {
          await this.runGenerate(today.y, today.m, false);
          await this.runYearlyRest(false);
        }
      } finally {
        this.busy = false;
      }
      if (showReview && this.settings.autoReview) await this.openReview(false);
    }

    // New month: untick the monthly routine. New year: untick the yearly one.
    // Holidays, days off and shopping Sundays from today to Sunday. Shown at
    // start-up before anything else; "OK" silences it for the rest of the week
    // (until the entries change), "Przypomnij jutro" until tomorrow.
    async showWeekAlert(today, force) {
      const src = await this.readSources();
      const days = weekAhead(src, today);
      if (!days.length) {
        if (force) notify('w tym tygodniu nie ma świąt ani niedziel handlowych.');
        return;
      }
      if (!force && !shouldShowWeekAlert(days, this.state.weekAlert, today)) return;
      const choice = await new Promise((resolve) => new WeekAlertModal(this.app, days, today, resolve).open());
      const base = { week: toIso(weekStart(today)), sig: weekSignature(days) };
      if (choice === 'ok') this.state.weekAlert = Object.assign(base, { ok: true, snoozeUntil: null });
      else if (choice === 'tomorrow') this.state.weekAlert = Object.assign(base, { ok: false, snoozeUntil: toIso(addDays(today, 1)) });
      else return; // closed with X / Esc: ask again next time
      await this.saveState();
    }

    // Weekly / monthly routine edited since last time: ask whether to apply the
    // edit to the days already written out (from today or from tomorrow).
    async checkRoutineChanges(today) {
      const src = await this.readSources();
      // No snapshot yet (fresh install): the current files are the baseline.
      const snapW = this.state.weeklySnapshot || weeklySnapshot(src.weekly);
      const snapM = this.state.monthlySnapshot || monthlySnapshot(src.monthly);
      const ch = routinesChanged(src, snapW, snapM);
      if (ch.weekly || ch.monthly) {
        const choice = await new Promise((resolve) => new RoutineChangeModal(this.app, ch, resolve).open());
        if (choice === 'today' || choice === 'tomorrow') {
          const start = choice === 'today' ? today : addDays(today, 1);
          const res = await this.editDaily((model) => {
            let n = 0;
            if (ch.weekly) n += applyWeeklyChange(model, src, snapW, this.state, start);
            if (ch.monthly) n += applyMonthlyChange(model, src, snapM, this.state, start, today);
            return { n, changed: n > 0 };
          });
          if (res) notify(`zmiany rutyny zastosowane (zmienione miejsca: ${res.n}).`);
        }
      }
      this.state.weeklySnapshot = weeklySnapshot(src.weekly);
      this.state.monthlySnapshot = monthlySnapshot(src.monthly);
      await this.saveState();
    }

    async resetIfNeeded(today) {
      const mk = monthKey(today.y, today.m);
      const yk = String(today.y);
      let changed = false;
      if (!this.state.lastMonthly) {
        this.state.lastMonthly = mk;
        changed = true;
      } else if (this.state.lastMonthly !== mk) {
        const f = this.file(this.settings.monthlyPath);
        if (f) await this.app.vault.process(f, uncheckAll);
        this.state.lastMonthly = mk;
        changed = true;
        notify('nowy miesiąc – rutyna miesięczna odznaczona.');
      }
      if (!this.state.lastYearly) {
        this.state.lastYearly = yk;
        changed = true;
      } else if (this.state.lastYearly !== yk) {
        const f = this.file(this.settings.yearlyPath);
        if (f) await this.app.vault.process(f, uncheckAll);
        this.state.lastYearly = yk;
        this.state.skippedYearly = new Set();
        changed = true;
        notify('nowy rok – rutyna roczna odznaczona.');
      }
      if (changed) await this.saveState();
    }

    async runGenerate(y, m, verbose) {
      return this.withUndo(`Rozpisz miesiąc (${MONTHS[m - 1].toLowerCase()})`, () => this.doGenerate(y, m, verbose));
    }

    async doGenerate(y, m, verbose) {
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        const r = generateMonth(model, src, y, m, today, this.state);
        return Object.assign(r, { changed: r.added > 0 || r.days > 0 });
      });
      await this.saveState();
      if (!res) return;
      if (res.changed) notify(`${MONTHS[m - 1]} – nowe dni: ${res.days}, dodane zadania: ${res.added}.`);
      else if (verbose) notify(`${MONTHS[m - 1]} jest już rozpisany, nic nie dodano.`);
    }

    async runYearlyRest(verbose) {
      return this.withUndo('Dodaj rutyny roczne do końca roku', () => this.doYearlyRest(verbose));
    }

    async doYearlyRest(verbose) {
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        const added = generateYearlyRest(model, src, today, this.state);
        return { added, changed: added > 0 };
      });
      await this.saveState();
      if (!res) return;
      if (res.changed) notify(`dodano ${res.added} zadań rocznych do kolejnych miesięcy.`);
      else if (verbose) notify('rutyny roczne do końca roku są już rozpisane.');
    }

    // --- review -------------------------------------------------------------

    async openReview(verbose) {
      const f = this.file(this.settings.dailyPath);
      if (!f) return;
      const src = await this.readSources();
      const today = todayNow();
      const review = collectReview(parseDaily(await this.app.vault.read(f), today, this.settings.noteLanguage), src, today, this.state);
      if (!reviewNeeded(review)) {
        if (verbose) notify('brak zaległych dni.');
        return;
      }
      new ReviewModal(this.app, this, review).open();
    }

    isDailyView(view) {
      return !!(view && view.file && view.file.path === normalizePath(this.settings.dailyPath));
    }

    // Works on the editor content (not the file on disk) so unsaved typing is
    // never lost; one setValue keeps it a single undo step.
    async moveSelectionToNextMonth(editor) {
      const from = editor.getCursor('from').line;
      const to = editor.getCursor('to').line;
      const before = editor.getValue();
      const res = moveLinesToNextMonth(before, from, to, todayNow(), this.settings.noteLanguage);
      if (!res) {
        notify('zaznacz linię z zadaniem (nie nagłówek).');
        return;
      }
      await this.backup(before);
      editor.setValue(res.text);
      editor.setCursor({ line: Math.min(from, editor.lineCount() - 1), ch: 0 });
      notify(`przeniesiono ${res.count} → ${MONTHS[res.target.m - 1]} ${res.target.y}, BEZ DATY.`);
    }

    async applyReviewDecisions(decisions) {
      return this.withUndo('Przegląd zaległych dni', () => this.doApplyReview(decisions));
    }

    async doApplyReview(decisions) {
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        // Recomputed on the current file content; decisions match by item id.
        const review = collectReview(model, src, today, this.state);
        const r = applyReview(model, review, decisions, today, { spreadDays: this.settings.spreadDays });
        return Object.assign(r, { changed: r.moved + r.deleted + r.removedBlocks > 0 });
      });
      if (!res) return;
      for (const k of res.skipped) this.state.skippedYearly.add(k);
      await this.saveState();
      notify(`przeniesione ${res.moved}, usunięte ${res.deleted}, zamknięte dni ${res.removedBlocks}.`);
    }

    // --- sync ---------------------------------------------------------------

    async refreshCache() {
      const f = this.file(this.settings.dailyPath);
      this.cache = f ? checkboxStates(await this.app.vault.read(f)) : new Map();
    }

    async onModify(file) {
      if (file.path !== normalizePath(this.settings.dailyPath)) return;
      const next = checkboxStates(await this.app.vault.read(file));
      const changes = diffStates(this.cache, next);
      this.cache = next;
      if (!changes.length) return;
      const today = todayNow();
      const mf = this.file(this.settings.monthlyPath);
      const yf = this.file(this.settings.yearlyPath);
      if (mf && changes.some((c) => c.kind === 'M')) await this.app.vault.process(mf, (t) => applySyncMonthly(t, changes, today));
      if (yf && changes.some((c) => c.kind === 'R')) await this.app.vault.process(yf, (t) => applySyncYearly(t, changes, today));
    }
  }

  const LABEL_TEXT = { WOLNE: 'dzień wolny', HANDLOWA: 'niedziela handlowa' };
  const capital = (s) => s.charAt(0) + s.slice(1).toLowerCase();

  class WeekAlertModal extends Modal {
    constructor(app, days, today, resolve) {
      super(app);
      this.days = days;
      this.today = today;
      this.resolve = resolve;
      this.choice = null;
    }
    onOpen() {
      const { contentEl } = this;
      contentEl.addClass('plain-planner-week');
      contentEl.createEl('h3', { text: 'W tym tygodniu' });
      const list = contentEl.createEl('ul', { cls: 'plain-planner-week-list' });
      const todayIso = toIso(this.today);
      const tomorrowIso = toIso(addDays(this.today, 1));
      for (const d of this.days) {
        const li = list.createEl('li');
        const when = d.iso === todayIso ? 'dziś' : d.iso === tomorrowIso ? 'jutro' : null;
        const head = `${capital(WEEKDAYS[weekdayOf(d.t.y, d.t.m, d.t.d)])} ${pad2(d.t.d)}.${pad2(d.t.m)}${when ? ` (${when})` : ''}`;
        li.createEl('strong', { text: head });
        const parts = d.events.map((e) => (e.task ? `do zrobienia: ${e.text}` : e.text));
        for (const l of d.label.split(' - ').filter(Boolean)) parts.push(LABEL_TEXT[l] || l.toLowerCase());
        li.appendText(` – ${parts.join(' · ')}`);
      }
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      const add = (text, choice, cta) => {
        const b = buttons.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
        b.addEventListener('click', () => {
          this.choice = choice;
          this.close();
        });
      };
      add('Przypomnij mi jutro', 'tomorrow');
      add('OK', 'ok', true);
    }
    onClose() {
      this.contentEl.empty();
      this.resolve(this.choice);
    }
  }

  class UndoConfirmModal extends Modal {
    constructor(app, undo, editedSince, resolve) {
      super(app);
      this.undo = undo;
      this.editedSince = editedSince;
      this.resolve = resolve;
      this.ok = false;
    }
    onOpen() {
      const { contentEl } = this;
      const at = new Date(this.undo.at);
      const when = `${pad2(at.getDate())}.${pad2(at.getMonth() + 1)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
      contentEl.createEl('h3', { text: 'Cofnąć ostatnie rozpisanie?' });
      contentEl.createEl('p', {
        text: `Ostatnia zmiana wtyczki: „${this.undo.label}” (${when}). TODO DAILY wróci do stanu sprzed niej, a wtyczka zapomni dni, które wtedy rozpisała, więc będzie można rozpisać je jeszcze raz.`,
      });
      if (this.editedSince) {
        contentEl.createEl('p', {
          cls: 'plain-planner-warn',
          text: 'Uwaga: TODO DAILY zmienił się od tamtej pory (Twoje wpisy, odhaczenia albo Ctrl+Z). Te późniejsze zmiany też zostaną cofnięte. Obecny plik trafi do kopii w folderze backups wtyczki.',
        });
      }
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      buttons.createEl('button', { text: 'Anuluj' }).addEventListener('click', () => this.close());
      const ok = buttons.createEl('button', { text: 'Cofnij', cls: this.editedSince ? 'mod-warning' : 'mod-cta' });
      ok.addEventListener('click', () => {
        this.ok = true;
        this.close();
      });
    }
    onClose() {
      this.contentEl.empty();
      this.resolve(this.ok);
    }
  }

  class RoutineChangeModal extends Modal {
    constructor(app, changes, resolve) {
      super(app);
      this.changes = changes;
      this.resolve = resolve;
      this.choice = 'no';
    }
    onOpen() {
      const { contentEl } = this;
      const which = [this.changes.weekly && 'tygodniowa', this.changes.monthly && 'miesięczna'].filter(Boolean).join(' i ');
      contentEl.createEl('h3', { text: `Zmieniła się rutyna ${which}` });
      contentEl.createEl('p', {
        text: 'Zastosować zmiany w dniach, które są już rozpisane? Twoje wpisy zostaną nietknięte, a usunięte (zrobione) zadania nie wrócą.',
      });
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      const add = (text, choice, cta) => {
        const b = buttons.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
        b.addEventListener('click', () => {
          this.choice = choice;
          this.close();
        });
      };
      add('Nie', 'no');
      add('Od jutra', 'tomorrow');
      add('Od dziś', 'today', true);
    }
    onClose() {
      this.contentEl.empty();
      this.resolve(this.choice);
    }
  }

  class MonthPickModal extends SuggestModal {
    constructor(app, plugin) {
      super(app);
      this.plugin = plugin;
      this.setPlaceholder('Który miesiąc rozpisać?');
    }
    getSuggestions(query) {
      const t = todayNow();
      const list = [];
      for (let i = 0; i < 13; i++) {
        const x = fromDate(new Date(t.y, t.m - 1 + i, 1));
        list.push({ y: x.y, m: x.m, label: `${MONTHS[x.m - 1]} ${x.y}` });
      }
      const q = query.trim().toUpperCase();
      return list.filter((it) => it.label.includes(q));
    }
    renderSuggestion(it, el) {
      el.setText(it.label);
    }
    onChooseSuggestion(it) {
      this.plugin.runGenerate(it.y, it.m, true);
    }
  }

  const TYPE_LABEL = { done: 'zrobione', routine: 'rutyna', holiday: 'święto', weekly: 'tygodniowa', own: 'własne' };

  // Review of past days, built for long lists too: summary + bulk controls on
  // top, one collapsible group of weekly lines per day, a scrolling list and
  // buttons that stay visible below it.
  class ReviewModal extends Modal {
    constructor(app, plugin, review) {
      super(app);
      this.plugin = plugin;
      this.review = review;
      this.decisions = new Map();
      this.controls = []; // { type, blockId, get(), set(action) }
      this.bulks = []; // { sel, pick, placeholder }
    }

    // Each bulk dropdown shows the action its rows share, or "— różne —"
    // once they differ (a custom date counts as different).
    refreshBulks() {
      for (const b of this.bulks) {
        const values = new Set(this.controls.filter(b.pick).map((c) => c.get()));
        const [only] = values;
        const shared = values.size === 1 && [...b.sel.options].some((o) => o.value && o.value === only);
        b.placeholder.text = shared ? '— ustaw —' : '— różne —';
        b.sel.value = shared ? only : '';
      }
    }

    // One <select> (+ date input) bound to an item; returns its setter.
    actionSelect(parent, item, options, def) {
      const sel = parent.createEl('select', { cls: 'dropdown' });
      for (const [value, label] of options) sel.createEl('option', { value, text: label });
      const date = parent.createEl('input', { type: 'date', cls: 'plain-planner-date' });
      date.value = toIso(addDays(todayNow(), 1));
      const sync = () => {
        date.toggle(sel.value === 'date');
        this.decisions.set(item.id, { action: sel.value, date: date.value });
        if (!this.bulkUpdating) this.refreshBulks();
      };
      sel.addEventListener('change', sync);
      date.addEventListener('change', sync);
      sel.value = def;
      sync();
      return {
        get: () => sel.value,
        set: (action) => {
          if (!options.some(([v]) => v === action)) return;
          sel.value = action;
          sync();
        },
      };
    }

    row(parent, item, options, def, blockId) {
      const row = parent.createDiv({ cls: 'plain-planner-row' });
      row.createSpan({ cls: `plain-planner-tag plain-planner-tag-${item.type || 'routine'}`, text: TYPE_LABEL[item.type] || 'roczna' });
      row.createSpan({ cls: 'plain-planner-text', text: item.text });
      const controls = row.createDiv({ cls: 'plain-planner-controls' });
      if (item.type === 'done') {
        controls.createSpan({ cls: 'plain-planner-note', text: 'zostanie usunięte' });
        return;
      }
      const { get, set } = this.actionSelect(controls, item, options, def);
      this.controls.push({ type: item.type || 'overdue', blockId, get, set });
    }

    // "set all ..." dropdown; `pick(control)` selects which rows it changes.
    bulk(parent, label, options, pick) {
      const wrap = parent.createDiv({ cls: 'plain-planner-bulk' });
      wrap.createSpan({ text: label });
      const sel = wrap.createEl('select', { cls: 'dropdown' });
      const placeholder = sel.createEl('option', { value: '', text: '— ustaw —' });
      for (const [value, text] of options) if (value !== 'date') sel.createEl('option', { value, text });
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        this.bulkUpdating = true;
        for (const c of this.controls) if (pick(c)) c.set(sel.value);
        this.bulkUpdating = false;
        this.refreshBulks();
      });
      this.bulks.push({ sel, pick, placeholder });
      return wrap;
    }

    onOpen() {
      const { contentEl } = this;
      contentEl.addClass('plain-planner-review');
      contentEl.createEl('h2', { text: 'Przegląd zaległych dni' });
      const dayOptions = Object.entries(ACTIONS);
      const overdueOptions = [
        ['later', 'Nie teraz'],
        ['today', ACTIONS.today],
        ['tomorrow', ACTIONS.tomorrow],
        ['date', ACTIONS.date],
        ['spread', ACTIONS.spread],
        ['nextMonth', ACTIONS.nextMonth],
        ['skip', 'Pomiń w tym roku'],
      ];

      const count = { own: 0, weekly: 0, routine: 0, holiday: 0, done: 0 };
      for (const b of this.review.blocks) for (const it of b.items) count[it.type]++;
      const parts = [`dni: ${this.review.blocks.length}`];
      if (count.own) parts.push(`własne: ${count.own}`);
      if (count.routine) parts.push(`z rutyn: ${count.routine}`);
      if (count.weekly) parts.push(`tygodniowe: ${count.weekly}`);
      if (count.holiday) parts.push(`święta: ${count.holiday}`);
      if (count.done) parts.push(`zrobione: ${count.done}`);
      if (this.review.overdue.length) parts.push(`zaległe roczne: ${this.review.overdue.length}`);
      contentEl.createEl('p', { cls: 'plain-planner-summary', text: parts.join(' · ') });

      const bulkBox = contentEl.createDiv({ cls: 'plain-planner-bulkbox' });
      const list = contentEl.createDiv({ cls: 'plain-planner-scroll' });

      if (count.own) this.bulk(bulkBox, 'Wszystkie własne →', dayOptions, (c) => c.type === 'own');
      if (count.routine) this.bulk(bulkBox, 'Wszystkie z rutyn →', dayOptions, (c) => c.type === 'routine');
      if (count.weekly) this.bulk(bulkBox, 'Wszystkie tygodniowe →', dayOptions, (c) => c.type === 'weekly');
      if (this.review.overdue.length) this.bulk(bulkBox, 'Wszystkie zaległe roczne →', overdueOptions, (c) => c.type === 'overdue');

      for (const b of this.review.blocks) {
        const head = list.createDiv({ cls: 'plain-planner-dayhead' });
        head.createEl('h4', { text: b.label });
        if (!b.items.length) {
          list.createEl('p', { cls: 'plain-planner-note', text: 'Pusty – nagłówek zostanie usunięty.' });
          continue;
        }
        if (b.items.some((it) => it.type !== 'done')) {
          this.bulk(head, 'Cały dzień →', dayOptions, (c) => c.blockId === b.id && c.type !== 'overdue');
        }
        const weekly = b.items.filter((it) => it.type === 'weekly');
        for (const it of b.items) if (it.type !== 'weekly') this.row(list, it, dayOptions, it.default, b.id);
        if (weekly.length) {
          const det = list.createEl('details', { cls: 'plain-planner-weekly' });
          const sum = det.createEl('summary');
          sum.createSpan({ text: `Rutyna tygodniowa: ${weekly.length} – domyślnie usuń ` });
          this.bulk(sum, '', dayOptions, (c) => c.blockId === b.id && c.type === 'weekly');
          for (const it of weekly) this.row(det, it, dayOptions, it.default, b.id);
        }
      }
      if (this.review.overdue.length) {
        list.createDiv({ cls: 'plain-planner-dayhead' }).createEl('h4', { text: 'Niezrobione z rutyny rocznej (wcześniejsze miesiące)' });
        for (const o of this.review.overdue) {
          this.row(list, { id: o.id, type: null, text: `${o.text} (${MONTHS[o.month - 1].toLowerCase()})` }, overdueOptions, 'later', 'overdue');
        }
      }
      this.refreshBulks();

      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      buttons.createEl('button', { text: 'Później' }).addEventListener('click', () => this.close());
      const apply = buttons.createEl('button', { text: 'Zastosuj', cls: 'mod-cta' });
      apply.addEventListener('click', async () => {
        apply.disabled = true;
        await this.plugin.applyReviewDecisions(this.decisions);
        this.close();
      });
    }

    onClose() {
      this.contentEl.empty();
    }
  }

  // One description of the settings, rendered two ways: declaratively on
  // Obsidian 1.13+ (shows up in the settings search) and with the classic
  // Setting API on older versions.
  const SETTING_GROUPS = [
    {
      heading: 'Pliki',
      items: [
        {
          key: 'noteLanguage', type: 'dropdown', name: 'Język notatek',
          options: { pl: 'Polski', en: 'English' },
          desc: 'Język nagłówków, które wtyczka dopisuje (dni tygodnia, miesiące, BEZ DATY, WOLNE). Pliki rutyn i świąt mogą być w obu językach.',
        },
        { key: 'dailyPath', type: 'file', name: 'Plik TODO DAILY' },
        { key: 'weeklyPath', type: 'file', name: 'Rutyna tygodniowa' },
        { key: 'monthlyPath', type: 'file', name: 'Rutyna miesięczna' },
        { key: 'yearlyPath', type: 'file', name: 'Rutyna roczna' },
        { key: 'holidaysPath', type: 'file', name: 'Święta (opcjonalny)' },
      ],
    },
    {
      heading: 'Działanie',
      items: [
        {
          key: 'workTag', type: 'text', name: 'Tag pomijany w dni wolne', placeholder: '#praca',
          desc: 'Linie rutyny tygodniowej z tym tagiem nie trafiają do dni oznaczonych „- WOLNE”. Puste = nie pomijaj.',
        },
        {
          key: 'tradingSundays', type: 'toggle', name: 'Niedziele handlowe',
          desc: 'Dopisuje „- HANDLOWA” w nagłówku niedziel handlowych.',
        },
        {
          key: 'autoGenerate', type: 'toggle', name: 'Rozpisuj automatycznie',
          desc: 'Po otwarciu Obsidiana rozpisuje bieżący miesiąc i dodaje rutyny roczne do końca roku.',
        },
        {
          key: 'spreadDays', type: 'number', name: '„Rozłóż na najbliższe dni” – na ile dni', min: 1, max: 31,
          desc: 'Zadania z tą opcją trafiają po kolei na dziś i kolejne dni (1–31).',
        },
        {
          key: 'weekAlert', type: 'toggle', name: 'Przypomnienie o świętach w tym tygodniu',
          desc: 'Przy starcie pokazuje święta, dni wolne i niedziele handlowe od dziś do niedzieli.',
        },
        {
          key: 'autoReview', type: 'toggle', name: 'Przegląd zaległych dni przy starcie',
          desc: 'Wyłącz, jeśli wolisz uruchamiać go komendą lub skrótem klawiszowym.',
        },
      ],
    },
  ];
  const SETTING_ITEMS = SETTING_GROUPS.flatMap((g) => g.items);

  class PlainPlannerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    getSettingDefinitions() {
      return SETTING_GROUPS.map((g) => ({
        type: 'group',
        heading: g.heading,
        items: g.items.map((it) => {
          const control = { type: it.type, key: it.key, defaultValue: DEFAULT_SETTINGS[it.key] };
          if (it.placeholder) control.placeholder = it.placeholder;
          if (it.type === 'file') control.filter = (f) => f.extension === 'md';
          if (it.type === 'dropdown') control.options = it.options;
          if (it.type === 'number') {
            Object.assign(control, { min: it.min, max: it.max, step: 1 });
            control.validate = (v) => (cleanSetting(it, v) === null ? `${it.min}–${it.max}` : undefined);
          }
          return it.desc ? { name: it.name, desc: it.desc, control } : { name: it.name, control };
        }),
      }));
    }

    getControlValue(key) {
      return this.plugin.settings[key];
    }

    // Overridden so a change is stored next to the plugin state; the default
    // would save the settings object alone and drop the rest of data.json.
    async setControlValue(key, value) {
      const item = SETTING_ITEMS.find((it) => it.key === key);
      if (!item) return;
      const v = cleanSetting(item, value);
      if (v === null) return;
      this.plugin.settings[key] = v;
      await this.plugin.saveState();
    }

    // Fallback for Obsidian older than 1.13.
    display() {
      const { containerEl } = this;
      containerEl.empty();
      for (const g of SETTING_GROUPS) {
        new Setting(containerEl).setName(g.heading).setHeading();
        for (const it of g.items) {
          const s = new Setting(containerEl).setName(it.name);
          if (it.desc) s.setDesc(it.desc);
          const value = this.getControlValue(it.key);
          const save = (v) => this.setControlValue(it.key, v);
          if (it.type === 'toggle') s.addToggle((t) => t.setValue(value).onChange(save));
          else if (it.type === 'dropdown') s.addDropdown((dd) => dd.addOptions(it.options).setValue(value).onChange(save));
          else s.addText((t) => t.setValue(String(value)).setPlaceholder(it.placeholder || '').onChange(save));
        }
      }
    }
  }

  module.exports = PlainPlannerPlugin;
  module.exports.core = core;
  module.exports.PlainPlannerSettingTab = PlainPlannerSettingTab;
} else {
  module.exports = { core };
}
})();
