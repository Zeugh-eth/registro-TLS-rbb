import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { observe } from '../lib/signed-response.mjs';
import { STATE, loadConfig, storeEvidence, registryAt, recordObservation, verifyEvidence, readEvidence } from '../lib/signed-registry.mjs';
import { RetryProvider } from '../lib/rbb-rpc.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const url = args.find(arg => !arg.startsWith('--'));
if (!url) {
  console.error('Uso: node scripts/signed-observe.mjs <url> [--no-anchor] [--publish]');
  process.exit(2);
}

async function publish(config, evidenceHash, directory, entry) {
  const p = config.publish;
  if (!p?.ftpURL || !p?.netrc || !p?.publicBaseURL) throw new Error('Configure publish.ftpURL, publish.netrc e publish.publicBaseURL.');
  const upload = (file, remote) => run('curl', ['-sS', '--fail', '--ftp-create-dirs', '--netrc-file', p.netrc, '-T', file, p.ftpURL + remote], { timeout: 120000 });
  for (const name of ['bundle.json', 'document.pdf', 'anchor.json', 'report.json']) {
    if (existsSync(directory + name)) await upload(directory + name, evidenceHash.slice(2) + '/' + name);
  }
  let index = { schema: 'rbb-signed-index/v1', observations: [] };
  try {
    const response = await fetch(p.publicBaseURL + 'index.json', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.ok) index = await response.json();
  } catch {}
  if (!index.observations.some(o => o.evidenceHash === evidenceHash)) index.observations.push(entry);
  index.observations.sort((a, b) => (a.notBefore || 0) - (b.notBefore || 0));
  index.updatedAt = new Date().toISOString();
  const indexFile = directory + 'index.json';
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
  await upload(indexFile, 'index.json');
  await fs.rm(indexFile);
  return p.publicBaseURL + evidenceHash.slice(2) + '/';
}

const config = await loadConfig();
const provider = new RetryProvider(config.nonceSource.rpcUrl);
try {
  const { bundle, body } = await observe(url, { nonceSource: config.nonceSource });
  const { evidenceHash, directory } = await storeEvidence(bundle, body);
  let anchor = null, contract = null;
  const mode = args.includes('--no-anchor') ? 'none' : config.recorder?.mode || (config.contract && existsSync(STATE + 'writer.key') ? 'direct' : 'none');
  if (mode === 'direct') {
    const wallet = new Wallet((await fs.readFile(STATE + 'writer.key', 'utf8')).trim(), provider);
    contract = await registryAt(config.contract, wallet);
    anchor = { ...await recordObservation(contract, bundle, evidenceHash), recordedVia: 'direct' };
  } else if (mode === 'relayer') {
    const apiKey = process.env.RELAYER_API_KEY || (await fs.readFile(config.recorder.apiKeyFile, 'utf8')).trim();
    const response = await fetch(new URL('/v1/observations', config.recorder.url), {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: await fs.readFile(directory + 'bundle.json'), signal: AbortSignal.timeout(300000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Relayer recusou: ' + result.error);
    if (config.contract && result.contract.toLowerCase() !== config.contract.toLowerCase()) throw new Error('Relayer registrou em outro contrato: ' + result.contract);
    anchor = result;
    contract = await registryAt(anchor.contract, provider);
  } else if (mode !== 'none') throw new Error('recorder.mode desconhecido: ' + mode);
  if (anchor) await fs.writeFile(directory + 'anchor.json', JSON.stringify(anchor, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const evidence = await readEvidence(directory);
  const report = await verifyEvidence({ ...evidence, contract, nonceSource: config.nonceSource });
  await fs.writeFile(directory + 'report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let publishedAt = null;
  if (args.includes('--publish')) {
    publishedAt = await publish(config, evidenceHash, directory, { evidenceHash, sourceURL: report.sourceURL,
      documentHash: report.documentHash, notBefore: report.notBefore, notBeforeISO: report.notBeforeISO,
      notAfter: report.notAfter ?? null, notAfterISO: report.notAfterISO ?? null,
      transactionHash: anchor?.transactionHash ?? null, anchored: report.anchored });
  }
  console.log(JSON.stringify({ ok: true, evidenceHash, directory, anchored: report.anchored, claim: report.claim, publishedAt }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, url, at: new Date().toISOString(), error: String(error.shortMessage || error.message).slice(0, 400) }));
  process.exitCode = 1;
} finally { provider.destroy(); }
