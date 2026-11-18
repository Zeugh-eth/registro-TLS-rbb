import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { observe, verifyBundle, verifyBundleSignature, contentDigest, signResponse, publicJwk, COMPONENTS, jwkFingerprint, sha256Hex } from '../lib/signed-response.mjs';
import { recordObservation, verifyEvidence, idOf } from '../lib/signed-registry.mjs';
import { createRelayer, addApiKey, loadApiKeys } from '../relayer/server.mjs';
import { createSigner } from '../../signed-origin/server.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function fakeChain(blocks) {
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_blockNumber') result = '0x' + Math.max(...Object.keys(blocks).map(Number)).toString(16);
    else if (method === 'eth_getBlockByNumber') result = blocks[Number(BigInt(params[0]))] || null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'Content-Type': 'application/json' } });
  };
}

const NOW = Math.floor(Date.now() / 1000);
const blocks = {};
for (let n = 100; n <= 103; n++) blocks[n] = { hash: '0x' + String(n).padStart(64, 'a'), timestamp: '0x' + (NOW - 120 + n).toString(16) };
const chainFetch = fakeChain(blocks);
const nonceSource = { name: 'test', chainId: 1, rpcUrl: 'http://rpc.invalid', confirmations: 3 };

function bundleFor(sourceURL, nonce, privateKey, keyId = 'teste-1') {
  const u = new URL(sourceURL);
  const headers = signResponse({ authority: u.host, path: u.pathname, body: PDF, nonce: nonce.blockHash, keyId, privateKey, created: NOW });
  const jwk = publicJwk(privateKey, keyId);
  const key = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: jwk.kid };
  return { schema: 'rbb-signed-response/v1', sourceURL, authority: u.host, path: u.pathname, nonce,
    request: { method: 'GET', acceptSignature: `sig1=${COMPONENTS};nonce="${nonce.blockHash}"` },
    response: { status: 200, contentType: 'application/pdf', contentDigest: headers['Content-Digest'], signatureInput: headers['Signature-Input'], signature: headers.Signature },
    document: { sha256: sha256Hex(PDF), size: PDF.length },
    key: { url: new URL('/.well-known/publication-key.json', sourceURL).href, jwk: key, fingerprint: jwkFingerprint(key) },
    fetchedAt: new Date(NOW * 1000).toISOString() };
}
const encode = bundle => Buffer.from(JSON.stringify(bundle, null, 2) + '\n');

test('Node sample signer produces responses the verifier accepts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(dir + '/teste.pdf', PDF);
  const { privateKey } = generateKeyPairSync('ed25519');
  const port = await freePort();
  const authority = `127.0.0.1:${port}`;
  const server = createSigner({ privateKey, keyId: 'teste-1', documents: dir, prefix: '/publicacoes/', authorities: new Set([authority]) });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://${authority}/publicacoes/teste.pdf`;
  const result = await observe(url, { nonceSource, nonceFetcher: chainFetch, allowInsecure: true });

  assert.equal(result.bundle.nonce.blockNumber, 100);
  assert.equal(result.bundle.nonce.blockHash, blocks[100].hash);
  assert.equal(result.bundle.document.sha256, sha256Hex(PDF));
  assert.equal(result.bundle.response.contentDigest, contentDigest(PDF));
  assert.equal(result.offline.keyId, 'teste-1');
  assert.deepEqual(result.body, PDF);

  const changed = Buffer.from(PDF); changed[10] ^= 1;
  assert.throws(() => verifyBundle(result.bundle, changed), /não corresponde/);
  const otherNonce = structuredClone(result.bundle); otherNonce.nonce.blockHash = blocks[101].hash;
  assert.throws(() => verifyBundle(otherNonce, PDF), /nonce/);
  const otherPath = structuredClone(result.bundle); otherPath.sourceURL = url.replace('teste', 'outro'); otherPath.path = '/publicacoes/outro.pdf';
  assert.throws(() => verifyBundle(otherPath, PDF), /Assinatura do servidor inválida/);
  const otherCreated = structuredClone(result.bundle);
  otherCreated.response.signatureInput = otherCreated.response.signatureInput.replace(/created=\d+/, 'created=1');
  assert.throws(() => verifyBundle(otherCreated, PDF), /Assinatura do servidor inválida/);
  assert.doesNotThrow(() => verifyBundleSignature(result.bundle));

  assert.equal((await fetch(`http://${authority}/publicacoes/nao-existe.pdf`)).status, 404);
  assert.equal((await fetch(`http://${authority}/publicacoes/..%2Fsegredo.pdf`)).status, 404);
  const preflight = await fetch(url, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Accept-Signature/);
  await assert.rejects(observe(url, { nonceSource, nonceFetcher: chainFetch }), /HTTPS/);
});

