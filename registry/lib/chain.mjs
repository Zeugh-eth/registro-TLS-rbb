import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { JsonRpcProvider, Wallet, Contract, getAddress, keccak256 } from 'ethers';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const WRITER = getAddress('0x43c530588209ac49c1fc6987af930b9077168fdb');
export const CHAIN_ID = 648629;
export const GENESIS = '0x51ced064ee81680acece8a551efbc98a58a72ecd995e27977e60eede5a3d5496';
const networkFile = ROOT + '../operations/networks.json';
const network = JSON.parse(fs.readFileSync(fs.existsSync(networkFile) ? networkFile : ROOT + '../operations/networks.example.json', 'utf8'));

// Ethers signs locally. Transport is explicit; failed sends never switch routes or retry.
// Both routes use the same configured testnet RPC. A fresh public clone uses direct RPC.
export class PiProvider extends JsonRpcProvider {
  constructor({ transport = process.env.RBB_RPC_TRANSPORT || (network.ssh_target ? 'ssh' : 'direct'), fetcher = globalThis.fetch } = {}) {
    super('http://unused.invalid', undefined, { batchMaxCount: 1, cacheTimeout: -1 });
    if (!['ssh', 'direct'].includes(transport)) throw new Error('Unsupported RPC transport');
    this.rpcTransport = transport;
    this.rpcFetch = fetcher;
  }
  async _send(payload) {
    if (this.rpcTransport === 'direct') {
      try {
        const response = await this.rpcFetch(network.testnet.rpc_url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error();
        const result = await response.json();
        const values = Array.isArray(result) ? result : [result];
        if (!values.length || values.some(value => !value || value.jsonrpc !== '2.0' || !Object.hasOwn(value, 'id') ||
            (!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')))) throw new Error();
        return values;
      } catch { throw new Error('Direct RPC request failed; outcome may be unknown'); }
    }
    if (!network.ssh_target) throw new Error('Configure ssh_target in operations/networks.json before using SSH');
    const input = JSON.stringify({ url: network.testnet.rpc_url, payload });
    const script = `import json,urllib.request\np=json.loads(${JSON.stringify(input)})\nreq=urllib.request.Request(p['url'],data=json.dumps(p['payload']).encode(),headers={'Content-Type':'application/json'})\nwith urllib.request.urlopen(req,timeout=20) as r: print(r.read().decode())\n`;
    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.RBB_PRIVATE_KEY;
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=10', network.ssh_target, 'python3 -'], { env: childEnv });
      let stdout = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('RPC timeout')); }, 30000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); // Never expose RPC payloads or SSH diagnostics in browser responses.
      child.on('error', () => { clearTimeout(timer); reject(new Error('SSH unavailable')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error('Pi/RPC connection failed'));
        try { const r = JSON.parse(stdout); resolve(Array.isArray(r) ? r : [r]); }
        catch { reject(new Error('Invalid RPC response')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(script);
    });
  }
}

export function artifact() { return JSON.parse(fs.readFileSync(ROOT + 'build/DocumentRegistry.json', 'utf8')); }
export function signer(provider, key = process.env.RBB_PRIVATE_KEY) {
  if (!key) throw new Error('RBB_PRIVATE_KEY is not configured');
  let wallet;
  try { wallet = new Wallet(key, provider); } catch { throw new Error('Invalid private key format'); }
  if (wallet.address !== WRITER) throw new Error('Private key does not match the authorized writer');
  return wallet;
}

export async function verifyNetwork(provider) {
  const chain = Number(BigInt(await provider.send('eth_chainId', [])));
  if (chain !== CHAIN_ID) throw new Error('Wrong chain ID');
  const genesis = await provider.send('eth_getBlockByNumber', ['0x0', false]);
  if (genesis?.hash !== GENESIS) throw new Error('Wrong genesis');
  if (await provider.send('eth_syncing', []) !== false) throw new Error('RPC still syncing');
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const age = Date.now() / 1000 - Number(BigInt(block.timestamp));
  if (age > 120 || age < -30) throw new Error('RPC head not fresh');
  return block;
}

export async function registry(provider, address = process.env.RBB_REGISTRY_ADDRESS) {
  if (!address) throw new Error('Registry not deployed/configured');
  const contract = new Contract(getAddress(address), artifact().abi, provider);
  if (await provider.getCode(contract.target) === '0x') throw new Error('No contract at registry address');
  if (await contract.writer() !== WRITER) throw new Error('Registry writer mismatch');
  const manifestPath = ROOT + 'data/deployment.json';
  if (!fs.existsSync(manifestPath)) throw new Error('Deployment manifest missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.chainId !== CHAIN_ID || getAddress(manifest.contractAddress) !== contract.target ||
      keccak256(await provider.getCode(contract.target)) !== manifest.runtimeCodeHash) {
    throw new Error('Registry does not match verified deployment');
  }
  return contract;
}

export function validDigest(hash) {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0{64}$/.test(hash);
}

export async function transactionOptions(provider, from, transaction) {
  const block = await verifyNetwork(provider);
  const tx = { ...transaction, from };
  await provider.call(tx);
  const estimate = await provider.estimateGas(tx);
  const gasLimit = (estimate * 120n + 99n) / 100n;
  if (gasLimit > BigInt(block.gasLimit)) throw new Error('Gas exceeds block limit');
  const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
  if (await provider.getBalance(from, 'pending') < gasLimit * gasPrice) throw new Error('Insufficient gas balance');
  return { chainId: CHAIN_ID, type: 0, gasLimit, gasPrice,
    nonce: await provider.getTransactionCount(from, 'pending') };
}
