import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Wallet, Interface, getAddress, keccak256 } from 'ethers';
import { ROOT, CHAIN_ID, GENESIS, WRITER } from './chain.mjs';
import { parseTceInput, calendarSources, fetchOfficial } from './tce.mjs';
import { editionDate } from '../public/tce-input.js';
import { sourceId } from '../public/publication-wallet.js';

export const TARGET = Object.freeze({ chainId: CHAIN_ID, genesis: GENESIS, writer: WRITER,
  contract: '0xdC0c47925AD2d85626027cE773A4db9d19Cac569',
  verifier: '0xc5F79B0cEEbD34412a7a1dEd28912be983580849' });
export const KEY_FILE = ROOT + 'state/secrets/batch-writer.key';
export const BATCH_ROOT = ROOT + 'state/batches/';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readBatchResponse(response, route) {
  const json = await response.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Resposta inválida da aplicação local.');
  // A failed job is valid state: the runner must be able to request a fresh proof.
  const failedJob = /^\/jobs\/[0-9a-f-]{36}$/.test(route) && json.status === 'failed';
  if (!response.ok || (json.error && !failedJob)) throw new Error(json.error || 'Aplicação local indisponível.');
  return json;
}

export function dateWindow(end, days = 365) {
  editionDate(end);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Intervalo deve ter entre 1 e 365 dias.');
  const last = Date.parse(end + 'T00:00:00Z');
  const dates = Array.from({ length: days }, (_, i) => new Date(last - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
  editionDate(dates[0]);
  return { start: dates[0], end, days, dates };
}

export function newPlan(end, days = 365) {
  return { schema: 'rbb-publication-batch/v1', target: { ...TARGET }, window: dateWindow(end, days),
    createdAt: new Date().toISOString(), calendar: [], entries: [], discoveryComplete: false };
}

export function validatePlan(plan) {
  if (plan?.schema !== 'rbb-publication-batch/v1') throw new Error('Plano de lote inválido.');
  for (const [key, value] of Object.entries(TARGET)) if (plan.target?.[key] !== value) throw new Error('Destino do lote diferente da RBB testnet autorizada.');
  const window = dateWindow(plan.window?.end, plan.window?.days);
  if (JSON.stringify(window) !== JSON.stringify(plan.window)) throw new Error('Janela do lote alterada.');
  if (!Array.isArray(plan.calendar) || !Array.isArray(plan.entries) || plan.entries.length > window.days * 16) throw new Error('Inventário inválido.');
  const calendarDates = new Set();
  for (const day of plan.calendar) {
    if (!window.dates.includes(day.date) || calendarDates.has(day.date) || !['checked', 'error'].includes(day.status)) throw new Error('Calendário fora do intervalo ou duplicado.');
    calendarDates.add(day.date);
    if (day.status === 'checked' && (!Array.isArray(day.urls) || day.urls.length > 16 || day.urls.some(url => typeof url !== 'string' || parseTceInput(url, day.date).canonicalURL !== url))) throw new Error('Fontes do calendário inválidas.');
  }
  if (plan.discoveryComplete && window.dates.some(date => !plan.calendar.some(day => day.date === date && day.status === 'checked'))) throw new Error('Inventário marcado completo com datas ausentes.');
  const seen = new Set();
  for (const entry of plan.entries) {
    const parsed = parseTceInput(entry.url, entry.date);
    if (!window.dates.includes(entry.date) || parsed.canonicalURL !== entry.url || seen.has(entry.url)) throw new Error('Edição fora do lote ou duplicada.');
    if (!plan.calendar.some(day => day.date === entry.date && day.status === 'checked' && day.urls.includes(entry.url))) throw new Error('PDF sem vínculo com o inventário oficial.');
    seen.add(entry.url);
  }
  if (plan.calendar.some(day => day.status === 'checked' && day.urls.some(url => !seen.has(url)))) throw new Error('PDF do calendário ausente no lote.');
  return plan;
}

export async function saveJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Discovery is ordinary HTTPS, not a publication proof. Every item is proven again before signing.
export async function discover(plan, { fetchCalendar = fetchOfficial, persist = async () => {}, delay = sleep } = {}) {
  validatePlan(plan);
  for (const date of plan.window.dates) {
    if (plan.calendar.some(day => day.date === date && day.status === 'checked')) continue;
    const parsed = parseTceInput('https://www.tce.sp.gov.br/diariooficial', date);
    let day;
    try {
      const response = await fetchCalendar(parsed.calendarURL);
      const json = JSON.parse(response.body.toString('utf8'));
      if (!json || typeof json !== 'object' || !Object.hasOwn(json, 'file')) throw new Error('Calendário sem campo file.');
      const urls = calendarSources(json, date);
      if (urls.some(url => typeof url !== 'string' || !parseTceInput(url, date).canonicalURL)) throw new Error('Fonte do calendário não é PDF.');
      day = { date, status: 'checked', urls, checkedAt: new Date().toISOString() };
      for (const url of urls) if (!plan.entries.some(entry => entry.url === url)) plan.entries.push({ date, url, status: 'queued' });
    } catch {
      day = { date, status: 'error', error: 'Falha ao consultar ou validar o calendário; data não classificada como vazia.' };
    }
    plan.calendar = [...plan.calendar.filter(previous => previous.date !== date), day];
    await persist(plan);
    await delay(150);
  }
  plan.discoveryComplete = plan.window.dates.every(date => plan.calendar.some(day => day.date === date && day.status === 'checked'));
  plan.entries.sort((a, b) => a.date.localeCompare(b.date) || a.url.localeCompare(b.url));
  await persist(plan);
  return plan;
}

export function summary(plan) {
  const states = {};
  for (const entry of plan.entries) states[entry.status] = (states[entry.status] || 0) + 1;
  return { start: plan.window.start, end: plan.window.end, days: plan.window.days,
    checkedDays: plan.calendar.filter(day => day.status === 'checked').length,
    emptyDays: plan.calendar.filter(day => day.status === 'checked' && !day.urls.length).length,
    calendarErrors: plan.calendar.filter(day => day.status === 'error').length,
    documents: plan.entries.length, states, discoveryComplete: plan.discoveryComplete };
}

export function walletFromSecret(secret, expected = WRITER) {
  let wallet;
  try {
    const value = secret.trim();
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Error();
    wallet = new Wallet(value.startsWith('0x') ? value : '0x' + value);
  } catch { throw new Error('Chave inválida. Use somente a chave individual da conta, nunca a frase de recuperação.'); }
  if (wallet.address.toLowerCase() !== expected.toLowerCase()) throw new Error('A chave não corresponde à carteira escritora autorizada.');
  return wallet;
}

export async function loadBatchWallet(file = KEY_FILE, expected = WRITER) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > 128) throw new Error('Arquivo da chave deve pertencer ao usuário, ser regular e ter permissão 600.');
    return walletFromSecret(await handle.readFile('utf8'), expected);
  } finally { await handle.close(); }
}

