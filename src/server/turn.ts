/** coturn's standard TURN REST credentials (HMAC-SHA1 over expiring username).
 * This is credential provisioning, NOT application-layer encryption. DTLS
 * remains end-to-end between the verified peers; coturn relays ciphertext.
 */
import { createHmac } from 'node:crypto';
import { randomToken } from '../shared/crypto.js';

export interface TurnConfig {
  urls: string[];
  secret: string;
  /** Operator-issued enrolment key, never the coturn REST secret. */
  accessKey: string;
  ttlSeconds: number;
}

export function turnConfigFromEnv(env: NodeJS.ProcessEnv): TurnConfig | null {
  const urlsRaw = env.FLUXA_TURN_URLS;
  const secret = env.FLUXA_TURN_SECRET;
  const accessKey = env.FLUXA_TURN_ACCESS_KEY;
  if (!urlsRaw && !secret && !accessKey) return null;
  if (!urlsRaw || !secret || secret.length < 32 || !accessKey || accessKey.length < 32) {
    throw new Error('TURN requires FLUXA_TURN_URLS, FLUXA_TURN_SECRET and FLUXA_TURN_ACCESS_KEY (both keys at least 32 characters)');
  }
  if (accessKey === secret) throw new Error('TURN access key must differ from the coturn REST secret');
  let urls: unknown;
  try { urls = JSON.parse(urlsRaw); } catch { throw new Error('FLUXA_TURN_URLS must be a JSON array'); }
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8 ||
      urls.some((url) => typeof url !== 'string' || url.length > 256 || !/^turns?:[^\s]+$/i.test(url))) {
    throw new Error('TURN URLs must be 1–8 turn:/turns: URLs');
  }
  const ttlSeconds = Number(env.FLUXA_TURN_TTL_SECONDS ?? 43_200);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 600 || ttlSeconds > 86_400) throw new Error('TURN TTL must be between 600 and 86400 seconds');
  return { urls, secret, accessKey, ttlSeconds };
}

export function temporaryTurnServer(config: TurnConfig, nowSeconds = Math.floor(Date.now() / 1000)) {
  const username = `${nowSeconds + config.ttlSeconds}:${randomToken(8)}`;
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  return { urls: config.urls, username, credential };
}
