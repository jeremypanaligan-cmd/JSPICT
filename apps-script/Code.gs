/**
 * JSP Extender Control — Google Sheets backend (Apps Script Web App).
 *
 * The static PWA on GitHub Pages cannot write to a spreadsheet directly, so
 * this Web App is the API layer. It also keeps the sheet private: deploy with
 * "Execute as: Me" and "Who has access: Anyone", and revoke link sharing.
 *
 * SETUP
 * 1. Open your spreadsheet → Extensions → Apps Script.
 * 2. Delete the placeholder Code.gs content and paste this whole file.
 * 3. Run the `setup` function once, authorize it, then open the Execution log
 *    and copy the printed WORKER_KEY for worker/.env.
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the /exec URL into config.js (or the app's settings dialog).
 * 5. Spreadsheet: File → Settings → Time zone = Asia/Manila.
 *
 * SHEETS USED (headers in row 1, order does not matter):
 *   user                    username | password            (password may be "sha256:<hex>")
 *   extender_subscriptions  id | device_name | tapo_ip | subscriber_name | status |
 *                           expires_at | last_renewed_at | desired_power_state |
 *                           actual_power_state | last_heartbeat | created_at
 *   renewal_logs            id | subscription_id | renewed_at | previous_expiry | new_expiry | amount_paid | days
 *   override_logs           id | subscription_id | at | source | from_state | to_state | actor
 *
 * MONITORING
 * `setup()` installs a 5-minute time trigger that runs `monitor()`:
 *   - marks ACTIVE rows whose expires_at has passed as EXPIRED (even when the
 *     bridge PC is off), so the app never shows paid-up service that is not;
 *   - alerts when the bridge heartbeat is stale, at most once every 6 hours.
 * Alerts go to Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set,
 * otherwise to ALERT_EMAIL (default: the script owner). Configure them with
 * `configureAlerts('bot-token', 'chat-id')` and check with `testAlert()`.
 *
 * The `days` column is added automatically by `setup` and by the first `renew`
 * call, so an older renewal_logs tab keeps working.
 *
 * Run `hashPassword('your-password')` in the editor to get a hash you can paste
 * into the user tab instead of a plaintext password.
 */

const TABS = {
  users: 'user',
  subscriptions: 'extender_subscriptions',
  logs: 'renewal_logs',
  overrides: 'override_logs',
  events: 'power_events',
  bridge: 'bridge_status'
};

const MONITOR_MINUTES = 5;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

/**
 * Bump this whenever this file changes, then redeploy a new version. The PWA
 * footer and the bridge worker log compare against it, so a stale deployment
 * shows up immediately instead of looking like a bug.
 */
const BACKEND_VERSION = '2026-11-18';

const TIMEZONE = 'Asia/Manila';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const RENEWAL_PLANS = { 1: 50, 7: 250, 15: 470, 30: 900 };
const DEFAULT_RENEWAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------- entry points ------------------------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') {
    return sendJson({
      ok: true,
      service: 'jsp-extender',
      version: BACKEND_VERSION,
      time: isoNow()
    });
  }
  return sendJson({ ok: false, error: 'This API accepts POST requests.', code: 'ERROR' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(body.action || '');

    if (action === 'login') return sendJson(login(body));

    if (action === 'workerPoll' || action === 'workerApply') {
      requireWorkerKey(body.workerKey);
      return sendJson(
        action === 'workerPoll' ? workerPoll() : workerApply(body.updates, body.bridge, body.events)
      );
    }

    const session = requireToken(body.token);

    switch (action) {
      case 'session':
        return sendJson({ ok: true, username: session.u });
      case 'list':
        return sendJson({ ok: true, rows: listSubscriptions() });
      case 'history':
        return sendJson({ ok: true, rows: history() });
      case 'renew':
        return sendJson(renew(body));
      case 'setPower':
        return sendJson(setPower(body, session));
      case 'overrides':
        return sendJson({ ok: true, rows: overrideLogs() });
      case 'events':
        return sendJson({ ok: true, rows: eventLogs() });
      case 'monitorNow':
        return sendJson({ ok: true, result: monitor() });
      case 'saveSubscription':
        return sendJson(saveSubscription(body));
      default:
        fail('Unknown action: ' + action, 'ERROR');
    }
  } catch (error) {
    return sendJson({
      ok: false,
      error: String((error && error.message) || error),
      code: (error && error.code) || 'ERROR'
    });
  }
}

