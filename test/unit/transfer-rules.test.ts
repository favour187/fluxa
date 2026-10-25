import test from 'node:test';
import assert from 'node:assert/strict';
import { decideIncoming, parseTransferRule, DEFAULT_RULE, type TransferRule } from '../../src/client/transfer/rules.js';
import type { ManifestMsg } from '../../src/shared/protocol.js';

const manifest = (name: string, bytes = 10_000): ManifestMsg => ({
  t: 'manifest', v: 2, transferId: 'a'.repeat(32), senderName: 'Verified device', createdAt: Date.now(),
  totalBytes: bytes, files: [{ streamId: 1, name, relPath: name, size: bytes, mime: 'text/plain' }],
});
const context = { verified: true, visible: true, privateStorage: true, desktop: false };
const auto: TransferRule = { ...DEFAULT_RULE, incoming: 'auto', extensions: ['.txt'] };

test('safe defaults always ask and valid preferences round-trip without loosening bounds', () => {
  assert.equal(decideIncoming(DEFAULT_RULE, manifest('hello.txt'), context), 'ask');
  assert.deepEqual(parseTransferRule(auto), auto);
  for (const invalid of [
    { ...auto, maxMiB: 0 }, { ...auto, maxMiB: 101 }, { ...auto, extensions: ['.exe*'] },
    { ...auto, extensions: [] }, { ...auto, allowBackground: 'yes' }, { ...auto, incoming: 'trust everyone' },
  ]) assert.equal(parseTransferRule(invalid), null);
});

test('auto-accept only a verified, bounded, allowlisted batch into durable private storage', () => {
  assert.equal(decideIncoming(auto, manifest('report.txt'), context), 'auto');
  assert.equal(decideIncoming(auto, manifest('payload.exe'), context), 'ask');
  assert.equal(decideIncoming(auto, manifest('report.txt', 11 * 1024 * 1024), context), 'ask');
  assert.equal(decideIncoming(auto, manifest('report.txt'), { ...context, verified: false }), 'ask');
  assert.equal(decideIncoming(auto, manifest('report.txt'), { ...context, privateStorage: false }), 'ask');
  assert.equal(decideIncoming(auto, manifest('report.txt'), { ...context, visible: false }), 'ask');
  assert.equal(decideIncoming({ ...auto, allowBackground: true }, manifest('report.txt'), { ...context, visible: false }), 'ask', 'browser background cannot be guaranteed');
  assert.equal(decideIncoming({ ...auto, allowBackground: true }, manifest('report.txt'), { ...context, visible: false, desktop: true }), 'auto');
  assert.equal(decideIncoming({ ...auto, incoming: 'block' }, manifest('report.txt'), context), 'block');
});
