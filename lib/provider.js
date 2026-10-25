const { phoneMatches } = require('./validation');
function createProvider(env = process.env, fetcher = fetch) {
  const configured = () => Boolean(env.MOBILEMESSAGE_USERNAME && (env.MOBILEMESSAGE_PASSWORD || env.MOBILEMESSAGE_API_KEY));
  async function call(path, options = {}) {
    if (!configured()) throw new Error('Mobile Message credentials are not configured.');
    const response = await fetcher(`https://api.mobilemessage.com.au/v1/${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.MOBILEMESSAGE_USERNAME}:${env.MOBILEMESSAGE_PASSWORD || env.MOBILEMESSAGE_API_KEY}`).toString('base64')}` },
      signal: AbortSignal.timeout(options.method ? 12000 : 4000), cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }
  let senderCache;
  async function senders() {
    if (senderCache && Date.now() - senderCache.at < 30000) return senderCache.rows;
    const { response, data } = await call('senders');
    if (!response.ok || data?.status !== 'complete' || !Array.isArray(data.results)) throw new Error('Could not check approved senders. Check the provider credentials.');
    const rows = data.results.filter(row => typeof row.sender === 'string').map(row => ({
      sender: row.sender, type: row.type, label: row.label || row.sender, is_default: Boolean(row.is_default),
      // Personal mobiles receive replies on that mobile, not through the API.
      reply_capable: !/[a-z]/i.test(row.sender) && ['shared', 'dedicated'].includes(row.type),
    }));
    senderCache = { at: Date.now(), rows };
    return rows;
  }
  async function send({ phone, body, sender, id }) {
    try {
      const { response, data } = await call('messages', { method: 'POST', body: JSON.stringify({ enable_unicode: true, messages: [{ to: phone, sender, message: body, custom_ref: id }] }) });
      const row = data?.results?.[0];
      if (response.ok && ['success', 'accepted', 'queued', 'sent'].includes(String(row?.status).toLowerCase()) && row.message_id) return { status: 'queued', provider_message_id: String(row.message_id) };
      if (response.status >= 500 || !data || (response.ok && !row)) return { status: 'unknown', error: 'Provider acceptance is unconfirmed. Check Mobile Message before sending again.' };
      return { status: 'failed', error: 'Mobile Message rejected this SMS. Check the sender, recipient and available credits.' };
    } catch { return { status: 'unknown', error: 'Provider acceptance is unconfirmed. Check Mobile Message before sending again.' }; }
  }
  async function inbound(from, offset) {
    const query = new URLSearchParams({ from, offset: String(offset), limit: '200' });
    const { response, data } = await call(`inbound?${query}`);
    if (!response.ok || data?.status !== 'complete' || !Array.isArray(data.results) || !Number.isInteger(data.total) || data.total < 0) throw new Error('Incoming replies could not be refreshed.');
    return data;
  }
  async function receipt(row) {
    const query = new URLSearchParams(row.provider_message_id ? { message_id: row.provider_message_id } : { custom_ref: row._id });
    const { response, data } = await call(`messages?${query}`);
    if (!response.ok || !Array.isArray(data?.results)) throw new Error('Delivery status could not be refreshed.');
    const found = data.results.find(item => phoneMatches(item.to, row.phone) && (row.provider_message_id ? String(item.message_id) === row.provider_message_id : item.custom_ref === row._id));
    if (!found?.message_id) return null;
    const status = ({ success: 'sent', accepted: 'queued', error: 'failed', undeliverable: 'failed', blocked: 'failed' })[found.status] || found.status;
    return ['queued', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled'].includes(status) ? { status, provider_message_id: String(found.message_id), error: status === 'failed' ? 'The provider reports this SMS failed.' : null } : null;
  }
  return { configured, senders, send, inbound, receipt };
}
module.exports = { createProvider };
