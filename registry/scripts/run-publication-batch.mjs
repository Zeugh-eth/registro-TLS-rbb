import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Contract, Interface, Transaction, keccak256 } from 'ethers';
import { ROOT, PiProvider } from '../lib/chain.mjs';
import { publicationConfig } from '../lib/publication.mjs';
import { preparePublication, validatePublicationContract, sourceId, publicationDomain, publicationTypes } from '../public/publication-wallet.js';
import { verifyTypedData } from 'ethers';
import { BATCH_ROOT, TARGET, dateWindow, validatePlan, summary, saveJSON, loadBatchWallet,
  guardTransaction, submitOnce, sleep, readBatchResponse } from '../lib/publication-batch.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--end' || !args[1] || args.slice(2).some(flag => !['--execute', '--retry-failed'].includes(flag))) {
  throw new Error('Uso: node scripts/run-publication-batch.mjs --end YYYY-MM-DD [--execute] [--retry-failed]');
}
const window = dateWindow(args[1]);
const directory = BATCH_ROOT + window.start + '_' + window.end;
const planFile = directory + '/plan.json', pendingFile = directory + '/pending.json';
const plan = validatePlan(JSON.parse(await fs.readFile(planFile, 'utf8')));
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ ...summary(plan), mode: 'status-only', keyRequired: 'npm run batch:key', transactionBroadcast: false }, null, 2));
} else {
  await run().catch(error => {
    // Never print argument objects or stack traces from wallet/JSON-RPC exceptions.
    console.error('Lote interrompido: ' + String(error.message).replace(/(?:0x)?[0-9a-fA-F]{64}/g, '[valor omitido]').slice(0, 400));
    process.exitCode = 1;
  });
}

