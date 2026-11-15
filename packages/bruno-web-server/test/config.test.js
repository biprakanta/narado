const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseConfig, findSpec, dataDirName, ConfigError } = require('../src/narado/openapi/config');

test('config.nar: version 1, an optional name, and a spec inside the folder', () => {
  assert.deepEqual(parseConfig('version: 1\nname: Payments\nspec: specs/payments.yaml\n'), { version: 1, name: 'Payments', spec: 'specs/payments.yaml' });
  assert.deepEqual(parseConfig(''), { version: 1, name: null, spec: null });
  for (const [text, why] of [
    ['spec: ../other/openapi.yaml', /inside the collection/],
    ['spec: /etc/openapi.yaml', /inside the collection/],
    ['spec: .narado/x.yaml', /inside the collection/],
    ['spec: payments.txt', /\.yaml, \.yml or \.json/],
    ['version: 2', /not supported/],
    ['- a list', /mapping/],
    ['spec: [', /not valid YAML/]
  ]) {
    assert.throws(() => parseConfig(text), (err) => err instanceof ConfigError && why.test(err.message), text);
  }
});

test('findSpec: the configured spec, else openapi.yaml/.yml/.json; .client for older collections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cfg-'));
  fs.writeFileSync(path.join(dir, 'openapi.json'), '{}');
  assert.equal(findSpec(dir), path.join(dir, 'openapi.json'));
  fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.1.0');
  assert.equal(findSpec(dir), path.join(dir, 'openapi.yaml'));

  fs.mkdirSync(path.join(dir, '.narado'));
  fs.writeFileSync(path.join(dir, '.narado', 'config.nar'), 'spec: api.json\n');
  assert.throws(() => findSpec(dir), /names api\.json, which is not in/);
  fs.writeFileSync(path.join(dir, 'api.json'), '{}');
  assert.equal(findSpec(dir), path.join(dir, 'api.json'));
  fs.writeFileSync(path.join(dir, '.narado', 'config.nar'), 'name: Only a name\n');
  assert.equal(findSpec(dir), path.join(dir, 'openapi.yaml'), 'no spec in the config: fall back');

  assert.equal(dataDirName(dir), '.narado');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cfg-'));
  fs.mkdirSync(path.join(old, '.client'));
  assert.equal(dataDirName(old), '.client');
  assert.equal(dataDirName(fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cfg-'))), '.narado', 'new collections use .narado');
});
