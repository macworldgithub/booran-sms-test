const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const { randomUUID, randomInt, randomBytes } = require('node:crypto');
const { database } = require('./lib/database');
const { createProvider } = require('./lib/provider');
const { createAuth } = require('./lib/auth');
const { fail, phone, message, requestId, hash, publicMessage } = require('./lib/validation');
const { syncThread } = require('./lib/sync');

function createApp({ db: getDb = database, provider = createProvider(), env = process.env } = {}) {
  const app = express();
  const auth = createAuth(env);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (env.VERCEL || env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let valid;
        try { valid = new URL(origin).host === req.headers.host; } catch { valid = false; }
        if (!valid) return res.status(403).json({ error: 'Use the SMS workspace to make this request.' });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request denied.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  function publicUrl() {
    let url;
    try { url = new URL(env.APP_URL); } catch { fail('Set APP_URL to the public HTTPS URL before sending verification SMS.', 503); }
    if ((env.VERCEL || env.NODE_ENV === 'production') && url.protocol !== 'https:') fail('APP_URL must use HTTPS in production.', 503);
    if (!['http:', 'https:'].includes(url.protocol)) fail('APP_URL must be an HTTP or HTTPS URL.', 503);
    return url.origin;
  }
  app.get('/api/health', route(async (req, res) => {
    try { await (await getDb()).command({ ping: 1 }); res.status(auth.ready() && provider.configured() ? 200 : 503).json({ ready: auth.ready() && provider.configured() }); }
    catch { res.status(503).json({ ready: false }); }
  }));
  app.get('/api/session', (req, res) => res.json({ authenticated: auth.authenticated(req), configured: auth.ready() }));
  app.post('/api/login', route(async (req, res) => {
    if (!auth.ready()) fail('Configure the workspace password and session secret first.', 503);
    const db = await getDb();
    await auth.limit(db, 'login:global', 120, 900);
    const ip = env.VERCEL ? req.headers['x-vercel-forwarded-for'] || req.socket.remoteAddress : req.socket.remoteAddress;
    await auth.limit(db, `login:${hash(String(ip))}`, 15, 900);
    if (typeof req.body.password !== 'string' || !auth.equal(req.body.password, env.SMS_LAB_PASSWORD)) fail('Incorrect workspace password.', 401);
    auth.cookie(res, auth.issue()); res.json({ ok: true });
  }));
  app.post('/api/logout', auth.requireAuth, (req, res) => { auth.cookie(res, '', true); res.json({ ok: true }); });

  // Only an unguessable verification token is public. Inbox and send APIs require login.
  app.post('/api/verify/:token', route(async (req, res) => {
    if (!/^[a-f0-9]{48}$/.test(req.params.token) || !/^\d{6}$/.test(String(req.body.code || ''))) fail('Enter the six-digit code from your SMS.');
    const db = await getDb();
    const id = hash(req.params.token);
    const check = await db.collection('verifications').findOneAndUpdate({ _id: id, expires_at: { $gt: new Date() }, attempts: { $lt: 5 }, used: false }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
    if (!check) fail('This verification link has expired, was already used, or has too many attempts.');
    if (!auth.equal(check.code_hash, auth.sign(`${id}:${req.body.code}`))) fail('That code does not match. Check your SMS and try again.');
    const consumed = await db.collection('verifications').updateOne({ _id: id, used: false }, { $set: { used: true } });
    if (!consumed.modifiedCount) fail('This code has already been used.');
    await db.collection('threads').updateOne({ _id: check.thread_id }, { $set: { verified_at: new Date().toISOString() } });
    await db.collection('messages').updateOne({ _id: `verified:${id}` }, { $setOnInsert: { _id: `verified:${id}`, thread_id: check.thread_id, direction: 'system', status: 'verified', body: 'Phone verification completed on the Booran verification page.', created_at: new Date().toISOString() } }, { upsert: true });
    res.json({ ok: true });
  }));
  app.use('/api', auth.requireAuth);
  app.get('/api/settings', route(async (req, res) => {
    let senders = [], warning;
    try { senders = await provider.senders(); } catch (error) { warning = error.message; }
    let url; try { url = publicUrl(); } catch {}
    res.json({ sms_configured: provider.configured(), senders, warning, preferred_sender: env.SMS_LAB_REPLY_SENDER || env.MOBILEMESSAGE_SENDER_ID || env.MOBILEMESSAGE_FROM || '', app_url: url, https: url?.startsWith('https:') || false });
  }));
  app.get('/api/threads', route(async (req, res) => {
    const rows = await (await getDb()).collection('threads').find({}).sort({ updated_at: -1 }).limit(200).toArray();
    res.json({ threads: rows.map(({ sync_lock, ...row }) => row) });
  }));
  app.post('/api/threads', route(async (req, res) => {
    const number = phone(req.body.phone);
    const name = String(req.body.name || '').trim().slice(0, 80) || 'Test recipient';
    const db = await getDb();
    const now = new Date().toISOString();
    const row = await db.collection('threads').findOneAndUpdate({ phone: number }, { $setOnInsert: { _id: randomUUID(), phone: number, name, created_at: now, updated_at: now } }, { upsert: true, returnDocument: 'after' });
    res.json({ thread: row });
  }));
  async function getThread(req) {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) fail('Conversation not found.', 404);
    const db = await getDb();
    const thread = await db.collection('threads').findOne({ _id: req.params.id });
    if (!thread) fail('Conversation not found.', 404);
    return { db, thread };
  }
  app.get('/api/threads/:id', route(async (req, res) => {
    const { db, thread } = await getThread(req);
    let warnings = [];
    try { if (provider.configured()) warnings = await syncThread(db, thread, provider); }
    catch { warnings.push('Refresh failed. Showing saved conversation.'); }
    const rows = await db.collection('messages').find({ thread_id: thread._id }).sort({ created_at: -1, _id: -1 }).limit(300).toArray();
    const { sync_lock, ...fresh } = await db.collection('threads').findOne({ _id: thread._id });
    res.json({ thread: fresh, messages: rows.reverse().map(publicMessage), warnings, history_limit: 300 });
  }));
  app.post('/api/threads/:id/messages', route(async (req, res) => {
    const { db, thread } = await getThread(req);
    const id = requestId(req.body.request_id);
    const kind = req.body.kind === 'verification' ? 'verification' : 'text';
    const sender = typeof req.body.sender === 'string' ? req.body.sender : '';
    let body = kind === 'text' ? message(req.body.body) : '';
    const fingerprint = hash(JSON.stringify([thread._id, kind, sender, body]));
    const existing = await db.collection('messages').findOne({ _id: id });
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('This request ID was already used for a different message.', 409);
      return res.json({ message: publicMessage(existing), duplicate: true });
    }
    if (thread.unsubscribed) fail('This recipient has opted out. Use another test recipient.', 409);
    if (!provider.configured()) fail('Mobile Message is not configured.', 503);
    const senders = await provider.senders();
    if (!senders.some(row => row.sender === sender)) fail('Choose an active sender from this Mobile Message account.');
    await auth.limit(db, 'send:workspace', 60, 3600);
    await auth.limit(db, `send:${thread._id}`, 12, 60);
    let verification;
    if (kind === 'verification') {
      await auth.limit(db, `verify-send:${thread._id}`, 1, 60);
      const token = randomBytes(24).toString('hex');
      const code = String(randomInt(100000, 1000000));
      const verificationId = hash(token);
      verification = { _id: verificationId, thread_id: thread._id, code_hash: auth.sign(`${verificationId}:${code}`), expires_at: new Date(Date.now() + 10 * 60000), attempts: 0, used: false };
      body = message(`Booran Motors SMS test. Your verification code is ${code}. Verify within 10 minutes: ${publicUrl()}/verify/${token}`);
    }
    const now = new Date().toISOString();
    const row = { _id: id, thread_id: thread._id, phone: thread.phone, sender, direction: 'outbound', kind, body: kind === 'verification' ? 'Booran verification SMS · code and secure link sent to handset' : body, fingerprint, status: 'pending', created_at: now };
    try { await db.collection('messages').insertOne(row); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const saved = await db.collection('messages').findOne({ _id: id });
      if (saved?.fingerprint !== fingerprint) fail('Request ID conflict.', 409);
      return res.json({ message: publicMessage(saved), duplicate: true });
    }
    // Persist the send claim before contacting the provider. A failed response is never auto-resubmitted.
    if (verification) await db.collection('verifications').insertOne(verification);
    const result = await provider.send({ phone: thread.phone, body, sender, id });
    await db.collection('messages').updateOne({ _id: id }, { $set: result });
    await db.collection('threads').updateOne({ _id: thread._id }, { $set: { updated_at: now, last_preview: row.body, last_direction: 'outbound' } });
    res.json({ message: publicMessage({ ...row, ...result }) });
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.get('/verify/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify.html')));
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
  app.use((req, res) => res.status(404).send('Page not found.'));
  app.use((error, req, res, next) => {
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    res.status(status).json({ error: status < 500 || error.status ? error.message : 'The workspace could not complete this request. Check the database connection and configuration.' });
  });
  return app;
}
const app = createApp();
if (require.main === module) app.listen(process.env.PORT || 3100, () => console.log(`Booran SMS Lab: http://localhost:${process.env.PORT || 3100}`));
module.exports = { app, createApp };
