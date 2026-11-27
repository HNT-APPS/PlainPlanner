// Run: node --test tests/*.test.cjs  (loads main.js with a minimal stand-in for the `obsidian` module)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-planner-plugin-'));
const stubDir = path.join(tmp, 'node_modules', 'obsidian');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'index.js'), `
const notices = [];
class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Modal {}
class SuggestModal {}
class FuzzySuggestModal {}
class Setting {}
class MarkdownRenderChild { constructor(el) { this.containerEl = el; } }
class Notice { constructor(msg) { notices.push(msg); } }
class TFile { constructor(path) { this.path = path; this.basename = path.replace(/\\.md$/, ''); this.extension = 'md'; } }
const normalizePath = (p) => p;
const stub = { Plugin, PluginSettingTab, Modal, SuggestModal, FuzzySuggestModal, MarkdownRenderChild, Setting, Notice, TFile, normalizePath, notices };
stub.appLanguage = 'en';
stub.getLanguage = () => stub.appLanguage;
module.exports = stub;
`);
fs.copyFileSync(path.join(__dirname, '../main.js'), path.join(tmp, 'main.cjs'));
const PlainPlannerPlugin = require(path.join(tmp, 'main.cjs'));
const obsidianStub = require(stubDir);
const { TFile } = obsidianStub;
global.window = { setInterval: () => 0 };
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const lines = (t) => t.split('\n').filter(Boolean);

// In-memory vault; `interfere(text)` may return another text to simulate an
// edit that lands between the plugin's read and its write.
function makePlugin(files, saved = { settings: { dailyPath: 'TODO DAILY.md' } }) {
  const tfiles = new Map(Object.keys(files).map((p) => [p, new TFile(p)]));
  const vault = {
    interfere: null,
    on: () => {},
    getAbstractFileByPath: (p) => tfiles.get(p) || null,
    read: async (f) => files[f.path],
    process: async (f, fn) => {
      if (vault.interfere) {
        const edited = vault.interfere(files[f.path]);
        vault.interfere = null;
        if (edited !== undefined) files[f.path] = edited;
      }
      files[f.path] = fn(files[f.path]);
      return files[f.path];
    },
    configDir: '.obsidian',
    create: async (p, text) => { files[p] = text; tfiles.set(p, new TFile(p)); },
    folders: [],
    createFolder: async (p) => { vault.folders.push(p); },
    adapter: {
      exists: async () => true, mkdir: async () => {}, write: async () => {}, list: async () => ({ files: [] }), remove: async () => {},
      read: async (p) => { if (!(p in files)) throw new Error('missing'); return files[p]; },
    },
  };
  const plugin = new PlainPlannerPlugin({ vault }, { dir: '.obsidian/plugins/plain-planner' });
  plugin.loadData = async () => saved;
  plugin.saveData = async (d) => { plugin.savedData = d; };
  return { plugin, files, vault };
}

test('editDaily writes the change and records it for undo', async () => {
  const { plugin, files } = makePlugin({ 'TODO DAILY.md': 'a\n' });
  await plugin.loadState();
  plugin.undoOpen = { before: null, after: null };
  const res = await plugin.editDaily((model) => {
    model.preamble.push('b');
    plugin.state.filledDays.add(TODAY);
    return { changed: true };
  });
  assert.ok(res);
  assert.deepEqual(lines(files['TODO DAILY.md']), ['a', 'b']);
  assert.equal(plugin.undoOpen.before, 'a\n');
  assert.equal(plugin.undoOpen.after, files['TODO DAILY.md']);
});

test('editDaily keeps an edit made during the write and runs again on it', async () => {
  const { plugin, files, vault } = makePlugin({ 'TODO DAILY.md': 'a\n' });
  await plugin.loadState();
  let runs = 0;
  vault.interfere = () => 'a\nuser\n';
  await plugin.editDaily((model) => {
    runs++;
    // Like generateMonth: do the work only once per day, remembered in marks.
    if (plugin.state.filledDays.has(TODAY)) return { changed: false };
    plugin.state.filledDays.add(TODAY);
    model.preamble.push('routine');
    return { changed: true };
  });
  assert.equal(runs, 2);
  assert.deepEqual(lines(files['TODO DAILY.md']), ['a', 'user', 'routine']);
  assert.ok(plugin.state.filledDays.has(TODAY));
});

