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
    routineFolder: 'RUTYNY',
    routineFiles: { weekly: 'RUTYNA TYGODNIOWA', monthly: 'RUTYNA MIESIĘCZNA', yearly: 'RUTYNA ROCZNA', holidays: 'ŚWIĘTA' },
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
    routineFolder: 'ROUTINES',
    routineFiles: { weekly: 'WEEKLY ROUTINE', monthly: 'MONTHLY ROUTINE', yearly: 'YEARLY ROUTINE', holidays: 'HOLIDAYS' },
  },
};
const DEFAULT_LANG = 'pl';
const langOf = (code) => LANGS[code] || LANGS[DEFAULT_LANG];
const ALL_LANGS = Object.values(LANGS);
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
// A month header of TODO DAILY: "GRUDZIEŃ 2027" (or, in older notes, just
// "GRUDZIEŃ"). Returns { m, y } with y null when no year is written, or null.
function monthHeaderInfo(s) {
  const hm = /^(.*?)\s+(\d{4})$/.exec(normName(s));
  const m = monthFromName(hm ? hm[1] : s);
  if (!m) return null;
  return { m, y: hm ? +hm[2] : null };
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

// Where no year is written (a day heading outside its month, an older month
// header), a DD.MM date belongs to whichever year puts it closest to today
// (a rolling +/- 6 month window).
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
// Obsidian comments (%% ... %%, also over several lines; an unclosed one
// runs to the end of the file) are blanked out before a routine file is
// read. Line numbers stay the same, so checkbox sync still finds its lines.
function maskComments(text) {
  return text.replace(/%%[\s\S]*?(?:%%|$)/g, (c) => c.replace(/[^\n]/g, ''));
}
// A horizontal rule ("---", "***", "___"), e.g. above the example block.
const RULE_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

function stripBullet(line) {
  return line.replace(/^\s*[-*+]\s+(\[[^\]]\]\s+)?/, '').trim();
}

