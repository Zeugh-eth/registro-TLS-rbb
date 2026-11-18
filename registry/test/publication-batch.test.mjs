import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Wallet, Interface, keccak256 } from 'ethers';
import { newPlan, validatePlan, dateWindow, discover, summary, guardTransaction,
  submitOnce, loadBatchWallet, walletFromSecret, readBatchResponse, TARGET } from '../lib/publication-batch.mjs';
import { sourceId } from '../public/publication-wallet.js';

const url = date => `https://doe.tce.sp.gov.br/pdf/${date.slice(0, 4)}/${date.slice(5, 7)}/doe-tce-${date}.pdf`;

test('failed proof state remains readable for retry while HTTP and action errors still fail', async () => {
  const route = '/jobs/00000000-0000-4000-8000-000000000000';
  const failed = { id: route.slice(6), status: 'failed', error: 'Data da edição ausente ou ambígua no PDF.' };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await readBatchResponse(response(failed), route), failed);
  await assert.rejects(readBatchResponse(response(failed, 400), route), /Data da edição/);
  await assert.rejects(readBatchResponse(response(failed), '/prove'), /Data da edição/);
  await assert.rejects(readBatchResponse(response({ error: 'Serviço indisponível' }), route), /indisponível/);
  await assert.rejects(readBatchResponse(response(null), route), /inválida/);
});

test('365-day window is inclusive, handles leap years and rejects scope expansion', () => {
  assert.equal(dateWindow('2026-11-17').start, '2025-11-18');
  assert.equal(dateWindow('2024-03-01', 3).start, '2024-02-28');
  for (const [date, days] of [['2026-02-29', 365], ['2026-11-17', 366], ['2026-11-17', 0]]) assert.throws(() => dateWindow(date, days));
  const plan = newPlan('2026-11-17');
  assert.doesNotThrow(() => validatePlan(plan));
  assert.throws(() => validatePlan({ ...plan, discoveryComplete: true }), /ausentes/);
  assert.throws(() => validatePlan({ ...plan, target: { ...plan.target, chainId: 1 } }), /Destino/);
});

test('calendar inventory preserves extras, empty dates and errors without treating errors as no edition', async () => {
  const plan = newPlan('2026-11-17', 3);
  let calls = 0;
  const fetchCalendar = async endpoint => {
    calls++;
    if (endpoint.endsWith('/15')) return { body: Buffer.from('{"file":null}') };
    if (endpoint.endsWith('/16')) return { body: Buffer.from(JSON.stringify({ file: [new URL(url('2026-11-16')).pathname, new URL(url('2026-11-16').replace('.pdf', '-extra.pdf')).pathname] })) };
    return { body: Buffer.from('{"error":"temporarily unavailable"}') };
  };
  await discover(plan, { fetchCalendar, delay: async () => {} });
  assert.equal(summary(plan).emptyDays, 1); assert.equal(summary(plan).calendarErrors, 1);
  assert.equal(plan.entries.length, 2); assert.equal(plan.discoveryComplete, false);
  assert.doesNotThrow(() => validatePlan(plan));
  calls = 0;
  await discover(plan, { fetchCalendar: async () => { calls++; return { body: Buffer.from(JSON.stringify({ file: new URL(url('2026-11-17')).pathname })) }; }, delay: async () => {} });
  assert.equal(calls, 1); assert.equal(plan.discoveryComplete, true); assert.equal(plan.entries.length, 3);
  assert.doesNotThrow(() => validatePlan(plan));
  assert.throws(() => validatePlan({ ...plan, entries: plan.entries.slice(1) }), /ausente/);
  assert.throws(() => validatePlan({ ...plan, entries: [...plan.entries, plan.entries[0]] }), /duplicada/);
});

