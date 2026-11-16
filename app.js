/**
 * JSP Extender Control — PWA frontend logic.
 * Data + auth live in a Google Apps Script Web App (see apps-script/Code.gs).
 */

import { SHEETS_API_URL as DEFAULT_API_URL } from './config.js';

const CONFIG_KEY = 'jsp-extender.api';
const TOKEN_KEY = 'jsp-extender.token';
const USER_KEY = 'jsp-extender.user';
const TIMEZONE = 'Asia/Manila';
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_PLANS = [
  { days: 7, amount: 250 },
  { days: 15, amount: 470 },
  { days: 30, amount: 900 }
];
const DEFAULT_RENEWAL_DAYS = 30;
const HEARTBEAT_WINDOW_MS = 2 * 60 * 1000;
const POLL_MS = 20000;

/* Must match BACKEND_VERSION in apps-script/Code.gs — bump both together. */
const EXPECTED_BACKEND_VERSION = '2026-11-16';

/* ------------------------------- helpers ------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const pad = (value) => String(value).padStart(2, '0');
const ICONS = { success: '#i-check', warn: '#i-alert', error: '#i-alert' };

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

const currencyFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  maximumFractionDigits: 2
});

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

function isExpiredAt(row, nowMs = Date.now()) {
  const expiry = toDate(row.expires_at);
  return !expiry || expiry.getTime() <= nowMs;
}

function isBridgeOnline(row) {
  const heartbeat = toDate(row.last_heartbeat);
  return Boolean(heartbeat) && Date.now() - heartbeat.getTime() <= HEARTBEAT_WINDOW_MS;
}

function isValidIPv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
  return Boolean(match) && match.slice(1).every((octet) => Number(octet) <= 255);
}

/* -------------------------------- state -------------------------------- */

const state = {
  config: null,
  token: localStorage.getItem(TOKEN_KEY) || '',
  username: localStorage.getItem(USER_KEY) || '',
  rows: [],
  renewTargetId: null,
  editTargetId: null,
  refreshTimer: null,
  tickTimer: null,
  pollTimer: null
};

/* --------------------------------- DOM --------------------------------- */

const loginView = $('#login-view');
const appView = $('#app-view');
const loginForm = $('#login-form');
const loginUsername = $('#login-username');
const loginPassword = $('#login-password');
const loginError = $('#login-error');
const loginSubmit = $('#login-submit');
const loginConfigBtn = $('#login-config-btn');

const cardsEl = $('#cards');
const emptyState = $('#empty-state');
const bridgeSummary = $('#bridge-summary');
const userEmail = $('#user-email');
const syncState = $('#sync-state');
const backendVersion = $('#backend-version');
const btnRefresh = $('#btn-refresh');
const btnAdd = $('#btn-add');
const btnHistory = $('#btn-history');
const btnSettings = $('#btn-settings');
const btnSignout = $('#btn-signout');

const renewModal = $('#renew-modal');
const renewForm = $('#renew-form');
const renewDevice = $('#renew-device');
const renewCurrent = $('#renew-current');
const renewExtend = $('#renew-mode-extend');
const renewExtendHint = $('#renew-extend-hint');
const renewResetHint = $('#renew-reset-hint');
const renewPlans = $('#renew-plans');
const renewLength = $('#renew-length');
const renewAmount = $('#renew-amount');
const renewPreview = $('#renew-preview');
const renewError = $('#renew-error');
const renewSubmit = $('#renew-submit');

const extenderModal = $('#extender-modal');
const extenderForm = $('#extender-form');
const extenderTitle = $('#extender-title');
const extName = $('#ext-name');
const extSubscriber = $('#ext-subscriber');
const extIp = $('#ext-ip');
const extError = $('#ext-error');
const extenderSubmit = $('#extender-submit');

const historyDrawer = $('#history-drawer');
const historyList = $('#history-list');
const historyEmpty = $('#history-empty');
const historyLoading = $('#history-loading');

const settingsModal = $('#settings-modal');
const settingsForm = $('#settings-form');
const cfgUrl = $('#cfg-url');
const settingsError = $('#settings-error');

const toastHost = $('#toast-host');

/* ------------------------------- toasts -------------------------------- */

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.innerHTML = `<svg class="icon"><use href="${ICONS[type] || ICONS.success}" /></svg><span>${escapeHtml(message)}</span>`;
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease, transform .2s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, type === 'error' ? 5200 : 3600);
}

