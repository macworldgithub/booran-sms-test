const { createApp } = require('../server');
function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(row, part));
    const actual = row[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, value]) => {
      if (op === '$exists') return (actual !== undefined) === value;
      if (op === '$gt') return actual > value;
      if (op === '$lt') return actual < value;
      if (op === '$lte') return actual <= value;
      throw new Error(`Unsupported query ${op}`);
    });
    return actual === expected;
  });
}
function fixtureDb(records = {}) {
  function collection(name) {
    const rows = records[name] ||= [];
    function mutate(query, update, options) {
      let row = rows.find(item => matches(item, query)); let inserted = false;
      if (!row && options?.upsert) {
        row = Object.fromEntries(Object.entries(query).filter(([key, value]) => !key.startsWith('$') && (typeof value !== 'object' || value instanceof Date)));
        if (rows.some(item => item._id === row._id && row._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 });
        Object.assign(row, update.$setOnInsert); rows.push(row); inserted = true;
      }
      if (!row) return { row: null, inserted: false };
      Object.assign(row, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
      for (const [key, value] of Object.entries(update.$max || {})) if (row[key] === undefined || row[key] < value) row[key] = value;
      return { row, inserted };
    }
    return {
      find(query = {}) {
        let result = rows.filter(row => matches(row, query));
        const cursor = { sort(keys) { result.sort((a, b) => { for (const [key, direction] of Object.entries(keys)) { if (a[key] < b[key]) return -direction; if (a[key] > b[key]) return direction; } return 0; }); return cursor; }, limit(n) { result = result.slice(0, n); return cursor; }, async toArray() { return structuredClone(result); } };
        return cursor;
      },
      async findOne(query) { return structuredClone(rows.find(row => matches(row, query)) || null); },
      async findOneAndUpdate(query, update, options) { return structuredClone(mutate(query, update, options).row); },
      async updateOne(query, update, options) { const result = mutate(query, update, options); return { modifiedCount: result.row ? 1 : 0, upsertedCount: result.inserted ? 1 : 0 }; },
      async insertOne(row) { if (rows.some(item => item._id === row._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 }); rows.push(structuredClone(row)); return { insertedId: row._id }; },
    };
  }
  return { collection, command: async () => ({ ok: 1 }) };
}
const fixtureEnv = { SMS_LAB_PASSWORD: 'test-password-only', SMS_LAB_SESSION_SECRET: 'test-signing-key-that-is-longer-than-32-characters', APP_URL: 'https://sms-test.example', MOBILEMESSAGE_SENDER_ID: '61400000000' };
function fakeProvider(overrides = {}) {
  return { configured: () => true, sender: async () => ({ sender: '61400000000', type: 'dedicated', reply_capable: true, label: 'Test number' }), send: async () => ({ status: 'queued', provider_message_id: 'provider-1' }), inbound: async () => ({ results: [], total: 0 }), receipt: async () => null, ...overrides };
}
async function harness(t, options = {}) {
  const records = options.records || {};
  const db = fixtureDb(records);
  const env = { ...fixtureEnv, ...options.env };
  const app = createApp({ db: async () => db, env, provider: fakeProvider(options.provider) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const login = await request('/login', 'POST', { password: env.SMS_LAB_PASSWORD });
  cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  async function thread() { return (await request('/threads', 'POST', { phone: '0412 345 678', name: 'Test phone' })).body.thread; }
  return { request, records, thread, base, cookie };
}
module.exports = { fixtureDb, fixtureEnv, fakeProvider, harness };
