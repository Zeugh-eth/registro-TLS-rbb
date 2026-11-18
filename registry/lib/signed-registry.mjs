import fs from 'node:fs/promises';
import { Contract, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { ROOT } from './chain.mjs';
import { DEFAULT_NONCE_SOURCE, sha256Hex, verifyBundle, checkNonce, fetchKey } from './signed-response.mjs';

export const STATE = ROOT + 'state/signed/';
export const idOf = text => keccak256(toUtf8Bytes(text));

export async function artifact() {
  return JSON.parse(await fs.readFile(ROOT + 'build/SignedPublicationRegistry.json', 'utf8'));
}

export async function loadConfig(file = process.env.SIGNED_CONFIG || STATE + 'config.json') {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  return { nonceSource: DEFAULT_NONCE_SOURCE, ...saved };
}

export async function registryAt(address, runner) {
  const a = await artifact();
  const contract = new Contract(getAddress(address), a.abi, runner);
  const provider = runner.provider || runner;
  if (await provider.getCode(contract.target) === '0x') throw new Error('Nenhum contrato nesse endereço.');
  if (await contract.signatureScheme() !== 'RFC9421-ed25519') throw new Error('Contrato não é o registro de respostas assinadas.');
  return contract;
}

export async function storeEvidence(bundle, body, root = STATE + 'evidence/') {
  const encoded = Buffer.from(JSON.stringify(bundle, null, 2) + '\n');
  const evidenceHash = sha256Hex(encoded);
  const directory = root + evidenceHash.slice(2) + '/';
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(directory + 'bundle.json', encoded, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(directory + 'document.pdf', body, { flag: 'wx', mode: 0o600 });
  return { evidenceHash, directory };
}

export async function readEvidence(directory) {
  const encoded = await fs.readFile(directory + '/bundle.json');
  const body = await fs.readFile(directory + '/document.pdf');
  let anchor = null;
  try { anchor = JSON.parse(await fs.readFile(directory + '/anchor.json', 'utf8')); } catch {}
  return { encoded, bundle: JSON.parse(encoded), body, anchor, evidenceHash: sha256Hex(encoded) };
}

export async function ensureKey(contract, bundle) {
  const authorityId = idOf(bundle.authority);
  const existing = await contract.keyRegisteredAt(authorityId, bundle.key.fingerprint);
  if (existing !== 0n) return { registered: false, registeredAt: Number(existing) };
  const tx = await contract.registerKey(bundle.authority, bundle.key.jwk.kid, bundle.key.fingerprint);
  const receipt = await tx.wait(1, 180000);
  if (receipt?.status !== 1) throw new Error('Registro da chave falhou.');
  return { registered: true, transactionHash: receipt.hash, registeredAt: Number(await contract.keyRegisteredAt(authorityId, bundle.key.fingerprint)) };
}

export async function recordObservation(contract, bundle, evidenceHash) {
  const key = await ensureKey(contract, bundle);
  const tx = await contract.recordObservation(bundle.sourceURL, bundle.document.sha256, evidenceHash,
    bundle.nonce.blockNumber, bundle.nonce.blockHash, bundle.key.fingerprint);
  const receipt = await tx.wait(1, 180000);
  if (receipt?.status !== 1) throw new Error('Registro da observação falhou.');
  const event = receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'ObservationRecorded');
  const network = await contract.runner.provider.getNetwork();
  return { schema: 'rbb-signed-anchor/v1', chainId: Number(network.chainId), contract: contract.target,
    transactionHash: receipt.hash, blockNumber: receipt.blockNumber, registeredAt: Number(event.args.registeredAt),
    index: Number(event.args.index), key };
}

export async function checkAnchor(contract, anchor, evidenceHash, bundle) {
  const provider = contract.runner.provider || contract.runner;
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== anchor.chainId || getAddress(anchor.contract) !== contract.target) throw new Error('Âncora de outra rede ou contrato.');
  const receipt = await provider.getTransactionReceipt(anchor.transactionHash);
  if (receipt?.status !== 1) throw new Error('Transação da âncora não encontrada ou falhou.');
  const event = receipt.logs.filter(log => getAddress(log.address) === contract.target)
    .map(log => contract.interface.parseLog(log)).find(parsed => parsed?.name === 'ObservationRecorded');
  if (!event || event.args.evidenceHash !== evidenceHash) throw new Error('A transação não registra esta evidência.');
  const a = event.args;
  if (a.sourceURL !== bundle.sourceURL || a.documentHash !== bundle.document.sha256 || a.nonceBlockHash !== bundle.nonce.blockHash ||
      Number(a.nonceBlockNumber) !== bundle.nonce.blockNumber || a.keyFingerprint !== bundle.key.fingerprint) throw new Error('Evento diverge da evidência.');
  const block = await provider.getBlock(receipt.blockNumber);
  const registeredAt = Number(a.registeredAt);
  if (block.timestamp !== registeredAt || Number(await contract.evidenceRegisteredAt(evidenceHash)) !== registeredAt) throw new Error('Horário do registro inconsistente.');
  const keyAt = Number(await contract.keyRegisteredAt(idOf(bundle.authority), bundle.key.fingerprint));
  if (!keyAt || keyAt > registeredAt) throw new Error('Chave não registrada antes da observação.');
  return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, registeredAt, keyRegisteredAt: keyAt };
}

export async function verifyEvidence({ encoded, body, anchor, contract, nonceSource = DEFAULT_NONCE_SOURCE, fetcher = globalThis.fetch, liveKey = false }) {
  const evidenceHash = sha256Hex(encoded);
  const bundle = JSON.parse(encoded);
  const signature = verifyBundle(bundle, body);
  const nonce = await checkNonce(bundle.nonce, nonceSource, fetcher);
  const report = { evidenceHash, sourceURL: bundle.sourceURL, documentHash: signature.documentHash, keyId: signature.keyId,
    keyFingerprint: signature.keyFingerprint, notBefore: nonce.timestamp, notBeforeISO: new Date(nonce.timestamp * 1000).toISOString(),
    nonce: { chainId: bundle.nonce.chainId, blockNumber: nonce.blockNumber, blockHash: nonce.blockHash }, anchored: false };
  if (anchor && contract) {
    const checked = await checkAnchor(contract, anchor, evidenceHash, bundle);
    if (checked.registeredAt < nonce.timestamp) throw new Error('Registro anterior ao bloco do nonce.');
    Object.assign(report, { anchored: true, notAfter: checked.registeredAt, notAfterISO: new Date(checked.registeredAt * 1000).toISOString(),
      anchor: { chainId: anchor.chainId, contract: anchor.contract, ...checked } });
  }
  if (liveKey) {
    try { const jwk = await fetchKey(bundle.key.url, bundle.key.jwk.kid, fetcher); report.keyStillPublished = jwk.x === bundle.key.jwk.x; }
    catch { report.keyStillPublished = false; }
  }
  report.claim = report.anchored
    ? `${bundle.authority} assinou ${bundle.path} (SHA-256 ${signature.documentHash}) entre ${report.notBeforeISO} e ${report.notAfterISO}.`
    : `${bundle.authority} assinou ${bundle.path} (SHA-256 ${signature.documentHash}) depois de ${report.notBeforeISO}; sem âncora verificada.`;
  return report;
}
