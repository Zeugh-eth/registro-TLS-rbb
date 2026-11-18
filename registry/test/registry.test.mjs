import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import { hashDocument } from '../public/hashing.js';
import { ContractFactory, JsonRpcProvider, sha256, toUtf8Bytes, ZeroHash, ZeroAddress } from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { signer, validDigest, verifyNetwork, WRITER } from '../lib/chain.mjs';
import { createServer } from '../server.mjs';
import { validateContract, lookup, prepareRegistration, normalizeRuntime } from '../public/wallet.js';

test('contract behavior on a real local EVM', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const process = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
  let startupError;
  process.on('error', error => { startupError = error; });
  t.after(() => process.kill());
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (startupError) throw startupError;
    try { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}), headers:{'Content-Type':'application/json'} }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'anvil must start');
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const writer = await provider.getSigner(0), other = await provider.getSigner(1);
  const a = compile();
  const factory = new ContractFactory(a.abi, a.bytecode, writer);
  const contract = await factory.deploy(writer.address);
  await contract.waitForDeployment();
  const hash = sha256(toUtf8Bytes('documento original'));
  const config = { chainId: 31337, genesis: (await provider.send('eth_getBlockByNumber', ['0x0', false])).hash, writer: writer.address };
  const wallet = { request: ({method, params = []}) => provider.send(method, params) };
  await t.test('Remix-style deployed address validates without a server manifest', async () => {
    assert.equal(await validateContract(wallet, config, a, contract.target), contract.target);
    const wrongWriter = { ...config, writer: other.address };
    await assert.rejects(validateContract(wallet, wrongWriter, a, contract.target), /outra carteira/);
    await assert.rejects(validateContract(wallet, { ...config, chainId: 648629 }, a, contract.target), /Selecione RBB/);
    await assert.rejects(validateContract(wallet, config, a, ZeroAddress));
    const modified = { ...a, runtimeBytecode: '0x00' + a.runtimeBytecode.slice(4) };
    await assert.rejects(validateContract(wallet, config, modified, contract.target), /Código diferente/);
    const code = await provider.getCode(contract.target);
    const ref = Object.values(a.immutableReferences).flat()[0];
    const replacement = other.address.slice(2).toLowerCase().padStart(64, '0');
    const tampered = code.slice(0, 2 + ref.start * 2) + replacement + code.slice(2 + (ref.start + ref.length) * 2);
    try {
      await provider.send('anvil_setCode', [contract.target, tampered]);
      await assert.rejects(validateContract(wallet, config, a, contract.target), /outra carteira/);
    } finally { await provider.send('anvil_setCode', [contract.target, code]); }
  });
  await t.test('algorithm is discoverable on chain and incompatible declarations are rejected', async () => {
    assert.equal(await contract.hashAlgorithm(), 'SHA-256');
    const selector = contract.interface.encodeFunctionData('hashAlgorithm');
    const mismatch = { request: ({ method, params = [] }) => method === 'eth_call' && params[0].data === selector
      ? Promise.resolve(contract.interface.encodeFunctionResult('hashAlgorithm', ['KECCAK-256']))
      : wallet.request({ method, params }) };
    await assert.rejects(validateContract(mismatch, config, a, contract.target), /Algoritmo do contrato não suportado/);
  });
  await t.test('real file bytes round-trip through registration, repeat and public read', async () => {
    const original = new File([fs.readFileSync(new URL('./fixtures/abc.txt', import.meta.url))], 'abc.txt');
    const digest = await hashDocument(original, await contract.hashAlgorithm());
    assert.equal(digest, '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepEqual(Array.from(await contract.getRecord(digest)), [false, 0n]);
    const before = await lookup(wallet, config, a, contract.target, digest);
    assert.equal(before.registered, false); assert.equal(before.registeredAt, null);
    const tx = await prepareRegistration(wallet, config, a, contract.target, digest);
    const txHash = await wallet.request({ method:'eth_sendTransaction', params:[tx] });
    const first = await lookup(wallet, config, a, contract.target, digest, txHash);
    assert.equal(first.registered, true); assert.equal(first.algorithm, 'SHA-256');
    assert.equal(first.algorithmSource, 'contract.hashAlgorithm()');
    assert.equal(first.inclusion.isFirstRegistration, true);
    assert.equal(first.registeredAt, first.inclusion.blockTimestamp);
    const initialDate = first.registeredAt;
    assert.deepEqual(Array.from(await contract.getRecord(digest)), [true, BigInt(initialDate)]);
    const readerCalls = [];
    const publicReader = { request: ({method, params = []}) => {
      readerCalls.push(method);
      assert.ok(!['eth_accounts','eth_requestAccounts','eth_sendTransaction','eth_sendRawTransaction'].includes(method));
      return wallet.request({method, params});
    } };
    const sameFileRenamed = new File([await original.arrayBuffer()], 'renamed.pdf');
    const repeatHash = await hashDocument(sameFileRenamed, await contract.hashAlgorithm());
    assert.equal(repeatHash, digest);
    const publicProof = await lookup(publicReader, config, a, contract.target, repeatHash);
    assert.equal(publicProof.registeredAt, initialDate);
    assert.ok(readerCalls.includes('eth_call'));
    await provider.send('evm_increaseTime', [2]);
    assert.equal(await contract.register.staticCall(digest), BigInt(initialDate));
    const duplicateReceipt = await (await contract.register(digest)).wait();
    const duplicate = await lookup(wallet, config, a, contract.target, digest, duplicateReceipt.hash);
    assert.equal(duplicate.registeredAt, initialDate);
    assert.equal(duplicate.inclusion.isFirstRegistration, false);
    assert.ok(duplicate.inclusion.blockTimestamp > initialDate);
    const modified = await hashDocument(new File(['abd'], 'abc.txt'));
    const missing = await lookup(publicReader, config, a, contract.target, modified);
    assert.equal(missing.registered, false); assert.equal(missing.registeredAt, null);
    assert.deepEqual(Array.from(await contract.connect(other).getRecord(digest)), [true, BigInt(initialDate)]);
    fs.writeFileSync(new URL('../../reports/registry-roundtrip-2026-11-17.json', import.meta.url), JSON.stringify({
      environment:'Anvil local EVM, not RBB testnet', observedAt:new Date().toISOString(),
      digest, input:'abc (three exact bytes)', algorithm:first.algorithm, before, first, duplicate,
      renamedFileSameDigest:repeatHash === digest, publicReadWithoutAccount:true, modifiedFile:missing
    }, null, 2));
  });
  await t.test('wallet prepares, signs through provider and verifies the receipt end-to-end', async () => {
    const doc = sha256(toUtf8Bytes('MetaMask adapter test'));
    const tx = await prepareRegistration(wallet, config, a, contract.target, doc);
    assert.equal(tx.chainId, '0x7a69'); assert.equal(tx.from.toLowerCase(), writer.address.toLowerCase());
    const transactionHash = await wallet.request({method:'eth_sendTransaction',params:[tx]});
    const proof = await lookup(wallet, config, a, contract.target, doc, transactionHash);
    assert.equal(proof.registered, true); assert.equal(proof.submissionStatus, 'confirmed');
    assert.equal(proof.inclusion.transactionHash, transactionHash);
    await assert.rejects(lookup(wallet, config, a, contract.target, hash, transactionHash), /recibo não corresponde/);
    const wrongAccount = { request: ({method, params}) => method === 'eth_accounts' ? Promise.resolve([other.address]) : wallet.request({method, params}) };
    await assert.rejects(prepareRegistration(wrongAccount, config, a, contract.target, hash), /carteira escritora/);
  });
  await t.test('records SHA-256 and actual block timestamp with an event', async () => {
    assert.equal(await contract.registeredAt(hash), 0n);
    const receipt = await (await contract.register(hash)).wait();
    const block = await provider.getBlock(receipt.blockNumber);
    assert.equal(await contract.registeredAt(hash), BigInt(block.timestamp));
    const log = contract.interface.parseLog(receipt.logs[0]);
    assert.equal(log.name, 'DocumentRegistered'); assert.equal(log.args[0], hash);
    assert.equal(log.args[1], BigInt(block.timestamp));
  });
  await t.test('duplicate does not overwrite original time or emit another event', async () => {
    const first = await contract.registeredAt(hash);
    await provider.send('evm_increaseTime', [2]);
    const receipt = await (await contract.register(hash)).wait();
    assert.equal(receipt.logs.length, 0); assert.equal(await contract.registeredAt(hash), first);
  });
  await t.test('unauthorized writer cannot register or alter an existing record', async () => {
    await assert.rejects(contract.connect(other).register.staticCall(hash));
    await assert.rejects(contract.connect(other).register.staticCall(sha256(toUtf8Bytes('outro'))));
  });
  await t.test('zero hash, zero writer and native value are rejected', async () => {
    await assert.rejects(contract.register.staticCall(ZeroHash));
    await assert.rejects(factory.deploy(ZeroAddress));
    await assert.rejects(contract.register.staticCall(hash, { value: 1n }));
  });
  await t.test('different bytes produce independent records; hash matches SHA-256 standard vector', async () => {
    assert.equal(sha256(toUtf8Bytes('abc')), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const changed = sha256(toUtf8Bytes('documento original\n'));
    assert.notEqual(hash, changed); assert.equal(await contract.registeredAt(changed), 0n);
    await (await contract.register(changed)).wait(); assert.ok(await contract.registeredAt(changed) > 0n);
  });
});