/** Run once to generate the signing secret and print the worker key. */
function setup() {
  authSecret();
  LOG_EXTRA_COLUMNS.forEach(function (column) { ensureColumn(TABS.logs, column); });
  SUBSCRIPTION_EXTRA_COLUMNS.forEach(function (column) { ensureColumn(TABS.subscriptions, column); });
  ensureTab(TABS.overrides, OVERRIDE_HEADERS);
  ensureTab(TABS.events, EVENT_HEADERS);
  ensureTab(TABS.bridge, BRIDGE_HEADERS);
  const key = workerKey();
  Logger.log('Spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  Logger.log('WORKER_KEY (put this in worker/.env): ' + key);
  Logger.log('Monitor: ' + installMonitor());
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).');
}

/** Run in the editor with a plain password to get a value for the user tab. */
function hashPassword(plain) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(plain),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    const v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

/* -------------------------------- responses -------------------------------- */

function sendJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code || 'ERROR';
  throw error;
}

/* --------------------------------- secrets --------------------------------- */

function scriptProps() {
  return PropertiesService.getScriptProperties();
}

function authSecret() {
  const props = scriptProps();
  let secret = props.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

function workerKey() {
  const props = scriptProps();
  let key = props.getProperty('WORKER_KEY');
  if (!key) {
    key = 'wk_' + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('WORKER_KEY', key);
  }
  return key;
}

/* ---------------------------------- auth ----------------------------------- */

function login(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) fail('Username and password are required.', 'AUTH');

  const user = readTable(TABS.users).find(function (row) {
    return String(row.username || '').trim().toLowerCase() === username.toLowerCase();
  });
  if (!user) fail('Invalid username or password.', 'AUTH');

  const stored = String(user.password || '').trim();
  const matches = stored.indexOf('sha256:') === 0
    ? safeEqual(stored, 'sha256:' + hashPassword(password))
    : safeEqual(stored, password);

  if (!matches) fail('Invalid username or password.', 'AUTH');

  return { ok: true, token: makeToken(String(user.username).trim()), username: String(user.username).trim() };
}

function makeToken(username) {
  const payload = Utilities.base64EncodeWebSafe(
    JSON.stringify({ u: username, e: Date.now() + TOKEN_TTL_MS })
  );
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, authSecret())
  );
  return payload + '.' + signature;
}

function requireToken(token) {
  const raw = String(token || '');
  if (raw.indexOf('.') < 0) fail('Please sign in.', 'AUTH');

  const parts = raw.split('.');
  const expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], authSecret())
  );
  if (!safeEqual(parts[1], expected)) fail('Please sign in.', 'AUTH');

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    fail('Please sign in.', 'AUTH');
  }
  if (!payload.e || payload.e < Date.now()) {
    fail('Session expired. Please sign in again.', 'AUTH');
  }
  return payload;
}

function requireWorkerKey(key) {
  if (!safeEqual(String(key || ''), workerKey())) fail('Invalid worker key.', 'AUTH');
}

function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------- sheet helpers ------------------------------ */

function sheetByName(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) fail('Missing tab "' + name + '" in the spreadsheet.', 'ERROR');
  return sheet;
}

function getHeaders(sheet) {
  const lastColumn = Math.max(1, sheet.getLastColumn());
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (header) {
    return String(header).trim();
  });
}