test('private key loading enforces owner-only regular files, expected address and sanitized errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rbb-key-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const wallet = Wallet.createRandom(), file = directory + '/key';
  await fs.writeFile(file, wallet.privateKey + '\n', { mode: 0o600 });
  assert.equal((await loadBatchWallet(file, wallet.address)).address, wallet.address);
  await fs.chmod(file, 0o644);
  await assert.rejects(loadBatchWallet(file, wallet.address), /permissão 600/);
  await fs.chmod(file, 0o600);
  await fs.symlink(file, directory + '/link');
  await assert.rejects(loadBatchWallet(directory + '/link', wallet.address));
  assert.throws(() => walletFromSecret(wallet.privateKey, TARGET.writer), /não corresponde/);
  assert.throws(() => walletFromSecret('invalid-secret-do-not-print'), error => !error.message.includes('invalid-secret-do-not-print'));
});

test('batch signing guard rejects value, fees, other networks/contracts, document substitution and expiry', async () => {
  const artifact = JSON.parse(await fs.readFile(new URL('../build/PublicationRegistry.json', import.meta.url), 'utf8'));
  const now = 1800000000;
  const entry = { date: '2026-11-17', url: url('2026-11-17'), documentHash: '0x' + '12'.repeat(32), evidenceHash: '0x' + '34'.repeat(32) };
  const claim = { sourceId: sourceId(entry.url), documentHash: entry.documentHash, evidenceHash: entry.evidenceHash,
    editionDate: 20261117, publicationDate: 20261118, observedAt: now - 30, validUntil: now + 900, nonce: '0x' + '56'.repeat(32) };
  const attestation = { sourceURL: entry.url, claim, signature: '0x' + '78'.repeat(65) };
  const tx = { from: TARGET.writer, to: TARGET.contract, chainId: TARGET.chainId, value: '0x0', type: '0x0', gas: '0x50000', gasPrice: '0x0',
    data: new Interface(artifact.abi).encodeFunctionData('registerPublication', [entry.url, claim, attestation.signature]) };
  assert.doesNotThrow(() => guardTransaction(tx, entry, attestation, artifact, now));
  for (const changed of [{ chainId: 1 }, { to: TARGET.writer }, { from: TARGET.contract }, { value: '0x1' }, { gasPrice: '0x1' }, { type: '0x2' }, { gas: '0xf4241' }, { data: '0x' }]) {
    assert.throws(() => guardTransaction({ ...tx, ...changed }, entry, attestation, artifact, now));
  }
  assert.throws(() => guardTransaction(tx, { ...entry, date: '2026-11-16' }, attestation, artifact, now));
  assert.throws(() => guardTransaction(tx, { ...entry, evidenceHash: entry.documentHash }, attestation, artifact, now));
  assert.throws(() => guardTransaction(tx, entry, attestation, artifact, now + 850), /expirar/);
});

test('signed transaction is durably checkpointed before broadcast and an ambiguous response is never blindly resent', async () => {
  const wallet = Wallet.createRandom();
  const raw = await wallet.signTransaction({ to: TARGET.contract, nonce: 0, chainId: TARGET.chainId, gasLimit: 21000, gasPrice: 0, value: 0, type: 0 });
  const pending = { raw, hash: keccak256(raw) }, order = [];
  let saved, sends = 0;
  const persist = async item => { saved = JSON.parse(JSON.stringify(item)); order.push(item.broadcastAttemptedAt ? 'attempt-saved' : 'signed-saved'); };
  await assert.rejects(submitOnce(pending, { persist, receipt: async () => null,
    send: async () => { sends++; order.push('send'); throw new Error('RPC timeout after accepting transaction'); }, attempts: 0 }), /timeout/);
  assert.deepEqual(order, ['signed-saved', 'attempt-saved', 'send']);
  await assert.rejects(submitOnce(saved, { persist, receipt: async () => null, send: async () => { sends++; }, attempts: 0 }), /mesmo hash/);
  assert.equal(sends, 1);
  const receipt = { status: '0x1', transactionHash: saved.hash };
  assert.deepEqual(await submitOnce(saved, { persist, receipt: async () => receipt, send: async () => { sends++; } }), receipt);
  assert.equal(sends, 1);
  await assert.rejects(submitOnce({ ...saved, raw: '0x01' }, { persist }), /alterada/);
});
