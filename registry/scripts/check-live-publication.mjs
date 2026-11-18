// End-to-end validation of a REAL saved TCE proof on an EPHEMERAL LOCAL EVM only.
// Never connects a transaction signer to the RBB RPC.
import fs from 'node:fs';
import net from 'node:net';
import https from 'node:https';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import { compile } from './compile.mjs';
import { publicationConfig, attestEvidence, readPublication, downloadEvidence } from '../lib/publication.mjs';
import { preparePublication } from '../public/publication-wallet.js';

if (!process.argv[2]) throw new Error('Uso: node scripts/check-live-publication.mjs /caminho/para/job.json');
const job=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(job.status,'verified');
const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--silent'],{stdio:'ignore'});
const provider=new JsonRpcProvider(`http://127.0.0.1:${port}`,undefined,{cacheTimeout:-1});
try{
  let ready=false;
  for(let i=0;i<80;i++){try{await provider.send('eth_chainId',[]);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert.ok(ready);
  const writer=await provider.getSigner(0),config=await publicationConfig();
  const chainConfig={chainId:31337,writer:writer.address,genesis:(await provider.send('eth_getBlockByNumber',['0x0',false])).hash};
  const dependencies={provider,chainConfig};
  const artifact=compile('PublicationRegistry');
  const contract=await new ContractFactory(artifact.abi,artifact.bytecode,writer).deploy(writer.address,config.verifier);
  await contract.waitForDeployment();
  const input={url:job.result.sourceURL,date:job.result.editionDate,contract:contract.target};
  const before=await readPublication(input,dependencies);assert.equal(before.registered,false);
  console.log('Revalidando todas as apresentações TLSNotary e emitindo atestação para a EVM local…');
  const attestation=await attestEvidence({evidenceHash:job.result.evidenceHash,contract:contract.target},dependencies);
  const adapter={request:({method,params=[]})=>provider.send(method,params)};
  const tx=await preparePublication(adapter,{...config,...chainConfig},artifact,contract.target,attestation);
  const transactionHash=await provider.send('eth_sendTransaction',[tx]);
  const receipt=await provider.getTransactionReceipt(transactionHash);assert.equal(receipt.status,1);
  const after=await readPublication(input,dependencies);assert.equal(after.registered,true);assert.equal(after.records[0].documentHash,job.result.documentHash);
  await provider.send('evm_increaseTime',[10]);await provider.send('evm_mine',[]);
  const second=await attestEvidence({evidenceHash:job.result.evidenceHash,contract:contract.target},dependencies);
  await(await contract.registerPublication(second.sourceURL,second.claim,second.signature)).wait();
  // Prove historical reads do not depend on fetching the official website again.
  const originalGet=https.get;https.get=()=>{throw new Error('TCE fetch forbidden during historical read');};
  let later,calendar;
  try{later=await readPublication(input,dependencies);calendar=await readPublication({...input,url:'https://www.tce.sp.gov.br/diariooficial'},dependencies);}finally{https.get=originalGet;}
  assert.equal(later.firstRegisteredAtISO,after.firstRegisteredAtISO);assert.equal(calendar.firstRegisteredAtISO,after.firstRegisteredAtISO);
  const bundle=await downloadEvidence(job.result.evidenceHash);assert.equal(bundle.pdfPresentations.length,job.result.pdfParts.length);
  const result={environment:'REAL TCE TLSNotary proofs, LOCAL Anvil blockchain; no RBB transaction',
    trustModel:config.trustModel,sourceURL:input.url,editionDate:input.date,evidenceHash:job.result.evidenceHash,
    pdfParts:bundle.pdfPresentations.length,allPresentationsReverified:true,transactionHash,before,after,later,calendarQuery:calendar,
    repeatPreservedFirstDate:true,historicalReadWithoutTceFetch:true};
  fs.writeFileSync(new URL('../../reports/publication/live-roundtrip.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,environment:result.environment,firstRegisteredAt:after.firstRegisteredAtISO,parts:result.pdfParts,preserved:true}));
}finally{provider.destroy();child.kill();}