async function startAnvil(t) {
  const port = await freePort();
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
  t.after(() => anvil.kill());
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  t.after(() => provider.destroy());
  return { provider, url };
}

test('direct recording on a local EVM bounds the observation window', async t => {
  const { provider } = await startAnvil(t);
  const writer = await provider.getSigner(0), other = await provider.getSigner(1);
  const a = compile('SignedPublicationRegistry');
  const contract = await new ContractFactory(a.abi, a.bytecode, writer).deploy(writer.address, 1);
  await contract.waitForDeployment();
  const { privateKey } = generateKeyPairSync('ed25519');
  const nonce = { source: 'test', chainId: 1, blockNumber: 100, blockHash: blocks[100].hash, blockTimestamp: Number(BigInt(blocks[100].timestamp)) };
  const bundle = bundleFor('https://apolinar.io/publicacoes/teste.pdf', nonce, privateKey);
  verifyBundle(bundle, PDF);
  const encoded = encode(bundle);
  const evidenceHash = sha256Hex(encoded);

  await assert.rejects(contract.connect(other).registerKey('apolinar.io', 'teste-1', bundle.key.fingerprint));
  await assert.rejects(contract.recordObservation(bundle.sourceURL, bundle.document.sha256, evidenceHash, 100, nonce.blockHash, bundle.key.fingerprint));
  await assert.rejects(contract.authorityOf(Buffer.from('http://apolinar.io/x')));
  await assert.rejects(contract.authorityOf(Buffer.from('https://Apolinar.io/x')));
  assert.equal(Buffer.from((await contract.authorityOf(Buffer.from('https://apolinar.io/a/b.pdf'))).slice(2), 'hex').toString(), 'apolinar.io');

  const anchor = await recordObservation(contract, bundle, evidenceHash);
  assert.equal(anchor.key.registered, true);
  assert.equal(anchor.index, 0);
  const sourceId = idOf(bundle.sourceURL);
  assert.equal(await contract.observationCount(sourceId), 1n);
  assert.equal((await contract.observationAt(sourceId, 0)).evidenceHash, evidenceHash);
  assert.equal(Number(await contract.firstSeen(sourceId, bundle.document.sha256)), anchor.registeredAt);
  await assert.rejects(contract.recordObservation(bundle.sourceURL, bundle.document.sha256, evidenceHash, 100, nonce.blockHash, bundle.key.fingerprint));

  const report = await verifyEvidence({ encoded, body: PDF, anchor, contract, nonceSource, fetcher: chainFetch });
  assert.equal(report.anchored, true);
  assert.equal(report.notBefore, nonce.blockTimestamp);
  assert.equal(report.notAfter, anchor.registeredAt);
  assert.match(report.claim, /apolinar\.io assinou \/publicacoes\/teste\.pdf/);

  const forked = fakeChain({ ...blocks, 100: { ...blocks[100], hash: '0x' + 'f'.repeat(64) } });
  await assert.rejects(verifyEvidence({ encoded, body: PDF, anchor, contract, nonceSource, fetcher: forked }), /canônico/);
  const otherEncoded = encode(bundleFor('https://apolinar.io/publicacoes/teste.pdf', nonce, generateKeyPairSync('ed25519').privateKey));
  await assert.rejects(verifyEvidence({ encoded: otherEncoded, body: PDF, anchor, contract, nonceSource, fetcher: chainFetch }), /não registra esta evidência/);

  const local = await new ContractFactory(a.abi, a.bytecode, writer).deploy(writer.address, 31337);
  await local.waitForDeployment();
  const head = await provider.getBlock('latest');
  const sameChain = { source: 'anvil', chainId: 31337, blockNumber: head.number, blockHash: head.hash, blockTimestamp: head.timestamp };
  const good = bundleFor('https://apolinar.io/publicacoes/teste.pdf', sameChain, privateKey);
  await provider.send('evm_mine', []);
  await (await local.registerKey('apolinar.io', 'teste-1', good.key.fingerprint)).wait();
  await assert.rejects(local.recordObservation(good.sourceURL, good.document.sha256, '0x' + '2'.repeat(64), sameChain.blockNumber, '0x' + '1'.repeat(64), good.key.fingerprint));
  assert.equal((await recordObservation(local, good, sha256Hex(encode(good)))).index, 0);
  await provider.send('anvil_mine', ['0x101']);
  await assert.rejects(local.recordObservation(good.sourceURL, good.document.sha256, '0x' + '3'.repeat(64), sameChain.blockNumber, sameChain.blockHash, good.key.fingerprint));
});