test('network and signing guards', async () => {
  assert.equal(WRITER.toLowerCase(), '0x43c530588209ac49c1fc6987af930b9077168fdb');
  assert.throws(() => signer(null, 'invalid'));
  assert.throws(() => signer(null, '0x' + '11'.repeat(32)), /does not match/);
  await assert.rejects(verifyNetwork({ send: async () => '0xb8efce' }), /Wrong chain/);
  assert.equal(validDigest(ZeroHash), false);
  assert.equal(validDigest('0x' + '11'.repeat(32)), true);
});

test('static wallet app allows navigation but exposes no server signing endpoint', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const getWithHeaders = (path, headers) => new Promise((resolve, reject) => {
    http.get(origin + path, { headers }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const landing = await getWithHeaders('/', navigation);
  assert.equal(landing.status, 200); assert.match(landing.body, /Conectar MetaMask/);
  assert.equal((await getWithHeaders('/api/config', navigation)).status, 403);
  assert.equal((await getWithHeaders('/', { ...navigation, Host:'foreign.example' })).status, 403);
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.mode, 'metamask'); assert.equal(config.serverSigning, false);
  assert.equal(config.writer.toLowerCase(), WRITER.toLowerCase());
  assert.equal((await fetch(origin + '/api/register', {method:'POST',body:'{}'})).status,405);
  assert.equal((await fetch(origin + '/DocumentRegistry.sol')).status,200);
  assert.equal((await fetch(origin + '/wallet.js')).status,200);
  assert.equal((await fetch(origin + '/hashing.js')).status,200);
  assert.equal((await fetch(origin + '/ethers.js')).status,200);
  assert.equal((await fetch(origin + '/contract.json')).status,200);
  assert.equal((await fetch(origin + '/.env')).status,404);
});
