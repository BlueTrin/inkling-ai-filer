/**
 * inkling-ai-filer
 *
 * Watches a Google Drive folder, classifies each scanned page with Claude,
 * then renames the file and moves it into a topic folder.
 *
 * The set of destination folders is discovered from the Drive tree on each run
 * that has work to do, not configured, so renaming or deleting a folder is
 * absorbed without touching anything here.
 *
 * All configuration lives in Script Properties, so this file holds no
 * account-specific values and is safe to commit. The README lists them under
 * "Script Properties".
 *
 * This file has no top-level statements other than function declarations,
 * which is what lets test/parse.test.js evaluate it outside Apps Script.
 */

/*** CONFIG ***************************************************************/

function cfg_() {
  const props = PropertiesService.getScriptProperties();
  const need = function (key) {
    const v = props.getProperty(key);
    if (!v) throw new Error('Missing Script Property: ' + key);
    return v;
  };
  const num = function (key, fallback) {
    const v = props.getProperty(key);
    return v === null || v === '' ? fallback : Number(v);
  };

  return {
    inboxId:       need('INBOX_ID'),
    unsortedId:    need('UNSORTED_ID'),
    indexSheetId:  need('INDEX_SHEET_ID'),
    rootId:        need('ROOT_ID'),        // discovery walks beneath this
    apiKey:        need('ANTHROPIC_KEY'),

    model:         props.getProperty('MODEL') || 'claude-haiku-4-5',
    priceIn:       num('PRICE_IN_PER_MTOK', 1.0) / 1e6,
    priceOut:      num('PRICE_OUT_PER_MTOK', 5.0) / 1e6,
    minConfidence: num('MIN_CONFIDENCE', 0.6),
    dailyCallCap:  num('DAILY_CALL_CAP', 100),
    maxBytes:      num('MAX_MB', 20) * 1024 * 1024,
    settleMs:      num('SETTLE_SECONDS', 60) * 1000,
    maxAttempts:   num('MAX_ATTEMPTS', 3),
    maxDepth:      num('MAX_DEPTH', 3),
    maxFolders:    num('MAX_FOLDERS', 100),
    samplesPer:    num('SAMPLES_PER_FOLDER', 3),

    // "propose" records a suggested folder without creating it. "off" drops the
    // suggestion entirely. "auto" is not implemented; see the design note.
    folderCreation: props.getProperty('FOLDER_CREATION') || 'propose',

    // Safe default: anything other than the exact string "false" stays dry.
    dryRun:        props.getProperty('DRY_RUN') !== 'false'
  };
}

/*** ENTRY POINT — bind a 15-minute time-driven trigger to this ***********/

function watchInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;                 // a previous run is still going
  try {
    const cfg = cfg_();
    const inbox = DriveApp.getFolderById(cfg.inboxId);

    // R2: the idle path lists one folder and exits. No tree walk, no API call.
    const pending = [];
    const it = inbox.getFiles();
    const now = Date.now();
    while (it.hasNext()) {
      const file = it.next();
      if (now - file.getLastUpdated().getTime() < cfg.settleMs) continue;  // still uploading
      pending.push(file);
    }
    if (!pending.length) return;

    // One snapshot of the tree per run, shared by every file in the batch.
    const tree = discoverFolders_(cfg);
    reportTreeProblems_(cfg, tree);

    for (let i = 0; i < pending.length; i++) {
      if (callsToday_() >= cfg.dailyCallCap) { log_(cfg, 'CAP', 'daily cap reached'); return; }
      processOne_(cfg, pending[i], tree);
    }
  } finally {
    lock.releaseLock();
  }
}

