// Isolated UI review server. All SMS/database operations are fake, never live.
const { createApp } = require('../server');
const { fixtureDb, fixtureEnv, fakeProvider } = require('./helpers.cjs');
const express = require('express');
const { createAuth } = require('../lib/auth');
const records = { threads: [{ _id: '11111111-1111-4111-8111-111111111111', phone: '+61412345678', name: 'Booran test phone', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_preview: 'The reply is back in the same thread.' }], messages: [] };
const threadId = records.threads[0]._id;
records.messages = [
  { _id: 'preview-1', thread_id: threadId, direction: 'outbound', sender: '61400000000', phone: '+61412345678', body: 'Hi from Booran Motors. This is our two-way SMS test. Can you reply to confirm it arrived?', created_at: new Date(Date.now() - 120000).toISOString(), status: 'delivered' },
  { _id: 'preview-2', thread_id: threadId, direction: 'inbound', sender: '61400000000', phone: '+61412345678', body: 'Received, thanks! The sender looks right on my phone.', created_at: new Date(Date.now() - 60000).toISOString(), status: 'received' },
  { _id: 'preview-3', thread_id: threadId, direction: 'outbound', sender: '61400000000', phone: '+61412345678', body: 'Perfect. The reply is back in the same thread.', created_at: new Date().toISOString(), status: 'queued' },
];
const preview = express();
preview.get('/__preview', (req, res) => {
  const auth = createAuth(fixtureEnv); auth.cookie(res, auth.issue()); res.redirect('/');
});
preview.use(createApp({ db: async () => fixtureDb(records), env: fixtureEnv, provider: fakeProvider() }));
preview.listen(3101, () => console.log('Isolated fake-provider UI review: http://localhost:3101 · password: test-password-only'));
