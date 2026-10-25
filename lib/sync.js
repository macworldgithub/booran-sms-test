const { hash, phoneMatches } = require('./validation');
function eventDate(value) {
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(+date) ? date : null;
}
function matchReply(event, outgoing) {
  return outgoing.find(row =>
    (event.original_message_id && row.provider_message_id === String(event.original_message_id) || event.original_custom_ref && row._id === event.original_custom_ref) &&
    (!event.original_message_id || !row.provider_message_id || row.provider_message_id === String(event.original_message_id)) &&
    phoneMatches(event.from, row.phone) && phoneMatches(event.to, row.sender));
}
async function syncThread(db, thread, provider) {
  const warnings = [];
  const now = new Date().toISOString();
  // A database lease prevents overlapping polls across serverless instances.
  const lease = await db.collection('threads').findOneAndUpdate({ _id: thread._id, $or: [{ sync_lock: { $exists: false } }, { sync_lock: { $lt: new Date() } }] }, { $set: { sync_lock: new Date(Date.now() + 45000) } }, { returnDocument: 'after' });
  if (!lease) return warnings;
  try {
    const outgoing = await db.collection('messages').find({ thread_id: thread._id, direction: 'outbound' }).sort({ created_at: 1 }).toArray();
    const pending = outgoing.filter(row => !['delivered', 'failed', 'cancelled'].includes(row.status) && Date.now() - Date.parse(row.receipt_checked_at || row.created_at) >= 15000).slice(-4);
    for (const row of pending) {
      try {
        const result = await provider.receipt(row);
        await db.collection('messages').updateOne({ _id: row._id }, { $set: { ...(result || {}), receipt_checked_at: now } });
      } catch { warnings.push('Delivery status is temporarily unavailable; showing saved status.'); break; }
    }
    if (outgoing.length && Date.now() - Date.parse(thread.inbound_synced_at || '1970-01-01') >= 15000) {
      const from = (thread.inbound_synced_at || outgoing[0].created_at).slice(0, 10);
      const deadline = Date.now() + 16000;
      let offset = 0;
      try {
        while (true) {
          if (Date.now() >= deadline) throw new Error('Sync budget exceeded');
          const page = await provider.inbound(from, offset);
          for (const event of page.results) {
            if (!['inbound', 'unsubscribe'].includes(event.type) || !event.message_id || typeof event.message !== 'string') continue;
            const original = matchReply(event, outgoing);
            const date = eventDate(event.received_at);
            if (!original || !date || date < new Date(original.created_at)) continue;
            const row = { _id: `inbound:${hash(String(event.message_id))}`, thread_id: thread._id, direction: 'inbound', status: 'received', kind: event.type, body: event.message, phone: original.phone, sender: original.sender, created_at: date.toISOString(), provider_message_id: String(event.message_id) };
            const saved = await db.collection('messages').updateOne({ _id: row._id }, { $setOnInsert: row }, { upsert: true });
            if (saved.upsertedCount) {
              await db.collection('threads').updateOne({ _id: thread._id, updated_at: { $lte: row.created_at } }, { $set: { updated_at: row.created_at, last_preview: row.body, last_direction: 'inbound' } });
              if (event.type === 'unsubscribe') await db.collection('threads').updateOne({ _id: thread._id }, { $set: { unsubscribed: true } });
            }
          }
          offset += page.results.length;
          if (offset >= page.total) break;
          if (!page.results.length) throw new Error('Incomplete inbox');
        }
        await db.collection('threads').updateOne({ _id: thread._id }, { $set: { inbound_synced_at: now } });
      } catch { warnings.push('Incoming replies could not be refreshed; saved messages are still available.'); }
    }
  } finally { await db.collection('threads').updateOne({ _id: thread._id }, { $unset: { sync_lock: '' } }); }
  return [...new Set(warnings)];
}
module.exports = { syncThread, matchReply, eventDate };