function readTable(name) {
  const sheet = sheetByName(name);
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];

  const headers = values.shift().map(function (header) {
    return String(header).trim();
  });

  return values
    .filter(function (row) {
      return row.some(function (cell) { return String(cell).trim() !== ''; });
    })
    .map(function (row, index) {
      const record = { __row: index + 2 };
      headers.forEach(function (header, column) {
        if (header) record[header] = row[column];
      });
      return record;
    });
}

function appendObject(sheetName, record) {
  const sheet = sheetByName(sheetName);
  const headers = getHeaders(sheet);
  sheet.appendRow(headers.map(function (header) {
    return record[header] !== undefined && record[header] !== null ? record[header] : '';
  }));
}

const OVERRIDE_HEADERS = ['id', 'subscription_id', 'at', 'source', 'from_state', 'to_state', 'actor'];
const EVENT_HEADERS = ['id', 'subscription_id', 'at', 'action', 'reason', 'actor', 'source'];
const BRIDGE_HEADERS = ['id', 'last_heartbeat', 'updated_at', 'notes'];
const SUBSCRIPTION_EXTRA_COLUMNS = ['extender_ip', 'plug_reachable', 'extender_reachable', 'last_error'];
const LOG_EXTRA_COLUMNS = ['days', 'method', 'reference', 'received_by'];

/** Create a tab (with headers) when it does not exist yet. */
function ensureTab(name, headers) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

/** Audit trail for every manual power override made from the app. */
function recordOverride(target, fromOn, toOn, actor) {
  ensureTab(TABS.overrides, OVERRIDE_HEADERS);
  appendObject(TABS.overrides, {
    id: 'OVR-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
    subscription_id: String(target.id || '').trim(),
    at: isoNow(),
    source: 'app',
    from_state: fromOn,
    to_state: toOn,
    actor: actor ? String(actor) : 'unknown'
  });
}

function overrideLogs() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.overrides)) return [];
  return readTable(TABS.overrides)
    .map(function (row) {
      return {
        id: String(row.id || '').trim(),
        subscription_id: String(row.subscription_id || '').trim(),
        at: isoValue(row.at),
        source: String(row.source || '').trim(),
        from_state: toBool(row.from_state),
        to_state: toBool(row.to_state),
        actor: String(row.actor || '').trim()
      };
    })
    .sort(function (a, b) {
      return String(b.at).localeCompare(String(a.at));
    })
    .slice(0, 200);
}

/** Add a trailing header to a tab when it is missing (older sheets). */
function ensureColumn(sheetName, header) {
  const sheet = sheetByName(sheetName);
  const headers = getHeaders(sheet);
  if (headers.indexOf(header) >= 0) return;
  sheet.getRange(1, Math.max(1, headers.length) + 1).setValue(header);
}

function writeFields(sheet, rowIndex, headers, fields) {
  Object.keys(fields).forEach(function (key) {
    const column = headers.indexOf(key);
    if (column >= 0) sheet.getRange(rowIndex, column + 1).setValue(fields[key]);
  });
}

/* -------------------------------- normalize -------------------------------- */

function isoNow(date) {
  const value = date || new Date();
  const base = Utilities.formatDate(value, TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const zone = Utilities.formatDate(value, TIMEZONE, 'Z'); // e.g. +0800
  return base + zone.slice(0, 3) + ':' + zone.slice(3);
}

function isoValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return isoNow(value);
  return String(value).trim();
}

