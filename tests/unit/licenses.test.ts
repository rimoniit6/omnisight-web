import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLicenseKey, isValidLicenseFormat } from '../../src/lib/licenses';

const KEY_RE = /^OMNISIGHT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

test('generateLicenseKey produces OMNISIGHT-XXXX-XXXX-XXXX', () => {
  for (let i = 0; i < 500; i++) {
    const key = generateLicenseKey();
    assert.match(key, KEY_RE, `unexpected format: ${key}`);
  }
});

test('generateLicenseKey uses all three groups and canonical prefix', () => {
  const key = generateLicenseKey();
  const [prefix, ...groups] = key.split('-');
  assert.equal(prefix, 'OMNISIGHT', 'prefix should be OMNISIGHT');
  assert.equal(groups.length, 3, 'expected exactly 3 groups of 4');
  for (const group of groups) {
    assert.equal(group.length, 4, 'each group must be 4 chars');
  }
});

test('generateLicenseKey returns distinct keys', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const key = generateLicenseKey();
    assert.ok(!seen.has(key), 'duplicate key generated');
    seen.add(key);
  }
});

test('isValidLicenseFormat accepts canonical keys', () => {
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABCD-1234-EFGH'), true);
  assert.equal(isValidLicenseFormat('OMNISIGHT-0000-AAAA-ZZZ9'), true);
});

test('isValidLicenseFormat rejects malformed keys', () => {
  assert.equal(isValidLicenseFormat(''), false);
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABCD-1234'), false, 'too few groups');
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABCD-1234-EFGH-0000'), false, 'too many groups');
  assert.equal(isValidLicenseFormat('OMNISIGHT-abcd-1234-EFGH'), false, 'lowercase rejected');
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABC!-1234-EFGH'), false, 'invalid char rejected');
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABCD-1234-EFGH '), false, 'trailing space rejected');
  assert.equal(isValidLicenseFormat('OMNISIGHT-ABCD-1234-EFGH-'), false, 'trailing dash rejected');
  assert.equal(isValidLicenseFormat('FOOBAR-ABCD-1234-EFGH'), false, 'wrong prefix');
});

test('generated keys always pass isValidLicenseFormat (generator/validator agree)', () => {
  for (let i = 0; i < 500; i++) {
    const key = generateLicenseKey();
    assert.equal(isValidLicenseFormat(key), true, `generator/validator mismatch: ${key}`);
  }
});
