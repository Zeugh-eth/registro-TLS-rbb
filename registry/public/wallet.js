import { Interface, getAddress } from './ethers.js';
import { SUPPORTED_HASH_ALGORITHM } from './hashing.js';

export async function readHashAlgorithm(wallet, artifact, address) {
  const abi = new Interface(artifact.abi);
  const result = await wallet.request({ method: 'eth_call', params: [{ to: address, data: abi.encodeFunctionData('hashAlgorithm') }, 'latest'] });
  const algorithm = abi.decodeFunctionResult('hashAlgorithm', result)[0];
  if (algorithm !== SUPPORTED_HASH_ALGORITHM) throw new Error('Algoritmo do contrato não suportado: ' + algorithm);
  return algorithm;
}

export function normalizeRuntime(code, references) {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('Contrato sem bytecode válido.');
  let hex = code.slice(2).toLowerCase();
  const metadataBytes = parseInt(hex.slice(-4), 16);
  const end = hex.length - (metadataBytes + 2) * 2;
  if (end <= 0 || !/^a[0-9a-f]/.test(hex.slice(end, end + 2))) throw new Error('Metadata Solidity inválida.');
  hex = hex.slice(0, end);
  for (const ref of Object.values(references).flat()) {
    if ((ref.start + ref.length) * 2 > hex.length) throw new Error('Referência imutável inválida.');
    hex = hex.slice(0, ref.start * 2) + '0'.repeat(ref.length * 2) + hex.slice((ref.start + ref.length) * 2);
  }
  return hex;
}

export async function verifyNetwork(wallet, config) {
  const request = (method, params = []) => wallet.request({ method, params });
  if (Number(BigInt(await request('eth_chainId'))) !== config.chainId) throw new Error('Selecione RBB Testnet (648629) no MetaMask.');
  const genesis = await request('eth_getBlockByNumber', ['0x0', false]);
  if (genesis?.hash !== config.genesis) throw new Error('Genesis diferente da testnet configurada.');
  const block = await request('eth_getBlockByNumber', ['latest', false]);
  const age = Date.now() / 1000 - Number(BigInt(block.timestamp));
  if (age > 120 || age < -30) throw new Error('O RPC da carteira está desatualizado.');
  return block;
}

export async function validateContract(wallet, config, artifact, address) {
  await verifyNetwork(wallet, config);
  const target = getAddress(address.trim());
  const code = await wallet.request({ method: 'eth_getCode', params: [target, 'latest'] });
  if (normalizeRuntime(code, artifact.immutableReferences) !== normalizeRuntime(artifact.runtimeBytecode, artifact.immutableReferences)) {
    throw new Error('Código diferente. Compile no Remix com Solidity 0.8.30, Paris, otimização 200, viaIR desligado.');
  }
  // Every inlined immutable must contain the writer, including the access check.
  const encodedWriter = config.writer.slice(2).toLowerCase().padStart(64, '0');
  for (const ref of Object.values(artifact.immutableReferences).flat()) {
    if (ref.length !== 32 || code.slice(2 + ref.start * 2, 2 + (ref.start + ref.length) * 2).toLowerCase() !== encodedWriter) {
      throw new Error('Este contrato tem outra carteira escritora.');
    }
  }
  const abi = new Interface(artifact.abi);
  const raw = await wallet.request({ method: 'eth_call', params: [{ to: target, data: abi.encodeFunctionData('writer') }, 'latest'] });
  const writer = abi.decodeFunctionResult('writer', raw)[0];
  if (writer.toLowerCase() !== config.writer.toLowerCase()) throw new Error('Este contrato tem outra carteira escritora.');
  await readHashAlgorithm(wallet, artifact, target);
  return target;
}

export async function lookup(wallet, config, artifact, address, digest, transactionHash = null) {
  const target = await validateContract(wallet, config, artifact, address);
  const abi = new Interface(artifact.abi);
  const algorithm = await readHashAlgorithm(wallet, artifact, target);
  const value = await wallet.request({ method: 'eth_call', params: [{ to: target, data: abi.encodeFunctionData('getRecord', [digest]) }, 'latest'] });
  const [exists, firstTimestamp] = abi.decodeFunctionResult('getRecord', value);
  if (exists !== (firstTimestamp > 0n) || firstTimestamp > 8640000000000n) throw new Error('Registro inconsistente retornado pelo RPC.');
  const timestamp = Number(firstTimestamp);
  let inclusion = null, submissionStatus = transactionHash ? 'pending-or-unknown' : null;
  if (transactionHash) {
    const receipt = await wallet.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
    if (receipt) {
      const tx = await wallet.request({ method: 'eth_getTransactionByHash', params: [transactionHash] });
      const block = await wallet.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
      if (tx?.to?.toLowerCase() !== target.toLowerCase() || tx?.from?.toLowerCase() !== config.writer.toLowerCase() ||
          tx?.input?.toLowerCase() !== abi.encodeFunctionData('register', [digest]).toLowerCase() || block?.hash !== receipt.blockHash) {
        throw new Error('O recibo não corresponde ao registro solicitado.');
      }
      submissionStatus = BigInt(receipt.status) === 1n ? 'confirmed' : 'failed';
      if (submissionStatus === 'confirmed') {
        if (!timestamp) throw new Error('Recibo confirmado sem registro no contrato.');
        const events = (receipt.logs || []).filter(log => log.address.toLowerCase() === target.toLowerCase()).map(log => {
          try { return abi.parseLog(log); } catch { return null; }
        }).filter(event => event?.name === 'DocumentRegistered' && event.args[0].toLowerCase() === digest.toLowerCase());
        const blockTimestamp = Number(BigInt(block.timestamp));
        if (events.some(event => Number(event.args[1]) !== timestamp || timestamp !== blockTimestamp)) throw new Error('Evento e primeira data não coincidem.');
        inclusion = { transactionHash, blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash,
          blockTimestamp, isFirstRegistration: events.length === 1 };
      }
    }
  }
  return { schema: 'rbb-document-proof/v1', algorithm, algorithmSource: 'contract.hashAlgorithm()', digest, chainId: config.chainId,
    contractAddress: target, writer: config.writer, registered: timestamp > 0,
    registeredAt: timestamp || null, registeredAtISO: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    transactionHash, inclusion, submissionStatus };
}

export async function prepareRegistration(wallet, config, artifact, address, digest) {
  const target = await validateContract(wallet, config, artifact, address);
  const accounts = await wallet.request({ method: 'eth_accounts' });
  if (accounts[0]?.toLowerCase() !== config.writer.toLowerCase()) throw new Error('Selecione a carteira escritora autorizada no MetaMask.');
  const abi = new Interface(artifact.abi);
  const tx = { from: accounts[0], to: target, data: abi.encodeFunctionData('register', [digest]), value: '0x0' };
  await wallet.request({ method: 'eth_call', params: [tx, 'pending'] });
  const estimate = BigInt(await wallet.request({ method: 'eth_estimateGas', params: [tx] }));
  const gas = (estimate * 120n + 99n) / 100n;
  const block = await verifyNetwork(wallet, config);
  if (gas > BigInt(block.gasLimit)) throw new Error('Gas acima do limite do bloco.');
  const gasPrice = await wallet.request({ method: 'eth_gasPrice' });
  const balance = BigInt(await wallet.request({ method: 'eth_getBalance', params: [accounts[0], 'pending'] }));
  if (balance < gas * BigInt(gasPrice)) throw new Error('Saldo insuficiente para gas.');
  return { ...tx, chainId: '0x' + config.chainId.toString(16), gas: '0x' + gas.toString(16), gasPrice, type: '0x0' };
}
