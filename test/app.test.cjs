const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { harness } = require('./helpers.cjs');
const { phone, smsParts } = require('../lib/validation');
const { matchReply } = require('../lib/sync');
const { createProvider } = require('../lib/provider');
const payload = (extra = {}) => ({ request_id: randomUUID(), body: 'Booran test SMS', sender: '61400000000', kind: 'text', ...extra });

test('login protects send/history and denies forged cookies and cross-site writes', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/threads', 'GET', undefined, { cookie: '' })).status, 401);
  assert.equal((await request('/threads', 'GET', undefined, { cookie: 'sms_lab=9999999999999.fake.signature' })).status, 401);
  assert.equal((await request('/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await request('/threads', 'POST', { phone: '0412345678' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/threads', 'POST', { phone: '0412345678' }, { 'content-type': 'text/plain' })).status, 415);
  const login = await request('/login', 'POST', { password: 'test-password-only' });
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const logout = await request('/logout', 'POST', {});
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('normalizes Australian phones and bounds GSM/Unicode SMS parts', () => {
  assert.equal(phone('0412 345 678'), '+61412345678');
  assert.equal(phone('+61 (412) 345-678'), '+61412345678');
  assert.throws(() => phone('+12025550100'));
  assert.equal(smsParts('A'.repeat(160)).parts, 1);
  assert.equal(smsParts('^'.repeat(81)).parts, 2);
  assert.equal(smsParts('🙂'.repeat(36)).parts, 2);
});

test('one thread per normalized phone, rejects invalid inputs and unapproved senders', async t => {
  let calls = 0;
  const { request, thread } = await harness(t, { provider: { send: async () => { calls++; return { status: 'queued' }; } } });
  const a = await thread();
  const b = (await request('/threads', 'POST', { phone: '+61412345678' })).body.thread;
  assert.equal(a._id, b._id);
  assert.equal((await request('/threads', 'POST', { phone: 'invalid' })).status, 400);
  for (const invalid of [payload({ sender: 'not-approved' }), payload({ body: ' ' }), payload({ body: '🙂'.repeat(336) }), payload({ request_id: 'bad' })]) assert.equal((await request(`/threads/${a._id}/messages`, 'POST', invalid)).status, 400);
  assert.equal(calls, 0);
});

test('duplicate and concurrent request IDs send only once and conflicting payloads return 409', async t => {
  let calls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { request, thread, records } = await harness(t, { provider: { send: async () => { calls++; await wait; return { status: 'queued', provider_message_id: 'out-1' }; } } });
  const a = await thread(); const data = payload();
  const first = request(`/threads/${a._id}/messages`, 'POST', data);
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await request(`/threads/${a._id}/messages`, 'POST', data);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.message.status, 'pending');
  release(); assert.equal((await first).body.message.status, 'queued');
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', data)).body.duplicate, true);
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', { ...data, body: 'changed' })).status, 409);
  assert.equal(calls, 1); assert.equal(records.messages.length, 1);
});

test('unknown provider acceptance stays visible and cannot be resent with the same ID', async t => {
  let calls = 0;
  const { request, thread } = await harness(t, { provider: { send: async () => { calls++; return { status: 'unknown', error: 'Check provider.' }; } } });
  const a = await thread(); const data = payload();
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', data)).body.message.status, 'unknown');
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', data)).body.message.status, 'unknown');
  const history = await request(`/threads/${a._id}`);
  assert.equal(history.body.messages[0].status, 'unknown'); assert.equal(calls, 1);
});

