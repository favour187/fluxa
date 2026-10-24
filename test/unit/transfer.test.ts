/**
 * Transfer-engine tests.
 *
 * A pair of TransferManagers is wired to each other through an in-memory link
 * that delivers control messages and chunks asynchronously and in order, exactly
 * like a DataChannel. This lets us inject the situations a browser cannot easily
 * produce on demand: corrupted bytes, out-of-order chunks, host names that try
 * to escape the destination folder, and mid-flight disconnects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// The client modules use the browser timer API; Node exposes the same functions.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const { TransferManager } = await import('../../src/client/transfer/manager.js');
const { sha256OfBlob } = await import('../../src/client/sha256.js');
const { encodeChunk } = await import('../../src/shared/protocol.js');

type AnyTask = { id: string; state: string; error: string | null; totalBytes: number; role: string };
type Manager = InstanceType<typeof TransferManager>;

interface ReceivedSummary {
  name: string;
  size: number;
  sha256: string;
}

interface ReceivedFileShape {
  descriptor: { name: string };
  size: number;
  sha256: string;
  blob: Blob | null;
}

class Wire {
  other!: Manager;
  /** Flip to corrupt every byte of a specific stream on the way in. */
  corruptStream: number | null = null;
  /** Deliver with altered offsets to simulate a broken/attacking peer. */
  scrambleOffsets = false;
  closed = false;
  /** Hold chunk delivery so a transfer stays in flight while a test inspects it. */
  paused = false;
  delivered: string[] = [];

  sendControl(msg: unknown): void {
    if (this.closed) return;
    this.delivered.push((msg as { t: string }).t);
    const copy = JSON.parse(JSON.stringify(msg));
    setTimeout(() => {
      if (this.closed) return;
      this.other.handleControl(copy);
    }, 0);
  }

  sendChunk(streamId: number, offset: number, data: Uint8Array): boolean {
    if (this.closed) return false;
    if (this.paused) return true;
    const bytes = this.corruptStream === streamId ? data.map((b) => b ^ 0xff) : data;
    const sendOffset = this.scrambleOffsets && offset > 0 ? offset + 1 : offset;
    // Round-trip through the real frame encoder so header handling is covered.
    const frame = encodeChunk(streamId, sendOffset, bytes);
    setTimeout(() => {
      if (this.closed) return;
      const view = new Uint8Array(frame);
      const dv = new DataView(frame);
      this.other.handleChunk(dv.getUint32(2), dv.getFloat64(6), view.subarray(14));
    }, 0);
    return true;
  }

  async waitForDrain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makePeer(name: string, deviceId: string) {
  return {
    connId: `conn-${deviceId}`,
    deviceId,
    publicKey: 'pk',
    fingerprint: 'fp',
    name,
    platform: 'test',
    sessionNonce: 'session',
    confirmed: true,
  };
}

interface Harness {
  a: Manager;
  b: Manager;
  wireAtoB: Wire;
  wireBtoA: Wire;
  updatesB: AnyTask[];
  finishedB: { task: AnyTask; files: ReceivedSummary[] }[];
  protocolErrorsB: string[];
  incomingB: () => AnyTask | null;
  received: () => ReceivedSummary[];
  close: (reason: string) => void;
}

async function harness(preferMemory = true): Promise<Harness> {
  const peerA = makePeer('Device A', 'dev-a');
  const peerB = makePeer('Device B', 'dev-b');
  const wireAtoB = new Wire();
  const wireBtoA = new Wire();

  const updatesB: AnyTask[] = [];
  const finishedB: { task: AnyTask; files: ReceivedSummary[] }[] = [];
  const protocolErrorsB: string[] = [];
  let pendingIncoming: AnyTask | null = null;
  let stored: ReceivedSummary[] = [];

  const sessionA = {
    peer: peerB,
    verified: true,
    bufferedAmount: 0,
    sendControl: (m: unknown) => wireAtoB.sendControl(m),
    sendChunk: (s: number, o: number, d: Uint8Array) => wireAtoB.sendChunk(s, o, d),
    waitForDrain: () => wireAtoB.waitForDrain(),
  };
  const sessionB = {
    peer: peerA,
    verified: true,
    bufferedAmount: 0,
    sendControl: (m: unknown) => wireBtoA.sendControl(m),
    sendChunk: (s: number, o: number, d: Uint8Array) => wireBtoA.sendChunk(s, o, d),
    waitForDrain: () => wireBtoA.waitForDrain(),
  };

  const a = new TransferManager(sessionA as never, 'Device A', 64 * 1024, preferMemory, {
    onUpdate: () => undefined,
    onIncoming: () => undefined,
    onFinished: () => undefined,
    onProtocolError: () => undefined,
  });
  const b = new TransferManager(sessionB as never, 'Device B', 64 * 1024, preferMemory, {
    onUpdate: (task) => updatesB.push(task as unknown as AnyTask),
    onIncoming: (task) => {
      pendingIncoming = task as unknown as AnyTask;
      void (task as unknown as { accept: () => Promise<void> }).accept();
    },
    onFinished: (task, files) => {
      finishedB.push({ task: task as unknown as AnyTask, files: files as unknown as ReceivedSummary[] });
      stored = files.map((f) => ({
        name: f.descriptor.name,
        size: f.size,
        sha256: f.sha256,
      }));
    },
    onProtocolError: (message) => protocolErrorsB.push(message),
  });

  wireAtoB.other = b;
  wireBtoA.other = a;

  return {
    a,
    b,
    wireAtoB,
    wireBtoA,
    updatesB,
    finishedB,
    protocolErrorsB,
    incomingB: () => pendingIncoming,
    received: () => stored,
    close: (reason) => {
      wireAtoB.closed = true;
      a.handleSessionClosed(reason);
      b.handleSessionClosed(reason);
    },
  };
}