test('relayer records observations for API-key holders and checks the domain key', async t => {
  const { provider, url: rpcUrl } = await startAnvil(t);
  const writer = await provider.getSigner(0);
  const a = compile('SignedPublicationRegistry');
  const contract = await new ContractFactory(a.abi, a.bytecode, writer).deploy(writer.address, 31337);
  await contract.waitForDeployment();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const apiKey = await addApiKey('observador-1', dir + '/keys.json');
  await assert.rejects(addApiKey('observador-1', dir + '/keys.json'), /Já existe/);
  assert.equal(fs.statSync(dir + '/keys.json').mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(dir + '/keys.json', 'utf8').includes(apiKey));

  const { privateKey } = generateKeyPairSync('ed25519');
  const { privateKey: impostor } = generateKeyPairSync('ed25519');
  const published = publicJwk(privateKey, 'teste-1');
  const logged = [];
  const relayer = createRelayer({ contract, apiKeys: await loadApiKeys(dir + '/keys.json'), log: entry => logged.push(entry),
    keyFetcher: async () => ({ kty: published.kty, crv: published.crv, x: published.x, kid: published.kid }) });
  const port = await listen(relayer);
  t.after(() => relayer.close());
  const post = (body, key = apiKey) => fetch(`http://127.0.0.1:${port}/v1/observations`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body });

  const head = await provider.getBlock('latest');
  const nonce = { source: 'anvil', chainId: 31337, blockNumber: head.number, blockHash: head.hash, blockTimestamp: head.timestamp };
  await provider.send('evm_mine', []);
  const bundle = bundleFor('https://apolinar.io/publicacoes/teste.pdf', nonce, privateKey);
  const encoded = encode(bundle);

  assert.equal((await post(encoded, 'rbbk_' + 'x'.repeat(32))).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/observations`, { method: 'POST', body: encoded })).status, 401);
  const tampered = structuredClone(bundle); tampered.document.sha256 = '0x' + '9'.repeat(64);
  assert.equal((await post(encode(tampered))).status, 502);
  const refused = await post(encode(bundleFor('https://apolinar.io/publicacoes/teste.pdf', nonce, impostor)));
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /não é a publicada/);

  const accepted = await post(encoded);
  assert.equal(accepted.status, 201);
  const anchor = await accepted.json();
  assert.equal(anchor.recordedVia, 'relayer');
  assert.equal(anchor.contract, contract.target);
  assert.equal(logged.at(-1).observer, 'observador-1');
  assert.equal(Number(await contract.evidenceRegisteredAt(sha256Hex(encoded))), anchor.registeredAt);
  assert.ok(await contract.keyRegisteredAt(idOf('apolinar.io'), jwkFingerprint(published)) > 0n);
  assert.equal(await contract.keyRegisteredAt(idOf('apolinar.io'), jwkFingerprint(publicJwk(impostor, 'teste-1'))), 0n);

  const report = await verifyEvidence({ encoded, body: PDF, anchor, contract, nonceSource: { ...nonceSource, chainId: 31337, rpcUrl } });
  assert.equal(report.anchored, true);
  assert.ok(report.notAfter >= report.notBefore);

  assert.equal((await post(encoded)).status, 502);
  await provider.send('anvil_mine', ['0x100']);
  const stale = await post(encode(bundleFor('https://apolinar.io/publicacoes/outro.pdf', nonce, privateKey)));
  assert.equal(stale.status, 422);
  assert.match((await stale.json()).error, /antigo/);
});