test('verification code is handset-only, bounded, single use and updates its original thread', async t => {
  let sent;
  const { request, thread, records } = await harness(t, { provider: { send: async value => { sent = value; return { status: 'queued', provider_message_id: 'otp-1' }; } } });
  const a = await thread(); const data = payload({ kind: 'verification', body: '' });
  const response = await request(`/threads/${a._id}/messages`, 'POST', data);
  assert.equal(response.status, 200);
  const code = sent.body.match(/code is (\d{6})/)[1];
  const token = sent.body.match(/\/verify\/([a-f0-9]+)/)[1];
  assert.ok(!JSON.stringify(response.body).includes(code));
  assert.ok(!JSON.stringify(response.body).includes(token));
  assert.ok(!JSON.stringify(records.messages).includes(code));
  assert.equal((await request(`/verify/${token}`, 'POST', { code: '000000' }, { cookie: '' })).status, 400);
  assert.equal((await request(`/verify/${token}`, 'POST', { code }, { cookie: '' })).status, 200);
  assert.equal((await request(`/verify/${token}`, 'POST', { code }, { cookie: '' })).status, 400);
  assert.ok(records.threads[0].verified_at);
  assert.equal(records.messages.filter(row => row.direction === 'system').length, 1);
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', data)).body.duplicate, true);
});

test('verification expires exactly at deadline and locks after five incorrect guesses', async t => {
  let sent;
  const { request, thread, records } = await harness(t, { provider: { send: async value => { sent = value; return { status: 'queued', provider_message_id: 'otp-2' }; } } });
  const a = await thread(); await request(`/threads/${a._id}/messages`, 'POST', payload({ kind: 'verification' }));
  const code = sent.body.match(/code is (\d{6})/)[1], token = sent.body.match(/\/verify\/([a-f0-9]+)/)[1];
  records.verifications[0].expires_at = new Date(0);
  assert.equal((await request(`/verify/${token}`, 'POST', { code }, { cookie: '' })).status, 400);
  records.verifications[0].expires_at = new Date(Date.now() + 100000);
  for (let i = 0; i < 5; i++) assert.equal((await request(`/verify/${token}`, 'POST', { code: '000000' }, { cookie: '' })).status, 400);
  assert.equal((await request(`/verify/${token}`, 'POST', { code }, { cookie: '' })).status, 400);
  assert.equal(records.threads[0].verified_at, undefined);
});

test('production verification requires a public HTTPS URL', async t => {
  let calls = 0;
  const { request, thread } = await harness(t, { env: { APP_URL: 'http://localhost:3100', NODE_ENV: 'production' }, provider: { send: async () => { calls++; } } });
  const a = await thread();
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', payload({ kind: 'verification' }))).status, 503);
  assert.equal(calls, 0);
});

test('inbound correlates to both numbers and original ID, paginates and deduplicates', async t => {
  let calls = 0;
  let events = [];
  const { request, thread, records } = await harness(t, { provider: { inbound: async (from, offset) => { calls++; return { results: events.slice(offset, offset + 1), total: events.length }; }, receipt: async () => ({ status: 'delivered', provider_message_id: 'provider-1' }) } });
  const a = await thread(); const data = payload();
  await request(`/threads/${a._id}/messages`, 'POST', data);
  records.messages[0].created_at = '2026-01-01T00:00:00.000Z';
  const event = { message_id: 'reply-1', from: '0412345678', to: '61400000000', original_message_id: 'provider-1', original_custom_ref: `lab:${data.request_id}`, message: 'It works!', type: 'inbound', received_at: '2026-10-25 10:30:00' };
  events = [event, { ...event, message_id: 'foreign', original_message_id: 'sales-floor-1', original_custom_ref: 'sales-floor-ref' }, { ...event, message_id: 'wrong-phone', from: '61433333333' }, { ...event, message_id: 'wrong-sender', to: '61455555555' }];
  let history = await request(`/threads/${a._id}`);
  assert.equal(history.body.messages.length, 2); assert.equal(calls, 4);
  assert.equal(history.body.messages[0].status, 'delivered');
  assert.equal(history.body.messages[1].body, 'It works!');
  records.threads[0].inbound_synced_at = '2026-01-01T00:00:00.000Z';
  history = await request(`/threads/${a._id}`);
  assert.equal(history.body.messages.length, 2); assert.equal(records.messages.length, 2);
  const outgoing = records.messages.filter(row => row.direction === 'outbound');
  assert.equal(matchReply({ ...event, original_message_id: 'conflict' }, outgoing), undefined);
});

