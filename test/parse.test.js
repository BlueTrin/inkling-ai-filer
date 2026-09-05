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
  const v = (o) => gs.validateVerdict_(o, FOLDERS, 3);

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

test('promptText_', async (t) => {
  const SAMPLES = { 'Work/Projects': ['2026-02 kickoff', '2026-03 sprint review'] };

  await t.test('enumerates the allowed folders', () => {
    const p = gs.promptText_(FOLDERS, {}, 'propose');
    for (const folder of FOLDERS) {
      assert.ok(p.includes(folder), 'prompt must name ' + folder);
    }
    assert.ok(p.includes('handwritten or printed'), 'must not prime for handwriting only');
  });

  await t.test('includes example filenames so an opaque folder name is still legible', () => {
    const p = gs.promptText_(FOLDERS, SAMPLES, 'propose');
    assert.ok(p.includes('2026-02 kickoff'));
    assert.ok(p.includes('2026-03 sprint review'));
  });

  await t.test('folders without samples still appear', () => {
    const p = gs.promptText_(FOLDERS, SAMPLES, 'propose');
    assert.ok(p.includes('Personal'));
  });

  await t.test('asks for ambiguity rather than an arbitrary pick', () => {
    const p = gs.promptText_(FOLDERS, {}, 'propose');
    assert.ok(p.includes('ambiguous'));
    assert.ok(p.includes('Do not pick one arbitrarily'));
  });

  await t.test('mentions suggested_folder only when creation is not off', () => {
    assert.ok(gs.promptText_(FOLDERS, {}, 'propose').includes('suggested_folder'));
    assert.ok(!gs.promptText_(FOLDERS, {}, 'off').includes('suggested_folder'));
  });

  await t.test('never shows an empty suggested_folder in the JSON template', () => {
    // An empty example value anchors the model to copy it back empty, which is
    // exactly what happened on the first live run.
    assert.ok(!gs.promptText_(FOLDERS, {}, 'propose').includes('"suggested_folder":""'));
  });
});

test('round trip: a realistic fenced reply parses and validates', () => {
  const raw = '```json\n' +
    '{"name":"2026-09-06 project kickoff notes","folder":"Work/Projects",' +
    '"confidence":0.82,"summary":"Notes from the project kickoff meeting."}\n```';
  const parsed = JSON.parse(gs.stripFences_(raw));
  const verdict = gs.validateVerdict_(parsed, FOLDERS, 3);
  assert.strictEqual(verdict.folder, 'Work/Projects');
  assert.ok(verdict.confidence >= 0.6);
  assert.strictEqual(gs.safeName_(verdict.name) + '.pdf',
                     '2026-09-06 project kickoff notes.pdf');
});


test('validateAmbiguous_ (via validateVerdict_)', async (t) => {
  const v = (o) => gs.validateVerdict_(o, FOLDERS, 3);

  await t.test('two real folders the model could not choose between', () => {
    const r = v({ folder: '', confidence: 0.3,
                  ambiguous: ['Work/Projects', 'Work/Other'] });
    assert.deepStrictEqual(r.ambiguous, ['Work/Projects', 'Work/Other']);
  });

  await t.test('a single candidate is not an ambiguity', () => {
    assert.deepStrictEqual(v({ ambiguous: ['Work/Projects'] }).ambiguous, []);
  });

  await t.test('invented folders are dropped, and dropping can dissolve the ambiguity', () => {
    const r = v({ ambiguous: ['Work/Projects', 'Work/Invented'] });
    assert.deepStrictEqual(r.ambiguous, [], 'only one real candidate left');
  });

  await t.test('duplicates in the list do not manufacture an ambiguity', () => {
    assert.deepStrictEqual(v({ ambiguous: ['Personal', 'Personal'] }).ambiguous, []);
  });

  await t.test('non-arrays and junk entries do not throw', () => {
    assert.deepStrictEqual(v({ ambiguous: 'Work/Projects' }).ambiguous, []);
    assert.deepStrictEqual(v({ ambiguous: null }).ambiguous, []);
    assert.deepStrictEqual(v({ ambiguous: [1, {}, null] }).ambiguous, []);
  });

  await t.test('an ambiguous reply can still carry a usable name', () => {
    const r = v({ name: '2026-03-14 renewal', ambiguous: ['Work/Projects', 'Personal'] });
    assert.strictEqual(r.name, '2026-03-14 renewal');
  });
});

