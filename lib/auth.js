const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const { hash, fail } = require('./validation');
function equal(a, b) { return timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b)))); }
function createAuth(env) {
  function ready() { return env.SMS_LAB_PASSWORD?.length >= 10 && env.SMS_LAB_SESSION_SECRET?.length >= 32; }
  const sign = text => createHmac('sha256', env.SMS_LAB_SESSION_SECRET || 'unconfigured').update(text).digest('hex');
  function issue() {
    const value = `${Date.now() + 8 * 3600000}.${randomBytes(24).toString('hex')}`;
    return `${value}.${sign(value)}`;
  }
  function authenticated(req) {
    if (!ready()) return false;
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sms_lab='))?.slice(8) || '';
    const [expires, nonce, signature] = token.split('.');
    return /^\d+$/.test(expires) && Number(expires) > Date.now() && /^[a-f0-9]{48}$/.test(nonce || '') && equal(signature, sign(`${expires}.${nonce}`));
  }
  function requireAuth(req, res, next) { if (!authenticated(req)) return res.status(401).json({ error: 'Sign in to the SMS workspace.' }); next(); }
  function cookie(res, value, clear = false) {
    res.cookie('sms_lab', value, { httpOnly: true, sameSite: 'strict', secure: Boolean(env.VERCEL || env.NODE_ENV === 'production'), path: '/', maxAge: clear ? 0 : 8 * 3600000 });
  }
  async function limit(db, key, maximum, seconds) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    const record = await db.collection('limits').findOneAndUpdate({ _id: `${key}:${bucket}` }, { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((bucket + 1) * seconds * 1000) } }, { upsert: true, returnDocument: 'after' });
    if (record.count > maximum) fail('Too many attempts. Please wait before trying again.', 429);
  }
  return { ready, issue, authenticated, requireAuth, cookie, limit, equal, sign };
}
module.exports = { createAuth };