function parseWeekly(text) {
  const map = new Map();
  let cur = -1;
  for (const line of splitLines(maskComments(text))) {
    if (RULE_RE.test(line)) continue;
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
  splitLines(maskComments(text)).forEach((line, i) => {
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
  splitLines(maskComments(text)).forEach((line, i) => {
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
  for (const raw of splitLines(maskComments(text))) {
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
    s.header = `## **${langOf(model.lang).months[m - 1]} ${y}**`;
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

// The note is: the user's text (preamble), the plan (month sections) and,
// from the first "#" / "##" heading under the plan that is not a month name,
// the user's text again (tail). Preamble and tail are never changed.
function parseDaily(text, today, lang) {
  const model = { preamble: [], months: new Map(), tail: [], lang: lang || DEFAULT_LANG };
  let target = model.preamble;
  let curSec = null;
  for (const line of splitLines(text)) {
    if (target === model.tail) {
      target.push(line);
      continue;
    }
    const mh = /^##(?!#)\s*(.*)$/.exec(line);
    const mi = mh && monthHeaderInfo(mh[1]);
    if (curSec && /^#{1,2}\s+\S/.test(line) && !mi) {
      target = model.tail;
      target.push(line);
      continue;
    }
    if (mi) {
      const m = mi.m;
      const sec = getSection(model, mi.y || resolveYear(m, 15, today), m, true);
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
        // A day under its own month takes that month's year.
        const y = curSec && curSec.m === m ? curSec.y : resolveYear(m, d, today);
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

// A month header always carries its year ("## **GRUDZIEŃ 2027**"), since a
// note can hold more than 12 months ahead. One already in the note language
// with the year is kept exactly as written; others are rewritten, keeping bold.
function monthHeader(sec, lang) {
  const name = `${langOf(lang).months[sec.m - 1]} ${sec.y}`;
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
  if (model.tail.length) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
    out.push(...model.tail);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Obsidian opens a note with the cursor on line 1. A code block there (the
  // cheat sheet) would show its source in live preview, so keep line 1 empty.
  if (out.length && /^\s*(```|~~~)/.test(out[0])) out.unshift('');
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
    filledDays: new Set(), filledYearly: new Set(), skippedYearly: new Set(), placedYearly: new Set(),
    placedHolidays: new Set(), labeledDays: new Set(), strippedDays: new Set(),
  };
}

// The "already written out" memory, saved before a run so "Cofnij ostatnie
// rozpisanie" can put it back together with the file. Routine snapshots and
// the week alert are left alone on purpose (undo must not re-ask about them).
const MARK_KEYS = ['filledDays', 'filledYearly', 'placedYearly', 'placedHolidays', 'labeledDays', 'strippedDays', 'skippedYearly'];
function snapshotMarks(state) {
  const o = {};
  for (const k of MARK_KEYS) o[k] = [...state[k]].sort();
  return o;
}
function restoreMarks(state, marks) {
  for (const k of MARK_KEYS) state[k] = new Set(marks[k] || []);
}

// Yearly items of month m (in year y): dated ones go under their day, undated
// ones under "### BEZ DATY" at the end of the month. Each item is placed only
// once (state.placedYearly), so items added to the file later still show up,
// while ones you delete from the plan never come back.
function fillYearly(model, src, y, m, today, state, present) {
  const ymk = monthKey(y, m);
  const todayN = dateNum(today.y, today.m, today.d);
  if (dateNum(y, m, daysInMonth(y, m)) < todayN) return 0;
  let added = 0;
  for (const it of src.yearly) {
    if (it.month !== m) continue;
    if (it.checked && y === today.y) continue; // already done this year
    const period = String(y);
    const ref = pad2(m);
    const key = routineKey('R', period, ref, it.text);
    if (present.has(key) || state.placedYearly.has(key)) continue;
    const line = makeRoutineLine('R', period, ref, it.text, model.lang);
    if (it.date) {
      let t = { y, m: it.date.m, d: Math.min(it.date.d, daysInMonth(y, it.date.m)) };
      if (dateNum(t.y, t.m, t.d) < todayN) t = today; // date already passed: do it today
      appendLine(ensureDay(model, t.y, t.m, t.d).lines, line);
    } else {
      appendLine(undatedExtra(model, y, m).lines, line);
    }
    present.add(key);
    state.placedYearly.add(key);
    added++;
  }
  state.filledYearly.add(ymk);
  return added;
}

// Upgrade from the per-month gate (before 0.15): every item of a month that
// was already filled in counts as placed, so nothing deleted comes back.
function migrateFilledYearly(src, months, state) {
  for (const ymk of months) {
    const [y, m] = ymk.split('-').map(Number);
    for (const it of src.yearly) if (it.month === m) state.placedYearly.add(routineKey('R', String(y), pad2(m), it.text));
  }
}

// New entries of the yearly routine and the holidays file reach the months
// already in the plan (run at start-up and by "Run now"). Months that are not
// in the plan are left to "Fill in a month" / "Fill in the year".
function fillNewEntries(model, src, today, state) {
  const present = routinePresence(model);
  let added = 0;
  for (const s of [...model.months.values()]) {
    added += fillHolidays(model, src, s.y, s.m, today, state, present);
    added += fillYearly(model, src, s.y, s.m, today, state, present);
  }
  added += stripWorkOnDaysOff(model, src, today, state);
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

// The month is not in the note at all (no heading, no days), e.g. its fill-in
// was undone with Ctrl+Z: forget that it was filled in so it can be filled
// in again. Only for an explicit "fill in a month"; automatic runs keep the
// memory, so a month deleted on purpose does not come back by itself.
function forgetMonthIfAbsent(model, y, m, state) {
  if (model.months.has(monthKey(y, m))) return false;
  const ym = monthKey(y, m);
  const keep = (set, belongs) => new Set([...set].filter((v) => !belongs(v)));
  state.filledDays = keep(state.filledDays, (v) => v.startsWith(`${ym}-`));
  state.filledYearly = keep(state.filledYearly, (v) => v === ym);
  state.placedYearly = keep(state.placedYearly, (v) => v.startsWith(`R|${y}|${pad2(m)}|`));
  state.labeledDays = keep(state.labeledDays, (v) => v.startsWith(`${ym}-`));
  state.strippedDays = keep(state.strippedDays, (v) => v.startsWith(`${ym}-`));
  state.placedHolidays = keep(state.placedHolidays, (v) => v.startsWith(`S|${y}|${pad2(m)}-`));
  return true;
}

// Months "Fill in the year" works on: those after the current one up to
// December, or, with nextYear (used in December), all of the next year.
function yearMonths(today, nextYear) {
  const out = [];
  if (nextYear) for (let m = 1; m <= 12; m++) out.push({ y: today.y + 1, m });
  else for (let m = today.m + 1; m <= 12; m++) out.push({ y: today.y, m });
  return out;
}

// Yearly routines and holidays for those months (holidays also for this one).
function generateYearlyRest(model, src, today, state, nextYear) {
  const present = routinePresence(model);
  let added = fillHolidays(model, src, today.y, today.m, today, state, present);
  for (const { y, m } of yearMonths(today, nextYear)) {
    added += fillHolidays(model, src, y, m, today, state, present);
    added += fillYearly(model, src, y, m, today, state, present);
  }
  added += stripWorkOnDaysOff(model, src, today, state);
  return added;
}

// "Fill in the year": every month after the current one, up to December, gets
// its header and an undated block (a month with nothing in it gets just those).
// Returns how many months were missing.
function addYearSkeleton(model, today, nextYear) {
  let added = 0;
  for (const { y, m } of yearMonths(today, nextYear)) {
    if (!getSection(model, y, m, false)) added++;
    undatedExtra(model, y, m);
  }
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
      // A brand-new routine line the day already has stays as it is. This
      // happens when the day was filled in after the routine was edited but
      // before the change was picked up (e.g. "Fill in a month" right after
      // the edit), so the remembered routine is older than the day.
      const taken = new Set();
      const already = newL.map((n, i) => {
        if (origin[i] !== null) return false;
        const idx = day.lines.findIndex((l, k) => !consumed.has(k) && !taken.has(k) && l.trim() === n);
        if (idx < 0) return false;
        taken.add(idx);
        return true;
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
        if (already[i]) {
          anchors.push(null); // already in the day, kept where it is
          return;
        }
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

// Actions for a line of a past day, in the order the review offers them.
const ACTIONS = ['today', 'tomorrow', 'date', 'spread', 'nextMonth', 'delete', 'keep'];
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
  let day = null;
  for (let i = Math.min(idx, lines.length - 1); i >= 0; i--) {
    const dh = /^###(?!#)\s*(\d{1,2})\.(\d{1,2})\.?(?:\s.*)?$/.exec(lines[i]);
    if (!day && dh && +dh[2] >= 1 && +dh[2] <= 12) day = { m: +dh[2], d: +dh[1] };
    const mh = /^##(?!#)\s*(.*)$/.exec(lines[i]);
    const mi = mh && monthHeaderInfo(mh[1]);
    if (mi) {
      if (day && day.m !== mi.m) break;
      return { y: mi.y || resolveYear(mi.m, day ? day.d : 15, today), m: mi.m };
    }
  }
  return day ? { y: resolveYear(day.m, day.d, today), m: day.m } : null;
}

// Backlog note when none is set: BACKLOG.md next to the daily note.
function backlogDefaultPath(dailyPath) {
  const i = (dailyPath || '').lastIndexOf('/');
  return i >= 0 ? `${dailyPath.slice(0, i)}/BACKLOG.md` : 'BACKLOG.md';
}

// Lines from..to (inclusive) that can be moved: not headings, not blank.
function movableLines(lines, from, to) {
  const picked = [];
  for (let i = from; i <= to && i < lines.length; i++) {
    if (lines[i].trim() && !/^\s*#/.test(lines[i])) picked.push(i);
  }
  return picked;
}

// The backlog note holds tasks for later years under "# 2027", "# 2028", ...
// Adds `moved` at the end of the year's section (created, in year order, when
// missing). Anything else in the note is left as it is.
function addToBacklog(text, year, moved) {
  const lines = text ? splitLines(text) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const yearOf = (l) => {
    const h = /^#(?!#)\s*(\d{4})\s*$/.exec(l);
    return h ? +h[1] : null;
  };
  const start = lines.findIndex((l) => yearOf(l) === year);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^#(?!#)\s/.test(lines[end])) end++;
    let at = end;
    while (at > start + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, ...moved);
  } else {
    let at = lines.findIndex((l) => yearOf(l) !== null && yearOf(l) > year);
    if (at < 0) at = lines.length;
    const block = [`# ${year}`, ...moved];
    if (at > 0 && lines[at - 1].trim()) block.unshift('');
    if (at < lines.length) block.push('');
    lines.splice(at, 0, ...block);
  }
  return lines.join('\n') + '\n';
}

// Takes lines from..to out of TODO DAILY for the backlog. Returns
// { text, moved } or null when there is nothing to move.
function takeLinesForBacklog(text, from, to) {
  const lines = splitLines(text);
  const picked = movableLines(lines, from, to);
  if (!picked.length) return null;
  const drop = new Set(picked);
  return { text: lines.filter((_, i) => !drop.has(i)).join('\n'), moved: picked.map((i) => lines[i]) };
}

// Moves lines from..to (inclusive, headings and blank lines skipped) to the
// "BEZ DATY" block of the month after the one they sit in (never earlier than
// the month after today). Returns the new text, or null when nothing moved.
function moveLinesToNextMonth(text, from, to, today, lang) {
  const lines = splitLines(text);
  const picked = movableLines(lines, from, to);
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

// --- user interface texts -------------------------------------------------------

// Texts of commands, dialogs, notices and settings. `{name}` is filled in by
// uiText. Counts are written as "label: n" so no plural forms are needed.
// The UI language is separate from the note language (LANGS): someone may
// use Obsidian in English and keep their notes in Polish.
const UI = {
  pl: {
    cmdGenerateMonth: 'Rozpisz miesiąc',
    cmdYearlyRest: 'Rozpisz rok',
    cmdReview: 'Przegląd zaległych dni',
    cmdMoveNextMonth: 'Przenieś na następny miesiąc ({undated})',
    cmdMoveBacklog: 'Przenieś do backlogu ({year})',
    cmdWeekAlert: 'Pokaż święta w tym tygodniu',
    cmdRunNow: 'Uruchom teraz (jak przy starcie Obsidiana)',
    cmdUndoLast: 'Cofnij ostatnie rozpisanie',
    cmdForget: 'Zapomnij rozpisane dni (rozpisz od nowa)',
    cmdSetup: 'Utwórz plik planu dnia i wybierz język',
    cmdCreateRoutine: 'Utwórz rutynę',
    routinePickPlaceholder: 'Którą rutynę utworzyć?',
    routineHolidays: 'Święta i dni wolne',
    routineCreated: 'utworzono {file}. Wpisz zadania nad linią ---, pod nią jest przykład.',
    routineLinked: 'plik {file} już istnieje, wtyczka będzie go teraz używać.',
    routineAllSet: 'wszystkie rutyny są już ustawione (Ustawienia → Plain Planner).',

    setupTitle: 'Plain Planner – pierwsze kroki',
    setupLanguage: 'Język',
    setupLanguageDesc: 'Język okien i komunikatów oraz nazw miesięcy i dni tygodnia w planie.',
    setupIntro: 'Wtyczka utworzy nową notatkę, w której będzie rozpisywać plan dnia na kolejne miesiące. Na górze znajdziesz rozwijaną ściągę komend, którą możesz usunąć. Możesz też dopisywać własny tekst: nad planem albo pod nim, pod własnym nagłówkiem # lub ##.',
    setupMissing: 'Nie ma już pliku {path} (usunięty albo przeniesiony poza Obsidianem). Utwórz nowy.',
    setupName: 'Nazwa notatki',
    setupCreateBtn: 'Utwórz',
    setupExists: 'Notatka {file} już istnieje. Podaj inną nazwę.',
    setupBadName: 'Nazwa nie może być pusta ani zawierać znaków \\ / : * ? " < > | # ^ [ ].',
    setupDone: 'plan dnia będzie w {file}. Użyj komendy „{cmd}”, aby rozpisać miesiąc.',

    cheatTitle: 'ściąga komend',
    cheatNote: 'Możesz usunąć ten blok z notatki: najedź na niego i kliknij </>, albo wejdź w niego strzałkami.',
    cheatFallback: 'Ściąga komend Plain Planner (widoczna, gdy wtyczka jest włączona).',
    cheatPaletteName: 'Paleta komend',
    cheatPaletteAfter: 'potem wpisz „Plain Planner”',
    cheatMenuAfter: 'też w menu prawego przycisku (na telefonie: przytrzymaj)',
    cheatNone: 'brak skrótu',
    cheatHint: 'Skróty ustawisz w: Ustawienia → Skróty klawiszowe, wyszukaj „Plain Planner”.',

    undoRunNow: 'Uruchom teraz',
    undoStartup: 'start Obsidiana',
    undoNewDay: 'nowy dzień',
    undoGenerateMonth: 'Rozpisz miesiąc ({month})',
    undoYearlyRest: 'Rozpisz rok',
    undoReview: 'Przegląd zaległych dni',

    forgotDays: 'wtyczka zapomniała, które dni rozpisała.',
    fileNotFound: 'nie znaleziono pliku {path}',
    writeConflict: 'plik zmieniał się w trakcie zapisu, nic nie zmieniono. Spróbuj ponownie.',
    nothingToUndo: 'nie ma czego cofać.',
    undone: 'cofnięto „{label}”. Możesz rozpisać jeszcze raz.',
    noHolidaysThisWeek: 'w tym tygodniu nie ma świąt ani niedziel handlowych.',
    routineChangesApplied: 'zmiany rutyny zastosowane (zmienione miejsca: {n}).',
    newEntriesAdded: 'nowe wpisy z rutyny rocznej i świąt dodane do planu: {n}.',
    newMonthUnchecked: 'nowy miesiąc – rutyna miesięczna odznaczona.',
    newYearUnchecked: 'nowy rok – rutyna roczna odznaczona.',
    monthFilled: '{month} – nowe dni: {days}, dodane zadania: {added}.',
    monthAlreadyFilled: '{month} jest już rozpisany, nic nie dodano.',
    yearlyAdded: 'dodano zadania roczne do kolejnych miesięcy: {n}.',
    yearlyAlreadyFilled: 'rutyny roczne do końca roku są już rozpisane.',
    yearMonthsAdded: 'dodano miesiące do końca roku: {months}, zadania roczne i święta: {n}.',
    yearNextTitle: 'Rozpisać rok {year}?',
    yearNextText: 'Jest grudzień, więc z tego roku nie zostało nic do rozpisania. Wtyczka dopisze cały rok {year}: dwanaście miesięcy z blokiem BEZ DATY, rutyny roczne i święta. Możesz to potem cofnąć komendą „Cofnij ostatnie rozpisanie”.',
    yearNextOk: 'Rozpisz rok {year}',
    yearHintMonth: 'Bieżący miesiąc ({month}) rozpiszesz komendą „Rozpisz miesiąc”.',
    noOverdue: 'brak zaległych dni.',
    selectTaskLine: 'zaznacz linię z zadaniem (nie nagłówek).',
    movedToNextMonth: 'przeniesiono {n} → {month} {year}, {undated}.',
    movedToBacklog: 'przeniesiono {n} → {file}, rok {year}.',
    reviewApplied: 'przeniesione {moved}, usunięte {deleted}, zamknięte dni {closed}.',

    weekTitle: 'W tym tygodniu',
    whenToday: 'dziś',
    whenTomorrow: 'jutro',
    dayHead: '{weekday} {dd}.{mm}',
    dateTime: '{dd}.{mm} {hh}:{min}',
    toDo: 'do zrobienia: {text}',
    labelDayOff: 'dzień wolny',
    labelShoppingSunday: 'niedziela handlowa',
    remindTomorrow: 'Przypomnij mi jutro',
    ok: 'OK',

    undoTitle: 'Cofnąć ostatnie rozpisanie?',
    undoBody: 'Ostatnia zmiana wtyczki: „{label}” ({when}). {file} wróci do stanu sprzed niej, a wtyczka zapomni dni, które wtedy rozpisała, więc będzie można rozpisać je jeszcze raz.',
    undoWarning: 'Uwaga: {file} zmienił się od tamtej pory (Twoje wpisy, odhaczenia albo Ctrl+Z). Te późniejsze zmiany też zostaną cofnięte. Obecny plik trafi do kopii w folderze backups wtyczki.',
    cancel: 'Anuluj',
    undo: 'Cofnij',

    routineChangedWeekly: 'Zmieniła się rutyna tygodniowa',
    routineChangedMonthly: 'Zmieniła się rutyna miesięczna',
    routineChangedBoth: 'Zmieniła się rutyna tygodniowa i miesięczna',
    routineChangeBody: 'Zastosować zmiany w dniach, które są już rozpisane? Twoje wpisy zostaną nietknięte, a usunięte (zrobione) zadania nie wrócą.',
    no: 'Nie',
    fromTomorrow: 'Od jutra',
    fromToday: 'Od dziś',

    monthPickPlaceholder: 'Który miesiąc rozpisać?',

    reviewTitle: 'Przegląd zaległych dni',
    actionToday: 'Na dziś',
    actionTomorrow: 'Na jutro',
    actionDate: 'Na wybrany dzień',
    actionSpread: 'Rozłóż na najbliższe dni',
    actionNextMonth: 'Na następny miesiąc ({undated})',
    actionDelete: 'Usuń',
    actionKeep: 'Zostaw (zdecyduję później)',
    actionLater: 'Nie teraz',
    actionSkip: 'Pomiń w tym roku',
    typeDone: 'zrobione',
    typeRoutine: 'rutyna',
    typeHoliday: 'święto',
    typeWeekly: 'tygodniowa',
    typeOwn: 'własne',
    typeYearly: 'roczna',
    willBeDeleted: 'zostanie usunięte',
    bulkSet: '— ustaw —',
    bulkMixed: '— różne —',
    sumDays: 'dni: {n}',
    sumOwn: 'własne: {n}',
    sumRoutine: 'z rutyn: {n}',
    sumWeekly: 'tygodniowe: {n}',
    sumHoliday: 'święta: {n}',
    sumDone: 'zrobione: {n}',
    sumOverdue: 'zaległe roczne: {n}',
    bulkOwn: 'Wszystkie własne →',
    bulkRoutine: 'Wszystkie z rutyn →',
    bulkWeekly: 'Wszystkie tygodniowe →',
    bulkOverdue: 'Wszystkie zaległe roczne →',
    bulkDay: 'Cały dzień →',
    emptyDay: 'Pusty – nagłówek zostanie usunięty.',
    weeklyGroup: 'Rutyna tygodniowa: {n} – domyślnie usuń ',
    overdueHeading: 'Niezrobione z rutyny rocznej (wcześniejsze miesiące)',
    later: 'Później',
    apply: 'Zastosuj',

    headFiles: 'Pliki',
    headBehaviour: 'Działanie',
    setUiLanguage: 'Język interfejsu',
    setUiLanguageDesc: 'Język komend, okien i komunikatów. Teksty tej karty zmienią się po jej ponownym otwarciu.',
    optAuto: 'Automatycznie (jak Obsidian)',
    setNoteLanguage: 'Język notatek',
    setNoteLanguageDesc: 'Język nagłówków, które wtyczka dopisuje (dni tygodnia, miesiące, {undated}, {dayOff}). Pliki rutyn i świąt mogą być w obu językach.',
    setDailyPath: 'Plik planu dnia',
    setWeeklyPath: 'Rutyna tygodniowa',
    setMonthlyPath: 'Rutyna miesięczna',
    setYearlyPath: 'Rutyna roczna',
    setHolidaysPath: 'Święta (opcjonalny)',
    setBacklogPath: 'Backlog',
    setBacklogPathDesc: 'Zadania na kolejne lata, pod nagłówkami „# 2027”, „# 2028”. Puste: BACKLOG.md obok pliku planu dnia. Plik powstaje przy pierwszym przeniesieniu.',
    setWorkTag: 'Tag pomijany w dni wolne',
    setWorkTagDesc: 'Linie rutyny tygodniowej z tym tagiem nie trafiają do dni oznaczonych „- {dayOff}”. Puste = nie pomijaj.',
    setTradingSundays: 'Niedziele handlowe',
    setTradingSundaysDesc: 'Dopisuje „- {shopping}” w nagłówku niedziel handlowych.',
    setAutoGenerate: 'Rozpisuj automatycznie',
    setAutoGenerateDesc: 'Po otwarciu Obsidiana rozpisuje bieżący miesiąc i dodaje rutyny roczne do końca roku.',
    setSpreadDays: '„{spread}” – na ile dni',
    setSpreadDaysDesc: 'Zadania z tą opcją trafiają po kolei na dziś i kolejne dni (1–31).',
    setWeekAlert: 'Przypomnienie o świętach w tym tygodniu',
    setWeekAlertDesc: 'Przy starcie pokazuje święta, dni wolne i niedziele handlowe od dziś do niedzieli.',
    setAutoReview: 'Przegląd zaległych dni przy starcie',
    setAutoReviewDesc: 'Wyłącz, jeśli wolisz uruchamiać go komendą lub skrótem klawiszowym.',
  },
  en: {
    cmdGenerateMonth: 'Fill in a month',
    cmdYearlyRest: 'Fill in the year',
    cmdReview: 'Review past days',
    cmdMoveNextMonth: 'Move to next month ({undated})',
    cmdMoveBacklog: 'Move to backlog ({year})',
    cmdWeekAlert: 'Show holidays this week',
    cmdRunNow: 'Run now (as on Obsidian start-up)',
    cmdUndoLast: 'Undo the last fill-in',
    cmdForget: 'Forget filled-in days (fill in again)',
    cmdSetup: 'Create the daily plan file and choose the language',
    cmdCreateRoutine: 'Create a routine',
    routinePickPlaceholder: 'Which routine to create?',
    routineHolidays: 'Holidays and days off',
    routineCreated: 'created {file}. Write your tasks above the --- line, an example is below it.',
    routineLinked: '{file} already exists, the plugin will use it from now on.',
    routineAllSet: 'all routines are already set (Settings → Plain Planner).',

    setupTitle: 'Plain Planner – getting started',
    setupLanguage: 'Language',
    setupLanguageDesc: 'Language of the interface and of month and weekday names in your plan.',
    setupIntro: 'The plugin creates a new note where it writes the day-by-day plan for each month. At the top you will find an expandable command cheat sheet, which you may delete. You can add your own text too: above the plan, or below it under your own # or ## heading.',
    setupMissing: 'The file {path} no longer exists (deleted, or moved outside Obsidian). Please create a new one.',
    setupName: 'Note name',
    setupCreateBtn: 'Create',
    setupExists: 'The note {file} already exists. Please choose another name.',
    setupBadName: 'The name must not be empty or contain \\ / : * ? " < > | # ^ [ ].',
    setupDone: 'the daily plan goes to {file}. Use the "{cmd}" command to fill in a month.',

    cheatTitle: 'command cheat sheet',
    cheatNote: 'You may delete this block from the note: hover over it and click </>, or move into it with the arrow keys.',
    cheatFallback: 'Plain Planner command cheat sheet (shown while the plugin is enabled).',
    cheatPaletteName: 'Command palette',
    cheatPaletteAfter: 'then type "Plain Planner"',
    cheatMenuAfter: 'also in the right-click menu (on mobile: long press)',
    cheatNone: 'no hotkey',
    cheatHint: 'Set hotkeys in: Settings → Hotkeys, search for "Plain Planner".',

    undoRunNow: 'Run now',
    undoStartup: 'Obsidian start-up',
    undoNewDay: 'new day',
    undoGenerateMonth: 'Fill in a month ({month})',
    undoYearlyRest: 'Fill in the year',
    undoReview: 'Review past days',

    forgotDays: 'the plugin forgot which days it filled in.',
    fileNotFound: 'file {path} not found',
    writeConflict: 'the file changed while saving, nothing was changed. Please try again.',
    nothingToUndo: 'nothing to undo.',
    undone: 'undid "{label}". You can fill in again.',
    noHolidaysThisWeek: 'no holidays or shopping Sundays this week.',
    routineChangesApplied: 'routine changes applied (places changed: {n}).',
    newEntriesAdded: 'new entries from the yearly routine and holidays added to the plan: {n}.',
    newMonthUnchecked: 'new month – monthly routine unchecked.',
    newYearUnchecked: 'new year – yearly routine unchecked.',
    monthFilled: '{month} – new days: {days}, tasks added: {added}.',
    monthAlreadyFilled: '{month} is already filled in, nothing added.',
    yearlyAdded: 'yearly tasks added to the coming months: {n}.',
    yearlyAlreadyFilled: 'yearly routines until the end of the year are already filled in.',
    yearMonthsAdded: 'months added until the end of the year: {months}, yearly tasks and holidays: {n}.',
    yearNextTitle: 'Fill in {year}?',
    yearNextText: 'It is December, so nothing is left of this year. The plugin will add all of {year}: twelve months with an undated block, yearly routines and holidays. You can take it back with "Undo the last fill-in".',
    yearNextOk: 'Fill in {year}',
    yearHintMonth: 'To fill in the current month ({month}), use "Fill in a month".',
    noOverdue: 'no past days to review.',
    selectTaskLine: 'select a task line (not a heading).',
    movedToNextMonth: 'moved {n} → {month} {year}, {undated}.',
    movedToBacklog: 'moved {n} → {file}, year {year}.',
    reviewApplied: 'moved {moved}, deleted {deleted}, days closed {closed}.',

    weekTitle: 'This week',
    whenToday: 'today',
    whenTomorrow: 'tomorrow',
    dayHead: '{weekday}, {mon} {d}',
    dateTime: '{mon} {d}, {hh}:{min}',
    toDo: 'to do: {text}',
    labelDayOff: 'day off',
    labelShoppingSunday: 'shopping Sunday',
    remindTomorrow: 'Remind me tomorrow',
    ok: 'OK',

    undoTitle: 'Undo the last fill-in?',
    undoBody: 'Last change made by the plugin: "{label}" ({when}). {file} goes back to how it was before it, and the plugin forgets the days it filled in then, so you can fill them in again.',
    undoWarning: 'Warning: {file} has changed since then (your entries, checked boxes or Ctrl+Z). Those later changes will be undone too. The current file is saved to the backups folder of the plugin.',
    cancel: 'Cancel',
    undo: 'Undo',

    routineChangedWeekly: 'The weekly routine has changed',
    routineChangedMonthly: 'The monthly routine has changed',
    routineChangedBoth: 'The weekly and monthly routines have changed',
    routineChangeBody: 'Apply the changes to days that are already filled in? Your own entries stay untouched, and deleted (done) tasks do not come back.',
    no: 'No',
    fromTomorrow: 'From tomorrow',
    fromToday: 'From today',

    monthPickPlaceholder: 'Which month to fill in?',

    reviewTitle: 'Review past days',
    actionToday: 'To today',
    actionTomorrow: 'To tomorrow',
    actionDate: 'To a chosen day',
    actionSpread: 'Spread over the next days',
    actionNextMonth: 'To next month ({undated})',
    actionDelete: 'Delete',
    actionKeep: 'Keep (decide later)',
    actionLater: 'Not now',
    actionSkip: 'Skip this year',
    typeDone: 'done',
    typeRoutine: 'routine',
    typeHoliday: 'holiday',
    typeWeekly: 'weekly',
    typeOwn: 'own',
    typeYearly: 'yearly',
    willBeDeleted: 'will be deleted',
    bulkSet: '— set —',
    bulkMixed: '— mixed —',
    sumDays: 'days: {n}',
    sumOwn: 'own: {n}',
    sumRoutine: 'from routines: {n}',
    sumWeekly: 'weekly: {n}',
    sumHoliday: 'holidays: {n}',
    sumDone: 'done: {n}',
    sumOverdue: 'overdue yearly: {n}',
    bulkOwn: 'All own →',
    bulkRoutine: 'All from routines →',
    bulkWeekly: 'All weekly →',
    bulkOverdue: 'All overdue yearly →',
    bulkDay: 'Whole day →',
    emptyDay: 'Empty – the heading will be removed.',
    weeklyGroup: 'Weekly routine: {n} – deleted by default ',
    overdueHeading: 'Not done from the yearly routine (earlier months)',
    later: 'Later',
    apply: 'Apply',

    headFiles: 'Files',
    headBehaviour: 'Behaviour',
    setUiLanguage: 'Interface language',
    setUiLanguageDesc: 'Language of commands, dialogs and notices. The texts of this tab change when you reopen it.',
    optAuto: 'Automatic (same as Obsidian)',
    setNoteLanguage: 'Note language',
    setNoteLanguageDesc: 'Language of the headings the plugin writes (weekdays, months, {undated}, {dayOff}). Routine and holiday files may use either language.',
    setDailyPath: 'Daily plan file',
    setWeeklyPath: 'Weekly routine',
    setMonthlyPath: 'Monthly routine',
    setYearlyPath: 'Yearly routine',
    setHolidaysPath: 'Holidays (optional)',
    setBacklogPath: 'Backlog',
    setBacklogPathDesc: 'Tasks for later years, under "# 2027", "# 2028" headings. Empty: BACKLOG.md next to the daily note. The file is created on the first move.',
    setWorkTag: 'Tag skipped on days off',
    setWorkTagDesc: 'Weekly routine lines with this tag are left out of days marked "- {dayOff}". Empty = do not skip.',
    setTradingSundays: 'Shopping Sundays',
    setTradingSundaysDesc: 'Adds "- {shopping}" to the heading of shopping Sundays (Poland).',
    setAutoGenerate: 'Fill in automatically',
    setAutoGenerateDesc: 'When Obsidian opens, fills in the current month and adds yearly routines until the end of the year.',
    setSpreadDays: '"{spread}" – number of days',
    setSpreadDaysDesc: 'Tasks with this option go to today and the following days in turn (1–31).',
    setWeekAlert: 'Reminder about holidays this week',
    setWeekAlertDesc: 'At start-up, shows holidays, days off and shopping Sundays from today to Sunday.',
    setAutoReview: 'Review past days at start-up',
    setAutoReviewDesc: 'Turn off if you prefer to open it with a command or a hotkey.',
  },
};
const UI_LANG_SETTINGS = ['auto', ...Object.keys(UI)];

// Interface language from the setting ('auto', 'pl', 'en') and the language
// Obsidian runs in.
function resolveUiLang(setting, appLang) {
  if (UI[setting]) return setting;
  return UI[appLang] ? appLang : 'en';
}

function uiText(lang, key, vars) {
  const dict = UI[lang] || UI.en;
  const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : UI.en[key] || key;
  return vars ? s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all)) : s;
}

// Month and weekday names as the interface writes them inside a sentence:
// Polish in lower case ("listopad"), English capitalised ("November").
const capitalise = (s) => s.charAt(0) + s.slice(1).toLowerCase();
function uiMonth(lang, m) {
  const name = langOf(lang).months[m - 1];
  return lang === 'pl' ? name.toLowerCase() : capitalise(name);
}
function uiWeekday(lang, wd) {
  return capitalise(langOf(lang).weekdays[wd]);
}
// "Czwartek 26.11" / "Thursday, Nov 26" (+ " (dziś)" / " (today)").
function uiDayHead(lang, t, when) {
  const head = uiText(lang, 'dayHead', {
    weekday: uiWeekday(lang, weekdayOf(t.y, t.m, t.d)),
    dd: pad2(t.d), mm: pad2(t.m), d: t.d, mon: uiMonth(lang, t.m).slice(0, 3),
  });
  return when ? `${head} (${uiText(lang, when === 'today' ? 'whenToday' : 'whenTomorrow')})` : head;
}

// --- command cheat sheet ----------------------------------------------------------

// A new daily note starts with a ```plain-planner``` code block. The plugin
// draws it as a small collapsible list of the commands and their current
// hotkeys, in the interface language, so the note itself never needs to be
// rewritten. The user may delete the block. Without the plugin it shows as
// a plain code block holding one line of explanation.
const CHEAT_COMMANDS = [
  ['generate-month', 'cmdGenerateMonth'],
  ['undo-last', 'cmdUndoLast'],
  ['review', 'cmdReview'],
  ['forget-filled', 'cmdForget'],
  ['move-next-month', 'cmdMoveNextMonth'],
  ['move-to-backlog', 'cmdMoveBacklog'],
  ['week-alert', 'cmdWeekAlert'],
  ['yearly-rest', 'cmdYearlyRest'],
  ['create-routine', 'cmdCreateRoutine'],
  ['run-now', 'cmdRunNow'],
];
const PLUGIN_ID = 'plain-planner';
const CHEAT_BLOCK = 'plain-planner';
const PALETTE_ID = 'command-palette:open';
const PALETTE_DEFAULT = [{ modifiers: ['Mod'], key: 'P' }];

// { modifiers: ['Mod', 'Shift'], key: 'M' } -> ['Ctrl', 'Shift', 'M'] (Cmd on macOS).
function hotkeyParts(hk, isMac) {
  const names = { Mod: isMac ? 'Cmd' : 'Ctrl', Ctrl: 'Ctrl', Meta: isMac ? 'Cmd' : 'Win', Alt: isMac ? 'Option' : 'Alt', Shift: 'Shift' };
  const order = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
  const mods = (hk.modifiers || []).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => names[m] || m);
  const key = hk.key && hk.key.length === 1 ? hk.key.toUpperCase() : hk.key;
  return [...mods, key].filter(Boolean);
}
function formatHotkey(hk, isMac) {
  return hotkeyParts(hk, isMac).join(' + ');
}

// Hotkeys of a command from .obsidian/hotkeys.json (an entry there replaces
// the default; the plugin sets no defaults of its own).
function hotkeysOf(hotkeys, id) {
  if (hotkeys && Object.prototype.hasOwnProperty.call(hotkeys, id)) return hotkeys[id] || [];
  return id === PALETTE_ID ? PALETTE_DEFAULT : [];
}

// Rows of the sheet: { label, combos: [['Ctrl', 'P'], ...], after }.
function cheatEntries(lang, noteLang, hotkeys, isMac, year) {
  const combos = (id) => hotkeysOf(hotkeys, id).map((h) => hotkeyParts(h, isMac));
  const undated = langOf(noteLang).undated;
  const rows = [{ label: uiText(lang, 'cheatPaletteName'), combos: combos(PALETTE_ID), after: uiText(lang, 'cheatPaletteAfter') }];
  for (const [id, key] of CHEAT_COMMANDS) {
    const menu = id === 'move-next-month' || id === 'move-to-backlog';
    const after = menu ? uiText(lang, 'cheatMenuAfter') : null;
    rows.push({ label: uiText(lang, key, { undated, year }), combos: combos(`${PLUGIN_ID}:${id}`), after });
  }
  return rows;
}

// Start of a new daily note: an empty line, the cheat sheet block, then a
// rule. Obsidian opens a note with the cursor on line 1; in live preview a
// cursor on the block's fence shows its source instead of the sheet, so the
// block starts on line 2. The blank line before "---" matters too: "---"
// right under a text line would turn it into a heading.
function cheatSheetBlock(lang) {
  return ['', '```' + CHEAT_BLOCK, uiText(lang, 'cheatFallback'), '```', '', '---', ''].join('\n');
}

// --- new routine files -----------------------------------------------------

const ROUTINE_KINDS = ['weekly', 'monthly', 'yearly', 'holidays'];
const ROUTINE_LABEL = { weekly: 'setWeeklyPath', monthly: 'setMonthlyPath', yearly: 'setYearlyPath', holidays: 'routineHolidays' };
const ROUTINE_SETTING = { weekly: 'weeklyPath', monthly: 'monthlyPath', yearly: 'yearlyPath', holidays: 'holidaysPath' };

// Example block at the bottom of a new routine file, inside a comment so the
// plugin does not read it. {work} is the work tag from the settings.
const ROUTINE_EXAMPLES = {
  pl: {
    head: 'PRZYKŁAD. To tylko przykład, możesz go dowolnie usunąć (razem z linią --- nad nim).',
    weekly: [
      'Wpisz zadania pod nagłówkiem dnia tygodnia, jedno w linii. Wtyczka dopisze je do każdego takiego dnia w planie:',
      '',
      '## PONIEDZIAŁEK',
      'pranie',
      'praca {work}',
      '',
      'Linie z tagiem {work} wtyczka pomija w dni wolne (tag zmienisz w ustawieniach).',
      'Po dodaniu lub zmianie zadań uruchom komendę „Uruchom teraz (jak przy starcie Obsidiana)”. Wtyczka zapyta, od kiedy zmiana ma obowiązywać, i dopisze ją do dni, które są już w planie.',
    ],
    monthly: [
      'Jedno zadanie w linii: - [ ], dzień miesiąca i treść. Zadanie pojawi się w planie w tym dniu każdego miesiąca:',
      '',
      '- [ ] 10 Zapłać czynsz',
      '- [ ] 28 Zapłać za telefon',
      '',
      'Dzień 31 w krótszym miesiącu trafi na jego ostatni dzień.',
      'Odhaczenie zadania w planie odhacza je także tutaj. Na początku nowego miesiąca wtyczka odznacza wszystkie.',
      'Po dodaniu lub zmianie zadań uruchom komendę „Uruchom teraz (jak przy starcie Obsidiana)”. Wtyczka zapyta, od kiedy zmiana ma obowiązywać, i dopisze ją do dni, które są już w planie.',
    ],
    yearly: [
      'Zadania wpisz jako - [ ] pod nazwą miesiąca. Z datą DD.MM trafią na ten dzień, bez daty do bloku BEZ DATY tego miesiąca:',
      '',
      '## MARZEC',
      '- [ ] 15.03 Przegląd samochodu',
      '- [ ] Zaplanuj wakacje',
      '',
      'Odhaczenie zadania w planie odhacza je także tutaj. W nowym roku wtyczka odznacza wszystkie.',
      'Po dodaniu nowych zadań uruchom komendę „Uruchom teraz (jak przy starcie Obsidiana)”. Wtyczka dopisze je do miesięcy, które są już w planie.',
    ],
    holidays: [
      'Jeden wpis w linii: data i opis. Wpis pojawi się w planie w tym dniu:',
      '',
      '24.12 Wigilia #wolne',
      '11.07.2027 Wesele Ani',
      '01.08-14.08 Urlop #wolne',
      'WIELKANOC+60 Boże Ciało #wolne',
      '- [ ] 20.12 Kup prezenty',
      '',
      'DD.MM to data co roku, DD.MM.RRRR tylko w tym roku, DD.MM-DD.MM zakres dni.',
      'WIELKANOC i ADWENT (pierwsza niedziela Adwentu) można przesunąć o dni, np. WIELKANOC+60 albo ADWENT-1.',
      'Tag #wolne oznacza dzień wolny: nagłówek dnia w planie dostaje „- WOLNE”, a linie z tagiem {work} są wtedy pomijane.',
      'Wpis zaczynający się od - [ ] jest zadaniem do odhaczenia, pozostałe są informacją.',
      'Po dodaniu nowych wpisów uruchom komendę „Uruchom teraz (jak przy starcie Obsidiana)”. Wtyczka dopisze je do miesięcy, które są już w planie.',
    ],
  },
  en: {
    head: 'EXAMPLE. This is only an example, delete it whenever you like (with the --- line above it).',
    weekly: [
      'Write tasks under a weekday heading, one per line. The plugin adds them to every such day in the plan:',
      '',
      '## MONDAY',
      'laundry',
      'work {work}',
      '',
      'Lines with the {work} tag are skipped on days off (change the tag in the settings).',
      'After adding or changing tasks, run the command "Run now (as on Obsidian start-up)". The plugin asks from when the change applies and adds it to the days already in the plan.',
    ],
    monthly: [
      'One task per line: - [ ], the day of the month and the text. The task appears in the plan on that day of every month:',
      '',
      '- [ ] 10 Pay the rent',
      '- [ ] 28 Pay the phone bill',
      '',
      'Day 31 goes to the last day of a shorter month.',
      'Ticking a task in the plan ticks it here too. At the start of a new month the plugin unticks them all.',
      'After adding or changing tasks, run the command "Run now (as on Obsidian start-up)". The plugin asks from when the change applies and adds it to the days already in the plan.',
    ],
    yearly: [
      'Write tasks as - [ ] under a month name. With a DD.MM date they go to that day, without one to that month\'s NO DATE block:',
      '',
      '## MARCH',
      '- [ ] 15.03 Car inspection',
      '- [ ] Plan the holidays',
      '',
      'Ticking a task in the plan ticks it here too. In a new year the plugin unticks them all.',
      'After adding new tasks, run the command "Run now (as on Obsidian start-up)". The plugin adds them to the months already in the plan.',
    ],
    holidays: [
      'One entry per line: a date and a description. The entry appears in the plan on that day:',
      '',
      '25.12 Christmas Day #dayoff',
      '11.07.2027 Anna\'s wedding',
      '01.08-14.08 Holiday leave #dayoff',
      'EASTER-2 Good Friday #dayoff',
      '- [ ] 20.12 Buy presents',
      '',
      'DD.MM is a date every year, DD.MM.YYYY only that year, DD.MM-DD.MM a range of days.',
      'EASTER and ADVENT (the first Sunday of Advent) can be shifted by days, e.g. EASTER+60 or ADVENT-1.',
      'The #dayoff tag marks a day off: its heading in the plan gets "- DAY OFF" and lines with the {work} tag are skipped.',
      'An entry starting with - [ ] is a task to tick off, the others are information.',
      'After adding new entries, run the command "Run now (as on Obsidian start-up)". The plugin adds them to the months already in the plan.',
    ],
  },
};

// Text of a new routine file: empty headings to write into (weekdays from
// Monday, months), then a rule and the commented-out example. Files without
// headings start with an empty line: "---" on line 1 would open frontmatter.
function routineTemplate(kind, lang, workTag) {
  const l = langOf(lang);
  const ex = ROUTINE_EXAMPLES[lang] || ROUTINE_EXAMPLES[DEFAULT_LANG];
  const work = workTag || '#praca';
  let body;
  if (kind === 'weekly') body = [1, 2, 3, 4, 5, 6, 0].flatMap((i) => [`## ${l.weekdays[i]}`, '']);
  else if (kind === 'yearly') body = l.months.flatMap((m) => [`## ${m}`, '']);
  else body = [''];
  const example = [ex.head, '', ...ex[kind]].map((line) => line.replace(/\{work\}/g, work));
  return [...body, '', '---', '%%', ...example, '%%', ''].join('\n');
}

// "<folder of the daily note>/RUTYNY/RUTYNA TYGODNIOWA.md" (ROUTINES/... in English).
function routineFilePath(kind, lang, dailyPath) {
  const l = langOf(lang);
  const i = (dailyPath || '').lastIndexOf('/');
  const dir = i >= 0 ? `${dailyPath.slice(0, i)}/` : '';
  return `${dir}${l.routineFolder}/${l.routineFiles[kind]}.md`;
}

// A name for a new note typed by the user -> "Name.md", or null when it can
// not be a file name (empty, a folder separator or a character Obsidian
// does not allow in links).
function noteFileName(name) {
  const n = String(name || '').trim().replace(/\.md$/i, '').trim();
  if (!n || /[\\/:*?"<>|#^[\]]/.test(n) || n.startsWith('.')) return null;
  return `${n}.md`;
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
  LANGS, ACTIONS, labelText,
  UI, UI_LANG_SETTINGS, resolveUiLang, uiText, uiMonth, uiWeekday, uiDayHead,
  CHEAT_COMMANDS, CHEAT_BLOCK, formatHotkey, cheatEntries, cheatSheetBlock, noteFileName,
  ROUTINE_KINDS, routineTemplate, routineFilePath, maskComments,
  pad2, monthKey, addDays, toIso, parseIso, resolveYear,
  parseWeekly, parseMonthly, parseYearly, parseHolidays, parseSources,
  easterOf, adventOf, tradingSundays, computeCalendar, migrateFilledHolidays, stripWorkOnDaysOff, setLineChecked, uncheckAll,
  parseDaily, serializeDaily, parseRoutineLine, routinePresence,
  newState, snapshotMarks, restoreMarks, generateMonth, generateYearlyRest, fillNewEntries, migrateFilledYearly, addYearSkeleton, addToBacklog, takeLinesForBacklog, backlogDefaultPath, yearMonths, monthHeaderInfo, forgetMonthIfAbsent,
  collectReview, reviewNeeded, applyReview, moveLinesToNextMonth,
  weeklySnapshot, monthlySnapshot, weekStart, weekAhead, weekSignature, shouldShowWeekAlert, routinesChanged, applyWeeklyChange, applyMonthlyChange,
  checkboxStates, diffStates, applySyncMonthly, applySyncYearly,
  cleanSetting,
};

// ---------------------------------------------------------------------------
// Obsidian plugin
// ---------------------------------------------------------------------------

if (obsidian) {
  const { Plugin, PluginSettingTab, Setting, Modal, SuggestModal, MarkdownRenderChild, Notice, TFile, normalizePath } = obsidian;
  const isMac = () => !!(obsidian.Platform && obsidian.Platform.isMacOS);

  // Note language for a fresh install: Polish when Obsidian runs in Polish
  // (getLanguage exists since 1.8.7), English otherwise.
  const appLanguage = () => (typeof obsidian.getLanguage === 'function' ? obsidian.getLanguage() : 'en');

  // A fresh install has no files set: the setup dialog asks for the daily
  // plan note, routine files are optional. Months are filled in on request
  // until the user turns on automatic filling.
  const DEFAULT_SETTINGS = {
    uiLanguage: 'auto',
    noteLanguage: 'en',
    dailyPath: '',
    weeklyPath: '',
    monthlyPath: '',
    yearlyPath: '',
    holidaysPath: '',
    backlogPath: '',
    tradingSundays: true,
    workTag: '#praca',
    autoGenerate: false,
    autoReview: true,
    weekAlert: true,
    spreadDays: 7,
  };
  const MAX_BACKUPS = 20;
  const DEFAULT_DAILY = 'TODO DAILY';
  const PATH_KEYS = ['dailyPath', 'weeklyPath', 'monthlyPath', 'yearlyPath', 'holidaysPath', 'backlogPath'];

  const todayNow = () => fromDate(new Date());
  const notify = (msg) => new Notice(`Plain Planner: ${msg}`);

  class PlainPlannerPlugin extends Plugin {
    // Interface language and text lookup.
    ui() {
      return resolveUiLang(this.settings.uiLanguage, appLanguage());
    }
    t(key, vars) {
      return uiText(this.ui(), key, vars);
    }
    say(key, vars) {
      notify(this.t(key, vars));
    }
    // Note keywords shown inside interface texts ("BEZ DATY", "WOLNE", ...).
    noteWords() {
      const l = langOf(this.settings.noteLanguage);
      return { undated: l.undated, dayOff: l.labels.WOLNE, shopping: l.labels.HANDLOWA };
    }
    dailyName() {
      const f = this.file(this.settings.dailyPath);
      return f ? f.basename : this.settings.dailyPath.replace(/\.md$/, '');
    }

    async onload() {
      await this.loadState();
      this.cache = new Map();
      this.lastRunDay = null;
      this.busy = false;
      this.undoOpen = null;

      this.addSettingTab(new PlainPlannerSettingTab(this.app, this));
      this.registerCommands();
      // Same action in the right-click / long-press menu of the editor.
      this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
        if (!this.isDailyView(view)) return;
        menu.addItem((item) => item
          .setTitle(this.t('cmdMoveNextMonth', this.noteWords()))
          .setIcon('calendar-plus')
          .onClick(() => this.moveSelectionToNextMonth(editor)));
        menu.addItem((item) => item
          .setTitle(this.t('cmdMoveBacklog', { year: todayNow().y + 1 }))
          .setIcon('archive')
          .onClick(() => this.moveSelectionToBacklog(editor)));
      }));
      this.cheats = new Set();
      this.cheatOpen = false;
      this.registerMarkdownCodeBlockProcessor(CHEAT_BLOCK, (_src, el, ctx) => ctx.addChild(new CheatSheet(el, this)));
      // Files renamed or moved inside Obsidian: follow them.
      this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)));

      this.app.workspace.onLayoutReady(async () => {
        await this.refreshCache();
        this.registerEvent(this.app.vault.on('modify', (f) => this.onModify(f)));
        if (!this.dailyFile()) this.openSetup(true);
        else await this.withUndo(this.t('undoStartup'), () => this.dailyRun(true));
      });
      // Obsidian has no event for hotkey changes; it saves them to
      // hotkeys.json, so watch that file's modification time.
      this.registerInterval(window.setInterval(() => this.checkHotkeys(), 3000));
      // Obsidian left open overnight: run again once the date changes.
      this.registerInterval(window.setInterval(() => {
        if (toIso(todayNow()) === this.lastRunDay) return;
        // New year: the backlog command names the next year.
        if (this.lastRunDay && +this.lastRunDay.slice(0, 4) !== todayNow().y) {
          this.registerCommands();
          this.refreshCheatSheet();
        }
        this.withUndo(this.t('undoNewDay'), () => this.dailyRun(true));
      }, 10 * 60 * 1000));
    }

    // Called again when the interface language changes: a command added
    // with an id already in use replaces the old one, so the palette shows
    // the new names at once.
    registerCommands() {
      const t = (key) => this.t(key, this.noteWords());
      this.addCommand({
        id: 'generate-month',
        name: t('cmdGenerateMonth'),
        callback: () => new MonthPickModal(this.app, this).open(),
      });
      this.addCommand({
        id: 'yearly-rest',
        name: t('cmdYearlyRest'),
        callback: () => this.askYearlyRest(),
      });
      this.addCommand({
        id: 'review',
        name: t('cmdReview'),
        callback: () => this.openReview(true),
      });
      this.addCommand({
        id: 'move-next-month',
        name: t('cmdMoveNextMonth'),
        editorCheckCallback: (checking, editor, view) => {
          if (!this.isDailyView(view)) return false;
          if (!checking) this.moveSelectionToNextMonth(editor);
          return true;
        },
      });
      this.addCommand({
        id: 'move-to-backlog',
        name: this.t('cmdMoveBacklog', { year: todayNow().y + 1 }),
        editorCheckCallback: (checking, editor, view) => {
          if (!this.isDailyView(view)) return false;
          if (!checking) this.moveSelectionToBacklog(editor);
          return true;
        },
      });
      this.addCommand({
        id: 'week-alert',
        name: t('cmdWeekAlert'),
        callback: () => this.showWeekAlert(todayNow(), true),
      });
      this.addCommand({
        id: 'run-now',
        name: t('cmdRunNow'),
        callback: async () => {
          await this.withUndo(this.t('undoRunNow'), () => this.dailyRun(false));
          await this.openReview(true);
        },
      });
      this.addCommand({
        id: 'undo-last',
        name: t('cmdUndoLast'),
        callback: () => this.undoLast(),
      });
      this.addCommand({
        id: 'forget-filled',
        name: t('cmdForget'),
        callback: async () => {
          this.state.filledDays = new Set();
          this.state.filledYearly = new Set();
          this.state.placedYearly = new Set();
          this.state.placedHolidays = new Set();
          this.state.labeledDays = new Set();
          this.state.strippedDays = new Set();
          await this.saveState();
          this.say('forgotDays');
        },
      });
      this.addCommand({
        id: 'setup',
        name: t('cmdSetup'),
        callback: () => this.openSetup(false),
      });
      this.addCommand({
        id: 'create-routine',
        name: t('cmdCreateRoutine'),
        callback: () => this.pickRoutine(),
      });
    }

    // --- new routine ----------------------------------------------------------

    // Routines whose setting does not point to an existing file.
    missingRoutines() {
      return ROUTINE_KINDS.filter((k) => !this.file(this.settings[ROUTINE_SETTING[k]]));
    }

    pickRoutine() {
      const kinds = this.missingRoutines();
      if (!kinds.length) return this.say('routineAllSet');
      new RoutinePickModal(this, kinds).open();
    }

    // Creates the routine file in the RUTYNY / ROUTINES folder next to the
    // daily note (or takes the file already there), sets it in the settings
    // and opens it.
    async createRoutine(kind) {
      const vault = this.app.vault;
      const path = normalizePath(routineFilePath(kind, this.settings.noteLanguage, this.settings.dailyPath));
      const existed = !!this.file(path);
      if (!existed) {
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        await vault.create(path, routineTemplate(kind, this.settings.noteLanguage, this.settings.workTag));
      }
      this.settings[ROUTINE_SETTING[kind]] = path;
      await this.saveState();
      this.app.workspace.openLinkText(path, '', false);
      const file = path.replace(/\.md$/, '');
      this.say(existed ? 'routineLinked' : 'routineCreated', { file });
    }

    // --- setup --------------------------------------------------------------

    dailyFile() {
      return this.file(this.settings.dailyPath);
    }

    // Asks for the daily plan note (and the language). `atStart`: run the
    // start-up work once a note is chosen.
    openSetup(atStart) {
      if (this.setupOpen) return;
      this.setupOpen = true;
      const missing = this.settings.dailyPath && !this.dailyFile() ? this.settings.dailyPath : null;
      new SetupModal(this, missing, async (path, lang) => {
        this.setupOpen = false;
        if (!path) return;
        this.settings.uiLanguage = lang;
        this.settings.noteLanguage = lang;
        await this.app.vault.create(path, cheatSheetBlock(lang));
        this.settings.dailyPath = path;
        await this.saveState();
        this.registerCommands();
        await this.refreshCache();
        this.app.workspace.openLinkText(path, '', false);
        this.say('setupDone', { file: this.dailyName(), cmd: this.t('cmdGenerateMonth') });
        if (atStart) await this.withUndo(this.t('undoStartup'), () => this.dailyRun(true));
      }).open();
    }

    // --- cheat sheet -----------------------------------------------------------

    hotkeysPath() {
      return normalizePath(`${this.app.vault.configDir}/hotkeys.json`);
    }

    async readHotkeys() {
      const adapter = this.app.vault.adapter;
      try {
        if (!(await adapter.exists(this.hotkeysPath()))) return {};
        return JSON.parse(await adapter.read(this.hotkeysPath())) || {};
      } catch (_e) {
        return {};
      }
    }

    async checkHotkeys() {
      let mtime = 0;
      try {
        const st = await this.app.vault.adapter.stat(this.hotkeysPath());
        mtime = st ? st.mtime : 0;
      } catch (_e) {
        mtime = 0;
      }
      if (this.hotkeysMtime === undefined) this.hotkeysMtime = mtime;
      if (mtime === this.hotkeysMtime) return;
      this.hotkeysMtime = mtime;
      await this.refreshCheatSheet();
    }

    // Redraws every cheat sheet on screen (hotkeys or language changed).
    async refreshCheatSheet() {
      if (!this.cheats || !this.cheats.size) return;
      const hotkeys = await this.readHotkeys();
      for (const c of this.cheats) c.render(hotkeys);
    }

    async onRename(f, oldPath) {
      let changed = false;
      // A backlog with no path of its own sits next to the daily note. Pin
      // it down before anything moves, so renaming the backlog or moving the
      // daily note keeps writing to the same file instead of a new one.
      if (!this.settings.backlogPath) {
        const own = this.backlogPath();
        if (oldPath === own) {
          this.settings.backlogPath = f.path;
          changed = true;
        } else if (this.settings.dailyPath && normalizePath(this.settings.dailyPath) === oldPath && this.file(own)) {
          this.settings.backlogPath = own;
          changed = true;
        }
      }
      for (const k of PATH_KEYS) {
        if (this.settings[k] && normalizePath(this.settings[k]) === oldPath) {
          this.settings[k] = f.path;
          changed = true;
        }
      }
      if (changed) await this.saveState();
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
        placedYearly: new Set(raw.placedYearly || []),
        // Before 0.15 yearly items had a per-month gate.
        legacyYearlyMonths: raw.placedYearly ? [] : raw.filledYearly || [],
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
      // R|YYYY|MM|text: keep this year and later (the review looks back over it).
      const year = String(todayNow().y);
      this.state.placedYearly = new Set([...this.state.placedYearly].filter((k) => k.split('|')[1] >= year));
      const filledDays = [...this.state.filledDays];
      await this.saveData({
        settings: this.settings,
        filledDays,
        filledYearly: [...this.state.filledYearly].sort(),
        placedHolidays: [...this.state.placedHolidays],
        labeledDays: [...this.state.labeledDays],
        strippedDays: [...this.state.strippedDays],
        skippedYearly: [...this.state.skippedYearly],
        placedYearly: [...this.state.placedYearly].sort(),
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
      if (!path) return null;
      const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
      return f instanceof TFile ? f : null;
    }

    async readSources() {
      // Routine files are optional; one that is set but missing is reported
      // once per session (a start-up run reads them several times).
      if (!this.warned) this.warned = new Set();
      const read = async (p) => {
        if (!p) return '';
        const f = this.file(p);
        if (!f) {
          if (!this.warned.has(p)) this.say('fileNotFound', { path: p });
          this.warned.add(p);
          return '';
        }
        return this.app.vault.read(f);
      };
      const src = parseSources(
        await read(this.settings.weeklyPath),
        await read(this.settings.monthlyPath),
        await read(this.settings.yearlyPath),
        await read(this.settings.holidaysPath),
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
      const f = this.dailyFile();
      if (!f) {
        this.openSetup(false);
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
      this.say('writeConflict');
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
        this.say('nothingToUndo');
        return;
      }
      const f = this.dailyFile();
      if (!f) {
        this.openSetup(false);
        return;
      }
      const current = await this.app.vault.read(f);
      const ok = await new Promise((resolve) => new UndoConfirmModal(this, u, current !== u.after, resolve).open());
      if (!ok) return;
      await this.backup(current);
      await this.app.vault.process(f, () => u.before);
      restoreMarks(this.state, u.marks);
      this.state.undo = null;
      await this.saveState();
      this.say('undone', { label: u.label });
    }

    // --- daily run ----------------------------------------------------------

    async dailyRun(showReview) {
      if (this.busy || !this.dailyFile()) return;
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
        if (this.state.legacyYearlyMonths.length) {
          migrateFilledYearly(await this.readSources(), this.state.legacyYearlyMonths, this.state);
          this.state.legacyYearlyMonths = [];
          await this.saveState();
        }
        await this.resetIfNeeded(today);
        await this.checkRoutineChanges(today);
        await this.addNewEntries();
        if (this.settings.autoGenerate) {
          await this.runGenerate(today.y, today.m, false);
          await this.runYearlyRest(false);
        }
      } finally {
        this.busy = false;
      }
      if (showReview && this.settings.autoReview) await this.openReview(false);
    }

    // New yearly routine items and holidays go to months already in the plan.
    async addNewEntries() {
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        const n = fillNewEntries(model, src, today, this.state);
        return { n, changed: n > 0 };
      });
      await this.saveState();
      if (res && res.changed) this.say('newEntriesAdded', { n: res.n });
    }

    // New month: untick the monthly routine. New year: untick the yearly one.
    // Holidays, days off and shopping Sundays from today to Sunday. Shown at
    // start-up before anything else; "OK" silences it for the rest of the week
    // (until the entries change), "Remind me tomorrow" until tomorrow.
    async showWeekAlert(today, force) {
      const src = await this.readSources();
      const days = weekAhead(src, today);
      if (!days.length) {
        if (force) this.say('noHolidaysThisWeek');
        return;
      }
      if (!force && !shouldShowWeekAlert(days, this.state.weekAlert, today)) return;
      const choice = await new Promise((resolve) => new WeekAlertModal(this, days, today, resolve).open());
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
        const choice = await new Promise((resolve) => new RoutineChangeModal(this, ch, resolve).open());
        if (choice === 'today' || choice === 'tomorrow') {
          const start = choice === 'today' ? today : addDays(today, 1);
          const res = await this.editDaily((model) => {
            let n = 0;
            if (ch.weekly) n += applyWeeklyChange(model, src, snapW, this.state, start);
            if (ch.monthly) n += applyMonthlyChange(model, src, snapM, this.state, start, today);
            return { n, changed: n > 0 };
          });
          if (res) this.say('routineChangesApplied', { n: res.n });
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
        this.say('newMonthUnchecked');
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
        this.say('newYearUnchecked');
      }
      if (changed) await this.saveState();
    }

    async runGenerate(y, m, verbose) {
      return this.withUndo(this.t('undoGenerateMonth', { month: uiMonth(this.ui(), m) }), () => this.doGenerate(y, m, verbose));
    }

    async doGenerate(y, m, verbose) {
      // A routine edited since it was last checked is dealt with first, so
      // the remembered routine matches what the new days are filled from.
      await this.checkRoutineChanges(todayNow());
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        if (verbose) forgetMonthIfAbsent(model, y, m, this.state);
        const r = generateMonth(model, src, y, m, today, this.state);
        return Object.assign(r, { changed: r.added > 0 || r.days > 0 });
      });
      await this.saveState();
      if (!res) return;
      const month = uiMonth(this.ui(), m);
      if (res.changed) this.say('monthFilled', { month, days: res.days, added: res.added });
      else if (verbose) this.say('monthAlreadyFilled', { month });
    }

    // In December there is nothing left of this year, so the command offers
    // the whole next year, after asking.
    askYearlyRest() {
      const today = todayNow();
      if (today.m !== 12) return this.runYearlyRest(true);
      new ConfirmModal(this.app, {
        title: this.t('yearNextTitle', { year: today.y + 1 }),
        text: this.t('yearNextText', { year: today.y + 1 }),
        ok: this.t('yearNextOk', { year: today.y + 1 }),
        cancel: this.t('cancel'),
        onOk: () => this.runYearlyRest(true, true),
      }).open();
    }

    async runYearlyRest(verbose, nextYear) {
      return this.withUndo(this.t('undoYearlyRest'), () => this.doYearlyRest(verbose, nextYear));
    }

    async doYearlyRest(verbose, nextYear) {
      await this.checkRoutineChanges(todayNow());
      const src = await this.readSources();
      const res = await this.editDaily((model, today) => {
        const added = generateYearlyRest(model, src, today, this.state, nextYear);
        // Only the command adds empty months, so the automatic run does not
        // bring back months the user deleted.
        const before = serializeDaily(model);
        const months = verbose ? addYearSkeleton(model, today, nextYear) : 0;
        const skeleton = serializeDaily(model) !== before;
        const noThisMonth = !getSection(model, today.y, today.m, false);
        return { added, months, noThisMonth, changed: added > 0 || skeleton };
      });
      await this.saveState();
      if (!res) return;
      if (res.changed && verbose) this.say('yearMonthsAdded', { months: res.months, n: res.added });
      else if (res.changed) this.say('yearlyAdded', { n: res.added });
      else if (verbose) this.say('yearlyAlreadyFilled');
      // The year leaves the current month alone: point to the command for it.
      if (verbose && res.noThisMonth) this.say('yearHintMonth', { month: uiMonth(this.ui(), todayNow().m) });
    }

    // --- review -------------------------------------------------------------

    async openReview(verbose) {
      const f = this.file(this.settings.dailyPath);
      if (!f) return;
      const src = await this.readSources();
      const today = todayNow();
      const review = collectReview(parseDaily(await this.app.vault.read(f), today, this.settings.noteLanguage), src, today, this.state);
      if (!reviewNeeded(review)) {
        if (verbose) this.say('noOverdue');
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
        this.say('selectTaskLine');
        return;
      }
      await this.backup(before);
      editor.setValue(res.text);
      editor.setCursor({ line: Math.min(from, editor.lineCount() - 1), ch: 0 });
      this.say('movedToNextMonth', {
        n: res.count, month: uiMonth(this.ui(), res.target.m), year: res.target.y, undated: this.noteWords().undated,
      });
    }

    backlogPath() {
      return normalizePath(this.settings.backlogPath || backlogDefaultPath(this.settings.dailyPath));
    }

    // Lines with the cursor or selection go to "# <next year>" of the backlog
    // note (created on first use). The backlog is written first, so a failed
    // write leaves TODO DAILY as it was.
    async moveSelectionToBacklog(editor) {
      const from = editor.getCursor('from').line;
      const to = editor.getCursor('to').line;
      const before = editor.getValue();
      const res = takeLinesForBacklog(before, from, to);
      if (!res) {
        this.say('selectTaskLine');
        return;
      }
      const year = todayNow().y + 1;
      const path = this.backlogPath();
      const f = this.file(path);
      if (f) await this.app.vault.process(f, (text) => addToBacklog(text, year, res.moved));
      else await this.app.vault.create(path, addToBacklog('', year, res.moved));
      await this.backup(before);
      editor.setValue(res.text);
      editor.setCursor({ line: Math.min(from, editor.lineCount() - 1), ch: 0 });
      this.say('movedToBacklog', { n: res.moved.length, file: path.replace(/\.md$/, ''), year });
    }

    async applyReviewDecisions(decisions) {
      return this.withUndo(this.t('undoReview'), () => this.doApplyReview(decisions));
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
      this.say('reviewApplied', { moved: res.moved, deleted: res.deleted, closed: res.removedBlocks });
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

  const LABEL_KEY = { WOLNE: 'labelDayOff', HANDLOWA: 'labelShoppingSunday' };

  // The ```plain-planner``` block: a collapsible list drawn by the plugin.
  // Being a rendered block, clicking it does not switch the editor to the
  // block's source, unlike a callout in live preview.
  class CheatSheet extends MarkdownRenderChild {
    constructor(el, plugin) {
      super(el);
      this.plugin = plugin;
    }
    async onload() {
      this.plugin.cheats.add(this);
      this.render(await this.plugin.readHotkeys());
    }
    onunload() {
      this.plugin.cheats.delete(this);
    }
    render(hotkeys) {
      const plugin = this.plugin;
      const lang = plugin.ui();
      const el = this.containerEl;
      el.empty();
      const det = el.createEl('details', { cls: 'plain-planner-cheat' });
      det.open = plugin.cheatOpen;
      det.addEventListener('toggle', () => {
        plugin.cheatOpen = det.open;
      });
      det.createEl('summary', { text: `Plain Planner – ${uiText(lang, 'cheatTitle')}` });
      // Two columns, no header row: command | hotkeys.
      const body = det.createEl('table').createEl('tbody');
      for (const row of cheatEntries(lang, plugin.settings.noteLanguage, hotkeys, isMac(), todayNow().y + 1)) {
        const tr = body.createEl('tr');
        tr.createEl('td', { cls: 'plain-planner-cheat-label', text: row.label });
        const keys = tr.createEl('td', { cls: 'plain-planner-cheat-keys' });
        if (!row.combos.length) keys.createSpan({ cls: 'plain-planner-cheat-none', text: uiText(lang, 'cheatNone') });
        row.combos.forEach((combo, i) => {
          if (i) keys.appendText(' / ');
          combo.forEach((k, j) => {
            if (j) keys.appendText(' + ');
            keys.createEl('kbd', { text: k });
          });
        });
        if (row.after) keys.appendText(`, ${row.after}`);
      }
      det.createEl('p', { text: uiText(lang, 'cheatHint') });
      det.createEl('p', { text: uiText(lang, 'cheatNote') });
    }
  }

  // First run (or the daily note is gone): language + name of the new daily
  // plan note. `done(path, lang)`; path is null when closed without creating.
  class SetupModal extends Modal {
    constructor(plugin, missingPath, done) {
      super(plugin.app);
      this.plugin = plugin;
      this.missingPath = missingPath;
      this.done = done;
      this.result = null;
      this.name = DEFAULT_DAILY;
      // English unless this vault already uses another language.
      this.lang = plugin.settings.dailyPath && UI[plugin.settings.noteLanguage] ? plugin.settings.noteLanguage : 'en';
    }
    onOpen() {
      this.render();
    }
    render() {
      const { contentEl } = this;
      const t = (key, vars) => uiText(this.lang, key, vars);
      contentEl.empty();
      contentEl.addClass('plain-planner-setup');
      contentEl.createEl('h2', { text: t('setupTitle') });

      const langRow = contentEl.createDiv({ cls: 'plain-planner-setup-row' });
      langRow.createEl('strong', { text: t('setupLanguage') });
      const sel = langRow.createEl('select', { cls: 'dropdown' });
      for (const [value, label] of [['en', 'English'], ['pl', 'Polski']]) sel.createEl('option', { value, text: label });
      sel.value = this.lang;
      sel.addEventListener('change', () => {
        this.lang = sel.value;
        this.render();
      });
      contentEl.createEl('p', { cls: 'plain-planner-note', text: t('setupLanguageDesc') });

      contentEl.createEl('p', { text: t('setupIntro') });
      if (this.missingPath) contentEl.createEl('p', { cls: 'plain-planner-warn', text: t('setupMissing', { path: this.missingPath }) });

      const nameRow = contentEl.createDiv({ cls: 'plain-planner-setup-row' });
      nameRow.createEl('strong', { text: t('setupName') });
      const input = nameRow.createEl('input', { type: 'text', cls: 'plain-planner-setup-name' });
      input.value = this.name;
      nameRow.createSpan({ cls: 'plain-planner-note', text: '.md' });
      const error = contentEl.createEl('p', { cls: 'plain-planner-warn' });

      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      const create = buttons.createEl('button', { text: t('setupCreateBtn'), cls: 'mod-cta' });
      const check = () => {
        this.name = input.value;
        const file = noteFileName(input.value);
        let msg = '';
        if (!file) msg = t('setupBadName');
        else if (this.app.vault.getAbstractFileByPath(file)) msg = t('setupExists', { file: file.replace(/\.md$/, '') });
        error.setText(msg);
        error.toggle(!!msg);
        create.disabled = !!msg;
        return msg ? null : file;
      };
      input.addEventListener('input', check);
      const submit = () => {
        const file = check();
        if (!file) return;
        this.result = file;
        this.close();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      create.addEventListener('click', submit);
      check();
      input.focus();
    }
    onClose() {
      this.contentEl.empty();
      this.done(this.result, this.lang);
    }
  }

  class WeekAlertModal extends Modal {
    constructor(plugin, days, today, resolve) {
      super(plugin.app);
      this.plugin = plugin;
      this.days = days;
      this.today = today;
      this.resolve = resolve;
      this.choice = null;
    }
    onOpen() {
      const { contentEl } = this;
      contentEl.addClass('plain-planner-week');
      const t = (key, vars) => this.plugin.t(key, vars);
      const lang = this.plugin.ui();
      contentEl.createEl('h3', { text: t('weekTitle') });
      const list = contentEl.createEl('ul', { cls: 'plain-planner-week-list' });
      const todayIso = toIso(this.today);
      const tomorrowIso = toIso(addDays(this.today, 1));
      for (const d of this.days) {
        const li = list.createEl('li');
        const when = d.iso === todayIso ? 'today' : d.iso === tomorrowIso ? 'tomorrow' : null;
        li.createEl('strong', { text: uiDayHead(lang, d.t, when) });
        const parts = d.events.map((e) => (e.task ? t('toDo', { text: e.text }) : e.text));
        for (const l of d.label.split(' - ').filter(Boolean)) parts.push(LABEL_KEY[l] ? t(LABEL_KEY[l]) : l.toLowerCase());
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
      add(t('remindTomorrow'), 'tomorrow');
      add(t('ok'), 'ok', true);
    }
    onClose() {
      this.contentEl.empty();
      this.resolve(this.choice);
    }
  }

  class UndoConfirmModal extends Modal {
    constructor(plugin, undo, editedSince, resolve) {
      super(plugin.app);
      this.plugin = plugin;
      this.undo = undo;
      this.editedSince = editedSince;
      this.resolve = resolve;
      this.ok = false;
    }
    onOpen() {
      const { contentEl } = this;
      const t = (key, vars) => this.plugin.t(key, vars);
      const at = new Date(this.undo.at);
      const when = t('dateTime', {
        dd: pad2(at.getDate()), mm: pad2(at.getMonth() + 1), d: at.getDate(),
        mon: uiMonth(this.plugin.ui(), at.getMonth() + 1).slice(0, 3),
        hh: pad2(at.getHours()), min: pad2(at.getMinutes()),
      });
      const file = this.plugin.dailyName();
      contentEl.createEl('h3', { text: t('undoTitle') });
      contentEl.createEl('p', { text: t('undoBody', { label: this.undo.label, when, file }) });
      if (this.editedSince) {
        contentEl.createEl('p', { cls: 'plain-planner-warn', text: t('undoWarning', { file }) });
      }
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      buttons.createEl('button', { text: t('cancel') }).addEventListener('click', () => this.close());
      const ok = buttons.createEl('button', { text: t('undo'), cls: this.editedSince ? 'mod-warning' : 'mod-cta' });
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

  // Yes / no question; onOk runs after the window closes.
  class ConfirmModal extends Modal {
    constructor(app, opts) {
      super(app);
      this.opts = opts;
    }
    onOpen() {
      const { contentEl } = this;
      contentEl.createEl('h3', { text: this.opts.title });
      contentEl.createEl('p', { text: this.opts.text });
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      buttons.createEl('button', { text: this.opts.cancel }).addEventListener('click', () => this.close());
      buttons.createEl('button', { text: this.opts.ok, cls: 'mod-cta' }).addEventListener('click', () => {
        this.close();
        this.opts.onOk();
      });
    }
    onClose() {
      this.contentEl.empty();
    }
  }

  class RoutineChangeModal extends Modal {
    constructor(plugin, changes, resolve) {
      super(plugin.app);
      this.plugin = plugin;
      this.changes = changes;
      this.resolve = resolve;
      this.choice = 'no';
    }
    onOpen() {
      const { contentEl } = this;
      const t = (key) => this.plugin.t(key);
      const { weekly, monthly } = this.changes;
      contentEl.createEl('h3', { text: t(weekly && monthly ? 'routineChangedBoth' : weekly ? 'routineChangedWeekly' : 'routineChangedMonthly') });
      contentEl.createEl('p', { text: t('routineChangeBody') });
      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      const add = (text, choice, cta) => {
        const b = buttons.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
        b.addEventListener('click', () => {
          this.choice = choice;
          this.close();
        });
      };
      add(t('no'), 'no');
      add(t('fromTomorrow'), 'tomorrow');
      add(t('fromToday'), 'today', true);
    }
    onClose() {
      this.contentEl.empty();
      this.resolve(this.choice);
    }
  }

  class RoutinePickModal extends SuggestModal {
    constructor(plugin, kinds) {
      super(plugin.app);
      this.plugin = plugin;
      this.kinds = kinds;
      this.setPlaceholder(plugin.t('routinePickPlaceholder'));
    }
    label(kind) {
      return this.plugin.t(ROUTINE_LABEL[kind]);
    }
    getSuggestions(query) {
      const q = query.trim().toLowerCase();
      return this.kinds.filter((k) => this.label(k).toLowerCase().includes(q));
    }
    renderSuggestion(kind, el) {
      el.setText(this.label(kind));
    }
    onChooseSuggestion(kind) {
      this.plugin.createRoutine(kind);
    }
  }

  class MonthPickModal extends SuggestModal {
    constructor(app, plugin) {
      super(app);
      this.plugin = plugin;
      this.setPlaceholder(plugin.t('monthPickPlaceholder'));
    }
    getSuggestions(query) {
      const t = todayNow();
      const list = [];
      for (let i = 0; i < 13; i++) {
        const x = fromDate(new Date(t.y, t.m - 1 + i, 1));
        list.push({ y: x.y, m: x.m, label: `${capitalise(uiMonth(this.plugin.ui(), x.m))} ${x.y}` });
      }
      const q = query.trim().toLowerCase();
      return list.filter((it) => it.label.toLowerCase().includes(q));
    }
    renderSuggestion(it, el) {
      el.setText(it.label);
    }
    onChooseSuggestion(it) {
      this.plugin.runGenerate(it.y, it.m, true);
    }
  }

  const TYPE_KEY = { done: 'typeDone', routine: 'typeRoutine', holiday: 'typeHoliday', weekly: 'typeWeekly', own: 'typeOwn' };
  const ACTION_KEY = {
    today: 'actionToday', tomorrow: 'actionTomorrow', date: 'actionDate', spread: 'actionSpread',
    nextMonth: 'actionNextMonth', delete: 'actionDelete', keep: 'actionKeep', later: 'actionLater', skip: 'actionSkip',
  };

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

    t(key, vars) {
      return this.plugin.t(key, vars);
    }

    // Each bulk dropdown shows the action its rows share, or "— mixed —"
    // once they differ (a custom date counts as different).
    refreshBulks() {
      for (const b of this.bulks) {
        const values = new Set(this.controls.filter(b.pick).map((c) => c.get()));
        const [only] = values;
        const shared = values.size === 1 && [...b.sel.options].some((o) => o.value && o.value === only);
        b.placeholder.text = this.t(shared ? 'bulkSet' : 'bulkMixed');
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
      row.createSpan({ cls: `plain-planner-tag plain-planner-tag-${item.type || 'routine'}`, text: this.t(TYPE_KEY[item.type] || 'typeYearly') });
      row.createSpan({ cls: 'plain-planner-text', text: item.text });
      const controls = row.createDiv({ cls: 'plain-planner-controls' });
      if (item.type === 'done') {
        controls.createSpan({ cls: 'plain-planner-note', text: this.t('willBeDeleted') });
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
      const placeholder = sel.createEl('option', { value: '', text: this.t('bulkSet') });
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
      contentEl.createEl('h2', { text: this.t('reviewTitle') });
      const words = this.plugin.noteWords();
      const options = (keys) => keys.map((k) => [k, this.t(ACTION_KEY[k], words)]);
      const dayOptions = options(ACTIONS);
      const overdueOptions = options(['later', 'today', 'tomorrow', 'date', 'spread', 'nextMonth', 'skip']);

      const count = { own: 0, weekly: 0, routine: 0, holiday: 0, done: 0 };
      for (const b of this.review.blocks) for (const it of b.items) count[it.type]++;
      const parts = [this.t('sumDays', { n: this.review.blocks.length })];
      if (count.own) parts.push(this.t('sumOwn', { n: count.own }));
      if (count.routine) parts.push(this.t('sumRoutine', { n: count.routine }));
      if (count.weekly) parts.push(this.t('sumWeekly', { n: count.weekly }));
      if (count.holiday) parts.push(this.t('sumHoliday', { n: count.holiday }));
      if (count.done) parts.push(this.t('sumDone', { n: count.done }));
      if (this.review.overdue.length) parts.push(this.t('sumOverdue', { n: this.review.overdue.length }));
      contentEl.createEl('p', { cls: 'plain-planner-summary', text: parts.join(' · ') });

      const bulkBox = contentEl.createDiv({ cls: 'plain-planner-bulkbox' });
      const list = contentEl.createDiv({ cls: 'plain-planner-scroll' });

      if (count.own) this.bulk(bulkBox, this.t('bulkOwn'), dayOptions, (c) => c.type === 'own');
      if (count.routine) this.bulk(bulkBox, this.t('bulkRoutine'), dayOptions, (c) => c.type === 'routine');
      if (count.weekly) this.bulk(bulkBox, this.t('bulkWeekly'), dayOptions, (c) => c.type === 'weekly');
      if (this.review.overdue.length) this.bulk(bulkBox, this.t('bulkOverdue'), overdueOptions, (c) => c.type === 'overdue');

      for (const b of this.review.blocks) {
        const head = list.createDiv({ cls: 'plain-planner-dayhead' });
        head.createEl('h4', { text: b.label });
        if (!b.items.length) {
          list.createEl('p', { cls: 'plain-planner-note', text: this.t('emptyDay') });
          continue;
        }
        if (b.items.some((it) => it.type !== 'done')) {
          this.bulk(head, this.t('bulkDay'), dayOptions, (c) => c.blockId === b.id && c.type !== 'overdue');
        }
        const weekly = b.items.filter((it) => it.type === 'weekly');
        for (const it of b.items) if (it.type !== 'weekly') this.row(list, it, dayOptions, it.default, b.id);
        if (weekly.length) {
          const det = list.createEl('details', { cls: 'plain-planner-weekly' });
          const sum = det.createEl('summary');
          sum.createSpan({ text: this.t('weeklyGroup', { n: weekly.length }) });
          this.bulk(sum, '', dayOptions, (c) => c.blockId === b.id && c.type === 'weekly');
          for (const it of weekly) this.row(det, it, dayOptions, it.default, b.id);
        }
      }
      if (this.review.overdue.length) {
        list.createDiv({ cls: 'plain-planner-dayhead' }).createEl('h4', { text: this.t('overdueHeading') });
        for (const o of this.review.overdue) {
          this.row(list, { id: o.id, type: null, text: `${o.text} (${uiMonth(this.plugin.ui(), o.month)})` }, overdueOptions, 'later', 'overdue');
        }
      }
      this.refreshBulks();

      const buttons = contentEl.createDiv({ cls: 'plain-planner-buttons' });
      buttons.createEl('button', { text: this.t('later') }).addEventListener('click', () => this.close());
      const apply = buttons.createEl('button', { text: this.t('apply'), cls: 'mod-cta' });
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
  // Setting API on older versions. Built on demand, in the interface language.
  function settingGroups(plugin) {
    const words = plugin.noteWords();
    const t = (key) => plugin.t(key, Object.assign({ spread: plugin.t('actionSpread') }, words));
    return [
      {
        heading: t('headFiles'),
        items: [
          {
            key: 'uiLanguage', type: 'dropdown', name: t('setUiLanguage'), desc: t('setUiLanguageDesc'),
            options: { auto: t('optAuto'), pl: 'Polski', en: 'English' },
          },
          {
            key: 'noteLanguage', type: 'dropdown', name: t('setNoteLanguage'), desc: t('setNoteLanguageDesc'),
            options: { pl: 'Polski', en: 'English' },
          },
          { key: 'dailyPath', type: 'file', name: t('setDailyPath') },
          { key: 'weeklyPath', type: 'file', name: t('setWeeklyPath') },
          { key: 'monthlyPath', type: 'file', name: t('setMonthlyPath') },
          { key: 'yearlyPath', type: 'file', name: t('setYearlyPath') },
          { key: 'holidaysPath', type: 'file', name: t('setHolidaysPath') },
          { key: 'backlogPath', type: 'file', name: t('setBacklogPath'), desc: t('setBacklogPathDesc') },
        ],
      },
      {
        heading: t('headBehaviour'),
        items: [
          { key: 'workTag', type: 'text', name: t('setWorkTag'), desc: t('setWorkTagDesc'), placeholder: '#praca' },
          { key: 'tradingSundays', type: 'toggle', name: t('setTradingSundays'), desc: t('setTradingSundaysDesc') },
          { key: 'autoGenerate', type: 'toggle', name: t('setAutoGenerate'), desc: t('setAutoGenerateDesc') },
          { key: 'spreadDays', type: 'number', name: t('setSpreadDays'), desc: t('setSpreadDaysDesc'), min: 1, max: 31 },
          { key: 'weekAlert', type: 'toggle', name: t('setWeekAlert'), desc: t('setWeekAlertDesc') },
          { key: 'autoReview', type: 'toggle', name: t('setAutoReview'), desc: t('setAutoReviewDesc') },
        ],
      },
    ];
  }

  class PlainPlannerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    getSettingDefinitions() {
      return settingGroups(this.plugin).map((g) => ({
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
      const item = settingGroups(this.plugin).flatMap((g) => g.items).find((it) => it.key === key);
      if (!item) return;
      const v = cleanSetting(item, value);
      if (v === null) return;
      this.plugin.settings[key] = v;
      await this.plugin.saveState();
      if (key === 'uiLanguage' || key === 'noteLanguage') {
        this.plugin.registerCommands();
        await this.plugin.refreshCheatSheet();
      }
      return v;
    }

    // Fallback for Obsidian older than 1.13.
    display() {
      const { containerEl } = this;
      containerEl.empty();
      for (const g of settingGroups(this.plugin)) {
        new Setting(containerEl).setName(g.heading).setHeading();
        for (const it of g.items) {
          const s = new Setting(containerEl).setName(it.name);
          if (it.desc) s.setDesc(it.desc);
          const value = this.getControlValue(it.key);
          // Language changes redraw the tab so its texts follow at once.
          const save = async (v) => {
            const stored = await this.setControlValue(it.key, v);
            if (stored !== undefined && (it.key === 'uiLanguage' || it.key === 'noteLanguage')) this.display();
          };
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