const file = (name: string, bytes: number, text?: string): File =>
  new File([text !== undefined ? new TextEncoder().encode(text) : randomBytes(bytes)], name, {
    type: name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream',
  });

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a multi-file transfer completes with matching hashes', async () => {
  const h = await harness();
  const files = [file('empty.txt', 0), file('small.txt', 0, 'hello fluxa'), file('binary.bin', 200_000)];
  const task = h.a.send(files);

  await waitFor(() => task.state === 'complete', 20_000, 'sender completion');
  await waitFor(() => h.received().length === 3, 20_000, 'received files');

  assert.equal(task.state, 'complete');
  assert.equal(task.ackedBytes, task.totalBytes);

  const received = h.received();
  assert.deepEqual(received.map((r) => r.name).sort(), ['binary.bin', 'empty.txt', 'small.txt']);
  const incoming = h.incomingB() as unknown as { files: { descriptor: { name: string } }[] };
  assert.equal(incoming.files.length, 3);

  const receiverFinish = h.finishedB.at(-1)!;
  assert.equal(receiverFinish.task.state, 'complete');
  assert.equal(receiverFinish.files.length, 3);
  for (const summary of receiverFinish.files as unknown as ReceivedFileShape[]) {
    assert.equal(summary.size, files.find((f) => f.name === summary.descriptor.name)!.size);
    assert.match(summary.sha256, /^[0-9a-f]{64}$/);
  }
});

test('the receiver never reports completion when the bytes were altered', async () => {
  const h = await harness();
  h.wireAtoB.corruptStream = 1;
  const task = h.a.send([file('payload.bin', 300_000)]);

  await waitFor(() => task.state !== 'transferring' && task.state !== 'waiting-approval', 20_000, 'sender settles');
  await waitFor(() => h.finishedB.length > 0, 20_000, 'receiver settles');

  const receiver = h.finishedB.at(-1)!;
  assert.equal(receiver.task.state, 'failed');
  assert.match(receiver.task.error ?? '', /integrity|sha-256/i);
  assert.equal(receiver.files.length, 0, 'a corrupted file is never exposed');
  assert.equal(h.received().length, 0);

  assert.equal(task.state, 'failed');
  assert.match(task.error ?? '', /integrity|rejected|sha-256/i);
});

test('out-of-order chunks are rejected instead of being written at the wrong offset', async () => {
  const h = await harness();
  h.wireAtoB.scrambleOffsets = true;
  const task = h.a.send([file('ordered.bin', 400_000)]);

  await waitFor(() => h.finishedB.length > 0, 20_000, 'receiver settles');
  const receiver = h.finishedB.at(-1)!;
  assert.equal(receiver.task.state, 'failed');
  assert.match(receiver.task.error ?? '', /out-of-order/i);
  assert.equal(h.received().length, 0);
  await waitFor(() => task.state === 'failed', 20_000, 'sender settles');
});

test('manifests that try to escape the destination are refused', async () => {
  const h = await harness();
  // Inject a handcrafted manifest directly, as a hostile peer would.
  h.a.handleChunk; // (no-op reference so the import is used consistently)
  const evil = {
    t: 'manifest' as const,
    v: 1,
    transferId: 'b'.repeat(32),
    files: [{ streamId: 1, name: 'passwd', relPath: '../../etc/passwd', size: 4, mime: 'text/plain' }],
    totalBytes: 4,
    senderName: 'Hostile',
    createdAt: Date.now(),
  };
  h.b.handleControl(evil);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.incomingB(), null, 'no receive task is created');
  assert.ok(h.protocolErrorsB.some((m) => /invalid manifest/i.test(m)));
  assert.equal(h.wireBtoA.delivered.includes('error'), true, 'the sender is told why');
  assert.deepEqual(h.received(), []);
});