function parseDate(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(String(value).trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

function toBool(value) {
  if (value === true || value === 1) return true;
  const text = String(value).trim().toUpperCase();
  return text === 'TRUE' || text === '1' || text === 'YES' || text === 'ON';
}

/** true/false when the worker has reported, null when never reported. */
function optionalBool(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return toBool(value);
}

/** True when a cell holds anything - note that a real boolean false is a value. */
function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeSubscription(row) {
  return {
    id: String(row.id || '').trim(),
    device_name: String(row.device_name || '').trim(),
    tapo_ip: String(row.tapo_ip || '').trim(),
    extender_ip: String(row.extender_ip || '').trim(),
    subscriber_name: row.subscriber_name ? String(row.subscriber_name).trim() : '',
    status: String(row.status || '').trim().toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED',
    expires_at: isoValue(row.expires_at),
    last_renewed_at: isoValue(row.last_renewed_at),
    desired_power_state: toBool(row.desired_power_state),
    actual_power_state: toBool(row.actual_power_state),
    plug_reachable: optionalBool(row.plug_reachable),
    extender_reachable: optionalBool(row.extender_reachable),
    last_error: String(row.last_error || '').trim(),
    last_heartbeat: isoValue(row.last_heartbeat),
    created_at: isoValue(row.created_at)
  };
}

function findSubscription(id) {
  const wanted = String(id || '').trim();
  if (!wanted) fail('Missing subscription id.', 'ERROR');
  const found = readTable(TABS.subscriptions).find(function (row) {
    return String(row.id || '').trim() === wanted;
  });
  if (!found) fail('Subscription not found.', 'ERROR');
  return found;
}

function nextId(prefix, sheetName) {
  const numbers = readTable(sheetName)
    .map(function (row) { return String(row.id || '').trim(); })
    .map(function (id) {
      const match = new RegExp('^' + prefix + '-(\\d+)$').exec(id);
      return match ? Number(match[1]) : 0;
    });
  const next = (numbers.length ? Math.max.apply(null, numbers) : 0) + 1;
  return prefix + '-' + ('000' + next).slice(-3);
}

/* ------------------------------ data operations ----------------------------- */

function listSubscriptions() {
  return readTable(TABS.subscriptions).map(normalizeSubscription);
}

/** Days bought for a log row: the stored `days` value, else the date span. */
function renewalDays(row) {
  const stored = Number(String(row.days === null || row.days === undefined ? '' : row.days).trim());
  if (!isNaN(stored) && stored > 0) return stored;

  const newExpiry = parseDate(row.new_expiry);
  const renewed = parseDate(row.renewed_at);
  const previous = parseDate(row.previous_expiry);
  if (!newExpiry) return null;

  /* Extend mode counts from the old expiry, reset mode from the renewal time. */
  let base = renewed || previous;
  if (previous && (!base || previous.getTime() > base.getTime())) base = previous;
  if (!base) return null;

  const days = Math.round((newExpiry.getTime() - base.getTime()) / DAY_MS);
  return days > 0 ? days : null;
}

function history() {
  const names = {};
  readTable(TABS.subscriptions).forEach(function (row) {
    names[String(row.id || '').trim()] = String(row.device_name || '').trim();
  });

  return readTable(TABS.logs)
    .map(function (row) {
      const subscriptionId = String(row.subscription_id || '').trim();
      const amount = row.amount_paid;
      return {
        id: String(row.id || '').trim(),
        subscription_id: subscriptionId,
        device_name: names[subscriptionId] || 'Deleted extender',
        renewed_at: isoValue(row.renewed_at),
        previous_expiry: isoValue(row.previous_expiry),
        new_expiry: isoValue(row.new_expiry),
        days: renewalDays(row),
        amount_paid: amount === '' || amount === null || amount === undefined ? null : Number(amount),
        method: String(row.method || '').trim(),
        reference: String(row.reference || '').trim(),
        received_by: String(row.received_by || '').trim()
      };
    })
    .sort(function (a, b) {
      return String(b.renewed_at).localeCompare(String(a.renewed_at));
    })
    .slice(0, 100);
}

function renew(body) {
  const target = findSubscription(body.id);
  const mode = String(body.mode || '') === 'extend' ? 'extend' : 'reset';

  const hasDays = body.days !== null && body.days !== undefined && body.days !== '';
  const requestedDays = hasDays ? Number(body.days) : DEFAULT_RENEWAL_DAYS;
  if (hasDays && !RENEWAL_PLANS[requestedDays]) {
    fail('Renewal length must be 1, 7, 15 or 30 days.', 'ERROR');
  }
  const days = hasDays ? requestedDays : DEFAULT_RENEWAL_DAYS;

  const rawAmount = body.amount;
  const amount = rawAmount === null || rawAmount === undefined || rawAmount === '' ? '' : Number(rawAmount);
  if (amount !== '' && (isNaN(amount) || amount < 0)) {
    fail('Amount paid must be a positive number.', 'ERROR');
  }

  const method = String(body.method || '').trim().slice(0, 40);
  const reference = String(body.reference || '').trim().slice(0, 60);
  const receivedBy = String(body.received_by || '').trim().slice(0, 60);

  const now = new Date();
  const currentExpiry = parseDate(target.expires_at);
  const base = mode === 'extend' && currentExpiry && currentExpiry.getTime() > now.getTime()
    ? currentExpiry
    : now;
  const newExpiry = new Date(base.getTime() + days * DAY_MS);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    ensureColumn(TABS.logs, 'days');
    LOG_EXTRA_COLUMNS.forEach(function (column) { ensureColumn(TABS.logs, column); });
    const sheet = sheetByName(TABS.subscriptions);
    const headers = getHeaders(sheet);
    writeFields(sheet, target.__row, headers, {
      status: 'ACTIVE',
      expires_at: isoNow(newExpiry),
      last_renewed_at: isoNow(now),
      desired_power_state: true
    });

    appendObject(TABS.logs, {
      id: 'LOG-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      subscription_id: String(target.id).trim(),
      renewed_at: isoNow(now),
      previous_expiry: currentExpiry ? isoNow(currentExpiry) : '',
      new_expiry: isoNow(newExpiry),
      amount_paid: amount,
      days: days,
      method: method,
      reference: reference,
      received_by: receivedBy
    });
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    subscription: normalizeSubscription({
      id: target.id,
      device_name: target.device_name,
      tapo_ip: target.tapo_ip,
      subscriber_name: target.subscriber_name,
      status: 'ACTIVE',
      expires_at: isoNow(newExpiry),
      last_renewed_at: isoNow(now),
      desired_power_state: true,
      actual_power_state: target.actual_power_state,
      last_heartbeat: target.last_heartbeat,
      created_at: target.created_at
    })
  };
}

function setPower(body, session) {
  const target = findSubscription(body.id);
  const on = toBool(body.on);
  const previous = toBool(target.desired_power_state);
  const sheet = sheetByName(TABS.subscriptions);
  const headers = getHeaders(sheet);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    writeFields(sheet, target.__row, headers, { desired_power_state: on });
    if (previous !== on) {
      recordOverride(target, previous, on, session && session.u);
    }
  } finally {
    lock.releaseLock();
  }

  return { ok: true, id: String(target.id).trim(), desired_power_state: on };
}