function processOne_(cfg, file, tree) {
  try {
    if (file.getSize() > cfg.maxBytes) return park_(cfg, file, 'oversized');

    const verdict = classify_(cfg, file, tree);
    const newName = safeName_(verdict.name) + '.pdf';

    // The model looked at the tree and could not choose. Reaching for one of
    // the candidates anyway is the misfile this whole design tries to avoid.
    if (verdict.ambiguous.length >= 2) {
      return route_(cfg, file, newName, cfg.unsortedId, 'AMBIGUOUS',
                    newName + ' — fits ' + verdict.ambiguous.join(' and '), verdict);
    }

    const folderId = tree.ids[verdict.folder];
    const ok = Boolean(folderId) && verdict.confidence >= cfg.minConfidence;
    return route_(cfg, file, newName, ok ? folderId : cfg.unsortedId,
                  ok ? 'FILED' : 'UNSORTED', newName, verdict);

  } catch (e) {
    // Reached only for transient faults: HTTP failures, malformed JSON, Drive
    // errors. A well-formed reply naming an unknown folder is NOT an error,
    // it is a zero-confidence verdict, and lands in _Unsorted without retrying.
    const n = bumpAttempts_(file);
    if (n >= cfg.maxAttempts) park_(cfg, file, 'failed ' + n + 'x: ' + e.message);
    else log_(cfg, 'RETRY', file.getName() + ' attempt ' + n + ': ' + e.message);
  }
}

/** The single place a file is renamed and moved, so dry run has one gate. */
function route_(cfg, file, newName, destId, status, msg, verdict) {
  if (cfg.dryRun) return log_(cfg, 'DRY', status + ': ' + msg, verdict);
  file.setName(newName);
  file.moveTo(DriveApp.getFolderById(destId));
  log_(cfg, status, msg, verdict);
}

/*** FOLDER DISCOVERY *****************************************************/

/**
 * Breadth-first walk beneath the configured root. Returns the allowed labels
 * as root-relative paths, a path -> id map, a few example filenames per folder,
 * and whatever had to be skipped so it can be reported rather than swallowed.
 *
 * Inbox and _Unsorted are machinery, not taxonomy, and are never candidates.
 */
function discoverFolders_(cfg) {
  const root = DriveApp.getFolderById(cfg.rootId);
  const tree = { paths: [], ids: {}, samples: {}, skipped: [], capped: false };
  let queue = [{ folder: root, path: '', depth: 0 }];

  while (queue.length) {
    const node = queue.shift();
    const it = node.folder.getFolders();

    while (it.hasNext()) {
      const child = it.next();
      if (child.isTrashed()) continue;                        // P8, checked rather than assumed
      const id = child.getId();
      if (id === cfg.inboxId || id === cfg.unsortedId) continue;

      const name = child.getName();
      if (!isUsableSegment_(name)) { tree.skipped.push(name); continue; }

      if (tree.paths.length >= cfg.maxFolders) { tree.capped = true; queue = []; break; }

      const path = node.path ? node.path + '/' + name : name;
      tree.paths.push(path);
      tree.ids[path] = id;
      tree.samples[path] = sampleNames_(child, cfg.samplesPer);

      if (node.depth + 1 < cfg.maxDepth) {
        queue.push({ folder: child, path: path, depth: node.depth + 1 });
      }
    }
  }
  return tree;
}

function sampleNames_(folder, limit) {
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext() && out.length < limit) out.push(it.next().getName());
  return out;
}

/**
 * Tree-level problems are properties of the folder structure, not of any one
 * page, so they would otherwise be logged on every run forever. Report only
 * when the set of problems changes.
 */
function reportTreeProblems_(cfg, tree) {
  const dupes = findDuplicateGroups_(tree.paths);
  const lines = [];

  for (let i = 0; i < dupes.length; i++) {
    lines.push('DUPLICATE: ' + dupes[i].join(' | ') + ' — same folder name in ' +
               dupes[i].length + ' places, the model cannot reliably choose between them');
  }
  if (tree.skipped.length) {
    lines.push('SKIPPED: ' + tree.skipped.join(' | ') + ' — folder name contains "/"');
  }
  if (tree.capped) {
    lines.push('CAPPED: stopped at ' + cfg.maxFolders + ' folders, some are not filing destinations');
  }
  if (!lines.length) return;

  const props = PropertiesService.getScriptProperties();
  const stamp = String(hash_(lines.join('\n')));
  if (props.getProperty('tree_report') === stamp) return;      // already reported, unchanged
  props.setProperty('tree_report', stamp);
  for (let j = 0; j < lines.length; j++) log_(cfg, 'TREE', lines[j]);
}

/*** THE ONLY PART THAT SPENDS MONEY **************************************/

