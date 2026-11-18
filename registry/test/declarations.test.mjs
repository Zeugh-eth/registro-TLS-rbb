import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { createDeclarationArchive } from '../lib/declarations.mjs';
import { createServer } from '../server.mjs';
import { sha256 } from '../lib/tce.mjs';
import { PiProvider } from '../lib/chain.mjs';
import { saveJSON } from '../lib/publication-batch.mjs';
import { sourceId, publicationDomain, publicationTypes } from '../public/publication-wallet.js';

const sourceURL = 'https://doe.tce.sp.gov.br/pdf/2026/11/doe-tce-2026-11-14.pdf';
const hash = value => sha256(Buffer.from(value));

test('persistent declaration archive validates real receipts, preserves first dates and survives offline reads', async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rbb-declarations-'));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
  t.after(() => child.kill());
  let startupError; child.on('error', error => { startupError = error; });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (startupError) throw startupError;
    try { const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }); t.after(() => provider.destroy());
  const writer = await provider.getSigner(0), attester = Wallet.createRandom(), artifact = compile('PublicationRegistry');
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, writer).deploy(writer.address, attester.address);
  await contract.waitForDeployment();
  const config = { chainId: 31337, genesis: (await provider.send('eth_getBlockByNumber', ['0x0', false])).hash,
    writer: writer.address, verifier: attester.address, contract: contract.target,
    deploymentBlock: (await contract.deploymentTransaction().wait()).blockNumber, trustModel: 'test fixture; no TLS claim' };
  const archive = createDeclarationArchive({ stateRoot, provider, artifact, getConfig: async () => config });
  let counter = 0;
  async function claim() {
    const observedAt = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp));
    const pdf = Buffer.from('%PDF-test-only'), calendar = Buffer.from('calendar test fixture'), part = Buffer.from('PDF part test fixture');
    const manifest = { sourceURL, editionDate: '2026-11-14', editionDateCode: 20261114, publicationDateCode: 20261116,
      editionNumber: 934, observedAt, observationStartedAt: observedAt, documentHash: sha256(pdf), size: pdf.length,
      trustModel: config.trustModel, calendarProofHash: sha256(calendar),
      pdfParts: [{ start: 0, end: pdf.length - 1, total: pdf.length, etag: '"test-v1"', proofHash: sha256(part), observedAt }] };
    const bytes = Buffer.from(JSON.stringify(manifest)), evidenceHash = sha256(bytes), directory = path.join(stateRoot, 'evidence', evidenceHash.slice(2));
    await fs.mkdir(directory, { recursive: true });
    for (const [name, data] of [['manifest.json', bytes], ['document.pdf', pdf], ['calendar.tlsn', calendar], ['pdf-0.tlsn', part]]) await fs.writeFile(path.join(directory, name), data);
    return { sourceId: sourceId(sourceURL), documentHash: sha256(pdf), evidenceHash, editionDate: 20261114,
      publicationDate: 20261116, observedAt, validUntil: observedAt + 900, nonce: hash('nonce ' + ++counter) };
  }
  async function publish() {
    const p = await claim(), signature = await attester.signTypedData(publicationDomain(31337, contract.target), publicationTypes, p);
    const tx = await contract.registerPublication(sourceURL, p, signature); await tx.wait(); return tx.hash;
  }
  const firstHash = await publish();
  let original;
  await t.test('indexes confirmed transaction, receipt, public query metadata and hash-bound files', async () => {
    const index = await archive.sync(); assert.equal(index.records.length, 1); assert.equal(index.caughtUp, true);
    original = await archive.detail(firstHash);
    assert.equal(original.transaction.status, 1); assert.equal(original.receipt.status, '0x1');
    assert.equal(original.kind, 'first-registration'); assert.equal(original.hashes.algorithm, 'SHA-256');
    assert.equal(original.query.application.url, sourceURL); assert.equal(original.query.application.date, '2026-11-14');
    assert.equal(original.query.getRecord.sourceId, sourceId(sourceURL)); assert.equal(original.query.getRecord.editionDate, 20261114);
    assert.equal(original.dates.firstRegisteredAtISO, original.dates.includedAtISO);
    assert.equal(original.evidence.available, true); assert.equal(original.evidence.metadataMatchesClaim, true);
    assert.equal(original.evidence.parts.length, 3);
    assert.equal(sha256((await archive.attachment(firstHash, 'document.pdf')).bytes), original.hashes.document);
    await assert.rejects(archive.attachment(firstHash, '../../secrets/batch-writer.key'));
    await assert.rejects(archive.detail('../index'));
  });
  await t.test('disk-backed API and exports stay usable when RPC fails', async () => {
    const offline = createDeclarationArchive({ stateRoot, provider: { send() { throw new Error('RPC offline fixture'); } }, artifact, getConfig: async () => config });
    await assert.rejects(offline.sync(), /RPC offline/);
    assert.equal((await offline.list()).records.length, 1); assert.match((await offline.list()).sync.error, /RPC offline/);
    assert.equal((await offline.detail(firstHash)).transaction.hash, firstHash);
    assert.equal((await offline.exportJSON()).declarations[0].query.application.date, '2026-11-14');
    assert.match(await offline.exportCSV(), new RegExp(firstHash)); assert.match(await offline.exportCSV(), /SHA-256/);
    const server = createServer({ archive: offline }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.match(await (await fetch(base + '/declaracoes')).text(), /Declarações/);
      assert.equal((await (await fetch(base + '/api/declarations')).json()).records.length, 1);
      const csv = await fetch(base + '/api/declarations/export.csv'); assert.match(csv.headers.get('Content-Type'), /text\/csv/); assert.equal(csv.status, 200);
      const pdf = await fetch(base + '/api/declarations/' + firstHash + '/pdf'); assert.equal(pdf.headers.get('Content-Type'), 'application/pdf'); assert.equal(sha256(Buffer.from(await pdf.arrayBuffer())), original.hashes.document);
      assert.equal((await fetch(base + '/api/declarations/' + firstHash + '/calendar')).status, 200);
      assert.equal((await fetch(base + '/api/declarations/' + firstHash + '/pdf-0')).status, 200);
      assert.equal((await fetch(base + '/api/declarations', { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await fetch(base + '/api/declarations/sync', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(base + '/state/secrets/batch-writer.key')).status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  await t.test('link/date lookup survives an unavailable RPC with explicit archive provenance and no false negatives', async () => {
    const rpc = new PiProvider({ transport: 'direct', fetcher: async () => { throw new TypeError('fetch failed'); } });
    const offline = createDeclarationArchive({ stateRoot, provider: rpc, artifact, getConfig: async () => config });
    const server = createServer({ archive: offline }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const query = body => fetch(base + '/api/publication/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const input = { url: sourceURL.replace('/pdf/', '/v/pdf/'), date: '2026-11-14', contract: contract.target };
    try {
      const response = await query(input), found = await response.json();
      assert.equal(response.status, 200, JSON.stringify(found));
      assert.equal(found.registered, true); assert.equal(found.verification.source, 'archive');
      assert.equal(found.firstRegisteredAtISO, original.dates.firstRegisteredAtISO);
      assert.equal(found.records[0].documentHash, original.hashes.document);
      assert.equal(found.records[0].transactionHash, firstHash);
      assert.equal(found.records[0].sourceURL, sourceURL); assert.equal(found.sourceFetched, false);
      assert.ok(found.verification.verifiedAt);
      const absent = await query({ ...input, url: 'https://doe.tce.sp.gov.br/', date: '2026-11-13' });
      assert.equal(absent.status, 503); assert.equal((await absent.json()).code, 'RPC_UNAVAILABLE');
      const wrongContract = await query({ ...input, contract: attester.address });
      assert.notEqual(wrongContract.status, 200);
      const wrongDate = await query({ ...input, date: '2026-11-13' });
      assert.equal(wrongDate.status, 400);
      const file = path.join(stateRoot, 'declarations', 'records', firstHash + '.json'), bytes = await fs.readFile(file);
      try { await fs.writeFile(file, '{}'); assert.notEqual((await query(input)).status, 200); }
      finally { await fs.writeFile(file, bytes); }
    } finally { await new Promise(resolve => server.close(resolve)); rpc.destroy(); }
  });
  await t.test('link/date live lookup reports a current network check', async () => {
    const result = await archive.readPublication({ url: sourceURL, date: '2026-11-14', contract: contract.target });
    assert.equal(result.verification.source, 'rpc'); assert.equal(result.registered, true);
    assert.equal(result.firstRegisteredAtISO, original.dates.firstRegisteredAtISO);
    const absent = await archive.readPublication({ url: 'https://doe.tce.sp.gov.br/', date: '2026-11-13', contract: contract.target });
    assert.equal(absent.registered, false); assert.equal(absent.verification.source, 'rpc');
  });
  await t.test('tampered dossiers and files cannot be downloaded as authentic evidence', async () => {
    const file = path.join(stateRoot, 'declarations', 'records', firstHash + '.json'), bytes = await fs.readFile(file);
    await fs.writeFile(file, '{}'); await assert.rejects(archive.detail(firstHash), /alterado/); await fs.writeFile(file, bytes);
    const pdfFile = path.join(stateRoot, 'evidence', original.hashes.evidence.slice(2), 'document.pdf'), pdf = await fs.readFile(pdfFile);
    await fs.writeFile(pdfFile, 'tampered'); await assert.rejects(archive.attachment(firstHash, 'document.pdf'), /alterado/); await fs.writeFile(pdfFile, pdf);
  });
  const snapshot = await provider.send('evm_snapshot', []);
  await t.test('repeated publication retains the first timestamp and failed receipts never become declarations', async () => {
    await provider.send('evm_increaseTime', [5]); await provider.send('evm_mine', []);
    const repeatedHash = await publish();
    const send = provider.send.bind(provider);
    provider.send = async (method, params) => { const result = await send(method, params); return method === 'eth_getTransactionReceipt' && params[0] === repeatedHash ? { ...result, status: '0x0' } : result; };
    await assert.rejects(archive.sync(), /Recibo/); assert.equal((await archive.list()).records.length, 1);
    provider.send = send;
    await archive.sync(); const repeated = await archive.detail(repeatedHash);
    assert.equal(repeated.kind, 'observation'); assert.equal(repeated.dates.firstRegisteredAtISO, original.dates.firstRegisteredAtISO);
    assert.notEqual(repeated.dates.includedAtISO, original.dates.includedAtISO);
    const failed = await contract.registerPublication(sourceURL, await claim(), '0x', { gasLimit: 500000 }); await assert.rejects(failed.wait());
    await archive.sync(); assert.equal((await archive.list()).records.length, 2); await assert.rejects(archive.detail(failed.hash), /não arquivada/);
  });
  await t.test('a changed canonical chain rebuilds the index instead of preserving orphan confirmations', async () => {
    await provider.send('evm_revert', [snapshot]); await provider.send('evm_mine', []);
    const send = provider.send.bind(provider);
    provider.send = async (method, params) => {
      if (method === 'eth_getLogs') throw new Error('RPC lost during reorg rebuild');
      return send(method, params);
    };
    await assert.rejects(archive.sync(), /reorg rebuild/);
    assert.equal((await archive.list()).records.length, 0, 'known-orphaned confirmations must be invalidated even if rebuilding fails');
    provider.send = send;
    await archive.sync(); const list = await archive.list(); assert.equal(list.records.length, 1); assert.equal(list.records[0].id, firstHash);
    assert.equal((await archive.detail(firstHash)).dates.firstRegisteredAtISO, original.dates.firstRegisteredAtISO);
  });
});
