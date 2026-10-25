import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardSync, type ClipboardPort } from '../../src/client/clipboard-sync.js';
import type { PeerSession } from '../../src/client/peer.js';
import type { ClipboardSyncControl, ClipboardUpdate, ControlMessage } from '../../src/shared/protocol.js';
import { decodeFrame, encodeControl } from '../../src/shared/protocol.js';

const ID_A = 'A'.repeat(43);
const ID_B = 'B'.repeat(43);
type ClipMessage = ClipboardSyncControl | ClipboardUpdate;

function makePair() {
  const aPortState = { text: 'private local baseline A', enabled: false, writes: 0 };
  const bPortState = { text: 'private local baseline B', enabled: false, writes: 0 };
  const messagesA: ControlMessage[] = [];
  const messagesB: ControlMessage[] = [];
  const errorsA: string[] = [];
  const errorsB: string[] = [];
  const port = (state: typeof aPortState): ClipboardPort => ({
    enable: async (enabled) => { state.enabled = enabled; },
    read: async () => { if (!state.enabled) throw new Error('permission denied'); return state.text; },
    write: async (text) => { if (!state.enabled) throw new Error('permission denied'); state.text = text; state.writes++; },
  });
  let a!: ClipboardSync;
  let b!: ClipboardSync;
  const aSession = {
    state: 'connected', verified: true, peer: { name: 'B', deviceId: ID_B },
    sendControl: (msg: ControlMessage) => {
      const wire = decodeFrame(encodeControl(msg));
      if (wire.kind !== 'control') throw new Error('expected control frame');
      messagesA.push(wire.message);
      queueMicrotask(() => b.handle(wire.message as ClipMessage));
    },
  } as unknown as Pick<PeerSession, 'state' | 'verified' | 'peer' | 'sendControl'>;
  const bSession = {
    state: 'connected', verified: true, peer: { name: 'A', deviceId: ID_A },
    sendControl: (msg: ControlMessage) => {
      const wire = decodeFrame(encodeControl(msg));
      if (wire.kind !== 'control') throw new Error('expected control frame');
      messagesB.push(wire.message);
      queueMicrotask(() => a.handle(wire.message as ClipMessage));
    },
  } as unknown as Pick<PeerSession, 'state' | 'verified' | 'peer' | 'sendControl'>;
  a = new ClipboardSync(aSession, ID_A, port(aPortState), {
    onChange: () => {}, onInvitation: () => {}, onError: (message) => errorsA.push(message),
  });
  b = new ClipboardSync(bSession, ID_B, port(bPortState), {
    onChange: () => {}, onInvitation: () => {}, onError: (message) => errorsB.push(message),
  });
  return { a, b, aPortState, bPortState, messagesA, messagesB, errorsA, errorsB };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Controls are validated at the frame boundary, including actual UTF-8 size.
test('clipboard controls reject malformed IDs, origin, and oversized text', () => {
  const id = 'a'.repeat(32);
  const update = { t: 'clipboardUpdate' as const, id, origin: ID_A, counter: 1, text: '😀'.repeat(4096) };
  assert.equal(decodeFrame(encodeControl(update)).kind, 'control');
  for (const invalid of [
    { ...update, id: 'bad' },
    { ...update, text: '😀'.repeat(4097) },
    { ...update, counter: 0 },
    { ...update, origin: 'a'.repeat(81) },
    { t: 'clipboardSync', id, action: 'never' },
  ]) assert.throws(() => decodeFrame(encodeControl(invalid as ControlMessage)), /invalid clipboard/);
});

test('both verified devices must opt in; initial text is not sent and remote writes never echo', async (t) => {
  const p = makePair();
  t.after(() => { p.a.close(); p.b.close(); });
  await p.a.request();
  await turn();
  assert.equal(p.a.view.state, 'requesting');
  assert.equal(p.b.view.state, 'incoming');
  assert.equal(p.messagesA.some((m) => m.t === 'clipboardUpdate'), false);
  await p.a.pollOnce();
  assert.equal(p.bPortState.text, 'private local baseline B');
  await p.b.respond(true);
  await turn();
  assert.equal(p.a.view.state, 'active');
  assert.equal(p.b.view.state, 'active');
  assert.equal(p.bPortState.text, 'private local baseline B');
  p.aPortState.text = 'a fresh note 📝';
  await p.a.pollOnce();
  await turn();
  assert.equal(p.bPortState.text, 'a fresh note 📝');
  assert.equal(p.bPortState.writes, 1);
  await p.b.pollOnce();
  assert.equal(p.messagesB.some((m) => m.t === 'clipboardUpdate'), false, 'no feedback loop');
  p.bPortState.text = 'response from B';
  await p.b.pollOnce();
  await turn();
  assert.equal(p.aPortState.text, 'response from B');
  assert.equal(p.aPortState.writes, 1);
  p.a.stop();
  await turn();
  assert.equal(p.a.view.state, 'off');
  assert.equal(p.b.view.state, 'off');
  assert.equal(p.aPortState.enabled, false);
  assert.equal(p.bPortState.enabled, false);
  p.aPortState.text = 'do not send';
  await p.a.pollOnce();
  assert.equal(p.bPortState.text, 'response from B');
});

test('declined sync, spoofed updates and wrong-session responses never touch the clipboard', async (t) => {
  const p = makePair();
  t.after(() => { p.a.close(); p.b.close(); });
  await p.a.request();
  await turn();
  p.a.handle({ t: 'clipboardSync', action: 'accept', id: 'f'.repeat(32) });
  assert.equal(p.a.view.state, 'requesting');
  p.b.handle({ t: 'clipboardUpdate', id: 'a'.repeat(32), origin: ID_A, counter: 1, text: 'forged' });
  assert.equal(p.bPortState.writes, 0);
  await p.b.respond(false);
  await turn();
  assert.equal(p.a.view.state, 'error');
  assert.equal(p.b.view.state, 'off');
  assert.equal(p.bPortState.enabled, false);
  assert.equal(p.bPortState.text, 'private local baseline B');
});

test('stale replay and forged peer origin are ignored; a later valid update wins', async (t) => {
  const p = makePair();
  t.after(() => { p.a.close(); p.b.close(); });
  await p.a.request(); await turn(); await p.b.respond(true); await turn();
  const id = (p.messagesA[0] as ClipboardSyncControl).id;
  p.b.handle({ t: 'clipboardUpdate', id, origin: ID_A, counter: 2, text: 'newer' });
  await turn();
  p.b.handle({ t: 'clipboardUpdate', id, origin: ID_A, counter: 1, text: 'replayed' });
  p.b.handle({ t: 'clipboardUpdate', id, origin: 'C'.repeat(43), counter: 3, text: 'spoofed' });
  await turn();
  assert.equal(p.bPortState.text, 'newer');
  assert.equal(p.bPortState.writes, 1);
});

test('permission errors revoke sync on both ends instead of silently continuing', async (t) => {
  const p = makePair();
  t.after(() => { p.a.close(); p.b.close(); });
  await p.a.request(); await turn(); await p.b.respond(true); await turn();
  p.aPortState.enabled = false;
  await p.a.pollOnce(); await turn();
  assert.equal(p.a.view.state, 'error');
  assert.equal(p.b.view.state, 'off');
  assert.match(p.errorsA.join(' '), /permission denied/);
});
