import fs from 'node:fs';
import { keccak256 } from 'ethers';
import { ROOT, WRITER, CHAIN_ID, PiProvider, registry, signer, verifyNetwork, transactionOptions } from './chain.mjs';

export function createService() {
  const provider = new PiProvider();
  const dataDir = ROOT + 'data/registrations/';
  let queue = Promise.resolve();
  const configured = Boolean(process.env.RBB_REGISTRY_ADDRESS);
  const enabled = configured && process.env.RBB_ENABLE_WRITES === '1' && Boolean(process.env.RBB_PRIVATE_KEY);
  // Fail startup on an incorrect key, even if writes are disabled.
  if (process.env.RBB_PRIVATE_KEY) signer(provider);
  const pathFor = hash => dataDir + hash.toLowerCase() + '.json';
  const read = hash => fs.existsSync(pathFor(hash)) ? JSON.parse(fs.readFileSync(pathFor(hash), 'utf8')) : null;
  async function lookup(hash) {
    await verifyNetwork(provider);
    const c = await registry(provider);
    const timestamp = await c.registeredAt(hash);
    const submission = read(hash);
    let receipt = null;
    if (submission) receipt = await provider.getTransactionReceipt(submission.transactionHash);
    let inclusion = null;
    if (receipt?.status === 1) {
      const block = await provider.getBlock(receipt.blockNumber);
      const tx = await provider.getTransaction(submission.transactionHash);
      const expectedData = c.interface.encodeFunctionData('register', [hash]);
      if (!block || block.hash !== receipt.blockHash || tx?.from !== WRITER ||
          tx?.to !== c.target || tx?.data.toLowerCase() !== expectedData.toLowerCase() || timestamp === 0n) {
        throw new Error('Receipt verification failed');
      }
      inclusion = { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    }
    return { schema: 'rbb-document-proof/v1', algorithm: 'SHA-256', digest: hash.toLowerCase(),
      chainId: CHAIN_ID, contractAddress: c.target, writer: WRITER,
      registered: timestamp > 0n, registeredAt: timestamp ? Number(timestamp) : null,
      registeredAtISO: timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null,
      transactionHash: inclusion?.transactionHash || submission?.transactionHash || null,
      inclusion,
      submissionStatus: receipt ? (receipt.status === 1 ? 'confirmed' : 'failed') : (submission ? 'pending-or-unknown' : null) };
  }
  async function submit(hash) {
    if (!enabled) throw new Error('Writes disabled');
    const previous = await lookup(hash);
    if (previous.registered || previous.submissionStatus) return previous;
    const c = await registry(provider);
    const wallet = signer(provider);
    const tx = await c.register.populateTransaction(hash);
    const options = await transactionOptions(provider, WRITER, tx);
    const raw = await wallet.signTransaction({ ...tx, ...options });
    const transactionHash = keccak256(raw);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pathFor(hash), JSON.stringify({ digest: hash, transactionHash,
      createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
    // An uncertain response leaves a journal entry. Never automatically re-send with a new nonce.
    await provider.broadcastTransaction(raw);
    return { ...previous, transactionHash, submissionStatus: 'pending-or-unknown' };
  }
  return {
    config: { writer: WRITER, chainId: CHAIN_ID, contractAddress: process.env.RBB_REGISTRY_ADDRESS || null,
      writesEnabled: enabled, mode: configured ? 'testnet' : 'hash-only' },
    lookup,
    register(hash) {
      const job = queue.then(() => submit(hash));
      queue = job.catch(() => {});
      return job;
    },
    close: () => provider.destroy()
  };
}
