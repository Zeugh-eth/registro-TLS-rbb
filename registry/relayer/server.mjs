import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { verifyBundleSignature, fetchKey, keyURLFor, sha256Hex } from '../lib/signed-response.mjs';
import { STATE, loadConfig, registryAt, recordObservation, idOf } from '../lib/signed-registry.mjs';
import { RetryProvider } from '../lib/rbb-rpc.mjs';

const KEYS_FILE = process.env.RELAYER_KEYS_FILE || STATE + 'relayer-keys.json';
const MAX_BODY = 256 * 1024;
const MAX_NONCE_AGE = 200;
const digest = key => createHash('sha256').update(key).digest();

export async function loadApiKeys(file = KEYS_FILE) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; }
}

export async function addApiKey(name, file = KEYS_FILE) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name || '')) throw new Error('Nome inválido.');
  const keys = await loadApiKeys(file);
  if (keys.some(k => k.name === name)) throw new Error('Já existe uma chave com esse nome.');
  const key = 'rbbk_' + randomBytes(24).toString('base64url');
  keys.push({ name, sha256: digest(key).toString('hex'), createdAt: new Date().toISOString() });
  await fs.writeFile(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return key;
}

function authenticate(header, keys) {
  const match = /^Bearer (rbbk_[A-Za-z0-9_-]{32})$/.exec(header || '');
  if (!match) return null;
  const presented = digest(match[1]);
  return keys.find(k => timingSafeEqual(Buffer.from(k.sha256, 'hex'), presented))?.name ?? null;
}

export function createRelayer({ contract, apiKeys, keyFetcher = fetchKey, log = () => {} }) {
  let queue = Promise.resolve();
  const serial = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const provider = contract.runner.provider;

  async function accept(raw, observer) {
    let bundle;
    try { bundle = JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
    const evidenceHash = sha256Hex(raw);
    const checked = verifyBundleSignature(bundle);
    if (new URL(bundle.sourceURL).protocol !== 'https:') throw Object.assign(new Error('A URL precisa usar HTTPS.'), { status: 422 });
    const network = await provider.getNetwork();
    if (bundle.nonce.chainId !== Number(network.chainId)) throw Object.assign(new Error('Nonce de outra rede.'), { status: 422 });
    const [block, head] = await Promise.all([provider.getBlock(bundle.nonce.blockNumber), provider.getBlockNumber()]);
    if (block?.hash !== bundle.nonce.blockHash) throw Object.assign(new Error('Nonce não é um bloco canônico.'), { status: 422 });
    if (head - bundle.nonce.blockNumber > MAX_NONCE_AGE) throw Object.assign(new Error('Nonce antigo demais; faça uma nova observação.'), { status: 422 });
    return serial(async () => {
      const registered = await contract.keyRegisteredAt(idOf(checked.authority), checked.keyFingerprint);
      if (registered === 0n) {
        const published = await keyFetcher(keyURLFor(bundle.sourceURL), checked.keyId);
        if (published.x !== bundle.key.jwk.x) throw Object.assign(new Error('A chave não é a publicada pelo domínio.'), { status: 422 });
      }
      const anchor = await recordObservation(contract, bundle, evidenceHash);
      log({ at: new Date().toISOString(), observer, evidenceHash, sourceURL: bundle.sourceURL, transactionHash: anchor.transactionHash });
      return { ...anchor, recordedVia: 'relayer' };
    });
  }

  return http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body) + '\n'); };
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && pathname === '/v1/health') {
        const network = await provider.getNetwork();
        return reply(200, { chainId: Number(network.chainId), contract: contract.target, writer: await contract.writer() });
      }
      if (req.method !== 'POST' || pathname !== '/v1/observations') return reply(404, { error: 'not found' });
      const observer = authenticate(req.headers.authorization, apiKeys);
      if (!observer) return reply(401, { error: 'API key inválida.' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return reply(413, { error: 'Evidência grande demais.' }); chunks.push(chunk); }
      return reply(201, await accept(Buffer.concat(chunks), observer));
    } catch (error) {
      return reply(error.status || 502, { error: String(error.shortMessage || error.message).slice(0, 300) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'add-key') {
    console.log(await addApiKey(process.argv[3]));
    console.error('Guarde esta chave agora; ela não é exibida novamente.');
  } else {
    const config = await loadConfig();
    if (!config.contract || !existsSync(STATE + 'writer.key')) throw new Error('Configure o contrato e state/signed/writer.key (npm run signed:deploy).');
    const provider = new RetryProvider(config.nonceSource.rpcUrl);
    const wallet = new Wallet((await fs.readFile(STATE + 'writer.key', 'utf8')).trim(), provider);
    const contract = await registryAt(config.contract, wallet);
    const apiKeys = await loadApiKeys();
    const logFile = STATE + 'relayer.log';
    const server = createRelayer({ contract, apiKeys, log: entry => fs.appendFile(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 }) });
    const port = Number(process.env.PORT || 8792), host = process.env.HOST || '127.0.0.1';
    server.listen(port, host, () => console.log(`relayer: http://${host}:${port}/v1/observations · ${apiKeys.length} chave(s) de API · writer ${wallet.address}`));
  }
}
