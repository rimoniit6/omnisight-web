import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebsiteDomain, sanitizeWebsiteTitle } from '../src/shared/domain.js';

test('normalizes full URLs to domain only', () => {
  assert.equal(normalizeWebsiteDomain('https://www.github.com/a/b?x=1'), 'github.com');
  assert.equal(normalizeWebsiteDomain('https://github.com/a/b'), 'github.com');
  assert.equal(normalizeWebsiteDomain('https://mail.google.com/mail/u/0/'), 'mail.google.com');
  assert.equal(normalizeWebsiteDomain('https://www.youtube.com/watch?v=abc'), 'youtube.com');
  assert.equal(normalizeWebsiteDomain('https://stackoverflow.com/questions/123'), 'stackoverflow.com');
});

test('handles bare hosts and mixed case', () => {
  assert.equal(normalizeWebsiteDomain('github.com'), 'github.com');
  assert.equal(normalizeWebsiteDomain('GITHUB.COM'), 'github.com');
  assert.equal(normalizeWebsiteDomain('HTTP://WWW.YOUTUBE.COM/watch?v=1'), 'youtube.com');
  assert.equal(normalizeWebsiteDomain('www.github.com'), 'github.com');
});

test('strips credentials, ports, queries, fragments', () => {
  assert.equal(normalizeWebsiteDomain('https://user:pass@example.com/a'), 'example.com');
  assert.equal(normalizeWebsiteDomain('https://example.com:8443/path'), 'example.com');
  assert.equal(normalizeWebsiteDomain('https://example.com/path?token=SECRET123'), 'example.com');
  assert.equal(normalizeWebsiteDomain('https://example.com/#frag'), 'example.com');
});

test('rejects internal/unsupported schemes', () => {
  assert.equal(normalizeWebsiteDomain('chrome://settings'), null);
  assert.equal(normalizeWebsiteDomain('chrome-extension://abc/foo'), null);
  assert.equal(normalizeWebsiteDomain('edge://flags'), null);
  assert.equal(normalizeWebsiteDomain('about:blank'), null);
  assert.equal(normalizeWebsiteDomain('moz-extension://xyz'), null);
  assert.equal(normalizeWebsiteDomain('file:///C:/x.html'), null);
  assert.equal(normalizeWebsiteDomain('javascript:alert(1)'), null);
  assert.equal(normalizeWebsiteDomain('data:text/html,hi'), null);
  assert.equal(normalizeWebsiteDomain('devtools://devtools'), null);
});

test('rejects localhost, IPs and malformed hostnames', () => {
  assert.equal(normalizeWebsiteDomain('localhost:3000'), null);
  assert.equal(normalizeWebsiteDomain('http://localhost'), null);
  assert.equal(normalizeWebsiteDomain('http://127.0.0.1:3000'), null);
  assert.equal(normalizeWebsiteDomain('http://192.168.1.1'), null);
  assert.equal(normalizeWebsiteDomain('not a valid hostname'), null);
  assert.equal(normalizeWebsiteDomain(''), null);
  assert.equal(normalizeWebsiteDomain('   '), null);
  assert.equal(normalizeWebsiteDomain(null), null);
  assert.equal(normalizeWebsiteDomain(undefined), null);
  assert.equal(normalizeWebsiteDomain(42), null);
});

test('keeps subdomains other than www', () => {
  assert.equal(normalizeWebsiteDomain('https://mail.google.com/mail/'), 'mail.google.com');
  assert.equal(normalizeWebsiteDomain('https://sub.domain.io/x'), 'sub.domain.io');
});

test('sanitizeWebsiteTitle strips URL-like tokens', () => {
  assert.equal(sanitizeWebsiteTitle('GitHub'), 'GitHub');
  assert.equal(sanitizeWebsiteTitle('https://github.com/user/secret?token=abc'), null);
  assert.equal(sanitizeWebsiteTitle('Home — https://github.com/user/repo?x=1'), 'Home —');
  assert.equal(sanitizeWebsiteTitle('   '), null);
  assert.equal(sanitizeWebsiteTitle(null), null);
  assert.equal(sanitizeWebsiteTitle(undefined), null);
});
