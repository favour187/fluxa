/** Restrict plaintext signalling to loopback and private-LAN endpoints.
 * This does not authenticate LAN signalling (SAS does); it avoids sending
 * identity/pairing metadata over unencrypted public networks by accident.
 */
export function isLocalNetworkHost(input: string): boolean {
  const host = input.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  if (/^(?:fc|fd|fe[89ab])[0-9a-f:]+$/.test(host)) return true; // ULA/link-local IPv6
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some((n) => n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) ||
    (a === 172 && b! >= 16 && b! <= 31) || (a === 169 && b === 254);
}
