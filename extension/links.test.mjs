import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffLink, tabDraft, webTarget } from './links.mjs';

test('extension only drafts a user-selected HTTP(S) URL and title, never credentials', () => {
  assert.deepEqual(tabDraft('https://example.com/article?a=1', 'A\n page'), {
    url: 'https://example.com/article?a=1', title: 'A  page',
  });
  for (const value of ['javascript:alert(1)', 'file:///tmp/key', 'https://user:secret@example.com/',
    'chrome://settings', 'https://example.org/' + 'x'.repeat(3000)]) {
    assert.equal(tabDraft(value, 'bad'), null);
  }
});

test('Fluxa web destinations require HTTPS or private/loopback HTTP', () => {
  assert.equal(webTarget('https://fluxa.example.net/'), 'https://fluxa.example.net/');
  assert.equal(webTarget('http://192.168.1.20:8787/'), 'http://192.168.1.20:8787/');
  assert.equal(webTarget('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787/');
  for (const value of ['http://example.com/', 'https://user:pass@example.com/',
    'https://example.com/foo', 'https://example.com/?token=secret', 'javascript:alert(1)']) {
    assert.equal(webTarget(value), null);
  }
});

test('web handoff stays in fragment and installed-app handoff uses a user-reviewed protocol link', () => {
  const draft = tabDraft('https://example.net/work?search=one#section', 'Read now 📝');
  const web = handoffLink('web', 'http://127.0.0.1:8787/', draft);
  const parsed = new URL(web);
  assert.equal(parsed.search, '');
  const binary = atob(parsed.hash.slice('#handoff='.length).replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
  assert.deepEqual(payload, draft);
  const native = new URL(handoffLink('desktop', '', draft));
  assert.equal(native.protocol, 'fluxa:');
  assert.equal(native.host, 'handoff');
  assert.equal(native.searchParams.get('url'), draft.url);
  assert.equal(native.searchParams.get('title'), draft.title);
  assert.equal(native.href.includes('cookie'), false);
});