test('settings: declarative definitions cover every setting, saving keeps plugin state', async () => {
  const { plugin } = makePlugin({}, { settings: { spreadDays: 5 }, filledDays: [TODAY] });
  await plugin.loadState();
  const tab = new PlainPlannerPlugin.PlainPlannerSettingTab(plugin.app, plugin);
  const keys = tab.getSettingDefinitions().flatMap((g) => g.items.map((i) => i.control.key)).sort();
  assert.deepEqual(keys, Object.keys(plugin.settings).sort());
  assert.equal(tab.getControlValue('spreadDays'), 5);
  await tab.setControlValue('spreadDays', 40);
  assert.equal(plugin.settings.spreadDays, 5);
  await tab.setControlValue('workTag', '  #work ');
  assert.equal(plugin.settings.workTag, '#work');
  assert.deepEqual(plugin.savedData.filledDays, [TODAY]);
});

test('note language: Polish for settings from the old version, else follows the app', async () => {
  const old = makePlugin({}, { settings: { spreadDays: 5 } }).plugin;
  await old.loadState();
  assert.equal(old.settings.noteLanguage, 'pl');
  const fresh = makePlugin({}, {}).plugin;
  await fresh.loadState();
  assert.equal(fresh.settings.noteLanguage, 'en'); // app in English
  const chosen = makePlugin({}, { settings: { noteLanguage: 'en' } }).plugin;
  await chosen.loadState();
  assert.equal(chosen.settings.noteLanguage, 'en');
});

// Runs onload with the Obsidian calls it needs and returns the command names.
async function loadCommands(saved, appLanguage) {
  obsidianStub.appLanguage = appLanguage;
  const { plugin } = makePlugin({}, saved);
  plugin.app.workspace = { on: () => {}, onLayoutReady: () => {} };
  const commands = {};
  plugin.addCommand = (c) => { commands[c.id] = c.name; };
  plugin.addSettingTab = () => {};
  plugin.registerEvent = () => {};
  plugin.registerInterval = () => {};
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  await plugin.onload();
  obsidianStub.appLanguage = 'en';
  return { plugin, commands };
}

test('interface language: follows Obsidian on auto, the setting otherwise', async () => {
  let { commands } = await loadCommands({}, 'pl');
  assert.equal(commands['generate-month'], 'Rozpisz miesiąc');
  assert.equal(commands['move-next-month'], 'Przenieś na następny miesiąc (BEZ DATY)');
  ({ commands } = await loadCommands({}, 'de'));
  assert.equal(commands['generate-month'], 'Fill in a month');
  ({ commands } = await loadCommands({ settings: { uiLanguage: 'en', noteLanguage: 'pl' } }, 'pl'));
  assert.equal(commands['move-next-month'], 'Move to next month (BEZ DATY)'); // note keyword stays in the note language
});

test('interface language: notices and settings use it', async () => {
  const { plugin } = await loadCommands({ settings: { uiLanguage: 'en' } }, 'pl');
  obsidianStub.notices.length = 0;
  await plugin.undoLast();
  assert.deepEqual(obsidianStub.notices, ['Plain Planner: nothing to undo.']);
  const tab = new PlainPlannerPlugin.PlainPlannerSettingTab(plugin.app, plugin);
  const groups = tab.getSettingDefinitions();
  assert.equal(groups[0].heading, 'Files');
  assert.equal(groups[0].items[0].name, 'Interface language');
  await tab.setControlValue('uiLanguage', 'pl');
  assert.equal(tab.getSettingDefinitions()[0].heading, 'Pliki');
  await tab.setControlValue('uiLanguage', 'xx');
  assert.equal(plugin.settings.uiLanguage, 'pl');
});

test('setup: asked for when no daily note is set or it is gone, routine files are optional', async () => {
  const fresh = makePlugin({}, {}).plugin;
  await fresh.loadState();
  assert.equal(fresh.settings.dailyPath, '');
  assert.equal(fresh.settings.autoGenerate, false);
  assert.equal(fresh.dailyFile(), null);
  let asked = 0;
  fresh.openSetup = () => { asked++; };
  assert.equal(await fresh.editDaily(() => ({ changed: true })), null);
  assert.equal(asked, 1);

  obsidianStub.notices.length = 0;
  const { plugin } = makePlugin({ 'TODO DAILY.md': '' }, { settings: { dailyPath: 'TODO DAILY.md', weeklyPath: 'gone.md' } });
  await plugin.loadState();
  await plugin.readSources();
  await plugin.readSources();
  assert.deepEqual(obsidianStub.notices, ['Plain Planner: file gone.md not found']); // once, unset files silent
});

