const { MongoClient } = require('mongodb');
let pending;
function mongoClient(uri, options = {}) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('Set MONGOURI to a MongoDB connection string ending in /booran_sms_lab.');
  const client = new MongoClient(uri, options);
  // Read the database directly from the URI. Never default to a CRM database.
  if (client.options.dbName !== 'booran_sms_lab') throw new Error('MONGOURI must select the booran_sms_lab database in its connection string.');
  return client;
}

function withLabDatabase(uri) {
  if (!uri) return '';
  const parts = String(uri).match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/);
  if (!parts) throw new Error('The source MongoDB connection string is invalid.');
  const updated = `${parts[1]}/booran_sms_lab${parts[2] || ''}`;
  mongoClient(updated);
  return updated;
}

async function database() {
  if (!pending) pending = (async () => {
    const client = mongoClient(process.env.MONGOURI, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      const db = client.db();
      await Promise.all([
        db.collection('threads').createIndex({ phone: 1 }, { unique: true }),
        db.collection('messages').createIndex({ thread_id: 1, created_at: 1 }),
        db.collection('messages').createIndex({ provider_message_id: 1 }),
        db.collection('limits').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
        db.collection('verifications').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      ]);
      return db;
    } catch (error) { await client.close(); throw error; }
  })().catch(error => { pending = undefined; throw error; });
  return pending;
}
module.exports = { database, mongoClient, withLabDatabase };