/* ------------------------------- modals -------------------------------- */

function openModal(node) {
  node.classList.add('is-open');
  node.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(node) {
  node.classList.remove('is-open');
  node.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal.is-open') && !document.querySelector('.drawer.is-open')) {
    document.body.style.overflow = '';
  }
}

document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    const target = document.getElementById(closer.dataset.close);
    if (target) closeModal(target);
    return;
  }
  if (event.target.classList.contains('modal')) closeModal(event.target);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.modal.is-open, .drawer.is-open').forEach(closeModal);
});

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = label;
}

function showError(node, message) {
  node.textContent = message;
  node.classList.remove('hidden');
}

function clearError(node) {
  node.textContent = '';
  node.classList.add('hidden');
}

/* -------------------------------- config -------------------------------- */

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const url = String(saved.url || DEFAULT_API_URL || '').trim();
  return {
    url,
    configured: /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/i.test(url)
  };
}

function openSettings() {
  cfgUrl.value = state.config?.configured ? state.config.url : '';
  clearError(settingsError);
  openModal(settingsModal);
}

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = cfgUrl.value.trim();

  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/i.test(url)) {
    showError(settingsError, 'Paste the Apps Script Web App /exec URL, e.g. https://script.google.com/macros/s/AKfy.../exec');
    return;
  }

  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url }));
  toast('API URL saved. Reloading…', 'success');
  setTimeout(() => window.location.reload(), 700);
});

/* ------------------------------ API client ------------------------------ */

async function api(action, payload = {}, { auth = true } = {}) {
  if (!state.config?.configured) {
    const error = new Error('The Apps Script API URL is not configured yet.');
    error.code = 'CONFIG';
    throw error;
  }

  const body = JSON.stringify({ action, ...(auth ? { token: state.token } : {}), ...payload });

  let response;
  try {
    response = await fetch(state.config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow'
    });
  } catch {
    const error = new Error('Cannot reach the Apps Script backend. Check your internet connection.');
    error.code = 'NETWORK';
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Backend returned HTTP ${response.status}.`);
    error.code = 'HTTP';
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error('Backend returned an invalid response. Is the Web App deployed with access "Anyone"?');
    error.code = 'PARSE';
    throw error;
  }

  if (!data.ok) {
    const error = new Error(data.error || 'Request failed.');
    error.code = data.code || 'ERROR';
    throw error;
  }

  return data;
}

/* -------------------------------- views -------------------------------- */

function showLogin() {
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  userEmail.textContent = state.username || '';
  userEmail.title = state.username || '';
}

function saveSession(token, username) {
  state.token = token;
  state.username = username || '';
  localStorage.setItem(TOKEN_KEY, token);
  if (username) localStorage.setItem(USER_KEY, username);
}

function clearSession() {
  state.token = '';
  state.username = '';
  state.rows = [];
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function handleAuthError(error) {
  if (error?.code !== 'AUTH') return false;
  clearSession();
  renderCards();
  showLogin();
  showError(loginError, error.message || 'Session expired. Please sign in again.');
  return true;
}

/* ------------------------------ auth flow ------------------------------ */

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(loginError);

  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) {
    showError(loginError, 'Enter your username and password.');
    return;
  }

  setBusy(loginSubmit, true, 'Signing in…');
  try {
    const data = await api('login', { username, password }, { auth: false });
    saveSession(data.token, data.username || username);
    loginForm.reset();
    showApp();
    await loadSubscriptions();
    toast('Signed in.', 'success');
  } catch (error) {
    showError(loginError, error.message || 'Sign in failed.');
  } finally {
    setBusy(loginSubmit, false, 'Sign in');
  }
});

loginConfigBtn.addEventListener('click', openSettings);
btnSettings.addEventListener('click', openSettings);

btnSignout.addEventListener('click', () => {
  clearSession();
  renderCards();
  showLogin();
  toast('Signed out.', 'warn');
});

/* ---------------------------- data loading ----------------------------- */

async function loadSubscriptions({ silent = false } = {}) {
  if (!state.token) return;
  if (!silent) syncState.textContent = 'Syncing…';

  try {
    const data = await api('list');
    state.rows = data.rows || [];
    renderCards();
    syncState.textContent = `Synced ${new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    if (handleAuthError(error)) return;
    syncState.textContent = 'Sync failed';
    if (!silent) toast(`Could not load extenders: ${error.message}`, 'error');
  }
}