function saveSubscription(body) {
  const id = String(body.id || '').trim();
  const deviceName = String(body.device_name || '').trim();
  const subscriberName = String(body.subscriber_name || '').trim();
  const tapoIp = String(body.tapo_ip || '').trim();
  const extenderIp = String(body.extender_ip || '').trim();

  if (!deviceName) fail('Device name is required.', 'ERROR');
  if (extenderIp && !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(extenderIp)) {
    fail('Enter a valid extender IP, e.g. 192.168.100.10', 'ERROR');
  }
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(tapoIp)) {
    fail('Enter a valid IPv4 address, e.g. 192.168.1.50', 'ERROR');
  }
  if (tapoIp.split('.').some(function (octet) { return Number(octet) > 255; })) {
    fail('Enter a valid IPv4 address, e.g. 192.168.1.50', 'ERROR');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    ensureColumn(TABS.subscriptions, 'extender_ip');
    if (id) {
      const target = findSubscription(id);
      const sheet = sheetByName(TABS.subscriptions);
      const headers = getHeaders(sheet);
      writeFields(sheet, target.__row, headers, {
        device_name: deviceName,
        subscriber_name: subscriberName,
        tapo_ip: tapoIp,
        extender_ip: extenderIp
      });
      return { ok: true, id: id };
    }

    const newId = nextId('SUB', TABS.subscriptions);
    appendObject(TABS.subscriptions, {
      id: newId,
      device_name: deviceName,
      tapo_ip: tapoIp,
      extender_ip: extenderIp,
      subscriber_name: subscriberName,
      status: 'EXPIRED',
      expires_at: isoNow(new Date()),
      last_renewed_at: '',
      desired_power_state: false,
      actual_power_state: false,
      last_heartbeat: '',
      created_at: isoNow(new Date())
    });
    return { ok: true, id: newId };
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------- worker API ------------------------------- */

function workerPoll() {
  return { ok: true, serverTime: isoNow(), rows: listSubscriptions() };
}

function workerApply(updates, bridge, events) {
  SUBSCRIPTION_EXTRA_COLUMNS.forEach(function (column) { ensureColumn(TABS.subscriptions, column); });
  const sheet = sheetByName(TABS.subscriptions);
  const headers = getHeaders(sheet);
  const rows = readTable(TABS.subscriptions);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let updated = 0;

  try {
    (updates || []).forEach(function (entry) {
      const target = rows.find(function (row) {
        return String(row.id || '').trim() === String(entry.id || '').trim();
      });
      if (!target) return;

      const incoming = entry.fields || {};
      const fields = {};

      if (incoming.status !== undefined) {
        fields.status = String(incoming.status).trim().toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED';
      }
      if (incoming.desired_power_state !== undefined) {
        fields.desired_power_state = toBool(incoming.desired_power_state);
      }
      if (incoming.actual_power_state !== undefined) {
        fields.actual_power_state = toBool(incoming.actual_power_state);
      }
      if (incoming.last_heartbeat) {
        fields.last_heartbeat = isoValue(incoming.last_heartbeat);
      }
      if (incoming.plug_reachable !== undefined) {
        fields.plug_reachable = toBool(incoming.plug_reachable);
      }
      if (incoming.extender_reachable !== undefined) {
        fields.extender_reachable = toBool(incoming.extender_reachable);
      }
      if (incoming.last_error !== undefined) {
        fields.last_error = String(incoming.last_error).slice(0, 200);
      }

      if (Object.keys(fields).length) {
        writeFields(sheet, target.__row, headers, fields);
        updated += 1;
      }
    });

    if (events && events.length) appendEvents(events);
    if (bridge && bridge.last_heartbeat) writeBridgeStatus(bridge);
  } finally {
    lock.releaseLock();
  }

  return { ok: true, updated: updated, events: events ? events.length : 0 };
}

/** Physical ON/OFF history written by the bridge (dispute evidence). */
function appendEvents(events) {
  ensureTab(TABS.events, EVENT_HEADERS);
  events.slice(0, 50).forEach(function (event) {
    appendObject(TABS.events, {
      id: 'EVT-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      subscription_id: String(event.subscription_id || '').trim(),
      at: isoValue(event.at) || isoNow(),
      action: String(event.action || '').trim().toUpperCase() === 'ON' ? 'ON' : 'OFF',
      reason: String(event.reason || '').trim().slice(0, 60),
      actor: String(event.actor || 'bridge').trim().slice(0, 60),
      source: 'worker'
    });
  });
}

function eventLogs() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.events)) return [];
  return readTable(TABS.events)
    .map(function (row) {
      return {
        id: String(row.id || '').trim(),
        subscription_id: String(row.subscription_id || '').trim(),
        at: isoValue(row.at),
        action: String(row.action || '').trim().toUpperCase() === 'ON' ? 'ON' : 'OFF',
        reason: String(row.reason || '').trim(),
        actor: String(row.actor || '').trim(),
        source: String(row.source || '').trim()
      };
    })
    .sort(function (a, b) {
      return String(b.at).localeCompare(String(a.at));
    })
    .slice(0, 200);
}

