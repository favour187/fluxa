/**
 * A one-shot same-origin mailbox lets the browser extension open a new tab
 * without killing the already-paired Fluxa tab. Only a validated draft moves;
 * the existing app still requires a sender click and recipient approval.
 */
import type { HandoffDraft, FluxaApp } from './app.js';

const CHANNEL = 'fluxa:handoff:v1';

export function handoffFromFragment(hash: string): HandoffDraft | null {
  if (!/^#handoff=[A-Za-z0-9_-]{1,6000}$/.test(hash)) return null;
  try {
    const encoded = hash.slice('#handoff='.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return typeof record['url'] === 'string' && typeof record['title'] === 'string'
      ? { url: record['url'], title: record['title'] }
      : null;
  } catch { return null; }
}

export async function offerToExistingWindow(draft: HandoffDraft): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return false;
  const channel = new BroadcastChannel(CHANNEL);
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const finish = (accepted: boolean) => { clearTimeout(timeout); channel.close(); resolve(accepted); };
    const timeout = setTimeout(() => finish(false), 750);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const reply = event.data as Record<string, unknown> | null;
      if (reply?.['t'] === 'ack' && reply['id'] === id) finish(true);
    };
    channel.postMessage({ t: 'handoff', id, draft });
  });
}

export function listenForHandoffs(app: FluxaApp): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Record<string, unknown> | null;
    const draft = message?.['draft'] as Record<string, unknown> | null;
    if (message?.['t'] !== 'handoff' || typeof message['id'] !== 'string' || message['id'].length > 80 ||
        !draft || typeof draft['url'] !== 'string' || typeof draft['title'] !== 'string') return;
    if (app.prepareHandoff(draft['url'], draft['title'])) channel.postMessage({ t: 'ack', id: message['id'] });
  };
  return () => channel.close();
}