/* -------------------------------- cards -------------------------------- */

function countdownMarkup(row, nowMs = Date.now()) {
  const expiry = toDate(row.expires_at);
  if (!expiry || expiry.getTime() <= nowMs) return '<span class="cd-expired">Expired</span>';

  const diff = expiry.getTime() - nowMs;
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);

  return `
    <span class="cd-part"><span class="cd-num">${days}</span><span class="cd-unit">d</span></span>
    <span class="cd-part"><span class="cd-num">${pad(hours)}</span><span class="cd-unit">h</span></span>
    <span class="cd-part"><span class="cd-num">${pad(minutes)}</span><span class="cd-unit">m</span></span>
  `.trim();
}

function powerLabel(row) {
  if (row.actual_power_state === true) return 'Plug reports ON';
  if (row.actual_power_state === false) return 'Plug reports OFF';
  return 'Plug state unknown';
}

function bridgeChip(row) {
  const online = isBridgeOnline(row);
  return `<span class="chip ${online ? 'chip--ok' : 'chip--warn'}" data-role="bridge">
      <svg class="icon"><use href="#${online ? 'i-wifi' : 'i-wifi-off'}" /></svg>
      ${online ? 'Bridge online' : 'Bridge offline'}
    </span>`;
}

function cardMarkup(row) {
  const expired = isExpiredAt(row);
  const desiredOn = Boolean(row.desired_power_state);

  return `
  <article class="card ${expired ? 'card--expired' : ''}" data-card="${escapeHtml(row.id)}">
    <header class="card__head">
      <div>
        <h3 class="card__title">${escapeHtml(row.device_name || 'Unnamed extender')}</h3>
        <p class="card__sub">${escapeHtml(row.subscriber_name || 'No subscriber assigned')}</p>
      </div>
      <span class="badge ${expired ? 'badge--expired' : 'badge--active'}" data-role="badge">
        <span class="dot"></span>${expired ? 'EXPIRED' : 'ACTIVE'}
      </span>
    </header>

    <div class="countdown-block">
      <span class="countdown-label">Time remaining</span>
      <div class="countdown" data-role="countdown">${countdownMarkup(row)}</div>
    </div>

    <dl class="card__meta">
      <div>
        <dt>Expires</dt>
        <dd data-role="expiry">${escapeHtml(formatDateTime(row.expires_at))}</dd>
      </div>
      <div>
        <dt>Plug power</dt>
        <dd data-role="power">${escapeHtml(powerLabel(row))}</dd>
      </div>
    </dl>

    <div class="card__chips">
      ${bridgeChip(row)}
      <span class="chip" title="Static local IP">
        <svg class="icon"><use href="#i-plug" /></svg>
        ${escapeHtml(row.tapo_ip || 'No IP')}
      </span>
      <span class="chip hide-sm">
        <svg class="icon"><use href="#i-clock" /></svg>
        Renewed ${escapeHtml(formatDateTime(row.last_renewed_at))}
      </span>
    </div>

    <div class="card__actions">
      <button class="btn btn--primary" type="button" data-action="renew">
        <svg class="icon"><use href="#i-zap" /></svg>
        Renew
      </button>
      <button class="icon-btn" type="button" data-action="edit" aria-label="Edit ${escapeHtml(row.device_name || 'extender')}">
        <svg class="icon"><use href="#i-edit" /></svg>
      </button>
    </div>

    <div class="override">
      <div class="override__text">
        <span>Manual override</span>
        <small data-role="desired-label">${desiredOn ? 'Force ON requested' : 'Force OFF requested'}</small>
      </div>
      <button class="switch ${desiredOn ? 'is-on' : ''}" type="button" role="switch"
        aria-checked="${desiredOn ? 'true' : 'false'}" aria-label="Desired plug power"
        data-action="override" data-on="${desiredOn ? 'true' : 'false'}">
        <span class="switch__thumb"></span>
      </button>
    </div>
  </article>`;
}

function renderCards() {
  if (!state.rows.length) {
    cardsEl.innerHTML = '';
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    cardsEl.innerHTML = state.rows.map(cardMarkup).join('');
  }
  updateBridgeSummary();
  tick();
}

