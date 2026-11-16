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
  logs: 'renewal_logs'
};

const TIMEZONE = 'Asia/Manila';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const RENEWAL_PLANS = { 7: 250, 15: 470, 30: 900 };
const DEFAULT_RENEWAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------- entry points ------------------------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') {
    return sendJson({ ok: true, service: 'jsp-extender', time: isoNow() });
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
      return sendJson(action === 'workerPoll' ? workerPoll() : workerApply(body.updates));
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
        return sendJson(setPower(body));
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
  ensureColumn(TABS.logs, 'days');
  const key = workerKey();
  Logger.log('Spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  Logger.log('WORKER_KEY (put this in worker/.env): ' + key);
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

function normalizeSubscription(row) {
  return {
    id: String(row.id || '').trim(),
    device_name: String(row.device_name || '').trim(),
    tapo_ip: String(row.tapo_ip || '').trim(),
    subscriber_name: row.subscriber_name ? String(row.subscriber_name).trim() : '',
    status: String(row.status || '').trim().toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED',
    expires_at: isoValue(row.expires_at),
    last_renewed_at: isoValue(row.last_renewed_at),
    desired_power_state: toBool(row.desired_power_state),
    actual_power_state: toBool(row.actual_power_state),
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
        amount_paid: amount === '' || amount === null || amount === undefined ? null : Number(amount)
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
    fail('Renewal length must be 7, 15 or 30 days.', 'ERROR');
  }
  const days = hasDays ? requestedDays : DEFAULT_RENEWAL_DAYS;

  const rawAmount = body.amount;
  const amount = rawAmount === null || rawAmount === undefined || rawAmount === '' ? '' : Number(rawAmount);
  if (amount !== '' && (isNaN(amount) || amount < 0)) {
    fail('Amount paid must be a positive number.', 'ERROR');
  }

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
      days: days
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

function setPower(body) {
  const target = findSubscription(body.id);
  const on = toBool(body.on);
  const sheet = sheetByName(TABS.subscriptions);
  const headers = getHeaders(sheet);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    writeFields(sheet, target.__row, headers, { desired_power_state: on });
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

  if (!deviceName) fail('Device name is required.', 'ERROR');
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(tapoIp)) {
    fail('Enter a valid IPv4 address, e.g. 192.168.1.50', 'ERROR');
  }
  if (tapoIp.split('.').some(function (octet) { return Number(octet) > 255; })) {
    fail('Enter a valid IPv4 address, e.g. 192.168.1.50', 'ERROR');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (id) {
      const target = findSubscription(id);
      const sheet = sheetByName(TABS.subscriptions);
      const headers = getHeaders(sheet);
      writeFields(sheet, target.__row, headers, {
        device_name: deviceName,
        subscriber_name: subscriberName,
        tapo_ip: tapoIp
      });
      return { ok: true, id: id };
    }

    const newId = nextId('SUB', TABS.subscriptions);
    appendObject(TABS.subscriptions, {
      id: newId,
      device_name: deviceName,
      tapo_ip: tapoIp,
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

function workerApply(updates) {
  if (!updates || !updates.length) return { ok: true, updated: 0 };

  const sheet = sheetByName(TABS.subscriptions);
  const headers = getHeaders(sheet);
  const rows = readTable(TABS.subscriptions);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let updated = 0;

  try {
    updates.forEach(function (entry) {
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

      if (Object.keys(fields).length) {
        writeFields(sheet, target.__row, headers, fields);
        updated += 1;
      }
    });
  } finally {
    lock.releaseLock();
  }

  return { ok: true, updated: updated };
}
