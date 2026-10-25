// Copy only the required configuration; never print existing credentials.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parse } = require('dotenv');
const { withLabDatabase } = require('../lib/database');
const target = path.join(__dirname, '..', '.env');
if (fs.existsSync(target)) throw new Error('The SMS Lab .env already exists. It was not overwritten.');
const source = process.argv[2] || path.join(__dirname, '..', '..', 'booran-sales-floor-backend', '.env');
const existing = parse(fs.readFileSync(source));
const values = {
  MONGOURI: withLabDatabase(existing.MONGOURI || existing.MONGODB_URI_FLWUP || existing.MONGODB_URI || ''),
  MOBILEMESSAGE_USERNAME: existing.MOBILEMESSAGE_USERNAME || '',
  MOBILEMESSAGE_PASSWORD: existing.MOBILEMESSAGE_PASSWORD || existing.MOBILEMESSAGE_API_KEY || '',
  MOBILEMESSAGE_SENDER_ID: existing.MOBILEMESSAGE_SENDER_ID || existing.MOBILEMESSAGE_FROM || '',
  SMS_LAB_REPLY_SENDER: '',
  SMS_LAB_PASSWORD: randomBytes(18).toString('base64url'),
  SMS_LAB_SESSION_SECRET: randomBytes(48).toString('hex'),
  APP_URL: 'http://localhost:3100',
  PORT: '3100',
};
fs.writeFileSync(target, '# Local SMS Lab configuration. Do not commit or share.\n' + Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
const missing = ['MONGOURI', 'MOBILEMESSAGE_USERNAME', 'MOBILEMESSAGE_PASSWORD', 'MOBILEMESSAGE_SENDER_ID'].filter(key => !values[key]);
console.log('Created ignored .env using the existing Mobile Message account and a separate test database.');
console.log('Workspace login password: read SMS_LAB_PASSWORD in .env.');
if (missing.length) console.log(`Configuration still needed: ${missing.join(', ')}`);
