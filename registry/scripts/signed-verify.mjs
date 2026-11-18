import { readEvidence, registryAt, verifyEvidence } from '../lib/signed-registry.mjs';
import { RBB_NONCE_SOURCE, ETHEREUM_NONCE_SOURCE } from '../lib/signed-response.mjs';
import { RetryProvider } from '../lib/rbb-rpc.mjs';

const target = process.argv[2];
if (!target) {
  console.error('Uso: node scripts/signed-verify.mjs <pasta-da-evidência | URL-da-pasta-publicada>');
  process.exit(2);
}

async function load(location) {
  if (!/^https?:\/\//.test(location)) return readEvidence(location);
  const base = location.endsWith('/') ? location : location + '/';
  const get = async name => {
    const response = await fetch(base + name, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  };
  const [encoded, body, anchor] = await Promise.all([get('bundle.json'), get('document.pdf'), get('anchor.json')]);
  if (!encoded || !body) throw new Error('bundle.json ou document.pdf ausentes em ' + base);
  return { encoded, body, anchor: anchor ? JSON.parse(anchor) : null };
}

const provider = new RetryProvider(process.env.RBB_RPC_URL || RBB_NONCE_SOURCE.rpcUrl);
try {
  const evidence = await load(target);
  const bundle = JSON.parse(evidence.encoded);
  const nonceSource = [RBB_NONCE_SOURCE, ETHEREUM_NONCE_SOURCE].find(source => source.chainId === bundle.nonce.chainId);
  if (!nonceSource) throw new Error('Rede do nonce desconhecida: ' + bundle.nonce.chainId);
  const contract = evidence.anchor ? await registryAt(evidence.anchor.contract, provider) : null;
  const report = await verifyEvidence({ ...evidence, contract, nonceSource, liveKey: true });
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.shortMessage || error.message) }, null, 2));
  process.exitCode = 1;
} finally { provider.destroy(); }