function classify_(cfg, file, tree) {
  const body = {
    model: cfg.model,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'document',
          source: { type: 'base64', media_type: 'application/pdf',
                    data: Utilities.base64Encode(file.getBlob().getBytes()) } },
        { type: 'text', text: promptText_(tree.paths, tree.samples, cfg.folderCreation) }
      ]
    }]
  };

  const res = fetchWithRetry_('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });

  incCallsToday_();
  const json = JSON.parse(res.getContentText());
  const parsed = JSON.parse(stripFences_(json.content[0].text));   // throws -> retry
  const verdict = validateVerdict_(parsed, tree.paths, cfg.maxDepth);  // never throws
  if (cfg.folderCreation === 'off') verdict.suggested = '';
  verdict._usage = json.usage || {};
  return verdict;
}

/** Pure. The prompt is a function so the test can assert the folder list is in it. */
function promptText_(allowedFolders, samples, folderCreation) {
  const lines = allowedFolders.map(function (p) {
    const eg = (samples && samples[p]) || [];
    return eg.length ? '  ' + p + ' — e.g. ' + eg.join(', ') : '  ' + p;
  });

  let s = 'This is a scan of a single page, handwritten or printed.\n' +
    'Existing folders, with examples of what is already filed in each:\n' +
    lines.join('\n') + '\n' +
    'Reply with JSON only, no prose, no code fences:\n' +
    '{"name":"YYYY-MM-DD short topic",' +
    '"folder":"<exactly one of the folders above, or \"\" if none of them fits>",' +
    '"confidence":0.0-1.0,' +
    '"summary":"one sentence",' +
    (folderCreation === 'off' ? '' :
      '"suggested_folder":"<the folder that SHOULD exist for this page, ' +
      'as a path such as Admin/Insurance — always fill this in when \"folder\" is empty>",') +
    '"ambiguous":["<folders that fit equally well, if you cannot choose>"]}\n' +
    'Use the date written or printed on the page if there is one, otherwise today. ' +
    'If the page is illegible or does not fit any folder, set confidence below 0.5.\n' +
    'If two or more folders fit equally well and you cannot choose between them, ' +
    'list those folders in "ambiguous" and set confidence below 0.5. ' +
    'Do not pick one arbitrarily. Otherwise use an empty list.\n';

  if (folderCreation !== 'off') {
    s += 'Whenever no existing folder fits, "folder" must be empty AND ' +
         '"suggested_folder" must name the folder that should exist. ' +
         'Never leave "suggested_folder" empty while "folder" is also empty. ' +
         'Nothing is created automatically — the suggestion is reviewed by a human.\n';
  }
  return s;
}

function fetchWithRetry_(url, opts) {
  let wait = 1000;
  for (let i = 0; i < 3; i++) {
    const res = UrlFetchApp.fetch(url, opts);
    const code = res.getResponseCode();
    if (code < 400) return res;
    if (code !== 429 && code < 500) throw new Error('HTTP ' + code + ': ' + res.getContentText());
    Utilities.sleep(wait); wait *= 3;
  }
  throw new Error('gave up after 3 attempts');
}

/*** PURE HELPERS — covered by test/parse.test.js *************************/

/** Strip a leading and trailing markdown fence, anchored so a fence inside a
 *  JSON string value is left alone. */
