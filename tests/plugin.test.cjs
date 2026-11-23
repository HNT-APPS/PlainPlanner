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
class Setting {}
class Notice { constructor(msg) { notices.push(msg); } }
class TFile { constructor(path) { this.path = path; this.basename = path.replace(/\\.md$/, ''); this.extension = 'md'; } }
const normalizePath = (p) => p;
module.exports = { Plugin, PluginSettingTab, Modal, SuggestModal, Setting, Notice, TFile, normalizePath, notices };
`);
fs.copyFileSync(path.join(__dirname, '../main.js'), path.join(tmp, 'main.cjs'));
const PlainPlannerPlugin = require(path.join(tmp, 'main.cjs'));
const { TFile } = require(stubDir);
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const lines = (t) => t.split('\n').filter(Boolean);

// In-memory vault; `interfere(text)` may return another text to simulate an
// edit that lands between the plugin's read and its write.
function makePlugin(files, saved = {}) {
  const tfiles = new Map(Object.keys(files).map((p) => [p, new TFile(p)]));
  const vault = {
    interfere: null,
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
    adapter: { exists: async () => true, mkdir: async () => {}, write: async () => {}, list: async () => ({ files: [] }), remove: async () => {} },
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
  const fresh = makePlugin({}).plugin;
  await fresh.loadState();
  assert.equal(fresh.settings.noteLanguage, 'en'); // stub has no getLanguage -> English
  const chosen = makePlugin({}, { settings: { noteLanguage: 'en' } }).plugin;
  await chosen.loadState();
  assert.equal(chosen.settings.noteLanguage, 'en');
});