function updateBridgeSummary() {
  const total = state.rows.length;
  const online = state.rows.filter(isBridgeOnline).length;
  bridgeSummary.className = `chip ${online > 0 ? 'chip--ok' : 'chip--warn'}`;
  bridgeSummary.innerHTML = `
    <svg class="icon"><use href="#${online > 0 ? 'i-wifi' : 'i-wifi-off'}" /></svg>
    <span>${total ? `${online}/${total} bridge${total === 1 ? '' : 's'} online` : 'No bridge'}</span>`;
}

function tick() {
  if (!state.rows.length) return;
  const now = Date.now();

  for (const row of state.rows) {
    const card = cardsEl.querySelector(`[data-card="${row.id}"]`);
    if (!card) continue;

    const expired = isExpiredAt(row, now);
    card.classList.toggle('card--expired', expired);

    const countdown = card.querySelector('[data-role="countdown"]');
    if (countdown) countdown.innerHTML = countdownMarkup(row, now);

    const badge = card.querySelector('[data-role="badge"]');
    if (badge) {
      badge.className = `badge ${expired ? 'badge--expired' : 'badge--active'}`;
      badge.innerHTML = `<span class="dot"></span>${expired ? 'EXPIRED' : 'ACTIVE'}`;
    }

    const bridge = card.querySelector('[data-role="bridge"]');
    if (bridge) {
      const online = isBridgeOnline(row);
      bridge.className = `chip ${online ? 'chip--ok' : 'chip--warn'}`;
      bridge.innerHTML = `<svg class="icon"><use href="#${online ? 'i-wifi' : 'i-wifi-off'}" /></svg>${online ? 'Bridge online' : 'Bridge offline'}`;
    }
  }
}

/* ------------------------------ card actions --------------------------- */

function rowById(id) {
  return state.rows.find((row) => String(row.id) === String(id)) || null;
}

function planByDays(days) {
  const fallback = RENEWAL_PLANS[RENEWAL_PLANS.length - 1];
  return RENEWAL_PLANS.find((plan) => plan.days === Number(days)) || fallback;
}

function selectedPlan() {
  return planByDays($('input[name="renew-plan"]:checked')?.value ?? DEFAULT_RENEWAL_DAYS);
}

function renewalBase(row, mode) {
  const expiry = toDate(row.expires_at);
  const active = !isExpiredAt(row);
  if (active && mode === 'extend' && expiry) return expiry;
  return new Date();
}

function updateRenewPreview() {
  const row = rowById(state.renewTargetId);
  if (!row) return;
  const mode = $('input[name="renew-mode"]:checked')?.value || 'reset';
  const plan = selectedPlan();
  const base = renewalBase(row, mode);
  const active = !isExpiredAt(row);
  const expiry = toDate(row.expires_at);

  renewLength.textContent = `${plan.days} days`;
  renewPreview.textContent = formatDateTime(new Date(base.getTime() + plan.days * DAY_MS));

  renewExtendHint.textContent = active && expiry
    ? `Adds ${plan.days} days on top of ${formatDateTime(expiry)}.`
    : 'Not available while this subscription is expired.';
  renewResetHint.textContent = `Starts a fresh ${plan.days}-day period from now.`;
}

function openRenewModal(row) {
  state.renewTargetId = row.id;
  const active = !isExpiredAt(row);

  renewDevice.textContent = `${row.device_name || 'Extender'} · ${row.subscriber_name || 'No subscriber'}`;
  renewCurrent.textContent = formatDateTime(row.expires_at);
  clearError(renewError);

  const defaultPlan = planByDays(DEFAULT_RENEWAL_DAYS);
  const planInput = renewPlans.querySelector(`input[name="renew-plan"][value="${defaultPlan.days}"]`);
  if (planInput) planInput.checked = true;
  renewAmount.value = String(defaultPlan.amount);

  renewExtend.disabled = !active;
  renewExtend.checked = active;
  $('#renew-mode-reset').checked = !active;

  updateRenewPreview();
  openModal(renewModal);
}

renewPlans.addEventListener('change', () => {
  renewAmount.value = String(selectedPlan().amount);
  updateRenewPreview();
});

$('#renew-modes').addEventListener('change', updateRenewPreview);

renewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const row = rowById(state.renewTargetId);
  if (!row) return;

  const mode = $('input[name="renew-mode"]:checked')?.value || 'reset';
  const plan = selectedPlan();
  const rawAmount = renewAmount.value.trim();
  const amount = rawAmount === '' ? null : Number(rawAmount);

  clearError(renewError);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    showError(renewError, 'Amount paid must be a positive number, or leave it blank.');
    return;
  }

  setBusy(renewSubmit, true, 'Renewing…');
  try {
    await api('renew', { id: row.id, mode, days: plan.days, amount });
    closeModal(renewModal);
    await loadSubscriptions({ silent: true });
    toast(`${row.device_name || 'Extender'} renewed for ${plan.days} days — plug power ON requested.`, 'success');
  } catch (error) {
    if (handleAuthError(error)) return;
    showError(renewError, error.message || 'Renewal failed.');
  } finally {
    setBusy(renewSubmit, false, 'Confirm renewal');
  }
});

function setSwitch(card, on) {
  const button = card?.querySelector('[data-action="override"]');
  if (!button) return;
  button.classList.toggle('is-on', on);
  button.setAttribute('aria-checked', on ? 'true' : 'false');
  button.dataset.on = on ? 'true' : 'false';
  const label = card.querySelector('[data-role="desired-label"]');
  if (label) label.textContent = on ? 'Force ON requested' : 'Force OFF requested';
}

async function toggleOverride(row) {
  const next = !row.desired_power_state;
  const card = cardsEl.querySelector(`[data-card="${row.id}"]`);
  const button = card?.querySelector('[data-action="override"]');

  setSwitch(card, next);
  row.desired_power_state = next;
  if (button) button.setAttribute('aria-busy', 'true');

  try {
    await api('setPower', { id: row.id, on: next });
    toast(
      `${row.device_name || 'Extender'}: bridge will turn the plug ${next ? 'ON' : 'OFF'} within 30 seconds.`,
      next ? 'success' : 'warn'
    );
  } catch (error) {
    row.desired_power_state = !next;
    setSwitch(card, !next);
    if (handleAuthError(error)) return;
    toast(`Could not change power state: ${error.message}`, 'error');
  } finally {
    if (button) button.removeAttribute('aria-busy');
  }
}

cardsEl.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const card = trigger.closest('[data-card]');
  const row = card ? rowById(card.dataset.card) : null;
  if (!row) return;

  if (trigger.dataset.action === 'renew') openRenewModal(row);
  if (trigger.dataset.action === 'edit') openExtenderModal(row);
  if (trigger.dataset.action === 'override') void toggleOverride(row);
});

/* ---------------------------- add / edit plug -------------------------- */

function openExtenderModal(row = null) {
  state.editTargetId = row?.id || null;
  extenderTitle.textContent = row ? 'Edit extender' : 'Add extender';
  extName.value = row?.device_name || '';
  extSubscriber.value = row?.subscriber_name || '';
  extIp.value = row?.tapo_ip || '';
  clearError(extError);
  openModal(extenderModal);
  setTimeout(() => extName.focus(), 120);
}

btnAdd.addEventListener('click', () => openExtenderModal());
document.querySelectorAll('[data-add-extender]').forEach((button) => {
  button.addEventListener('click', () => openExtenderModal());
});

extenderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(extError);

  const deviceName = extName.value.trim();
  const subscriberName = extSubscriber.value.trim();
  const tapoIp = extIp.value.trim();

  if (!deviceName) {
    showError(extError, 'Device name is required.');
    return;
  }
  if (!isValidIPv4(tapoIp)) {
    showError(extError, 'Enter the plug\'s static IPv4 address, e.g. 192.168.1.50');
    return;
  }

  const editing = Boolean(state.editTargetId);
  const payload = {
    device_name: deviceName,
    subscriber_name: subscriberName,
    tapo_ip: tapoIp
  };
  if (editing) payload.id = state.editTargetId;

  setBusy(extenderSubmit, true, 'Saving…');
  try {
    await api('saveSubscription', payload);
    closeModal(extenderModal);
    await loadSubscriptions({ silent: true });
    toast(editing ? 'Extender updated.' : 'Extender registered. Renew it to start the 30-day period.', 'success');
  } catch (error) {
    if (handleAuthError(error)) return;
    showError(extError, error.message || 'Save failed.');
  } finally {
    setBusy(extenderSubmit, false, 'Save extender');
  }
});

/* -------------------------------- history ------------------------------ */