function stripFences_(text) {
  return String(text === null || text === undefined ? '' : text)
    .trim()
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```$/, '')
    .trim();
}

/**
 * Coerce a parsed model reply into a verdict. Never throws. An unknown folder
 * or an out-of-range confidence yields confidence 0, which routes to
 * _Unsorted with the suggested name still applied.
 */
function validateVerdict_(parsed, allowedFolders, maxDepth) {
  const v = { name: '', folder: '', confidence: 0, summary: '', suggested: '', ambiguous: [] };
  if (!parsed || typeof parsed !== 'object') return v;

  if (typeof parsed.name === 'string') v.name = parsed.name;
  if (typeof parsed.summary === 'string') v.summary = parsed.summary;
  v.suggested = sanitiseSuggestion_(parsed.suggested_folder, maxDepth);
  v.ambiguous = validateAmbiguous_(parsed.ambiguous, allowedFolders);

  if (allowedFolders.indexOf(parsed.folder) === -1) return v;
  if (typeof parsed.confidence !== 'number' || !isFinite(parsed.confidence)) return v;
  if (parsed.confidence < 0 || parsed.confidence > 1) return v;

  v.folder = parsed.folder;
  v.confidence = parsed.confidence;
  return v;
}

/** Candidates the model could not choose between. Only real folders count, and
 *  fewer than two of them is not an ambiguity. */
function validateAmbiguous_(raw, allowedFolders) {
  if (!Array.isArray(raw)) return [];
  const seen = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string') continue;
    if (allowedFolders.indexOf(raw[i]) === -1) continue;
    if (seen.indexOf(raw[i]) === -1) seen.push(raw[i]);
  }
  return seen.length >= 2 ? seen : [];
}

/**
 * A suggested folder is advisory today and a real folder name the day
 * FOLDER_CREATION becomes "auto", so it is sanitised now while it is inert.
 * Returns '' for anything unusable rather than guessing.
 */
function sanitiseSuggestion_(raw, maxDepth) {
  const depth = maxDepth > 0 ? maxDepth : 3;
  if (typeof raw !== 'string') return '';

  const segments = raw.split('/')
    .map(function (s) { return safeName_(s); })
    .filter(function (s) { return s && s !== 'untitled'; });

  if (!segments.length || segments.length > depth) return '';
  for (let i = 0; i < segments.length; i++) {
    const low = segments[i].toLowerCase();
    if (low === 'inbox' || low === '_unsorted') return '';   // never propose machinery
  }
  return segments.join('/').slice(0, 200);
}

/** Drive-safe filename stem. Never returns an empty string, so a model that
 *  omits the name cannot produce a file called ".pdf". */
function safeName_(s) {
  const cleaned = String(s === null || s === undefined ? '' : s)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, ' ')   // control chars become spaces, then collapse
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return cleaned || 'untitled';
}

/** A folder name containing the path separator would re-parse as two levels,
 *  which misfiles silently. Excluded from the candidate set instead. */
function isUsableSegment_(name) {
  return typeof name === 'string' && name.length > 0 && name.indexOf('/') === -1;
}

/** Case, accents and punctuation removed, plus a crude plural trim. Used only
 *  to spot folders worth reporting to a human, never to route a file, so a
 *  missed synonym costs nothing and a false pair costs one report. */
function normaliseLabel_(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // combining marks left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/s$/, '');
}

/** Groups of folder paths whose final segment means the same thing. Two folders
 *  called Insurance and Insurances are a choice the model cannot make well. */
function findDuplicateGroups_(paths) {
  const byKey = {};
  const order = [];
  for (let i = 0; i < paths.length; i++) {
    const segs = paths[i].split('/');
    const key = normaliseLabel_(segs[segs.length - 1]);
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) { byKey[key] = []; order.push(key); }
    byKey[key].push(paths[i]);
  }
  const out = [];
  for (let j = 0; j < order.length; j++) {
    if (byKey[order[j]].length >= 2) out.push(byKey[order[j]]);
  }
  return out;
}

/** djb2. Only used to notice that a report has changed since last time. */
function hash_(s) {
  let h = 5381;
  const str = String(s === null || s === undefined ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

/*** HOUSEKEEPING *********************************************************/

function park_(cfg, file, why) {
  if (!cfg.dryRun) file.moveTo(DriveApp.getFolderById(cfg.unsortedId));
  log_(cfg, 'PARKED', file.getName() + ' - ' + why);
}

function bumpAttempts_(file) {
  const d = file.getDescription() || '';
  const n = (parseInt((d.match(/attempts=(\d+)/) || [])[1], 10) || 0) + 1;
  file.setDescription((d.replace(/attempts=\d+/, '') + ' attempts=' + n).trim());
  return n;
}

function callsTodayKey_() { return 'calls_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd'); }

function callsToday_() {
  const props = PropertiesService.getScriptProperties();
  return parseInt(props.getProperty(callsTodayKey_()) || '0', 10);
}

function incCallsToday_() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(callsTodayKey_(), String(callsToday_() + 1));
}

function log_(cfg, status, msg, v) {
  const u = (v && v._usage) || {};
  const cost = (u.input_tokens || 0) * cfg.priceIn + (u.output_tokens || 0) * cfg.priceOut;
  SpreadsheetApp.openById(cfg.indexSheetId).getSheets()[0].appendRow([
    new Date(), status, msg,
    v ? v.folder : '', v ? v.confidence : '', v ? v.summary : '', v ? v.suggested : '',
    u.input_tokens || '', u.output_tokens || '', cost ? cost.toFixed(5) : ''
  ]);
}
