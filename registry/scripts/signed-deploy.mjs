import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ContractFactory, Wallet } from 'ethers';
import { compile } from './compile.mjs';
import { CHAIN_ID, verifyNetwork } from '../lib/chain.mjs';
import { RetryProvider } from '../lib/rbb-rpc.mjs';
import { STATE } from '../lib/signed-registry.mjs';
import { RBB_NONCE_SOURCE } from '../lib/signed-response.mjs';

const keyFile = STATE + 'writer.key';
const configFile = STATE + 'config.json';
await fs.mkdir(STATE, { recursive: true, mode: 0o700 });
if (existsSync(configFile)) throw new Error('Já existe um contrato configurado em ' + configFile);
if (!existsSync(keyFile)) await fs.writeFile(keyFile, Wallet.createRandom().privateKey + '\n', { mode: 0o600, flag: 'wx' });
const provider = new RetryProvider();
try {
  const wallet = new Wallet((await fs.readFile(keyFile, 'utf8')).trim(), provider);
  await verifyNetwork(provider);
  const a = compile('SignedPublicationRegistry');
  const factory = new ContractFactory(a.abi, a.bytecode, wallet);
  const deploy = await factory.getDeployTransaction(wallet.address, CHAIN_ID);
  const gasLimit = (await provider.estimateGas({ ...deploy, from: wallet.address })) * 12n / 10n;
  const contract = await factory.deploy(wallet.address, CHAIN_ID, { gasLimit, gasPrice: 0n, type: 0 });
  const receipt = await contract.deploymentTransaction().wait(1, 300000);
  if (receipt?.status !== 1) throw new Error('Deploy falhou.');
  const config = { chainId: CHAIN_ID, contract: contract.target, deploymentBlock: receipt.blockNumber,
    deploymentTransaction: receipt.hash, writer: wallet.address, nonceSource: RBB_NONCE_SOURCE };
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(config, null, 2));
} catch (error) {
  console.error('Deploy não concluído:', String(error.shortMessage || error.message).slice(0, 300), JSON.stringify(error.error || error.info?.error || null));
  console.error('Writer:', new Wallet((await fs.readFile(keyFile, 'utf8')).trim()).address);
  process.exitCode = 1;
} finally { provider.destroy(); }
