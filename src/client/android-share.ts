/**
 * Android's explicit Share target. The system launches Fluxa with ACTION_SEND;
 * its native plugin copies granted content URIs into a bounded private inbox.
 * This adapter reads those files in 64 KiB slices, never base64-encodes the
 * whole file and never claims to keep WebRTC running in the background.
 */
import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';

export interface AndroidSharedFile {
  index: number;
  name: string;
  mime: string;
  size: number;
}

export interface AndroidSharedItem {
  id: string;
  createdAt: number;
  text: string;
  title: string;
  files: AndroidSharedFile[];
}

export interface AndroidSharePlugin {
  list(): Promise<{ items: AndroidSharedItem[]; error: string }>;
  readChunk(options: { id: string; index: number; offset: number; length: number }): Promise<{ data: string }>;
  discard(options: { id: string }): Promise<void>;
  addListener(eventName: 'shareReceived', listener: () => void): Promise<PluginListenerHandle>;
}

const CHUNK = 64 * 1024;
const ID = /^[0-9a-f]{32}$/;
const MAX_FILE = 512 * 1024 * 1024;

/** Native calls are made only on an installed Android app, never on web/iOS. */
export function androidSharePlugin(): AndroidSharePlugin | null {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  return registerPlugin<AndroidSharePlugin>('FluxaIncomingShare');
}

/** The native bridge is a trust boundary: reject malformed metadata, not just payloads. */
export function validAndroidShare(item: AndroidSharedItem): boolean {
  return Boolean(item && ID.test(item.id) && Number.isSafeInteger(item.createdAt) &&
    typeof item.text === 'string' && new TextEncoder().encode(item.text).length <= 16 * 1024 &&
    typeof item.title === 'string' && item.title.length <= 160 &&
    Array.isArray(item.files) && item.files.length <= 32 && (item.text.length > 0 || item.files.length > 0) &&
    item.files.every((file, index) => file && file.index === index && typeof file.name === 'string' &&
      file.name.length > 0 && file.name.length <= 180 && typeof file.mime === 'string' && file.mime.length <= 128 &&
      Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE));
}

/** Chrome typically shares a URL in EXTRA_TEXT and a title in EXTRA_SUBJECT. */
export function classifyAndroidText(text: string, subject: string):
  { kind: 'link' | 'clipboard'; text: string; url?: string; title?: string } {
  if (!text.trim()) throw new Error('This share has no text');
  const lines = text.trim().split(/\r?\n/);
  const candidate = lines.at(-1)?.trim() ?? '';
  if (/^https?:\/\//i.test(candidate)) {
    const url = new URL(candidate);
    if (url.username || url.password) throw new Error('This URL contains credentials. Remove the username/password before sharing');
    if (url.href.length > 2048) throw new Error('Shared URL exceeds the 2,048-character limit');
    const note = lines.slice(0, -1).join('\n');
    const title = subject.trim().slice(0, 160);
    return { kind: 'link', text: note, url: url.href, ...(title ? { title } : {}) };
  }
  return { kind: 'clipboard', text };
}

/** A Blob slice whose ReadableStream obtains only the requested native bytes. */
class SharedSlice extends Blob {
  constructor(
    private readonly plugin: Pick<AndroidSharePlugin, 'readChunk'>,
    private readonly id: string,
    private readonly index: number,
    private readonly begin: number,
    private readonly end: number,
    mime: string,
  ) { super([], { type: mime }); }

  override get size(): number { return this.end - this.begin; }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = this.begin;
    let cancelled = false;
    const plugin = this.plugin;
    const id = this.id;
    const index = this.index;
    const end = this.end;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        if (cancelled) return;
        if (offset >= end) { controller.close(); return; }
        const length = Math.min(CHUNK, end - offset);
        try {
          const { data } = await plugin.readChunk({ id, index, offset, length });
          if (cancelled) return;
          const binary = atob(data);
          if (binary.length !== length) throw new Error('Shared file changed while reading it');
          const chunk = new Uint8Array(length);
          for (let i = 0; i < length; i++) chunk[i] = binary.charCodeAt(i);
          offset += length;
          controller.enqueue(chunk);
          if (offset === end) controller.close();
        } catch (err) {
          if (!cancelled) controller.error(err);
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 1 });
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const result = new Uint8Array(this.size);
    const reader = this.stream().getReader();
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result.set(value, at);
        at += value.byteLength;
      }
    } finally { reader.releaseLock(); }
    return result.buffer;
  }

  override slice(start = 0, end = this.size, contentType = this.type): Blob {
    const length = this.size;
    const clamp = (value: number) => Math.min(length, Math.max(0, value < 0 ? length + value : value));
    const a = clamp(start);
    return new SharedSlice(this.plugin, this.id, this.index, this.begin + a,
      this.begin + Math.max(a, clamp(end)), contentType);
  }
}

/** File API facade: TransferManager hashes and streams slices as usual. */
export class AndroidInboxFile extends File {
  constructor(
    private readonly plugin: Pick<AndroidSharePlugin, 'readChunk'>,
    private readonly shareId: string,
    private readonly file: AndroidSharedFile,
  ) { super([], file.name, { type: file.mime }); }

  override get size(): number { return this.file.size; }

  override slice(start = 0, end = this.size, contentType = this.type): Blob {
    const length = this.size;
    const clamp = (value: number) => Math.min(length, Math.max(0, value < 0 ? length + value : value));
    const a = clamp(start);
    return new SharedSlice(this.plugin, this.shareId, this.file.index, a, Math.max(a, clamp(end)), contentType);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.slice().stream();
  }

  override arrayBuffer(): Promise<ArrayBuffer> { return this.slice().arrayBuffer(); }
}
