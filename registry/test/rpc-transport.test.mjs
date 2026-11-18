import test from 'node:test';
import assert from 'node:assert/strict';
import { PiProvider } from '../lib/chain.mjs';

test('direct transport uses only the configured RPC and preserves batch results/errors', async t => {
  const payload = [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: ['0x' + '11'.repeat(32)] }];
  const results = [{ jsonrpc: '2.0', id: 1, result: '0x9e5b5' },
    { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'node error' } }];
  let calls = 0;
  const provider = new PiProvider({ transport: 'direct', fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'http://52.87.7.52:8545');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), payload);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    return { ok: true, json: async () => results };
  } });
  t.after(() => provider.destroy());
  assert.deepEqual(await provider._send(payload), results); assert.equal(calls, 1);
  assert.throws(() => new PiProvider({ transport: 'unexpected' }), /Unsupported/);
});

test('uncertain raw transaction send is not retried or switched to SSH and errors omit payloads', async t => {
  let calls = 0;
  const provider = new PiProvider({ transport: 'direct', fetcher: async () => {
    calls++; throw new Error('private diagnostic must not propagate');
  } });
  t.after(() => provider.destroy());
  await assert.rejects(provider._send({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x1234'] }),
    error => /outcome may be unknown/.test(error.message) && !/private diagnostic|1234/.test(error.message));
  assert.equal(calls, 1);
});
