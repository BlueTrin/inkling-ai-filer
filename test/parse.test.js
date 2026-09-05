/**
 * Tests for the pure parsing path in src/Code.gs.
 *
 * Apps Script cannot be unit-tested directly, but the functions that decide
 * where a file goes are pure. Code.gs has no top-level statements other than
 * function declarations, so it can be evaluated in a vm context and its
 * functions pulled out.
 *
 *   node --test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
const gs = vm.createContext({});
vm.runInContext(src, gs);

const FOLDERS = ['Work/Projects', 'Work/Other', 'Receipts', 'Personal'];

test('stripFences_', async (t) => {
  const f = gs.stripFences_;

  await t.test('leaves bare JSON alone', () => {
    assert.strictEqual(f('{"a":1}'), '{"a":1}');
  });

  await t.test('strips a ```json fence', () => {
    assert.strictEqual(f('```json\n{"a":1}\n```'), '{"a":1}');
  });

  await t.test('strips a bare ``` fence', () => {
    assert.strictEqual(f('```\n{"a":1}\n```'), '{"a":1}');
  });

  await t.test('tolerates surrounding whitespace', () => {
    assert.strictEqual(f('\n\n  ```json\n{"a":1}\n```  \n'), '{"a":1}');
  });

  await t.test('leaves a fence inside a string value alone', () => {
    // The anchored regex is the reason this passes; a global replace would
    // corrupt the value and the JSON.parse downstream would throw.
    const raw = '{"summary":"the note said ``` verbatim"}';
    assert.strictEqual(f(raw), raw);
  });

  await t.test('handles null and undefined', () => {
    assert.strictEqual(f(null), '');
    assert.strictEqual(f(undefined), '');
  });
});

test('validateVerdict_', async (t) => {
  const v = (o) => gs.validateVerdict_(o, FOLDERS);

  await t.test('accepts a well-formed verdict', () => {
    const r = v({ name: '2026-09-06 kickoff notes', folder: 'Work/Projects',
                  confidence: 0.82, summary: 'one sentence' });
    assert.strictEqual(r.folder, 'Work/Projects');
    assert.strictEqual(r.confidence, 0.82);
    assert.strictEqual(r.name, '2026-09-06 kickoff notes');
  });

  await t.test('an invented folder yields confidence 0 but keeps the name', () => {
    const r = v({ name: 'a good name', folder: 'Work/Invented', confidence: 0.99 });
    assert.strictEqual(r.confidence, 0, 'must not be trusted');
    assert.strictEqual(r.folder, '');
    assert.strictEqual(r.name, 'a good name', 'unknown folder: the name is still applied');
  });

  await t.test('confidence as a string is rejected', () => {
    assert.strictEqual(v({ folder: 'Receipts', confidence: '0.9' }).confidence, 0);
  });

  await t.test('confidence out of range is rejected', () => {
    assert.strictEqual(v({ folder: 'Receipts', confidence: 1.4 }).confidence, 0);
    assert.strictEqual(v({ folder: 'Receipts', confidence: -0.1 }).confidence, 0);
  });

  await t.test('NaN and Infinity are rejected', () => {
    assert.strictEqual(v({ folder: 'Receipts', confidence: NaN }).confidence, 0);
    assert.strictEqual(v({ folder: 'Receipts', confidence: Infinity }).confidence, 0);
  });

  await t.test('missing fields do not throw', () => {
    assert.strictEqual(v({}).confidence, 0);
    assert.strictEqual(v(null).confidence, 0);
    assert.strictEqual(v('a string').confidence, 0);
  });

  await t.test('a folder that is a prototype property is rejected', () => {
    // Object.keys-based allow list plus indexOf, so "constructor" must not pass.
    assert.strictEqual(v({ folder: 'constructor', confidence: 0.9 }).confidence, 0);
  });
});

test('safeName_', async (t) => {
  const f = gs.safeName_;

  await t.test('replaces path separators', () => {
    assert.strictEqual(f('Work/Projects: kickoff'), 'Work-Projects- kickoff');
  });

  await t.test('never returns an empty stem', () => {
    assert.strictEqual(f(''), 'untitled');
    assert.strictEqual(f(null), 'untitled');
    assert.strictEqual(f(undefined), 'untitled');
    assert.strictEqual(f('///'), '---');
  });

  await t.test('truncates to 120 characters', () => {
    assert.strictEqual(f('x'.repeat(300)).length, 120);
  });

  await t.test('strips trailing dots and spaces', () => {
    assert.strictEqual(f('note...  '), 'note');
  });

  await t.test('collapses whitespace', () => {
    assert.strictEqual(f('a\n\tb   c'), 'a b c');
  });
});

test('promptText_ enumerates the allowed folders', () => {
  const p = gs.promptText_(FOLDERS);
  for (const folder of FOLDERS) {
    assert.ok(p.includes(folder), 'prompt must name ' + folder);
  }
  assert.ok(p.includes('handwritten or printed'), 'must not prime for handwriting only');
});

test('round trip: a realistic fenced reply parses and validates', () => {
  const raw = '```json\n' +
    '{"name":"2026-09-06 project kickoff notes","folder":"Work/Projects",' +
    '"confidence":0.82,"summary":"Notes from the project kickoff meeting."}\n```';
  const parsed = JSON.parse(gs.stripFences_(raw));
  const verdict = gs.validateVerdict_(parsed, FOLDERS);
  assert.strictEqual(verdict.folder, 'Work/Projects');
  assert.ok(verdict.confidence >= 0.6);
  assert.strictEqual(gs.safeName_(verdict.name) + '.pdf',
                     '2026-09-06 project kickoff notes.pdf');
});
