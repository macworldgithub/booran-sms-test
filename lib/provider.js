const { phoneMatches } = require('./validation');
function configuredSender(env = process.env) {
  const value = String(env.MOBILEMESSAGE_SENDER_ID || env.MOBILEMESSAGE_FROM || '').trim();
  return /^[+\d\s()-]+$/.test(value) ? value.replace(/[+\s()-]/g, '') : value;
}
function createProvider(env = process.env, fetcher = fetch) {
  const configured = () => Boolean(env.MOBILEMESSAGE_USERNAME && (env.MOBILEMESSAGE_PASSWORD || env.MOBILEMESSAGE_API_KEY) && configuredSender(env));
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
  async function sender() {
    if (senderCache && Date.now() - senderCache.at < 30000) return senderCache.row;
    const { response, data } = await call('senders');
    if (!response.ok || data?.status !== 'complete' || !Array.isArray(data.results)) throw new Error('Could not check approved senders. Check the provider credentials.');
    const match = data.results.find(row => typeof row.sender === 'string' && row.sender === configuredSender(env));
    if (!match) throw new Error('The sender configured in MOBILEMESSAGE_SENDER_ID is not active on this account.');
    const row = {
      sender: match.sender, type: match.type, label: match.label || match.sender,
      // Personal mobiles receive replies on that mobile, not through the API.
      reply_capable: !/[a-z]/i.test(match.sender) && ['shared', 'dedicated'].includes(match.type),
    };
    senderCache = { at: Date.now(), row };
    return row;
  }
  async function send({ phone, body, id }) {
    try {
      const { response, data } = await call('messages', { method: 'POST', body: JSON.stringify({ enable_unicode: true, messages: [{ to: phone, sender: configuredSender(env), message: body, custom_ref: id }] }) });
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
  return { configured, sender, send, inbound, receipt };
}
module.exports = { createProvider, configuredSender };
