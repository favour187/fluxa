/**
 * Filename sanitisation.
 *
 * The sender is untrusted: every name that arrives over the wire passes through
 * here before it can touch a filesystem (OPFS, File System Access, or a Blob
 * download). The goal is to make path traversal, null-byte injection, Windows
 * reserved names and absurd lengths impossible, while keeping ordinary unicode
 * filenames intact.
 */
import { LIMITS } from './protocol.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Replace anything that would be dangerous on any supported platform. */
export function sanitizeFilename(input: string): string | null {
  if (typeof input !== 'string') return null;
  let name = input
    .replace(CONTROL_CHARS, '')
    .replace(/[/\\]/g, '_') // path separators never belong in a basename
    .replace(/[:*?"<>|]/g, '_') // invalid on Windows
    .normalize('NFC');

  // No leading dots/dashes that hide files or look like flags; no trailing dots/spaces (Windows).
  name = name.replace(/^\.+/, '').replace(/[. ]+$/g, '').replace(/^[-]+/, '').trim();
  if (!name || name === '.' || name === '..') return null;

  // Truncate to the byte limit without splitting a multi-byte character.
  if (new TextEncoder().encode(name).byteLength > LIMITS.maxNameBytes) {
    let out = '';
    for (const ch of name) {
      if (new TextEncoder().encode(out + ch).byteLength > LIMITS.maxNameBytes - 8) break;
      out += ch;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot, dot + 12) : '';
    name = out + ext;
  }

  const stem = name.split('.')[0]!.toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) name = `_${name}`;
  if (!name) return null;
  return name;
}

/**
 * Sanitise a relative path (folders are sent as a path prefix).
 * Returns null when the path escapes its root or is otherwise unusable.
 */
export function sanitizeRelPath(name: string, relPath: string): { name: string; relPath: string } | null {
  const safeName = sanitizeFilename(name);
  if (!safeName) return null;

  const rawParts = String(relPath || safeName)
    .split(/[/\\]+/)
    .filter((p) => p.length > 0 && p !== '.');

  if (rawParts.length === 0 || rawParts.length > LIMITS.maxRelPathDepth) return null;
  if (rawParts.some((p) => p === '..')) return null;

  const parts: string[] = [];
  for (const part of rawParts) {
    const clean = sanitizeFilename(part);
    if (!clean) return null;
    parts.push(clean);
  }
  // The basename must match the declared name, otherwise the descriptor is inconsistent.
  if (parts[parts.length - 1] !== safeName) parts[parts.length - 1] = safeName;

  const joined = parts.join('/');
  if (joined.length > 1024) return null;
  return { name: safeName, relPath: joined };
}

/** Produce a non-colliding name given already-used names: "report.pdf" -> "report (1).pdf". */
export function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
