/** Pure, testable link builder. No extension API, network or cookies. */
export function tabDraft(rawUrl, rawTitle = '') {
  try {
    if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return null;
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) return null;
    const title = String(rawTitle).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || parsed.hostname;
    return { url: parsed.href, title };
  } catch { return null; }
}

export function webTarget(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '/index.html')) return null;
    if (url.protocol === 'http:') {
      const host = url.hostname.toLowerCase();
      const parts = host.split('.').map(Number);
      const privateIPv4 = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
      if (!(host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
          host === '[::1]' || privateIPv4)) return null;
    }
    return url.origin + url.pathname;
  } catch { return null; }
}

export function handoffLink(mode, target, draft) {
  const tab = tabDraft(draft?.url, draft?.title);
  if (!tab) throw new Error('This tab cannot be handed off');
  if (mode === 'desktop') {
    return `fluxa://handoff?url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title)}`;
  }
  const destination = webTarget(target);
  if (mode !== 'web' || !destination) throw new Error('Enter an HTTPS Fluxa URL or a private-LAN/localhost HTTP address');
  const data = new TextEncoder().encode(JSON.stringify(tab));
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // URL fragment: never sent to the web/signalling server as an HTTP request.
  return `${destination}#handoff=${encoded}`;
}
