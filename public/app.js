/* This client contains no provider credentials. All sending happens on the server. */
const $ = id => document.getElementById(id);
let threads = [], active, settings, currentMessages = [], busy = false, loading = false, draftRequest, timer, toastTimer;
let refreshEpoch = 0;
let view = 'conversations';
let renderedMessagesKey = null;
const drafts = new Map();
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    throw new Error(data.error || 'The workspace is temporarily unavailable.');
  }
  return data;
}
const post = (path, value) => api(path, { method: 'POST', body: JSON.stringify(value) });
function node(tag, className, value) { const el = document.createElement(tag); if (className) el.className = className; if (value !== undefined) el.textContent = value; return el; }
function toast(value) { $('toast').textContent = value; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
function notice(id, text) { $(id).textContent = text || ''; $(id).hidden = !text; }
function initials(name) { return name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(); }
function time(value) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function showLogin() { clearInterval(timer); $('workspace').hidden = true; $('login-screen').hidden = false; }
function showConversationPanel(panel) {
  $('inbox-shell').setAttribute('data-panel', panel);
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('inbox-shell').scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    if (panel === 'list') $('conversations-heading').focus({ preventScroll: true });
  }
}
function showView(next) {
  view = next;
  const views = {
    conversations: ['SMS Test Lab', 'Send, verify and reply. Your complete SMS testing workspace.', 'SMS conversations', 'inbox'],
    senders: ['Sender & connection', 'Check your configured sender and how replies return.', 'Sender & connection', 'senders'],
    guide: ['Testing guide', 'A simple walkthrough for your Booran SMS acceptance test.', 'Testing guide', 'guide'],
  };
  const [title, description, breadcrumb, nav] = views[next];
  $('page-title').replaceChildren(document.createTextNode(title), node('span', 'red-dot', '.'));
  $('page-description').textContent = description;
  $('breadcrumb-view').textContent = breadcrumb;
  for (const key of Object.keys(views)) $(`${key}-view`).hidden = key !== next;
  for (const name of ['inbox', 'senders', 'guide']) {
    const selected = name === nav;
    $(`${name}-nav`).classList.toggle('active', selected);
    $(`mobile-${name}`).classList.toggle('active', selected);
    if (selected) $(`${name}-nav`).setAttribute('aria-current', 'page');
    else $(`${name}-nav`).removeAttribute('aria-current');
  }
  if (next === 'conversations' && active) refreshThread();
}
function renderThreads() {
  const search = $('search').value.toLowerCase();
  const list = $('threads'); list.replaceChildren();
  const filtered = threads.filter(row => `${row.name} ${row.phone}`.toLowerCase().includes(search));
  $('thread-count').textContent = $('list-count').textContent = String(threads.length);
  if (!filtered.length) list.append(node('p', 'no-threads', threads.length ? 'No matching conversations.' : 'No conversations yet. Add your test phone to get started.'));
  for (const row of filtered) {
    const item = node('button', `thread-item${row._id === active ? ' selected' : ''}`);
    item.setAttribute('aria-pressed', String(row._id === active));
    item.append(node('span', 'avatar', initials(row.name)));
    const detail = node('div'); const title = node('div', 'thread-title');
    title.append(node('strong', '', row.name), node('time', '', new Date(row.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })));
    detail.append(title, node('p', '', row.phone), node('p', '', row.last_preview || 'Ready for your first test message'));
    item.append(detail); item.onclick = () => openThread(row._id); list.append(item);
  }
}
async function loadThreads() { const data = await api('/threads'); threads = data.threads; renderThreads(); }
function renderSenders() {
  $('sender').textContent = settings.sender?.sender || 'Sender unavailable';
  senderHelp();
}
function senderHelp() {
  const row = settings?.sender;
  $('sender-type').textContent = row?.reply_capable ? 'Two-way SMS' : row?.type === 'own' ? 'Replies to phone' : 'One-way SMS';
  $('sender-type').classList.toggle('one-way', !row?.reply_capable);
  $('sender-help').textContent = !row ? 'The configured SMS sender is unavailable. Check the connection.' : row.reply_capable ? 'Reply from your phone to this number. Your reply appears in this conversation.' : row.type === 'own' ? 'Replies to this sender go to its physical phone and cannot appear in this inbox.' : 'This branded sender supports outbound SMS only. SMS replies are not supported.';
  updateButtons();
}
function updateButtons() {
  const unavailable = busy || !active || !settings?.sender || threads.find(t => t._id === active)?.unsubscribed;
  $('send').disabled = Boolean(unavailable || !$('message').value.trim());
  $('verification-send').disabled = Boolean(unavailable || !settings?.app_url);
  $('message').disabled = busy;
  $('send-label').textContent = busy ? 'Sending…' : 'Send SMS';
  for (const button of document.querySelectorAll('[data-template]')) button.disabled = busy;
}
function renderMetrics(thread) {
  $('sent-count').textContent = String(currentMessages.filter(m => m.direction === 'outbound' && ['queued', 'scheduled', 'sent', 'delivered'].includes(m.status)).length);
  $('delivered-count').textContent = String(currentMessages.filter(m => m.direction === 'outbound' && m.status === 'delivered').length);
  $('received-count').textContent = String(currentMessages.filter(m => m.direction === 'inbound').length);
  $('verified-state').textContent = thread.verified_at ? 'Verified' : 'Not verified';
  $('verified-state').classList.toggle('success', Boolean(thread.verified_at));
  $('phone-badge').hidden = !thread.verified_at;
}
function renderMessages(rows) {
  const area = $('messages');
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90;
  const previous = renderedMessagesKey;
  const next = rows.map(m => `${m._id}:${m.status}`).join('|');
  currentMessages = rows;
  if (previous === next) return;
  renderedMessagesKey = next;
  area.replaceChildren();
  if (!rows.length) area.append(node('div', 'message-empty', 'Your test thread is ready.\nSend a message or try a verification SMS below.'));
  let day;
  for (const row of rows) {
    const label = new Date(row.created_at).toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' });
    if (label !== day) { area.append(node('div', 'message-day', label)); day = label; }
    const item = node('article', `message ${row.direction}`);
    item.append(node('div', 'bubble', row.body));
    const meta = node('div', 'message-meta');
    meta.append(node('span', '', time(row.created_at)));
    if (row.sender) meta.append(node('span', '', row.direction === 'outbound' ? `From ${row.sender}` : `To ${row.sender}`));
    const statusLabel = row.status === 'pending' ? 'Acceptance unconfirmed' : row.status === 'queued' ? 'Queued · accepted by provider' : row.status === 'delivered' ? '✓✓ Delivered' : row.status === 'received' ? '↙ Received' : row.status === 'unknown' ? 'Acceptance unconfirmed' : row.status;
    meta.append(node('span', `status ${row.status}`, statusLabel)); item.append(meta);
    if (row.error) item.append(node('p', 'message-error', row.error));
    area.append(item);
  }
  if (atBottom || previous === null) area.scrollTop = area.scrollHeight;
}
async function refreshThread() {
  if (!active || loading || document.hidden) return;
  const id = active, epoch = refreshEpoch;
  loading = true;
  try {
    const data = await api(`/threads/${id}`);
    if (active !== id || epoch !== refreshEpoch) return;
    threads = threads.map(t => t._id === id ? data.thread : t);
    renderMessages(data.messages); renderMetrics(data.thread); renderThreads(); updateButtons();
    notice('sync-warning', [...data.warnings, ...(data.thread.unsubscribed ? ['This phone has opted out. Sending is disabled for this conversation.'] : []), ...(data.messages.length >= data.history_limit ? ['Showing the latest 300 messages.'] : [])].join(' '));
  } catch (error) { if (id === active) notice('sync-warning', error.message); }
  finally { loading = false; }
}
async function openThread(id) {
  if (busy) return toast('Wait for the current send to finish.');
  if (active) drafts.set(active, $('message').value);
  active = id; refreshEpoch++; currentMessages = []; draftRequest = undefined;
  renderedMessagesKey = null;
  showView('conversations');
  const thread = threads.find(row => row._id === id);
  $('contact-name').textContent = thread.name; $('contact-phone').textContent = thread.phone; $('contact-avatar').textContent = initials(thread.name);
  $('empty-state').hidden = true; $('thread-panel').hidden = false;
  showConversationPanel('thread');
  $('messages').replaceChildren(node('p', 'message-empty', 'Loading conversation…'));
  $('message').value = drafts.get(id) || ''; $('send-error').textContent = '';
  updateCounter(); renderThreads(); renderMetrics(thread); notice('sync-warning', '');
  // Let an older fetch finish before refreshing the newly selected thread.
  if (loading) { await new Promise(resolve => { const check = setInterval(() => { if (!loading) { clearInterval(check); resolve(); } }, 100); }); }
  await refreshThread();
}
async function loadSettings() {
  settings = await api('/settings'); renderSenders();
  notice('global-warning', settings.warning || (!settings.sender ? 'The configured SMS sender is unavailable. Check your Mobile Message account.' : ''));
  $('provider-state').textContent = settings.sms_configured && settings.sender ? 'Mobile Message connected' : 'Mobile Message needs configuration';
  $('provider-dot').classList.toggle('danger-dot', !settings.sender);
  $('site-state').textContent = settings.https ? 'HTTPS verification site configured' : 'Local test site · use a public HTTPS URL for phone verification links';
  renderConnection();
}
function renderConnection() {
  const connected = settings.sms_configured && Boolean(settings.sender) && !settings.warning;
  $('header-provider-status').textContent = connected ? 'SMS connected' : 'Needs setup';
  $('header-provider-dot').classList.toggle('danger-dot', !connected);
  $('connection-status').textContent = connected ? 'Connected · configured sender available' : 'Connection needs attention';
  $('connection-status').classList.toggle('error', !connected);
  $('verification-site-status').textContent = settings.https ? 'Public HTTPS site configured' : 'Local testing';
  $('verification-site-url').textContent = settings.app_url || 'Configure the public site URL to enable SMS verification links.';
  $('sender-total').textContent = settings.sender ? 'Configured sender' : 'Unavailable';
  const table = $('sender-table'); table.replaceChildren();
  if (!settings.sender) {
    const row = node('tr'); const cell = node('td', '', settings.warning || 'The configured sender is unavailable. Recheck the connection after configuration.'); cell.colSpan = 3; row.append(cell); table.append(row);
  }
  if (settings.sender) {
    const sender = settings.sender;
    const row = node('tr');
    const name = node('td'); name.append(node('strong', '', sender.sender));
    name.setAttribute('data-label', 'Sender');
    if (sender.label && sender.label !== sender.sender) name.append(node('small', '', sender.label));
    const type = node('td', '', ({ alpha: 'Branded name', dedicated: 'Dedicated number', shared: 'Shared test number', own: 'Personal mobile' })[sender.type] || sender.type || 'Other');
    type.setAttribute('data-label', 'Type');
    const destination = node('td'); destination.append(node('span', `mini-badge${sender.reply_capable ? '' : ' one-way'}`, sender.reply_capable ? 'This interface' : sender.type === 'own' ? 'Personal phone' : 'Replies unavailable'));
    destination.setAttribute('data-label', 'Replies');
    row.append(name, type, destination); table.append(row);
  }
}
async function start() {
  $('login-screen').hidden = true; $('workspace').hidden = false;
  try { await Promise.all([loadSettings(), loadThreads()]); }
  catch (error) { notice('global-warning', error.message); }
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden && !busy && view === 'conversations') { if (active) refreshThread(); else loadThreads().catch(() => {}); } }, 5000);
}
function updateCounter() {
  const value = $('message').value;
  const basic = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
  const extended = new Set('\f^{}\\[~]|€');
  let units = 0, unicode = false;
  for (const c of value) { if (basic.has(c)) units++; else if (extended.has(c)) units += 2; else unicode = true; }
  if (unicode) units = value.length;
  const parts = units <= (unicode ? 70 : 160) ? 1 : Math.ceil(units / (unicode ? 67 : 153));
  $('sms-counter').textContent = `${value.length} characters · ${parts} SMS${unicode ? ' · Unicode' : ''}`;
  updateButtons();
}
async function send(kind) {
  if (busy || !active) return;
  $('send-error').textContent = '';
  const body = $('message').value;
  const payload = { body: kind === 'text' ? body : '', kind };
  const fingerprint = JSON.stringify([active, payload]);
  if (!draftRequest || draftRequest.fingerprint !== fingerprint) draftRequest = { fingerprint, id: crypto.randomUUID() };
  busy = true; updateButtons();
  try {
    const data = await post(`/threads/${active}/messages`, { ...payload, request_id: draftRequest.id });
    if (kind === 'text') { $('message').value = ''; drafts.delete(active); }
    draftRequest = undefined; updateCounter();
    if (['failed', 'unknown', 'pending'].includes(data.message.status)) $('send-error').textContent = data.message.error || 'Acceptance is unconfirmed. Check the thread and provider before sending again.';
    else toast(kind === 'verification' ? 'Verification SMS queued. Open the link on your phone and enter its code.' : 'SMS accepted by Mobile Message. Watching for delivery and replies.');
    await refreshThread(); await loadThreads();
  } catch (error) { $('send-error').textContent = `${error.message} If the request reached the server, retrying the unchanged message uses the same request ID.`; }
  finally { busy = false; updateCounter(); }
}
$('login-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = ''; try { await post('/login', { password: $('password').value }); $('password').value = ''; await start(); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; } };
$('logout').onclick = $('mobile-logout').onclick = async () => { try { await post('/logout', {}); showLogin(); active = undefined; drafts.clear(); } catch (error) { toast(error.message); } };
$('toggle-password').onclick = () => {
  const visible = $('password').type === 'password';
  $('password').type = visible ? 'text' : 'password';
  $('toggle-password').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('toggle-password').setAttribute('aria-pressed', String(visible));
};
function newDialog() { $('new-error').textContent = ''; $('new-dialog').showModal(); }
$('new-thread').onclick = $('empty-new').onclick = $('guide-start').onclick = newDialog;
$('close-dialog').onclick = () => $('new-dialog').close();
$('new-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; try { const data = await post('/threads', { name: $('recipient-name').value, phone: $('recipient-phone').value }); await loadThreads(); $('new-dialog').close(); $('new-form').reset(); await openThread(data.thread._id); } catch (error) { $('new-error').textContent = error.message; } finally { event.submitter.disabled = false; } };
$('search').oninput = renderThreads;
$('refresh-list').onclick = async () => { try { await Promise.all([loadThreads(), loadSettings()]); } catch (error) { toast(error.message); } };
$('refresh-thread').onclick = () => refreshThread();
$('back-to-conversations').onclick = () => showConversationPanel('list');
$('message').oninput = updateCounter;
$('send-form').onsubmit = event => { event.preventDefault(); send('text'); };
$('verification-send').onclick = () => send('verification');
$('inbox-nav').onclick = $('mobile-inbox').onclick = () => showView('conversations');
$('senders-nav').onclick = $('mobile-senders').onclick = () => showView('senders');
$('guide-nav').onclick = $('mobile-guide').onclick = () => showView('guide');
$('recheck-connection').onclick = async event => {
  event.currentTarget.disabled = true;
  try { await loadSettings(); toast('Connection details refreshed.'); }
  catch (error) { toast(error.message); }
  finally { $('recheck-connection').disabled = false; }
};
for (const button of document.querySelectorAll('[data-template]')) button.onclick = () => {
  $('message').value = button.dataset.template === 'branded' ? 'Hi from Booran Motors. This is a branded SMS test. Please check the sender name on your phone.' : 'Hi from Booran Motors. This is our two-way SMS test. Please reply to this message to confirm it arrived.';
  if (button.dataset.template === 'reply' && !settings.sender?.reply_capable) toast('The configured sender does not support replies in this interface.');
  updateCounter(); $('message').focus();
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && active && view === 'conversations' && !$('workspace').hidden) refreshThread(); });
// Track the usable screen height when a phone's keyboard or browser chrome moves.
if (typeof window !== 'undefined' && window.visualViewport) {
  const fitViewport = () => document.documentElement.style.setProperty('--usable-height', `${Math.round(window.visualViewport.height)}px`);
  window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}
api('/session').then(data => { if (data.authenticated) start(); else { showLogin(); if (!data.configured) $('login-error').textContent = 'Run npm run setup:local or configure SMS_LAB_PASSWORD and SMS_LAB_SESSION_SECRET.'; } }).catch(error => { $('login-error').textContent = error.message; });
