/** Per-verified-device transfer preferences. Default is always Ask. */
import type { ManifestMsg } from '../../shared/protocol.js';

export type IncomingRule = 'ask' | 'auto' | 'block';
export interface TransferRule {
  incoming: IncomingRule;
  /** Only small files whose extensions match this allowlist may be auto-accepted. */
  maxMiB: number;
  extensions: string[];
  /** Desktop-only: permit auto-accept when the Fluxa window is not visible. */
  allowBackground: boolean;
  /** Explicit file-picker selection sends immediately rather than staging. */
  sendImmediately: boolean;
}

export const DEFAULT_RULE: Readonly<TransferRule> = Object.freeze({
  incoming: 'ask', maxMiB: 10,
  extensions: ['.jpg', '.jpeg', '.png', '.pdf', '.txt'],
  allowBackground: false, sendImmediately: false,
});

export function parseTransferRule(raw: unknown): TransferRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!['ask', 'auto', 'block'].includes(String(value['incoming'])) ||
      !Number.isInteger(value['maxMiB']) || Number(value['maxMiB']) < 1 || Number(value['maxMiB']) > 100 ||
      !Array.isArray(value['extensions']) || value['extensions'].length > 12 ||
      !value['extensions'].every((extension: unknown) => typeof extension === 'string' && /^\.[a-z0-9]{1,10}$/.test(extension)) ||
      typeof value['allowBackground'] !== 'boolean' || typeof value['sendImmediately'] !== 'boolean') return null;
  const extensions = [...new Set(value['extensions'] as string[])];
  if (value['incoming'] === 'auto' && extensions.length === 0) return null;
  return {
    incoming: value['incoming'] as IncomingRule,
    maxMiB: Number(value['maxMiB']), extensions,
    allowBackground: value['allowBackground'] as boolean,
    sendImmediately: value['sendImmediately'] as boolean,
  };
}

export interface RuleContext {
  verified: boolean;
  /** Durable private storage available for the full batch; no OS file write. */
  privateStorage: boolean;
  visible: boolean;
  desktop: boolean;
}

export function decideIncoming(rule: TransferRule, manifest: ManifestMsg, context: RuleContext): 'ask' | 'auto' | 'block' {
  if (!context.verified) return 'ask'; // never automate a non-SAS-verified peer
  if (rule.incoming === 'block') return 'block';
  if (rule.incoming !== 'auto' || !context.privateStorage ||
      (!context.visible && !(context.desktop && rule.allowBackground)) ||
      manifest.totalBytes > rule.maxMiB * 1024 * 1024) return 'ask';
  const allowed = new Set(rule.extensions);
  return manifest.files.every((file) => {
    const match = /\.[a-z0-9]{1,10}$/i.exec(file.name);
    return Boolean(match && allowed.has(match[0].toLowerCase()));
  }) ? 'auto' : 'ask';
}