async function loadHistory() {
  historyLoading.classList.remove('hidden');
  historyList.classList.add('hidden');
  historyEmpty.classList.add('hidden');

  try {
    const data = await api('history');
    const rows = data.rows || [];

    historyLoading.classList.add('hidden');

    if (!rows.length) {
      historyEmpty.classList.remove('hidden');
      return;
    }

    historyList.classList.remove('hidden');
    historyList.innerHTML = rows
      .map((entry) => {
        const amount = entry.amount_paid === null || entry.amount_paid === undefined
          ? '—'
          : currencyFormatter.format(Number(entry.amount_paid));
        const days = Number(entry.days) || null;
        const plan = RENEWAL_PLANS.find((item) => item.days === days) || null;
        const planLabel = days
          ? (plan ? `${plan.days} days · ₱${plan.amount}` : `${days} days`)
          : 'Plan not recorded';
        return `
          <li class="history-item">
            <div class="history-item__top">
              <strong>${escapeHtml(entry.device_name || 'Deleted extender')}</strong>
              <span class="history-amount">${escapeHtml(amount)}</span>
            </div>
            <div class="history-item__meta">
              <span class="history-plan">${escapeHtml(planLabel)}</span>
              <span>Renewed ${escapeHtml(formatDateTime(entry.renewed_at))}</span>
            </div>
            <div class="history-item__dates">
              ${escapeHtml(formatDateTime(entry.previous_expiry))} → ${escapeHtml(formatDateTime(entry.new_expiry))}
            </div>
          </li>`;
      })
      .join('');
  } catch (error) {
    historyLoading.classList.add('hidden');
    historyEmpty.classList.remove('hidden');
    if (handleAuthError(error)) return;
    toast(`Could not load history: ${error.message}`, 'error');
  }
}

btnHistory.addEventListener('click', () => {
  openModal(historyDrawer);
  void loadHistory();
});

/* ------------------------------- refresh ------------------------------- */

btnRefresh.addEventListener('click', async () => {
  btnRefresh.classList.add('is-spinning');
  void loadBackendVersion();
  await loadSubscriptions();
  setTimeout(() => btnRefresh.classList.remove('is-spinning'), 400);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token) void loadSubscriptions({ silent: true });
});

/* -------------------------------- boot --------------------------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}

function startTimers() {
  clearInterval(state.tickTimer);
  clearInterval(state.pollTimer);
  state.tickTimer = setInterval(tick, 1000);
  state.pollTimer = setInterval(() => {
    if (state.token && document.visibilityState === 'visible') void loadSubscriptions({ silent: true });
  }, POLL_MS);
}

async function restoreSession() {
  if (!state.token) {
    showLogin();
    return;
  }
  try {
    const data = await api('session');
    state.username = data.username || state.username;
    showApp();
    await loadSubscriptions();
  } catch (error) {
    clearSession();
    renderCards();
    showLogin();
    if (error.code === 'AUTH') {
      showError(loginError, 'Session expired. Please sign in again.');
    }
  }
}

/* ---------------------------- backend version -------------------------- */

/** Ping the Web App so a stale Apps Script deployment is obvious in the footer. */
async function loadBackendVersion() {
  if (!backendVersion) return;

  const markStale = (text, title) => {
    backendVersion.textContent = text;
    backendVersion.classList.add('is-stale');
    backendVersion.title = title;
  };

  if (!state.config?.configured) {
    markStale('Backend v?', 'The Apps Script API URL is not configured yet.');
    return;
  }

  try {
    const response = await fetch(`${state.config.url}?action=ping`, { redirect: 'follow' });
    const data = await response.json();
    const version = String(data.version || '');
    if (!version) {
      markStale('Backend v?', 'The deployed Apps Script does not report a version — redeploy it.');
      return;
    }
    backendVersion.textContent = `Backend v${version}`;
    backendVersion.classList.toggle('is-stale', version !== EXPECTED_BACKEND_VERSION);
    backendVersion.title = version === EXPECTED_BACKEND_VERSION
      ? 'Apps Script backend is up to date.'
      : `Deployed backend is ${version}; this app expects ${EXPECTED_BACKEND_VERSION}. Redeploy the Apps Script as a new version.`;
  } catch {
    markStale('Backend v?', 'Could not read the backend version from the Apps Script Web App.');
  }
}

async function boot() {
  registerServiceWorker();
  state.config = loadConfig();
  startTimers();
  showLogin();

  if (!state.config.configured) {
    showError(loginError, 'The Apps Script API URL is not configured yet. Use the button below to add it.');
    openSettings();
    return;
  }

  void loadBackendVersion();
  await restoreSession();
}

void boot();