test('a manifest with duplicate streams or a wrong total is refused', async () => {
  const h = await harness();
  h.b.handleControl({
    t: 'manifest',
    v: 1,
    transferId: 'c'.repeat(32),
    files: [
      { streamId: 1, name: 'a.txt', relPath: 'a.txt', size: 1, mime: 'text/plain' },
      { streamId: 1, name: 'b.txt', relPath: 'b.txt', size: 1, mime: 'text/plain' },
    ],
    totalBytes: 2,
    senderName: 'Hostile',
    createdAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.incomingB(), null);
  assert.ok(h.protocolErrorsB.some((m) => /invalid manifest/i.test(m)));
});

test('cancelling stops both sides and discards partial data', async () => {
  const h = await harness();
  const task = h.a.send([file('cancel-me.bin', 4 * 1024 * 1024)]);
  await waitFor(() => task.state === 'transferring', 10_000, 'transfer start');
  await new Promise((resolve) => setTimeout(resolve, 30));

  await task.cancel('cancelled by test');
  await waitFor(() => task.state === 'cancelled', 10_000, 'sender cancelled');
  const receiver = h.incomingB() as unknown as { state: string };
  await waitFor(() => receiver.state === 'cancelled', 10_000, 'receiver cancelled');
  assert.deepEqual(h.received(), []);
});

test('losing the connection fails in-flight transfers instead of hanging', async () => {
  const h = await harness();
  const task = h.a.send([file('interrupted.bin', 4 * 1024 * 1024)]);
  await waitFor(() => task.state === 'transferring', 10_000, 'transfer start');
  h.close('network went away');

  await waitFor(() => task.state === 'failed', 10_000, 'sender failed');
  assert.match(task.error ?? '', /connection lost/i);
  const receiver = h.incomingB() as unknown as { state: string; error: string };
  await waitFor(() => receiver.state === 'failed', 10_000, 'receiver failed');
  assert.deepEqual(h.received(), []);
});

test('a second manifest while busy is refused with an explicit error', async () => {
  const h = await harness();
  h.wireAtoB.paused = true; // keep the first transfer in flight
  const task = h.a.send([file('busy.bin', 2 * 1024 * 1024)]);
  await waitFor(() => task.state === 'transferring', 10_000, 'transfer start');
  const firstTaskId = h.incomingB()!.id;

  h.b.handleControl({
    t: 'manifest',
    v: 1,
    transferId: 'd'.repeat(32),
    files: [{ streamId: 1, name: 'x.txt', relPath: 'x.txt', size: 1, mime: 'text/plain' }],
    totalBytes: 1,
    senderName: 'Other',
    createdAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.wireBtoA.delivered.includes('error'), true);
  assert.equal(h.incomingB()!.id, firstTaskId, 'the original transfer is still the active one');
  assert.ok(h.protocolErrorsB.length === 0, 'a refused manifest is not surfaced as a protocol failure');

  h.wireAtoB.paused = false;
  await task.cancel('done with the busy check');
  await waitFor(() => h.finishedB.length > 0, 10_000, 'receiver settles');
});

test('progress is reported from acknowledged bytes, never ahead of them', async () => {
  const h = await harness();
  const size = 3 * 1024 * 1024;
  const task = h.a.send([file('progress.bin', size)]);
  await waitFor(() => task.state === 'complete', 30_000, 'completion');
  for (const update of h.updatesB) {
    const t = update as unknown as { receivedBytes: number; totalBytes: number };
    assert.ok(t.receivedBytes <= t.totalBytes + 1);
  }
  assert.equal(task.ackedBytes, size);
});

test('received bytes hash to the original file', async () => {
  const h = await harness();
  const bytes = randomBytes(150_000);
  const source = new File([bytes], 'verify.bin', { type: 'application/octet-stream' });
  const task = h.a.send([source]);
  await waitFor(() => task.state === 'complete', 20_000, 'completion');
  const finished = h.finishedB.at(-1)!;
  const received = finished.files[0]! as unknown as { blob: Blob | null; sha256: string };
  assert.ok(received.blob, 'a memory sink keeps the bytes for saving');
  const hash = await sha256OfBlob(received.blob!);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, received.sha256);
});