test('setup: renaming a file inside Obsidian updates its setting', async () => {
  const { plugin } = makePlugin({ 'TODO DAILY.md': '' });
  await plugin.loadState();
  await plugin.onRename(new TFile('Plan/My plan.md'), 'TODO DAILY.md');
  assert.equal(plugin.settings.dailyPath, 'Plan/My plan.md');
  assert.equal(plugin.savedData.settings.dailyPath, 'Plan/My plan.md');
});

test('backlog: renaming it or moving the daily note keeps the same backlog file', async () => {
  // Backlog renamed (e.g. an icon added to its name).
  const a = makePlugin({ 'TODO DAILY.md': '', 'BACKLOG.md': '' }).plugin;
  await a.loadState();
  await a.onRename(new TFile('📦 BACKLOG.md'), 'BACKLOG.md');
  assert.equal(a.backlogPath(), '📦 BACKLOG.md');
  assert.equal(a.savedData.settings.backlogPath, '📦 BACKLOG.md');
  // Daily note moved to a folder while the backlog stays where it was.
  const b = makePlugin({ 'TODO DAILY.md': '', 'BACKLOG.md': '' }).plugin;
  await b.loadState();
  await b.onRename(new TFile('Plan/TODO DAILY.md'), 'TODO DAILY.md');
  assert.equal(b.settings.dailyPath, 'Plan/TODO DAILY.md');
  assert.equal(b.backlogPath(), 'BACKLOG.md');
  // No backlog yet: it still follows the daily note.
  const c = makePlugin({ 'TODO DAILY.md': '' }).plugin;
  await c.loadState();
  await c.onRename(new TFile('Plan/TODO DAILY.md'), 'TODO DAILY.md');
  assert.equal(c.settings.backlogPath, '');
  assert.equal(c.backlogPath(), 'Plan/BACKLOG.md');
});

test('setup: creates the note with the cheat sheet block; hotkey changes redraw it', async () => {
  const { plugin, files } = makePlugin({}, {});
  await plugin.loadState();
  plugin.app.workspace = { openLinkText: () => {} };
  plugin.registerCommands = () => {};
  let done;
  const origOpen = obsidianStub.Modal.prototype.open;
  obsidianStub.Modal.prototype.open = function () { done = this.done; };
  plugin.openSetup(false);
  obsidianStub.Modal.prototype.open = origOpen;
  await done('Plan.md', 'pl');
  assert.equal(plugin.settings.dailyPath, 'Plan.md');
  assert.equal(plugin.settings.noteLanguage, 'pl');
  assert.equal(plugin.settings.uiLanguage, 'pl');
  assert.ok(files['Plan.md'].startsWith('\n```plain-planner\n'));
  // Hotkey changes redraw the blocks on screen; the note is not rewritten.
  const before = files['Plan.md'];
  const drawn = [];
  plugin.cheats = new Set([{ render: (hk) => drawn.push(hk) }]);
  files['.obsidian/hotkeys.json'] = JSON.stringify({ 'plain-planner:generate-month': [{ modifiers: ['Mod'], key: 'M' }] });
  await plugin.refreshCheatSheet();
  assert.deepEqual(drawn[0]['plain-planner:generate-month'], [{ modifiers: ['Mod'], key: 'M' }]);
  assert.equal(files['Plan.md'], before);
});

test('fill in the year: points to "Fill in a month" while the current month is missing', async () => {
  const { plugin, files } = makePlugin({ 'TODO DAILY.md': '' }, { settings: { dailyPath: 'TODO DAILY.md', uiLanguage: 'en' } });
  await plugin.loadState();
  obsidianStub.notices.length = 0;
  await plugin.doYearlyRest(true);
  const hint = obsidianStub.notices.some((n) => n.includes('use "Fill in a month"'));
  // In December nothing is added without the next-year question, so no file change either way is fine.
  if (new Date().getMonth() !== 11) assert.ok(/BEZ DATY|NO DATE/.test(files['TODO DAILY.md']));
  assert.ok(hint);
  obsidianStub.notices.length = 0;
  const m = new Date().getMonth() + 1;
  const name = ['STYCZEŃ', 'LUTY', 'MARZEC', 'KWIECIEŃ', 'MAJ', 'CZERWIEC', 'LIPIEC', 'SIERPIEŃ', 'WRZESIEŃ', 'PAŹDZIERNIK', 'LISTOPAD', 'GRUDZIEŃ'][m - 1];
  files['TODO DAILY.md'] = `## **${name} ${new Date().getFullYear()}**\n### BEZ DATY\n`;
  await plugin.doYearlyRest(true);
  assert.ok(!obsidianStub.notices.some((n) => n.includes('Fill in a month')));
});

