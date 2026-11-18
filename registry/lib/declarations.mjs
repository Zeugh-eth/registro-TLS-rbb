import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, Interface, getAddress } from 'ethers';
import { ROOT, PiProvider } from './chain.mjs';
import { publicationConfig, getJob, readPublication as readLivePublication } from './publication.mjs';
import { parseTceInput, sha256 } from './tce.mjs';
import { sourceId, validatePublicationContract } from '../public/publication-wallet.js';
import { saveJSON } from './publication-batch.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const BATCH = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;
const iso = seconds => new Date(Number(seconds) * 1000).toISOString();
const dateText = code => String(code).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2 : null; };
async function optionalJSON(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }

export function createDeclarationArchive({ stateRoot = ROOT + 'state', provider: injectedProvider,
  getConfig = publicationConfig, artifact: injectedArtifact, readJob = getJob } = {}) {
  const directory = path.join(stateRoot, 'declarations');
  const indexFile = path.join(directory, 'index.json');
  let provider = injectedProvider, syncing, timer;
  const empty = () => ({ schema: 'rbb-declaration-index/v1', records: [], cursor: null, cursorHash: null, caughtUp: false, verifiedAt: null });
  const readIndex = () => optionalJSON(indexFile, empty());
  const ensureProvider = () => (provider ||= new PiProvider());

  async function localBatches() {
    let names = [];
    try { names = await fs.readdir(path.join(stateRoot, 'batches')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const batches = [];
    for (const name of names.filter(name => BATCH.test(name))) {
      const plan = await optionalJSON(path.join(stateRoot, 'batches', name, 'plan.json'));
      if (plan?.schema !== 'rbb-publication-batch/v1' || !Array.isArray(plan.entries)) continue;
      const counts = {};
      for (const entry of plan.entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
      const runner = await optionalJSON(path.join(stateRoot, 'batches', name, 'runner.json'));
      let processPresent = false;
      const lockedPid = await optionalJSON(path.join(stateRoot, 'batch-writer.lock'));
      if (Number.isSafeInteger(runner?.pid) && runner.pid > 1 && lockedPid === runner.pid) {
        try { process.kill(runner.pid, 0); processPresent = true; } catch {}
      }
      const current = plan.entries.find(entry => ['proving', 'proven', 'pending'].includes(entry.status));
      let job = null;
      if (current?.jobId) { try { job = await readJob(current.jobId); } catch {} }
      batches.push({ id: name, window: plan.window, target: plan.target, counts, total: plan.entries.length,
        complete: plan.entries.every(entry => ['confirmed', 'already_registered'].includes(entry.status)), processPresent,
        active: current ? { date: current.date, url: current.url, status: current.status, stage: job?.stage || null,
          jobId: current.jobId || null, transactionHash: current.transactionHash || null } : null,
        entries: plan.entries, failures: plan.entries.filter(entry => entry.status === 'failed').map(({ date, url, error, jobId }) => ({ date, url, error, jobId })),
        daysWithoutEdition: plan.calendar?.filter(day => day.status === 'checked' && !day.sources?.length && !plan.entries.some(entry => entry.date === day.date)).length ?? null,
        createdAt: plan.createdAt, startedAt: runner?.startedAt || null });
    }
    return batches;
  }

  async function localEvidence(hash, documentHash) {
    const archive = path.join(stateRoot, 'evidence', hash.slice(2));
    let bytes;
    try { bytes = await fs.readFile(path.join(archive, 'manifest.json')); }
    catch (error) { if (error.code === 'ENOENT') return { available: false, integrity: 'missing', parts: [] }; throw error; }
    if (sha256(bytes) !== hash) return { available: false, integrity: 'mismatch', parts: [] };
    const manifest = JSON.parse(bytes);
    if (manifest.documentHash !== documentHash || !Array.isArray(manifest.pdfParts) || manifest.pdfParts.length > 128) return { available: false, integrity: 'mismatch', parts: [] };
    const expected = [{ file: 'document.pdf', kind: 'pdf', hash: documentHash },
      { file: 'calendar.tlsn', kind: 'calendar', hash: manifest.calendarProofHash },
      ...manifest.pdfParts.map((part, index) => ({ file: `pdf-${index}.tlsn`, kind: 'part', index, hash: part.proofHash,
        start: part.start, end: part.end, total: part.total, etag: part.etag, observedAtISO: iso(part.observedAt) }))];
    const parts = [];
    for (const item of expected) {
      let present = false, valid = false, size = null;
      try { const file = await fs.readFile(path.join(archive, item.file)); present = true; size = file.length; valid = sha256(file) === item.hash; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      parts.push({ ...item, present, valid, size });
    }
    return { available: parts.every(part => part.valid), integrity: parts.every(part => part.valid) ? 'matches' : 'incomplete',
      manifest, parts, bundleURL: '/api/publication/evidence/' + hash };
  }

  async function localTiming(entry, batchId, hash, includedAtISO) {
    if (!entry?.jobId || !/^[0-9a-f-]{36}$/.test(entry.jobId)) return null;
    const file = path.join(stateRoot, 'jobs', entry.jobId, 'job.json');
    const job = await optionalJSON(file);
    if (job?.status !== 'verified') return null;
    const stat = await fs.stat(file);
    const saved = await optionalJSON(path.join(stateRoot, 'batches', batchId, 'transactions', hash + '.json'));
    const seconds = (later, earlier) => Number.isFinite(later) && Number.isFinite(earlier) && later >= earlier ? (later - earlier) / 1000 : null;
    return { jobId: entry.jobId, proofStartedAt: job.startedAt, proofFinishedAt: new Date(stat.mtimeMs).toISOString(),
      proofSeconds: seconds(stat.mtimeMs, Date.parse(job.startedAt)), proofFinishedAtSource: 'local job file mtime',
      signedAt: saved?.createdAt || null, broadcastAttemptedAt: saved?.broadcastAttemptedAt || null,
      preparationSeconds: seconds(Date.parse(saved?.createdAt), stat.mtimeMs),
      inclusionSeconds: seconds(Date.parse(includedAtISO), Date.parse(saved?.broadcastAttemptedAt)),
      pdfBytes: job.result.size, pdfParts: job.result.pdfParts.length,
      note: 'Tempos locais aproximados. O preparo inclui revalidação e eventuais esperas; a inclusão usa o timestamp do bloco.' };
  }

  async function buildRecord(log, config, artifact, batches) {
    const rpc = ensureProvider(), iface = new Interface(artifact.abi), contract = new Contract(config.contract, artifact.abi, rpc);
    const [receipt, tx, block] = await Promise.all([
      rpc.send('eth_getTransactionReceipt', [log.transactionHash]), rpc.send('eth_getTransactionByHash', [log.transactionHash]),
      rpc.send('eth_getBlockByNumber', [log.blockNumber, false])
    ]);
    if (log.removed || log.address.toLowerCase() !== config.contract.toLowerCase() || !receipt || receipt.status !== '0x1' ||
        receipt.transactionHash !== log.transactionHash || tx?.hash !== log.transactionHash || receipt.blockHash !== log.blockHash ||
        block?.hash !== receipt.blockHash || receipt.to?.toLowerCase() !== config.contract.toLowerCase() ||
        tx.to?.toLowerCase() !== config.contract.toLowerCase() || receipt.from?.toLowerCase() !== config.writer.toLowerCase() ||
        tx.from?.toLowerCase() !== config.writer.toLowerCase() || Number(BigInt(tx.chainId)) !== config.chainId) throw new Error('Recibo, rede ou bloco não correspondem à declaração.');
    const call = iface.parseTransaction({ data: tx.input, value: tx.value });
    if (call?.name !== 'registerPublication') throw new Error('Transação não é um registro de publicação.');
    const [url, claim, signature] = call.args, date = dateText(claim.editionDate);
    const parsed = parseTceInput(url, date);
    if (parsed.canonicalURL !== url || sourceId(url) !== claim.sourceId) throw new Error('Identidade da fonte inconsistente.');
    const events = receipt.logs.filter(item => item.address.toLowerCase() === config.contract.toLowerCase()).map(item => iface.parseLog(item));
    const observed = events.find(event => event.name === 'PublicationObserved' && event.args.sourceId === claim.sourceId &&
      event.args.editionDate === claim.editionDate && event.args.documentHash === claim.documentHash && event.args.evidenceHash === claim.evidenceHash && event.args.observedAt === claim.observedAt);
    if (!observed) throw new Error('Evento não corresponde aos metadados da transação.');
    const [[exists, first], [versionExists, version]] = await Promise.all([
      contract.getRecord(claim.sourceId, claim.editionDate), contract.getVersion(claim.sourceId, claim.editionDate, claim.documentHash)
    ]);
    if (!exists || !versionExists || first.registeredAt > version.registeredAt || version.documentHash !== claim.documentHash) throw new Error('Estado do contrato não confirma o registro.');
    const membership = [];
    let timing = null;
    for (const batch of batches) {
      if (batch.target?.chainId !== config.chainId || batch.target?.contract?.toLowerCase() !== config.contract.toLowerCase()) continue;
      const entry = batch.entries.find(entry => entry.url === url && entry.date === date);
      if (entry) {
        membership.push({ id: batch.id, window: batch.window, role: entry.status === 'already_registered' ? 'preexisting' : 'submitted' });
        if (entry.transactionHash === tx.hash) timing = await localTiming(entry, batch.id, tx.hash, iso(BigInt(block.timestamp)));
      }
    }
    const proof = await localEvidence(claim.evidenceHash, claim.documentHash);
    if (proof.manifest) {
      proof.metadataMatchesClaim = proof.manifest.sourceURL === url && proof.manifest.editionDate === date &&
        proof.manifest.editionDateCode === Number(claim.editionDate) && proof.manifest.publicationDateCode === Number(claim.publicationDate) &&
        proof.manifest.observedAt === Number(claim.observedAt);
      if (!proof.metadataMatchesClaim) { proof.available = false; proof.integrity = 'mismatch'; }
    }
    const claimObject = Object.fromEntries(['sourceId', 'documentHash', 'evidenceHash', 'editionDate', 'publicationDate', 'observedAt', 'validUntil', 'nonce'].map(key => [key, typeof claim[key] === 'bigint' ? Number(claim[key]) : claim[key]]));
    const blockTime = Number(BigInt(block.timestamp));
    return { schema: 'rbb-declaration/v1', id: tx.hash, verifiedAt: new Date().toISOString(),
      chain: { id: config.chainId, genesis: config.genesis, contract: config.contract, writer: config.writer, verifier: config.verifier },
      source: { url, sourceId: claim.sourceId, editionDate: date, editionDateCode: Number(claim.editionDate),
        publicationDate: dateText(claim.publicationDate), editionNumber: proof.metadataMatchesClaim ? proof.manifest.editionNumber || null : null, calendarURL: parsed.calendarURL },
      hashes: { algorithm: 'SHA-256', document: claim.documentHash, evidence: claim.evidenceHash },
      dates: { firstRegisteredAt: Number(first.registeredAt), firstRegisteredAtISO: iso(first.registeredAt),
        versionFirstRegisteredAtISO: iso(version.registeredAt), includedAtISO: iso(blockTime), observedAtISO: iso(claim.observedAt),
        collectionStartedAtISO: proof.manifest?.observationStartedAt ? iso(proof.manifest.observationStartedAt) : null },
      kind: events.some(event => event.name === 'PublicationRecorded') ? (first.documentHash === claim.documentHash ? 'first-registration' : 'new-version') : 'observation',
      transaction: { hash: tx.hash, from: tx.from, to: tx.to, nonce: Number(BigInt(tx.nonce)), type: tx.type,
        blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash, transactionIndex: Number(BigInt(receipt.transactionIndex)),
        status: 1, value: tx.value, gasLimit: tx.gas, gasUsed: receipt.gasUsed, gasPrice: tx.gasPrice, input: tx.input },
      attestation: { claim: claimObject, signature, trustModel: proof.manifest?.trustModel || config.trustModel },
      receipt: jsonSafe(receipt), evidence: proof, batches: membership, timing,
      query: { application: { url, date, contract: config.contract },
        getRecord: { sourceId: claim.sourceId, editionDate: Number(claim.editionDate) },
        getVersion: { sourceId: claim.sourceId, editionDate: Number(claim.editionDate), documentHash: claim.documentHash },
        firstDigestRegisteredAt: { documentHash: claim.documentHash }, hashAlgorithm: 'SHA-256' } };
  }

  function compact(record) {
    return { id: record.id, source: record.source, hashes: record.hashes, dates: record.dates, kind: record.kind,
      blockNumber: record.transaction.blockNumber, blockHash: record.transaction.blockHash,
      verifiedAt: record.verifiedAt, evidenceAvailable: record.evidence.available, evidenceIntegrity: record.evidence.integrity,
      pdfBytes: record.evidence.manifest?.size || null, pdfParts: record.evidence.manifest?.pdfParts.length || null,
      batchIds: record.batches.map(batch => batch.id), timing: record.timing };
  }

  async function synchronize() {
    const config = { ...await getConfig() };
    if (!config.contract || !Number.isSafeInteger(config.deploymentBlock)) throw new Error('Contrato ou bloco de deploy não configurado.');
    config.contract = getAddress(config.contract);
    const rpc = ensureProvider(), artifact = injectedArtifact || JSON.parse(await fs.readFile(ROOT + 'build/PublicationRegistry.json', 'utf8'));
    await validatePublicationContract({ request: ({ method, params = [] }) => rpc.send(method, params) }, config, artifact, config.contract);
    let index = await readIndex();
    if (index.contract && (index.contract !== config.contract || index.chainId !== config.chainId || index.genesis !== config.genesis)) throw new Error('Arquivo local pertence a outro contrato/rede.');
    const head = await rpc.send('eth_getBlockByNumber', ['latest', false]), latest = Number(BigInt(head.number));
    if (index.cursor !== null) {
      const previous = await rpc.send('eth_getBlockByNumber', ['0x' + index.cursor.toString(16), false]);
      if (previous?.hash !== index.cursorHash) {
        // Keep the prior snapshot on disk for audit, but rebuild confirmation from deployment.
        await saveJSON(path.join(directory, 'before-reorg.json'), index);
        index = empty();
        await saveJSON(indexFile, index); // Known orphaned records must not survive a failed rebuild.
      }
    }
    const batches = await localBatches(), topic = new Interface(artifact.abi).getEvent('PublicationObserved').topicHash;
    let from = Math.max(config.deploymentBlock, index.cursor === null ? config.deploymentBlock : index.cursor - 12);
    for (let page = 0; from <= latest && page < 4; page++) {
      const to = Math.min(latest, from + 4999), logs = [];
      for (let begin = from; begin <= to; begin += 1000) {
        const items = await rpc.send('eth_getLogs', [{ address: config.contract, fromBlock: '0x' + begin.toString(16), toBlock: '0x' + Math.min(to, begin + 999).toString(16), topics: [topic] }]);
        if (!Array.isArray(items)) throw new Error('RPC não retornou eventos válidos.');
        logs.push(...items.filter(item => !item.removed));
      }
      const inRange = new Set(logs.map(item => item.transactionHash));
      let records = index.records.filter(item => item.blockNumber < from || item.blockNumber > to || inRange.has(item.id));
      const known = new Map(records.map(item => [item.id, item]));
      for (const log of logs) {
        if (!HASH.test(log.transactionHash)) throw new Error('Hash de evento inválido.');
        const old = known.get(log.transactionHash);
        if (old?.blockHash === log.blockHash) continue;
        const record = await buildRecord(log, config, artifact, batches);
        await saveJSON(path.join(directory, 'records', record.id + '.json'), record);
        known.set(record.id, { ...compact(record), dossierHash: sha256(Buffer.from(JSON.stringify(record, null, 2) + '\n')) });
      }
      const checkpoint = await rpc.send('eth_getBlockByNumber', ['0x' + to.toString(16), false]);
      if (!checkpoint?.hash) throw new Error('Bloco de referência indisponível.');
      const checkedHead = await rpc.send('eth_getBlockByNumber', [head.number, false]);
      if (checkedHead?.hash !== head.hash) throw new Error('Cadeia mudou durante a indexação. Tente atualizar novamente.');
      index = { ...index, chainId: config.chainId, contract: config.contract, genesis: config.genesis,
        records: [...known.values()].sort((a, b) => b.blockNumber - a.blockNumber),
        cursor: to, cursorHash: checkpoint.hash, caughtUp: to === latest, verifiedAt: new Date().toISOString() };
      await saveJSON(indexFile, index);
      from = to + 1;
    }
    await saveJSON(path.join(directory, 'status.json'), { lastAttemptAt: new Date().toISOString(), error: null });
    return index;
  }

  function sync() {
    if (!syncing) syncing = synchronize().catch(async error => {
      await saveJSON(path.join(directory, 'status.json'), { lastAttemptAt: new Date().toISOString(), error: String(error.message).slice(0, 220) });
      throw error;
    }).finally(() => { syncing = null; });
    return syncing;
  }

  async function list() {
    const index = await readIndex(), status = await optionalJSON(path.join(directory, 'status.json'), {}), batches = await localBatches();
    const times = index.records.map(record => record.timing).filter(time => Number.isFinite(time?.proofSeconds));
    return { ...index, sync: { ...status, running: !!syncing },
      batches: batches.map(({ entries, ...batch }) => ({ ...batch, archivedDeclarations: index.records.filter(record => record.batchIds.includes(batch.id)).length })),
      performance: { samples: times.length, proofSeconds: median(times.map(time => time.proofSeconds)),
        preparationSeconds: median(times.map(time => time.preparationSeconds)), inclusionSeconds: median(times.map(time => time.inclusionSeconds)),
        minProofSeconds: times.length ? Math.min(...times.map(time => time.proofSeconds).filter(Number.isFinite)) : null,
        maxProofSeconds: times.length ? Math.max(...times.map(time => time.proofSeconds).filter(Number.isFinite)) : null } };
  }

  async function detail(id) {
    if (!HASH.test(id)) throw new Error('Identificador de declaração inválido.');
    const item = (await readIndex()).records.find(item => item.id === id);
    if (!item) throw new Error('Declaração ainda não arquivada.');
    const bytes = await fs.readFile(path.join(directory, 'records', id + '.json'));
    if (sha256(bytes) !== item.dossierHash) throw new Error('Dossiê local alterado; confira a sincronização.');
    return JSON.parse(bytes);
  }

  async function readPublication(input) {
    const parsed = parseTceInput(input.url, input.date), target = getAddress(input.contract.trim());
    const config = await getConfig();
    try {
      return await readLivePublication(input, { provider: ensureProvider(), chainConfig: config });
    } catch (error) {
      // Validation failures are not outages. Never mask a wrong chain, contract or input.
      if (error.code !== 'RPC_UNAVAILABLE') throw error;
      const index = await readIndex(), records = [];
      if (index.contract && (getAddress(index.contract) !== target || index.chainId !== config.chainId || index.genesis !== config.genesis))
        throw new Error('O arquivo preservado pertence a outro contrato ou rede.');
      const candidates = index.records.filter(item => item.kind === 'first-registration' &&
        item.source.editionDate === parsed.date && (!parsed.canonicalURL || item.source.url === parsed.canonicalURL));
      for (const item of candidates) {
        const record = await detail(item.id);
        if (record.chain.id !== config.chainId || record.chain.genesis !== config.genesis || getAddress(record.chain.contract) !== target ||
            getAddress(record.chain.writer) !== getAddress(config.writer) || getAddress(record.chain.verifier) !== getAddress(config.verifier) ||
            record.transaction.status !== 1 || record.receipt.status !== '0x1' || record.kind !== 'first-registration' ||
            record.source.sourceId !== sourceId(record.source.url) || record.source.editionDateCode !== parsed.dateCode ||
            record.source.editionDate !== parsed.date || (parsed.canonicalURL && record.source.url !== parsed.canonicalURL) ||
            record.dates.firstRegisteredAtISO !== record.dates.includedAtISO)
          throw new Error('Dossiê preservado não corresponde ao primeiro registro solicitado.');
        records.push({ sourceURL: record.source.url, editionDate: parsed.date,
          registeredAt: record.dates.firstRegisteredAt, registeredAtISO: record.dates.firstRegisteredAtISO,
          observedAt: record.attestation.claim.observedAt, observedAtISO: record.dates.observedAtISO,
          publicationDateCode: record.attestation.claim.publicationDate,
          documentHash: record.hashes.document, evidenceHash: record.hashes.evidence,
          evidenceAvailable: record.evidence.available, transactionHash: record.id,
          blockNumber: record.transaction.blockNumber, declarationURL: '/declaracoes#' + record.id });
      }
      if (!records.length) throw Object.assign(new Error('Não foi possível consultar a RBB e não há confirmação preservada para este link e data. Isso não significa que o documento não foi registrado. Tente novamente.'), { code: 'RPC_UNAVAILABLE' });
      records.sort((a, b) => a.registeredAt - b.registeredAt);
      return { schema: 'rbb-publication-history/v1', chainId: config.chainId, contract: target, algorithm: 'SHA-256',
        registered: true, editionDate: parsed.date, records, firstRegisteredAtISO: records[0].registeredAtISO,
        sourceFetched: false, readAt: new Date().toISOString(),
        verification: { source: 'archive', verifiedAt: index.verifiedAt, networkAvailable: false,
          partial: !parsed.canonicalURL, reason: error.message } };
    }
  }

  async function attachment(id, part) {
    const record = await detail(id);
    const item = record.evidence.parts.find(item => item.file === part);
    if (!item || !['document.pdf', 'calendar.tlsn'].includes(part) && !/^pdf-\d{1,3}\.tlsn$/.test(part)) throw new Error('Parte de evidência inválida.');
    const bytes = await fs.readFile(path.join(stateRoot, 'evidence', record.hashes.evidence.slice(2), part));
    if (sha256(bytes) !== item.hash) throw new Error('Arquivo de evidência alterado.');
    return { bytes, name: part, contentType: part === 'document.pdf' ? 'application/pdf' : 'application/octet-stream' };
  }

  async function exportJSON() {
    const index = await list();
    return { schema: 'rbb-declaration-export/v1', exportedAt: new Date().toISOString(), chainId: index.chainId, contract: index.contract,
      coverage: { throughBlock: index.cursor, verifiedAt: index.verifiedAt, caughtUp: index.caughtUp }, batches: await localBatches(),
      declarations: await Promise.all(index.records.map(record => detail(record.id))) };
  }

  async function exportCSV() {
    const { records } = await readIndex();
    const rows = [['url', 'edition_date', 'first_registered_at_utc', 'transaction_hash', 'block', 'source_id', 'hash_algorithm', 'document_sha256', 'evidence_sha256', 'publication_date', 'observed_at_utc', 'batch_ids'],
      ...records.map(r => [r.source.url, r.source.editionDate, r.dates.firstRegisteredAtISO, r.id, r.blockNumber, r.source.sourceId, 'SHA-256', r.hashes.document, r.hashes.evidence, r.source.publicationDate, r.dates.observedAtISO, r.batchIds.join(';')])];
    return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
  }

  return { sync, list, detail, readPublication, attachment, exportJSON, exportCSV,
    start() { if (timer) return; void sync().catch(() => {}); timer = setInterval(() => void sync().catch(() => {}), 15000); timer.unref(); },
    stop() { clearInterval(timer); timer = null; if (!injectedProvider) provider?.destroy(); } };
}
