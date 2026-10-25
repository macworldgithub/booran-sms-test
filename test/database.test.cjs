const test = require('node:test');
const assert = require('node:assert/strict');
const { mongoClient, withLabDatabase } = require('../lib/database');

test('MONGOURI must contain the lab database; CRM and implicit defaults are rejected', () => {
  assert.equal(mongoClient('mongodb://localhost:27017/booran_sms_lab').db().databaseName, 'booran_sms_lab');
  assert.throws(() => mongoClient(), /Set MONGOURI/);
  for (const uri of ['mongodb://localhost:27017', 'mongodb://localhost:27017/flwup_crm', 'mongodb://localhost:27017/booran_inventory_tracker', 'mongodb://localhost:27017/booran_sms_lab_other']) assert.throws(() => mongoClient(uri), /must select the booran_sms_lab/);
});

test('local setup changes only the URI database path and preserves credentials and options', () => {
  assert.equal(withLabDatabase('mongodb+srv://user:p%40ss@cluster.example/flwup_crm?retryWrites=true&w=majority&authSource=admin'), 'mongodb+srv://user:p%40ss@cluster.example/booran_sms_lab?retryWrites=true&w=majority&authSource=admin');
  assert.equal(withLabDatabase('mongodb://user:secret@one.example:27017,two.example:27017/crm?replicaSet=rs0'), 'mongodb://user:secret@one.example:27017,two.example:27017/booran_sms_lab?replicaSet=rs0');
  assert.equal(withLabDatabase('mongodb://localhost:27017'), 'mongodb://localhost:27017/booran_sms_lab');
  assert.equal(withLabDatabase(''), '');
  assert.throws(() => withLabDatabase('invalid'), /invalid/);
});