test('inbox outage preserves messages and checkpoint; opt-outs disable sending', async t => {
  let fail = true;
  let event;
  const { request, thread, records } = await harness(t, { provider: { inbound: async () => { if (fail) throw new Error('offline'); return { results: [event], total: 1 }; } } });
  const a = await thread(); await request(`/threads/${a._id}/messages`, 'POST', payload());
  records.messages[0].created_at = '2026-01-01T00:00:00.000Z';
  let history = await request(`/threads/${a._id}`);
  assert.equal(history.body.messages.length, 1); assert.match(history.body.warnings.join(''), /Incoming replies/);
  assert.equal(records.threads[0].inbound_synced_at, undefined);
  fail = false; event = { message_id: 'stop-1', from: '61412345678', to: '61400000000', original_message_id: 'provider-1', type: 'unsubscribe', message: 'STOP', received_at: '2026-10-25 10:00:00' };
  history = await request(`/threads/${a._id}`);
  assert.equal(history.body.thread.unsubscribed, true);
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', payload())).status, 409);
});

test('send attempts are rate limited across instances through the shared database', async t => {
  const { request, thread } = await harness(t);
  const a = await thread();
  for (let i = 0; i < 12; i++) assert.equal((await request(`/threads/${a._id}/messages`, 'POST', payload())).status, 200);
  assert.equal((await request(`/threads/${a._id}/messages`, 'POST', payload())).status, 429);
});

test('provider uses documented request shape and distinguishes own phones from two-way senders', async () => {
  const calls = [];
  const env = { MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'fixture-secret' };
  const provider = createProvider(env, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/senders')) return { ok: true, json: async () => ({ status: 'complete', results: [{ sender: 'BOORAN', type: 'alpha' }, { sender: '61400000000', type: 'dedicated' }, { sender: '61411111111', type: 'own' }] }) };
    return { ok: true, status: 200, json: async () => ({ results: [{ status: 'success', message_id: 'id-1' }] }) };
  });
  assert.deepEqual((await provider.senders()).map(row => row.reply_capable), [false, true, false]);
  assert.equal((await provider.send({ phone: '+61412345678', body: 'test', sender: 'BOORAN', id: 'lab:test' })).status, 'queued');
  assert.equal(calls[1].options.headers.Authorization, `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { enable_unicode: true, messages: [{ to: '+61412345678', message: 'test', sender: 'BOORAN', custom_ref: 'lab:test' }] });
  const unavailable = createProvider(env, async () => { throw new Error('Timeout'); });
  assert.equal((await unavailable.send({})).status, 'unknown');
});

test('provider receipt rejects mismatched recipient/message and recovers unknown acceptance by reference', async () => {
  let result = { to: '61499999999', message_id: 'id-1', custom_ref: 'lab:1', status: 'delivered' };
  const provider = createProvider({ MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'fixture' }, async () => ({ ok: true, json: async () => ({ results: [result] }) }));
  const row = { _id: 'lab:1', phone: '+61412345678', provider_message_id: 'id-1' };
  assert.equal(await provider.receipt(row), null);
  result = { ...result, to: '61412345678', message_id: 'other' };
  assert.equal(await provider.receipt(row), null);
  assert.equal((await provider.receipt({ ...row, provider_message_id: undefined })).status, 'delivered');
});

test('serves branded UI and public verification assets with security headers', async t => {
  const { base } = await harness(t);
  for (const file of ['/', '/styles.css', '/salesfloor.css', '/app.js', '/booran-logo.png', '/verify/abc', '/verify.js']) {
    const response = await fetch(base + file); assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await fetch(base + '/.env')).status, 404);
});
