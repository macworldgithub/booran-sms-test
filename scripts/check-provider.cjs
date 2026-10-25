// Read-only account and database readiness check. This script never sends an SMS.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createProvider } = require('../lib/provider');
const { mongoClient } = require('../lib/database');
(async () => {
  let failed = false;
  try {
    const senders = await createProvider().senders();
    console.log(JSON.stringify({ provider: 'connected', senders: senders.map(({ sender, type, reply_capable }) => ({ sender, type, reply_capable })) }, null, 2));
  } catch (error) { console.log(JSON.stringify({ provider: 'unavailable', error: error.message })); failed = true; }
  let client;
  try {
    client = mongoClient(process.env.MONGOURI, { serverSelectionTimeoutMS: 5000 });
    await client.connect(); await client.db().command({ ping: 1 });
    console.log('Database connection: booran_sms_lab available via MONGOURI. Read-only ping; no CRM records changed.');
  } catch { console.log('Database connection: unavailable. Check MONGOURI selects /booran_sms_lab and permits network access.'); failed = true; }
  finally { await client?.close(); }
  process.exitCode = failed ? 1 : 0;
})().catch(() => { console.error('Configuration check could not complete.'); process.exitCode = 1; });