/** One singleton row that proves the bridge is alive even with no subscriptions. */
function writeBridgeStatus(bridge) {
  ensureTab(TABS.bridge, BRIDGE_HEADERS);
  const sheet = sheetByName(TABS.bridge);
  const headers = getHeaders(sheet);
  const existing = readTable(TABS.bridge).find(function (row) {
    return String(row.id || '').trim() === 'BRIDGE';
  });
  const record = {
    id: 'BRIDGE',
    last_heartbeat: isoValue(bridge.last_heartbeat) || isoNow(),
    updated_at: isoNow(),
    notes: String(bridge.notes || '').trim().slice(0, 120)
  };
  if (existing) writeFields(sheet, existing.__row, headers, record);
  else appendObject(TABS.bridge, record);
}

/* -------------------------------- monitoring ------------------------------- */

/**
 * Runs from a 5-minute time trigger (see installMonitor). Works without the
 * bridge PC: expiries are recorded here, and the plug cut is queued through
 * desired_power_state for the worker to apply when it comes back.
 */
function monitor() {
  const now = new Date();
  const expired = expireOverdue(now);
  const rows = readTable(TABS.subscriptions);
  const bridge = bridgeHealth(rows, now.getTime());

  const messages = [];
  if (expired.length) {
    messages.push('Marked EXPIRED: ' + expired.join(', ') + ' (plug cut queued for the bridge).');
  }

  const pending = rows.filter(function (row) {
    return toBool(row.desired_power_state) !== toBool(row.actual_power_state);
  });

  // Alert on a stale bridge even with zero subscriptions; stay quiet only on a
  // brand-new install where the bridge has never reported.
  if (!bridge.online && (bridge.lastSeen || rows.length)) {
    messages.push(
      'Bridge OFFLINE — last heartbeat ' +
        (bridge.lastSeen ? Utilities.formatDate(bridge.lastSeen, TIMEZONE, 'yyyy-MM-dd HH:mm') + ' (' + bridge.ageMinutes + ' min ago)' : 'never') +
        '. Plug control is paused' +
        (pending.length ? '; ' + pending.length + ' plug command(s) queued.' : '.')
    );
  }

  const unreachable = rows.filter(function (row) {
    return hasValue(row.plug_reachable) && !toBool(row.plug_reachable);
  });
  if (unreachable.length) {
    messages.push(
      'Plug unreachable: ' +
        unreachable
          .map(function (row) {
            const detail = String(row.last_error || '').trim();
            return String(row.id || '').trim() + (detail ? ' (' + detail + ')' : '');
          })
          .join('; ') +
        '.'
    );
  }

  const tampered = rows.filter(function (row) {
    return (
      toBool(row.desired_power_state) &&
      toBool(row.actual_power_state) &&
      hasValue(row.extender_reachable) &&
      !toBool(row.extender_reachable) &&
      String(row.status || '').trim().toUpperCase() === 'ACTIVE'
    );
  });
  if (tampered.length) {
    messages.push(
      'POSSIBLE TAMPERING: ' +
        tampered
          .map(function (row) {
            const ip = String(row.extender_ip || '').trim() || 'the extender';
            return String(row.id || '').trim() + ' (' + ip + ' not detected while the plug is on)';
          })
          .join('; ') +
        '. It may have been moved to another outlet.'
    );
  }

  if (!messages.length) {
    clearAlertState();
    return { expired: expired, online: bridge.online, pending: pending.length, alerted: false };
  }

  const signature = [
    bridge.online ? 'online' : 'offline',
    expired.join(','),
    unreachable.map(function (row) { return String(row.id || '').trim(); }).join(','),
    tampered.map(function (row) { return String(row.id || '').trim(); }).join(',')
  ].join('|');
  const props = scriptProps();
  const lastSignature = props.getProperty('ALERT_SIGNATURE') || '';
  const lastAt = Number(props.getProperty('ALERT_AT') || 0);

  if (lastSignature === signature && now.getTime() - lastAt < ALERT_REPEAT_MS) {
    return { expired: expired, online: bridge.online, pending: pending.length, alerted: false, suppressed: true };
  }

  notify(bridge.online ? 'expiry update' : 'bridge offline', messages.join('\n'));
  props.setProperty('ALERT_SIGNATURE', signature);
  props.setProperty('ALERT_AT', String(now.getTime()));

  return { expired: expired, online: bridge.online, pending: pending.length, alerted: true };
}