test('sanitiseSuggestion_', async (t) => {
  const f = (s, d) => gs.sanitiseSuggestion_(s, d === undefined ? 3 : d);

  await t.test('keeps a plain path', () => {
    assert.strictEqual(f('Admin/Insurance'), 'Admin/Insurance');
  });

  await t.test('rejects a path deeper than the cap', () => {
    assert.strictEqual(f('a/b/c/d'), '');
    assert.strictEqual(f('a/b/c'), 'a/b/c');
  });

  await t.test('strips characters Drive would not accept', () => {
    assert.strictEqual(f('Admin: tax*'), 'Admin- tax-');
  });

  await t.test('drops empty segments rather than creating blank folders', () => {
    assert.strictEqual(f('Admin//Insurance'), 'Admin/Insurance');
    assert.strictEqual(f('///'), '');
  });

  await t.test('never proposes the machinery folders', () => {
    assert.strictEqual(f('Inbox'), '');
    assert.strictEqual(f('_Unsorted'), '');
    assert.strictEqual(f('Admin/inbox'), '');
  });

  await t.test('non-strings and empties yield no suggestion', () => {
    assert.strictEqual(f(null), '');
    assert.strictEqual(f(undefined), '');
    assert.strictEqual(f(42), '');
    assert.strictEqual(f(''), '');
  });
});

test('normaliseLabel_', async (t) => {
  const f = gs.normaliseLabel_;

  await t.test('ignores case, spacing and punctuation', () => {
    assert.strictEqual(f('Car Insurance'), f('car-insurance'));
  });

  await t.test('ignores accents', () => {
    assert.strictEqual(f('Résumé'), f('Resume'));
  });

  await t.test('ignores a trailing plural', () => {
    assert.strictEqual(f('Insurances'), f('Insurance'));
  });

  await t.test('keeps genuinely different names apart', () => {
    assert.notStrictEqual(f('Insurance'), f('Invoices'));
  });

  await t.test('handles null and undefined', () => {
    assert.strictEqual(f(null), '');
    assert.strictEqual(f(undefined), '');
  });
});

test('findDuplicateGroups_', async (t) => {
  const f = gs.findDuplicateGroups_;

  await t.test('a clean tree reports nothing', () => {
    assert.deepStrictEqual(f(['Work/Projects', 'Personal', 'Receipts']), []);
  });

  await t.test('near-duplicate leaf names are grouped', () => {
    const g = f(['Admin/Insurance', 'Admin/Insurances']);
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0], ['Admin/Insurance', 'Admin/Insurances']);
  });

  await t.test('the same name under different parents is reported too', () => {
    // Possibly deliberate, so this is a report for a human, never a routing change.
    const g = f(['Work/Admin', 'Personal/Admin']);
    assert.deepStrictEqual(g[0], ['Work/Admin', 'Personal/Admin']);
  });

  await t.test('three-way duplicates come back as one group', () => {
    const g = f(['Insurance', 'Admin/Insurances', 'Old/insurance']);
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].length, 3);
  });

  await t.test('an empty tree does not throw', () => {
    assert.deepStrictEqual(f([]), []);
  });
});

test('isUsableSegment_ excludes names that would re-parse as a path', () => {
  assert.strictEqual(gs.isUsableSegment_('Projects'), true);
  assert.strictEqual(gs.isUsableSegment_('Q1/Q2'), false);
  assert.strictEqual(gs.isUsableSegment_(''), false);
  assert.strictEqual(gs.isUsableSegment_(null), false);
});

test('hash_ changes when a report changes, and only then', () => {
  assert.strictEqual(gs.hash_('a\nb'), gs.hash_('a\nb'));
  assert.notStrictEqual(gs.hash_('a\nb'), gs.hash_('a\nc'));
  assert.strictEqual(typeof gs.hash_(null), 'number');
});
