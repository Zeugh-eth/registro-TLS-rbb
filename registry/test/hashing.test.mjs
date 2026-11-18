import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashDocument } from '../public/hashing.js';

test('application hashes exact binary bytes and empty files using SHA-256', async () => {
  for (const data of [new Uint8Array(), new Uint8Array([0, 255, 13, 10, 128, 65]), new TextEncoder().encode('abc')]) {
    const expected = '0x' + createHash('sha256').update(data).digest('hex');
    assert.equal(await hashDocument(new File([data], 'file.pdf')), expected);
  }
  assert.notEqual(await hashDocument(new File(['abc'], 'a')), await hashDocument(new File(['abc\n'], 'a')));
  await assert.rejects(hashDocument(new File(['abc'], 'a'), 'KECCAK-256'), /não suportado/);
});
