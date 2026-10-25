import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalNetworkHost } from '../../src/shared/network.js';
import { turnConfigFromEnv, temporaryTurnServer } from '../../src/server/turn.js';
import { normaliseSignalUrl } from '../../src/client/app.js';

test('plaintext signalling is constrained to private addresses, not public DNS/IPs', () => {
  for (const host of ['localhost', 'foo.localhost', 'mycomputer.local', '127.0.0.1',
    '10.1.2.3', '192.168.1.4', '172.16.0.2', '172.31.255.254', '169.254.1.2',
    '::1', 'fd00::4', 'fe80::1']) assert.equal(isLocalNetworkHost(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '192.0.2.1', '172.32.0.1',
    '172.15.0.1', '100.64.0.1', '256.1.1.1', 'evil.local.example', 'fczz::1']) {
    assert.equal(isLocalNetworkHost(host), false, host);
  }
  assert.equal(normaliseSignalUrl('192.168.1.20:8787'), 'ws://192.168.1.20:8787/ws');
  assert.equal(normaliseSignalUrl('ws://8.8.8.8/ws'), null);
  assert.equal(normaliseSignalUrl('http://example.com'), null);
  assert.equal(normaliseSignalUrl('wss://example.com/ws'), 'wss://example.com/ws');
  assert.equal(normaliseSignalUrl('https://user:pass@example.com'), null);
});

test('TURN needs separate secret and operator-issued access key and limits expiry', () => {
  const valid = { FLUXA_TURN_URLS: '["turn:relay.example.com:3478","turns:relay.example.com:5349"]',
    FLUXA_TURN_SECRET: 'S'.repeat(40), FLUXA_TURN_ACCESS_KEY: 'K'.repeat(40) };
  assert.equal(turnConfigFromEnv({}), null);
  assert.throws(() => turnConfigFromEnv({ ...valid, FLUXA_TURN_ACCESS_KEY: '' }), /requires/);
  assert.throws(() => turnConfigFromEnv({ ...valid, FLUXA_TURN_TTL_SECONDS: '1' }), /600/);
  assert.throws(() => turnConfigFromEnv({ ...valid, FLUXA_TURN_URLS: '["https://wrong"]' }), /TURN URLs/);
  const config = turnConfigFromEnv(valid)!;
  const first = temporaryTurnServer(config, 1_000_000);
  const second = temporaryTurnServer(config, 1_000_000);
  assert.match(first.username, /^1043200:/);
  assert.notEqual(first.username, second.username);
  assert.ok(!JSON.stringify(first).includes(config.secret));
  assert.ok(!JSON.stringify(first).includes(config.accessKey));
});