/** Flip overdue ACTIVE rows to EXPIRED and queue the plug cut. */
function expireOverdue(now) {
  const overdue = readTable(TABS.subscriptions).filter(function (row) {
    const expires = parseDate(row.expires_at);
    return expires && expires.getTime() <= now.getTime() &&
      String(row.status || '').trim().toUpperCase() === 'ACTIVE';
  });
  if (!overdue.length) return [];

  const sheet = sheetByName(TABS.subscriptions);
  const headers = getHeaders(sheet);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    overdue.forEach(function (row) {
      writeFields(sheet, row.__row, headers, { status: 'EXPIRED', desired_power_state: false });
    });
  } finally {
    lock.releaseLock();
  }

  return overdue.map(function (row) { return String(row.id || '').trim(); });
}

function bridgeHealth(rows, nowMs) {
  let lastSeen = null;

  // bridge_status is the authoritative heartbeat: it exists even when the
  // spreadsheet has no subscriptions yet.
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.bridge)) {
    readTable(TABS.bridge).forEach(function (row) {
      const beat = parseDate(row.last_heartbeat);
      if (beat && (!lastSeen || beat.getTime() > lastSeen.getTime())) lastSeen = beat;
    });
  }

  rows.forEach(function (row) {
    const beat = parseDate(row.last_heartbeat);
    if (beat && (!lastSeen || beat.getTime() > lastSeen.getTime())) lastSeen = beat;
  });
  const ageMs = lastSeen ? nowMs - lastSeen.getTime() : null;
  return {
    online: Boolean(lastSeen) && ageMs <= HEARTBEAT_STALE_MS,
    lastSeen: lastSeen,
    ageMinutes: lastSeen ? Math.round(ageMs / 60000) : null
  };
}