test('backlog: the command creates BACKLOG.md on first use, then appends to it', async () => {
  const { plugin, files } = makePlugin({ 'TODO DAILY.md': '### 12.11 CZWARTEK\n- [ ] rower\n- [ ] kask\n' });
  await plugin.loadState();
  plugin.backup = async () => {};
  const year = new Date().getFullYear() + 1;
  let text = files['TODO DAILY.md'];
  let cursor = { from: 1, to: 1 };
  const editor = {
    getCursor: (w) => ({ line: cursor[w], ch: 0 }),
    getValue: () => text,
    setValue: (v) => { text = v; },
    setCursor: () => {},
    lineCount: () => text.split('\n').length,
  };
  await plugin.moveSelectionToBacklog(editor);
  assert.equal(files['BACKLOG.md'], `# ${year}\n- [ ] rower\n`);
  assert.equal(text, '### 12.11 CZWARTEK\n- [ ] kask\n');
  await plugin.moveSelectionToBacklog(editor);
  assert.equal(files['BACKLOG.md'], `# ${year}\n- [ ] rower\n- [ ] kask\n`);
  obsidianStub.notices.length = 0;
  cursor = { from: 0, to: 0 };
  await plugin.moveSelectionToBacklog(editor);
  assert.equal(obsidianStub.notices.length, 1, 'a heading is not moved');
});

test('create a routine: file in the RUTYNY folder, set in the settings, opened; existing file is taken as is', async () => {
  const { plugin, files, vault } = makePlugin({ 'TODO DAILY.md': '' }, { settings: { dailyPath: 'TODO DAILY.md', noteLanguage: 'pl' } });
  await plugin.loadState();
  const opened = [];
  plugin.app.workspace = { openLinkText: (p) => opened.push(p) };
  assert.deepEqual(plugin.missingRoutines(), ['weekly', 'monthly', 'yearly', 'holidays']);
  await plugin.createRoutine('weekly');
  assert.deepEqual(vault.folders, ['RUTYNY']);
  assert.ok(files['RUTYNY/RUTYNA TYGODNIOWA.md'].startsWith('## PONIEDZIAŁEK'));
  assert.equal(plugin.settings.weeklyPath, 'RUTYNY/RUTYNA TYGODNIOWA.md');
  assert.equal(plugin.savedData.settings.weeklyPath, 'RUTYNY/RUTYNA TYGODNIOWA.md');
  assert.deepEqual(opened, ['RUTYNY/RUTYNA TYGODNIOWA.md']);
  assert.deepEqual(plugin.missingRoutines(), ['monthly', 'yearly', 'holidays']);

  files['RUTYNY/ŚWIĘTA.md'] = '24.12 Wigilia\n';
  const tf = new TFile('RUTYNY/ŚWIĘTA.md');
  const get = vault.getAbstractFileByPath;
  vault.getAbstractFileByPath = (p) => (p === tf.path || p === 'RUTYNY' ? tf : get(p));
  await plugin.createRoutine('holidays');
  assert.equal(files['RUTYNY/ŚWIĘTA.md'], '24.12 Wigilia\n', 'an existing file is not overwritten');
  assert.equal(plugin.settings.holidaysPath, 'RUTYNY/ŚWIĘTA.md');
  assert.deepEqual(vault.folders, ['RUTYNY']);
});

test('fill in a month / the year: routine changes are checked first', async () => {
  const { plugin } = makePlugin({ 'TODO DAILY.md': '' });
  await plugin.loadState();
  plugin.backup = async () => {};
  const calls = [];
  plugin.checkRoutineChanges = async () => calls.push('check');
  const read = plugin.readSources.bind(plugin);
  plugin.readSources = async () => { calls.push('read'); return read(); };
  const t = new Date();
  await plugin.doGenerate(t.getFullYear(), t.getMonth() + 1, false);
  assert.deepEqual(calls, ['check', 'read']);
  calls.length = 0;
  await plugin.doYearlyRest(false);
  assert.deepEqual(calls, ['check', 'read']);
});
