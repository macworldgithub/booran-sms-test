const { createHash } = require('node:crypto');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function phone(value) {
  const raw = String(value || '').replace(/[\s().+-]/g, '');
  const number = /^04\d{8}$/.test(raw) ? `61${raw.slice(1)}` : /^4\d{8}$/.test(raw) ? `61${raw}` : raw;
  if (!/^614\d{8}$/.test(number)) fail('Enter an Australian mobile number, for example 0412 345 678.');
  return `+${number}`;
}
function phoneMatches(a, b) { try { return phone(a) === phone(b); } catch { return false; } }
const gsm = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const extended = new Set('\f^{}\\[~]|€');
function smsParts(body) {
  let units = 0;
  let unicode = false;
  for (const char of body) {
    if (gsm.has(char)) units++;
    else if (extended.has(char)) units += 2;
    else unicode = true;
  }
  if (unicode) units = body.length;
  const single = unicode ? 70 : 160;
  return { encoding: unicode ? 'Unicode' : 'GSM-7', parts: units <= single ? 1 : Math.ceil(units / (unicode ? 67 : 153)), units };
}
function message(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Write a message first.');
  const body = value.trim();
  if (smsParts(body).parts > 10) fail('Shorten the message to 10 SMS parts or fewer.');
  return body;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('A valid request ID is required.');
  return `lab:${value}`;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function publicMessage(row) {
  const { code_hash, verification_token, fingerprint, ...safe } = row;
  // A verification code is sent to the handset, never returned in history.
  if (safe.kind === 'verification') safe.body = 'Booran verification SMS · code and secure link sent to handset';
  return safe;
}
module.exports = { fail, phone, phoneMatches, smsParts, message, requestId, hash, publicMessage };