export function guardTransaction(tx, entry, attestation, artifact, now = Math.floor(Date.now() / 1000)) {
  if (Number(BigInt(tx.chainId)) !== TARGET.chainId || getAddress(tx.to) !== TARGET.contract ||
      getAddress(tx.from) !== TARGET.writer || BigInt(tx.value) !== 0n || BigInt(tx.gasPrice) !== 0n ||
      BigInt(tx.gas) <= 0n || BigInt(tx.gas) > 1000000n || BigInt(tx.type) !== 0n) {
    throw new Error('Transação fora da política: somente este contrato/testnet, valor e gasPrice zero.');
  }
  const parsed = parseTceInput(entry.url, entry.date);
  const { claim } = attestation;
  const iface = new Interface(artifact.abi);
  if (parsed.canonicalURL !== entry.url || attestation.sourceURL !== entry.url || claim.sourceId !== sourceId(entry.url) ||
      Number(claim.editionDate) !== parsed.dateCode || claim.documentHash !== entry.documentHash || claim.evidenceHash !== entry.evidenceHash ||
      Number(claim.validUntil) < now + 60 || Number(claim.validUntil) > now + 900 ||
      Number(claim.observedAt) > now + 30 || now - Number(claim.observedAt) > 1200 ||
      tx.data !== iface.encodeFunctionData('registerPublication', [entry.url, claim, attestation.signature])) {
    throw new Error('Atestação não corresponde à edição/prova ou está perto de expirar.');
  }
  return tx;
}

// Persist the signed bytes BEFORE broadcasting. Restart only follows this exact hash;
// an ambiguous RPC result must never cause a fresh signature/nonce for the same item.
export async function submitOnce(pending, { persist, send, receipt, wait = sleep, attempts = 60 }) {
  if (keccak256(pending.raw) !== pending.hash) throw new Error('Transação persistida foi alterada.');
  await persist(pending);
  let result = await receipt(pending.hash);
  if (!result && !pending.broadcastAttemptedAt) {
    pending.broadcastAttemptedAt = new Date().toISOString();
    await persist(pending);
    const returnedHash = await send(pending.raw);
    if (returnedHash !== pending.hash) throw new Error('RPC retornou outro hash; lote interrompido.');
  }
  for (let i = 0; !result && i < attempts; i++) { await wait(5000); result = await receipt(pending.hash); }
  if (!result) throw new Error('Transação sem recibo confirmado. Lote parado; a retomada consultará o mesmo hash.');
  return result;
}
