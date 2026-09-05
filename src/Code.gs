/**
 * inkling-ai-filer
 *
 * Watches a Google Drive folder, classifies each scanned page with Claude,
 * then renames the file and moves it into a topic folder.
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
    targets:       JSON.parse(need('TARGETS')),   // {"Work/Projects":"1AbC...", ...}
    apiKey:        need('ANTHROPIC_KEY'),

    model:         props.getProperty('MODEL') || 'claude-haiku-4-5',
    priceIn:       num('PRICE_IN_PER_MTOK', 1.0) / 1e6,
    priceOut:      num('PRICE_OUT_PER_MTOK', 5.0) / 1e6,
    minConfidence: num('MIN_CONFIDENCE', 0.6),
    dailyCallCap:  num('DAILY_CALL_CAP', 100),
    maxBytes:      num('MAX_MB', 20) * 1024 * 1024,
    settleMs:      num('SETTLE_SECONDS', 60) * 1000,
    maxAttempts:   num('MAX_ATTEMPTS', 3),

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
    const it = inbox.getFiles();
    const now = Date.now();

    while (it.hasNext()) {
      if (callsToday_() >= cfg.dailyCallCap) { log_(cfg, 'CAP', 'daily cap reached'); return; }
      const file = it.next();
      if (now - file.getLastUpdated().getTime() < cfg.settleMs) continue;   // still uploading
      processOne_(cfg, file);
    }
  } finally {
    lock.releaseLock();
  }
}

function processOne_(cfg, file) {
  try {
    if (file.getSize() > cfg.maxBytes) return park_(cfg, file, 'oversized');

    const verdict = classify_(cfg, file);
    const folderId = cfg.targets[verdict.folder];
    const ok = Boolean(folderId) && verdict.confidence >= cfg.minConfidence;

    const newName = safeName_(verdict.name) + '.pdf';
    if (cfg.dryRun) {
      log_(cfg, 'DRY', file.getName() + ' -> ' + (verdict.folder || '_Unsorted') + '/' + newName, verdict);
      return;
    }

    file.setName(newName);
    file.moveTo(DriveApp.getFolderById(ok ? folderId : cfg.unsortedId));
    log_(cfg, ok ? 'FILED' : 'UNSORTED', newName, verdict);

  } catch (e) {
    // Reached only for transient faults: HTTP failures, malformed JSON, Drive
    // errors. A well-formed reply naming an unknown folder is NOT an error,
    // it is a zero-confidence verdict, and lands in _Unsorted without retrying.
    const n = bumpAttempts_(file);
    if (n >= cfg.maxAttempts) park_(cfg, file, 'failed ' + n + 'x: ' + e.message);
    else log_(cfg, 'RETRY', file.getName() + ' attempt ' + n + ': ' + e.message);
  }
}

/*** THE ONLY PART THAT SPENDS MONEY **************************************/

function classify_(cfg, file) {
  const allowed = Object.keys(cfg.targets);
  const body = {
    model: cfg.model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'document',
          source: { type: 'base64', media_type: 'application/pdf',
                    data: Utilities.base64Encode(file.getBlob().getBytes()) } },
        { type: 'text', text: promptText_(allowed) }
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
  const verdict = validateVerdict_(parsed, allowed);               // never throws
  verdict._usage = json.usage || {};
  return verdict;
}

/** Pure. The prompt is a function so the test can assert the folder list is in it. */
function promptText_(allowedFolders) {
  return 'This is a scan of a single page, handwritten or printed. ' +
    'Reply with JSON only, no prose, no code fences:\n' +
    '{"name":"YYYY-MM-DD short topic","folder":"<one of: ' +
    allowedFolders.join(' | ') + '>","confidence":0.0-1.0,"summary":"one sentence"}\n' +
    'Use the date written or printed on the page if there is one, otherwise today. ' +
    'If the page is illegible or does not fit any folder, set confidence below 0.5.';
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

/** Coerce a parsed model reply into a verdict. Never throws. An unknown folder
 *  or an out-of-range confidence yields confidence 0, which routes to
 *  _Unsorted with the suggested name still applied. */
function validateVerdict_(parsed, allowedFolders) {
  const v = { name: '', folder: '', confidence: 0, summary: '' };
  if (!parsed || typeof parsed !== 'object') return v;

  if (typeof parsed.name === 'string') v.name = parsed.name;
  if (typeof parsed.summary === 'string') v.summary = parsed.summary;

  if (allowedFolders.indexOf(parsed.folder) === -1) return v;
  if (typeof parsed.confidence !== 'number' || !isFinite(parsed.confidence)) return v;
  if (parsed.confidence < 0 || parsed.confidence > 1) return v;

  v.folder = parsed.folder;
  v.confidence = parsed.confidence;
  return v;
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
    v ? v.folder : '', v ? v.confidence : '', v ? v.summary : '',
    u.input_tokens || '', u.output_tokens || '', cost ? cost.toFixed(5) : ''
  ]);
}