function clearAlertState() {
  const props = scriptProps();
  props.deleteProperty('ALERT_SIGNATURE');
  props.deleteProperty('ALERT_AT');
}

/** Telegram when configured, otherwise email to ALERT_EMAIL / the script owner. */
function notify(subject, message) {
  const props = scriptProps();
  const text = '[JSP Extender] ' + subject + '\n\n' + message + '\n\n' + isoNow();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');

  if (token && chatId) {
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        payload: { chat_id: chatId, text: text },
        muteHttpExceptions: true
      });
      return;
    } catch (error) {
      Logger.log('Telegram alert failed: ' + error);
    }
  }

  const email = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  if (email) {
    try {
      MailApp.sendEmail(email, '[JSP Extender] ' + subject, text);
    } catch (error) {
      Logger.log('Email alert failed: ' + error);
    }
  }
}

/** Run once from the editor: configureAlerts('123:ABC', '123456789') */
function configureAlerts(telegramToken, telegramChatId, email) {
  const props = scriptProps();
  if (telegramToken) props.setProperty('TELEGRAM_BOT_TOKEN', String(telegramToken).trim());
  if (telegramChatId) props.setProperty('TELEGRAM_CHAT_ID', String(telegramChatId).trim());
  if (email) props.setProperty('ALERT_EMAIL', String(email).trim());
  return 'Alerts configured. Run testAlert() to confirm delivery.';
}

function testAlert() {
  notify('test alert', 'If you can read this, bridge alerts reach you.');
  return 'Test alert sent.';
}

/** Install (or refresh) the 5-minute monitor trigger. */
function installMonitor() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'monitor') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('monitor').timeBased().everyMinutes(MONITOR_MINUTES).create();
  return 'monitor() runs every ' + MONITOR_MINUTES + ' minutes';
}