async function run() {
  if (!plan.discoveryComplete || plan.calendar.some(day => day.status !== 'checked')) throw new Error('Conclua o inventário, incluindo as datas com erro, antes da execução.');
  const globalLock = await fs.open(ROOT + 'state/batch-writer.lock', 'wx', 0o600);
  await globalLock.writeFile(String(process.pid));
  let planLock, provider, awake, stopped = false;
  const stop = () => { stopped = true; console.log('Parada solicitada. Finalizando o documento/transação atual.'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    planLock = await fs.open(directory + '/plan.lock', 'wx', 0o600);
    await planLock.writeFile(String(process.pid));
    if (process.platform === 'darwin') {
      // Keep the Mac awake only while this bounded batch process is alive.
      awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      await new Promise((resolve, reject) => { awake.once('spawn', resolve); awake.once('error', reject); });
      awake.unref();
    }
    provider = new PiProvider();
    const artifact = JSON.parse(await fs.readFile(ROOT + 'build/PublicationRegistry.json', 'utf8'));
    const iface = new Interface(artifact.abi);
    const config = { ...await publicationConfig(), ...TARGET };
    const adapter = { request: ({ method, params = [] }) => method === 'eth_accounts' ? Promise.resolve([TARGET.writer]) : provider.send(method, params) };
    await validatePublicationContract(adapter, config, artifact, TARGET.contract);
    const contract = new Contract(TARGET.contract, artifact.abi, provider);
    const wallet = await loadBatchWallet();
    const persist = () => saveJSON(planFile, plan);
    const pending = await readOptional(pendingFile);
    if (pending) await finishPending(pending);
    let consecutiveFailures = 0;

    for (const entry of plan.entries) {
      if (stopped) break;
      const [exists, record] = await contract.getRecord(sourceId(entry.url), Number(entry.date.replaceAll('-', '')));
      if (exists) {
        entry.status = entry.status === 'confirmed' ? 'confirmed' : 'already_registered';
        entry.firstRegisteredAtISO = new Date(Number(record.registeredAt) * 1000).toISOString();
        entry.documentHash = record.documentHash; entry.evidenceHash = record.evidenceHash;
        await persist(); continue;
      }
      if (entry.status === 'confirmed' || entry.status === 'already_registered') throw new Error('Registro antes confirmado não encontrado; revisão da rede necessária.');
      if (entry.status === 'failed' && !args.includes('--retry-failed')) continue;
      const disk = await fs.statfs(ROOT);
      if (Number(disk.bavail) * Number(disk.bsize) < 5 * 1024 ** 3) throw new Error('Menos de 5 GiB livres; lote parado antes de gerar outra prova.');
      let job;
      try {
        if (entry.jobId) job = await api('/jobs/' + entry.jobId);
        if (!job || job.status === 'failed' || (job.status === 'verified' && Date.now() / 1000 - job.result.observedAt > 1000)) {
          job = await api('/prove', { url: entry.url, date: entry.date });
          entry.jobId = job.id;
        }
        entry.status = 'proving'; await persist();
        console.log(entry.date + ' · coletando prova · ' + entry.url);
        const deadline = Date.now() + 25 * 60 * 1000;
        while (job.status === 'running') {
          if (Date.now() > deadline) throw new Error('Coleta excedeu 25 minutos.');
          await sleep(2000); job = await api('/jobs/' + entry.jobId);
        }
        if (job.status !== 'verified') throw new Error(job.error || 'Falha na prova TLSNotary.');
        if (job.result.sourceURL !== entry.url || job.result.editionDate !== entry.date || !job.result.proofVerified) throw new Error('Prova não corresponde à edição.');
        entry.documentHash = job.result.documentHash; entry.evidenceHash = job.result.evidenceHash;
        entry.status = 'proven'; delete entry.error; await persist();
      } catch (error) {
        entry.status = 'failed'; entry.error = String(error.message).slice(0, 300); await persist();
        console.log(entry.date + ' · prova não concluída; nenhuma transação enviada.');
        if (++consecutiveFailures >= 3) throw new Error('Três provas consecutivas falharam. Revise as falhas antes de continuar.');
        continue;
      }
      if (stopped) break;
      // Fresh attestation per PDF. No annual batch of expiring signatures.
      const attestation = await api('/attest', { evidenceHash: entry.evidenceHash, contract: TARGET.contract });
      const tx = await preparePublication(adapter, config, artifact, TARGET.contract, attestation);
      guardTransaction(tx, entry, attestation, artifact);
      const [latestNonce, pendingNonce] = await Promise.all(['latest', 'pending'].map(tag => provider.send('eth_getTransactionCount', [TARGET.writer, tag])));
      if (BigInt(latestNonce) !== BigInt(pendingNonce)) throw new Error('A carteira possui outra transação pendente. Aguarde a confirmação antes de retomar.');
      const raw = await wallet.signTransaction({ chainId: TARGET.chainId, type: 0, nonce: Number(BigInt(pendingNonce)),
        to: TARGET.contract, data: tx.data, value: 0, gasPrice: 0, gasLimit: BigInt(tx.gas) });
      const signed = { schema: 'rbb-batch-pending/v1', hash: keccak256(raw), raw,
        url: entry.url, date: entry.date, documentHash: entry.documentHash, evidenceHash: entry.evidenceHash,
        attestation, preparedTransaction: tx, createdAt: new Date().toISOString() };
      await saveJSON(pendingFile, signed);
      entry.status = 'pending'; entry.transactionHash = signed.hash; await persist();
      await finishPending(signed);
      consecutiveFailures = 0;
    }
    plan.lastRunAt = new Date().toISOString();
    plan.runComplete = plan.entries.every(entry => ['confirmed', 'already_registered'].includes(entry.status));
    await persist();
    await saveJSON(ROOT + '../reports/publication/batch-365-progress.json', { ...summary(plan), target: TARGET,
      runComplete: plan.runComplete, entries: plan.entries, checkedAt: plan.lastRunAt });
    console.log(JSON.stringify({ ...summary(plan), runComplete: plan.runComplete }, null, 2));

    async function finishPending(saved) {
      const entry = plan.entries.find(item => item.url === saved.url && item.date === saved.date);
      if (!entry || saved.schema !== 'rbb-batch-pending/v1') throw new Error('Transação pendente fora do inventário.');
      const decoded = Transaction.from(saved.raw);
      if (decoded.hash !== saved.hash || decoded.from !== TARGET.writer || decoded.to !== TARGET.contract ||
          decoded.chainId !== BigInt(TARGET.chainId) || decoded.value !== 0n || decoded.gasPrice !== 0n || decoded.type !== 0 || decoded.gasLimit > 1000000n || decoded.gasLimit <= 0n ||
          decoded.data !== iface.encodeFunctionData('registerPublication', [entry.url, saved.attestation.claim, saved.attestation.signature]) ||
          saved.documentHash !== entry.documentHash || saved.evidenceHash !== entry.evidenceHash ||
          saved.attestation.sourceURL !== entry.url || saved.attestation.claim.sourceId !== sourceId(entry.url) ||
          Number(saved.attestation.claim.editionDate) !== Number(entry.date.replaceAll('-', '')) ||
          saved.attestation.claim.documentHash !== entry.documentHash || saved.attestation.claim.evidenceHash !== entry.evidenceHash ||
          verifyTypedData(publicationDomain(TARGET.chainId, TARGET.contract), publicationTypes, saved.attestation.claim, saved.attestation.signature) !== TARGET.verifier) {
        throw new Error('Transação persistida não corresponde à política e à prova.');
      }
      if (!saved.broadcastAttemptedAt) {
        if (Number(saved.attestation.claim.validUntil) < Date.now() / 1000 + 60) {
          await saveJSON(directory + '/transactions/' + saved.hash + '.not-sent.json', saved);
          await fs.unlink(pendingFile); entry.status = 'queued'; await persist(); return;
        }
        await validatePublicationContract(adapter, config, artifact, TARGET.contract);
        guardTransaction(saved.preparedTransaction, entry, saved.attestation, artifact);
      }
      const receipt = await submitOnce(saved, { persist: value => saveJSON(pendingFile, value),
        send: raw => provider.send('eth_sendRawTransaction', [raw]),
        receipt: hash => provider.send('eth_getTransactionReceipt', [hash]) });
      await saveJSON(directory + '/transactions/' + saved.hash + '.json', { ...saved, receipt });
      if (receipt.status !== '0x1') {
        entry.status = 'failed'; entry.error = 'Transação revertida. Recibo preservado; lote parado.';
        await persist(); await fs.unlink(pendingFile); throw new Error(entry.error);
      }
      const block = await provider.send('eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (block?.hash !== receipt.blockHash || receipt.from.toLowerCase() !== TARGET.writer.toLowerCase() || receipt.to.toLowerCase() !== TARGET.contract.toLowerCase()) throw new Error('Recibo não corresponde ao bloco/carteira/contrato.');
      const events = receipt.logs.filter(log => log.address.toLowerCase() === TARGET.contract.toLowerCase()).map(log => iface.parseLog(log));
      if (!events.some(event => event.name === 'PublicationRecorded' && event.args.sourceId === sourceId(entry.url) && Number(event.args.editionDate) === Number(entry.date.replaceAll('-', '')) && event.args.documentHash === entry.documentHash && event.args.evidenceHash === entry.evidenceHash)) throw new Error('Recibo sem o evento de registro esperado.');
      const result = await api('/read', { url: entry.url, date: entry.date, contract: TARGET.contract });
      const first = result.records?.find(item => item.sourceURL === entry.url);
      if (!result.registered || !first || first.documentHash !== entry.documentHash || first.evidenceHash !== entry.evidenceHash || first.registeredAt !== Number(BigInt(block.timestamp))) throw new Error('Consulta posterior não confirmou a primeira data esperada.');
      entry.status = 'confirmed'; entry.transactionHash = saved.hash;
      entry.firstRegisteredAtISO = first.registeredAtISO; entry.blockNumber = Number(BigInt(receipt.blockNumber));
      delete entry.error; await persist(); await fs.unlink(pendingFile);
      console.log(entry.date + ' · confirmado · ' + saved.hash + ' · ' + first.registeredAtISO);
    }
  } finally {
    provider?.destroy(); awake?.kill(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (planLock) { await planLock.close(); await fs.unlink(directory + '/plan.lock'); }
    await globalLock.close(); await fs.unlink(ROOT + 'state/batch-writer.lock');
  }
}

async function api(route, body) {
  const response = await fetch('http://127.0.0.1:8787/api/publication' + route, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
  return readBatchResponse(response, route);
}

async function readOptional(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
