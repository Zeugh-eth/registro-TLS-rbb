import fs from 'node:fs';
import { ContractFactory, Contract, keccak256 } from 'ethers';
import { compile } from './compile.mjs';
import { PiProvider, ROOT, WRITER, CHAIN_ID, signer, verifyNetwork, transactionOptions } from '../lib/chain.mjs';

const provider = new PiProvider();
try {
  const a = compile();
  const factory = new ContractFactory(a.abi, a.bytecode);
  const unsigned = await factory.getDeployTransaction(WRITER);
  const pendingPath = ROOT + 'data/deployment-pending.json';
  const manifestPath = ROOT + 'data/deployment.json';
  if (fs.existsSync(manifestPath)) throw new Error('Deployment already recorded; use existing contract');
  await verifyNetwork(provider);
  if (!process.argv.includes('--recover')) {
    if (fs.existsSync(pendingPath)) throw new Error('Pending deployment exists; use --recover, do not redeploy');
    const options = await transactionOptions(provider, WRITER, unsigned);
    if (!process.argv.includes('--broadcast')) {
      console.log(JSON.stringify({ mode: 'simulation-only', writer: WRITER, chainId: CHAIN_ID,
        gasLimit: options.gasLimit.toString(), gasPrice: options.gasPrice.toString(),
        bytecodeHash: keccak256(unsigned.data), readyForSigning: true }, null, 2));
      process.exitCode = 0;
    } else {
      const wallet = signer(provider);
      // Persist signed transaction hash BEFORE broadcast: ambiguous responses cannot cause blind retries.
      const raw = await wallet.signTransaction({ ...unsigned, ...options });
      const hash = keccak256(raw);
      fs.mkdirSync(ROOT + 'data', { recursive: true, mode: 0o700 });
      fs.writeFileSync(pendingPath, JSON.stringify({ hash, chainId: CHAIN_ID, writer: WRITER,
        bytecodeHash: keccak256(unsigned.data), createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
      await provider.broadcastTransaction(raw);
      console.log(`Deployment submitted: ${hash}. Run npm run deploy -- --recover to verify inclusion.`);
    }
  } else {
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    const receipt = await provider.getTransactionReceipt(pending.hash);
    if (!receipt) throw new Error('Deployment pending or unknown; do not send a second deployment');
    if (receipt.status !== 1 || !receipt.contractAddress) throw new Error('Deployment failed');
    const tx = await provider.getTransaction(pending.hash);
    if (tx.from !== WRITER || tx.chainId !== BigInt(CHAIN_ID) || tx.to !== null ||
        keccak256(tx.data) !== keccak256(unsigned.data)) throw new Error('Deployment transaction mismatch');
    const contract = new Contract(receipt.contractAddress, a.abi, provider);
    if (await contract.writer() !== WRITER) throw new Error('Unexpected deployed writer');
    const code = await provider.getCode(receipt.contractAddress);
    if (code === '0x') throw new Error('Deployment code missing');
    const manifest = { chainId: CHAIN_ID, writer: WRITER, contractAddress: receipt.contractAddress,
      transactionHash: pending.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      runtimeCodeHash: keccak256(code), compiler: a.compiler, evmVersion: a.evmVersion };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(manifest, null, 2));
  }
} catch {
  // Ethers errors can embed transaction payloads; never log raw errors with signing configured.
  console.error('Deployment not completed. Check network, pending deployment, wallet configuration and manifest. No automatic retry.');
  process.exitCode = 1;
} finally { provider.destroy(); }
