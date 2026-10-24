import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeName, sanitizeFilename, sanitizeRelPath } from '../../src/shared/filename.js';

test('keeps ordinary names intact', () => {
  assert.equal(sanitizeFilename('holiday-photo.jpg'), 'holiday-photo.jpg');
  assert.equal(sanitizeFilename('Ñoño データ.txt'), 'Ñoño データ.txt');
  assert.equal(sanitizeFilename('report (final) v2.pdf'), 'report (final) v2.pdf');
});

test('strips traversal and separators', () => {
  const traversal = sanitizeFilename('../../etc/passwd')!;
  assert.ok(!traversal.includes('/') && !traversal.includes('\\'), 'no separators survive');
  assert.ok(!traversal.startsWith('.'), 'leading dots are stripped so the result cannot be a hidden path');
  assert.ok(traversal.endsWith('passwd'));

  const windows = sanitizeFilename('..\\..\\windows\\system32')!;
  assert.ok(!windows.includes('\\') && !windows.startsWith('.'));
  assert.ok(!sanitizeFilename('a/b/c.txt')?.includes('/'));
  assert.ok(!sanitizeFilename('a\\b\\c.txt')?.includes('\\'));
});

test('rejects unusable names', () => {
  assert.equal(sanitizeFilename(''), null);
  assert.equal(sanitizeFilename('   '), null);
  assert.equal(sanitizeFilename('...'), null);
  assert.equal(sanitizeFilename('..'), null);
  assert.equal(sanitizeFilename('.'), null);
  assert.equal(sanitizeFilename('\u0000\u0001'), null);
});

test('removes control characters and null bytes', () => {
  assert.equal(sanitizeFilename('evil\u0000.txt'), 'evil.txt');
  assert.equal(sanitizeFilename('a\u001bb\u007fc.txt'), 'abc.txt');
});

test('escapes Windows-reserved names and devices', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('con.txt'), '_con.txt');
  assert.equal(sanitizeFilename('LPT1.log'), '_LPT1.log');
  assert.equal(sanitizeFilename('console.txt'), 'console.txt');
});

test('trims trailing dots and spaces that Windows silently drops', () => {
  assert.equal(sanitizeFilename('name.   '), 'name');
  assert.equal(sanitizeFilename('name...'), 'name');
});

test('truncates long unicode names without splitting characters', () => {
  const long = 'あ'.repeat(200) + '.txt';
  const out = sanitizeFilename(long)!;
  assert.ok(new TextEncoder().encode(out).byteLength <= 255);
  assert.ok(out.endsWith('.txt'));
  assert.ok(!out.includes('\ufffd'));
});

test('relative paths keep folder structure but cannot escape it', () => {
  assert.deepEqual(sanitizeRelPath('a.txt', 'project/src/a.txt'), { name: 'a.txt', relPath: 'project/src/a.txt' });
  assert.equal(sanitizeRelPath('passwd', '../../etc/passwd'), null);
  assert.equal(sanitizeRelPath('a.txt', 'src/../../a.txt'), null);
  assert.deepEqual(sanitizeRelPath('a.txt', './src/./a.txt'), { name: 'a.txt', relPath: 'src/a.txt' });
  assert.equal(sanitizeRelPath('a.txt', Array.from({ length: 20 }, () => 'd').join('/') + '/a.txt'), null);
});

test('dedupeName produces unique, human names', () => {
  const used = new Set<string>();
  const first = dedupeName('report.pdf', used);
  used.add(first.toLowerCase());
  const second = dedupeName('report.pdf', used);
  used.add(second.toLowerCase());
  const third = dedupeName('report.pdf', used);
  assert.equal(first, 'report.pdf');
  assert.equal(second, 'report (1).pdf');
  assert.equal(third, 'report (2).pdf');
  assert.equal(dedupeName('README', new Set(['readme'])), 'README (1)');
});
