// Read-only RBB simulation; this script has no signing or broadcasting path.
import fs from 'node:fs';
import { ContractFactory, keccak256 } from 'ethers';
import { ROOT, WRITER, CHAIN_ID, PiProvider, verifyNetwork } from '../lib/chain.mjs';
import { publicationConfig } from '../lib/publication.mjs';
import { compile } from './compile.mjs';
const provider=new PiProvider();
try {
  const config=await publicationConfig(),artifact=compile('PublicationRegistry');
  const tx=await new ContractFactory(artifact.abi,artifact.bytecode).getDeployTransaction(WRITER,config.verifier);
  const block=await verifyNetwork(provider);
  const request={from:WRITER,data:tx.data,value:'0x0'};
  const runtime=await provider.call(request);
  const gas=await provider.estimateGas(request);
  const result={environment:'RBB testnet read-only eth_call/estimateGas through Pi SSH; NO BROADCAST',
    checkedAt:new Date().toISOString(),chainId:CHAIN_ID,writer:WRITER,verifier:config.verifier,
    head:block.number,simulationSucceeded:runtime!=='0x',gasEstimate:gas.toString(),gasLimitWithMargin:((gas*120n+99n)/100n).toString(),
    creationCodeHash:keccak256(tx.data),compiler:artifact.compiler,evmVersion:artifact.evmVersion};
  fs.writeFileSync(ROOT+'../reports/publication/rbb-deploy-simulation.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {provider.destroy();}
