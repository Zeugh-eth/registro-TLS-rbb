import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, sha256, toUtf8Bytes, Signature } from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { parseTceInput, calendarSources } from '../public/tce-input.js';
import { parseEditionText, parseHttpResponse, assertRequest } from '../lib/tce.mjs';
import { publicationTypes, publicationDomain, sourceId, validatePublicationContract, preparePublication } from '../public/publication-wallet.js';
import { createServer } from '../server.mjs';
import { listPublications } from '../lib/publication.mjs';

const sourceURL = 'https://doe.tce.sp.gov.br/pdf/2026/11/doe-tce-2026-11-14.pdf';
const hash = value => sha256(toUtf8Bytes(value));

test('TCE URL identity is stable and dates/domains cannot be substituted', () => {
  assert.equal(parseTceInput(sourceURL).canonicalURL,sourceURL);
  assert.equal(parseTceInput(sourceURL.replace('/pdf/','/v/pdf/')).canonicalURL,sourceURL);
  const calendar = parseTceInput('https://www.tce.sp.gov.br/diariooficial','2026-11-14');
  assert.equal(calendar.calendarURL,'https://doe.tce.sp.gov.br/json/file/2026/11/14');
  assert.deepEqual(calendarSources({file:new URL(sourceURL).pathname},calendar.date),[sourceURL]);
  for (const url of ['http://doe.tce.sp.gov.br/','https://doe.tce.sp.gov.br.evil.example/','https://127.0.0.1/','https://user:pass@doe.tce.sp.gov.br/','https://doe.tce.sp.gov.br:8545/','https://doe.tce.sp.gov.br/?target=localhost']) {
    assert.throws(()=>parseTceInput(url,'2026-11-14'));
  }
  assert.throws(()=>parseTceInput(sourceURL,'2026-11-16'),/difere/);
  assert.throws(()=>parseTceInput('https://doe.tce.sp.gov.br/','2026-02-29'),/inválida/);
  assert.throws(()=>calendarSources({file:'https://evil.example/file.pdf'},'2026-11-14'));
});

test('real PDF declares separate availability/publication dates; wrong edition fails', () => {
  const text = fs.readFileSync(new URL('./fixtures/tce-first-page.txt',import.meta.url),'utf8');
  const dates = parseEditionText(text,'2026-11-14');
  assert.equal(dates.editionNumber,934);assert.equal(dates.publicationDate,'2026-11-16');
  assert.throws(()=>parseEditionText(text,'2026-11-16'),/não corresponde/);
  assert.throws(()=>parseEditionText(text.replace('Data de publicação','Outro campo'),'2026-11-14'),/ausente/);
  assert.throws(()=>parseEditionText(text+text,'2026-11-14'),/ambígua/);
});

test('TCE first day may use the ordinal 1º without weakening date or ambiguity checks', () => {
  const header = '712ª edição\nData de disponibilização: sexta-feira, 28 de novembro de 2025 ▪ Data de publicação: segunda-feira, 1º de dezembro de 2025';
  const parsed = parseEditionText(header, '2025-11-28');
  assert.equal(parsed.publicationDate, '2025-12-01');
  assert.equal(parsed.publicationDateCode, 20251201);
  assert.throws(() => parseEditionText(header, '2025-11-29'), /não corresponde/);
  assert.throws(() => parseEditionText(header + '\nData de publicação: terça-feira, 2 de dezembro de 2025', '2025-11-28'), /ambígua/);
});

test('authenticated HTTP rejects truncation, ambiguous framing and mismatched ranges/versions', () => {
  const response = value=>Buffer.from(value,'latin1');
  assert.equal(parseHttpResponse(response('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc')).body.toString(),'abc');
  assert.equal(parseHttpResponse(response('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n')).body.toString(),'abc');
  for(const bad of ['HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc',
    'HTTP/1.1 302 Found\r\nLocation: https://evil.example\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nabc']) assert.throws(()=>parseHttpResponse(response(bad)));
  const partial=response('HTTP/1.1 206 Partial Content\r\nContent-Type: application/pdf\r\nContent-Range: bytes 0-2/9\r\nETag: "v1"\r\nContent-Length: 3\r\n\r\nabc');
  const range={start:0,end:2,total:9,etag:'"v1"'};
  assert.equal(parseHttpResponse(partial,range).body.toString(),'abc');
  assert.throws(()=>parseHttpResponse(partial));
  assert.throws(()=>parseHttpResponse(partial,{...range,etag:'"v2"'}),/versão/);
  assert.throws(()=>parseHttpResponse(partial,{...range,start:3,end:5}),/Trecho/);
  const request=Buffer.from('GET '+new URL(sourceURL).pathname+' HTTP/1.1\r\nHost: doe.tce.sp.gov.br\r\nRange: bytes=0-2\r\nIf-Match: "v1"\r\n\r\n');
  assert.doesNotThrow(()=>assertRequest(request,sourceURL,range));
  assert.throws(()=>assertRequest(request,sourceURL,{...range,start:1}));
  assert.throws(()=>assertRequest(request,sourceURL));
});

test('publication contract preserves first dates and validates signed evidence on a real local EVM', async t => {
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--silent'],{stdio:'ignore'});
  let startupError;child.on('error',error=>{startupError=error;});t.after(()=>child.kill());
  const url=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<80;i++){if(startupError)throw startupError;try{const r=await fetch(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready);
  const provider=new JsonRpcProvider(url,undefined,{cacheTimeout:-1});t.after(()=>provider.destroy());
  const writer=await provider.getSigner(0),other=await provider.getSigner(1),attester=Wallet.createRandom();
  const a=compile('PublicationRegistry');const factory=new ContractFactory(a.abi,a.bytecode,writer);
  const contract=await factory.deploy(writer.address,attester.address);await contract.waitForDeployment();
  const config={chainId:31337,genesis:(await provider.send('eth_getBlockByNumber',['0x0',false])).hash,writer:writer.address,verifier:attester.address};
  const wallet={request:({method,params=[]})=>provider.send(method,params)};
  const now=()=>provider.send('eth_getBlockByNumber',['latest',false]).then(b=>Number(BigInt(b.timestamp)));
  let counter=0;
  async function claim(overrides={}){const time=await now();return {sourceId:sourceId(sourceURL),documentHash:hash('original PDF'),evidenceHash:hash('authenticated evidence'),editionDate:20261114,publicationDate:20261116,observedAt:time,validUntil:time+900,nonce:hash('nonce '+ ++counter),...overrides};}
  const sign=(p,domain=publicationDomain(31337,contract.target))=>attester.signTypedData(domain,publicationTypes,p);
  let first;
  await t.test('unoptimized Remix build is reproduced exactly; altered runtime remains rejected',async()=>{
    const variant=a.runtimeVariants.find(v=>v.optimizer.enabled===false);
    const plain=await new ContractFactory(a.abi,variant.bytecode,writer).deploy(writer.address,attester.address);
    await plain.waitForDeployment();
    assert.equal(await validatePublicationContract(wallet,config,a,plain.target),plain.target);
    const p=await claim(),signature=await attester.signTypedData(publicationDomain(31337,plain.target),publicationTypes,p);
    const prepared=await preparePublication(wallet,config,a,plain.target,{claim:p,signature,sourceURL});
    await wallet.request({method:'eth_sendTransaction',params:[prepared]});
    const original=(await plain.getRecord(p.sourceId,p.editionDate))[1];
    await provider.send('evm_increaseTime',[2]);await provider.send('evm_mine',[]);
    const repeat=await claim(),signed=await attester.signTypedData(publicationDomain(31337,plain.target),publicationTypes,repeat);
    await(await plain.registerPublication(sourceURL,repeat,signed)).wait();
    assert.equal((await plain.getRecord(p.sourceId,p.editionDate))[1].registeredAt,original.registeredAt);
    assert.equal(original.documentHash,p.documentHash);
    const badVerifier=await new ContractFactory(a.abi,variant.bytecode,writer).deploy(writer.address,other.address);
    await badVerifier.waitForDeployment();
    await assert.rejects(validatePublicationContract(wallet,config,a,badVerifier.target),/verifier/);
    const changed={request:async request=>request.method==='eth_getCode'?'0x00'+variant.runtimeBytecode.slice(4):wallet.request(request)};
    await assert.rejects(validatePublicationContract(changed,config,a,plain.target),/Bytecode diferente/);
  });
  await t.test('first registration is read publicly by the same canonical link and edition',async()=>{
    assert.equal(await validatePublicationContract(wallet,config,a,contract.target),contract.target);
    const p=await claim();const signature=await sign(p);
    const tx=await preparePublication(wallet,config,a,contract.target,{claim:p,signature,sourceURL});
    const txhash=await wallet.request({method:'eth_sendTransaction',params:[tx]});
    const receipt=await provider.getTransactionReceipt(txhash);const block=await provider.getBlock(receipt.blockNumber);
    const [exists,record]=await contract.connect(other).getRecord(p.sourceId,p.editionDate);
    assert.equal(exists,true);assert.equal(record.registeredAt,BigInt(block.timestamp));
    assert.equal(record.publicationDate,20261116n);assert.equal(record.documentHash,p.documentHash);
    first=record.registeredAt;
    assert.equal(await contract.sourceCount(p.editionDate),1n);assert.equal(await contract.sourceAt(p.editionDate,0),sourceURL);
    assert.equal(await contract.hashAlgorithm(),'SHA-256');
    assert.equal((await contract.getRecord(p.sourceId,20261113))[0],false);
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,signature));
  });
  await t.test('repeat and changed PDF preserve the original link/date timestamp',async()=>{
    await provider.send('evm_increaseTime',[10]);await provider.send('evm_mine',[]);
    const repeated=await claim();await(await contract.registerPublication(sourceURL,repeated,await sign(repeated))).wait();
    assert.equal((await contract.getRecord(repeated.sourceId,repeated.editionDate))[1].registeredAt,first);
    assert.equal((await contract.getVersion(repeated.sourceId,repeated.editionDate,repeated.documentHash))[1].registeredAt,first);
    const changed=await claim({documentHash:hash('replaced PDF')});await(await contract.registerPublication(sourceURL,changed,await sign(changed))).wait();
    const original=(await contract.getRecord(changed.sourceId,changed.editionDate))[1];
    const version=(await contract.getVersion(changed.sourceId,changed.editionDate,changed.documentHash))[1];
    assert.equal(original.registeredAt,first);assert.equal(original.documentHash,hash('original PDF'));assert.ok(version.registeredAt>first);
    assert.equal(await contract.sourceCount(changed.editionDate),1n);
    fs.writeFileSync(new URL('../../reports/publication/contract-roundtrip.json',import.meta.url),JSON.stringify({environment:'Anvil local EVM; not RBB',sourceURL,editionDate:20261114,
      firstRegisteredAt:Number(first),firstRegisteredAtISO:new Date(Number(first)*1000).toISOString(),replacementRegisteredAt:Number(version.registeredAt),
      firstTimestampPreserved:true,publicReadWithoutWalletSignature:true,originalHash:original.documentHash,replacementHash:version.documentHash},null,2));
  });
  await t.test('confirmed list comes from events and preserves first dates across versions and pages',async()=>{
    const deployment=await contract.deploymentTransaction().wait();
    const dependencies={provider,chainConfig:{...config,contract:contract.target,deploymentBlock:deployment.blockNumber}};
    const list=await listPublications({contract:contract.target},dependencies);
    assert.equal(list.complete,true);assert.equal(list.sourceFetched,false);assert.equal(list.records.length,1);
    assert.equal(list.records[0].sourceURL,sourceURL);assert.equal(list.records[0].editionDate,'2026-11-14');
    assert.equal(list.records[0].registeredAt,Number(first));assert.equal(list.records[0].documentHash,hash('original PDF'));
    assert.ok(list.records[0].transactionHash);assert.equal(list.nextBeforeBlock,null);
    const receipt=await provider.getTransactionReceipt(list.records[0].transactionHash);assert.equal(receipt.status,1);
    const before=await listPublications({contract:contract.target,beforeBlock:receipt.blockNumber},dependencies);assert.equal(before.records.length,0);
    for(const cursor of [-1,0,1.5,'latest',Number.MAX_SAFE_INTEGER])await assert.rejects(listPublications({contract:contract.target,beforeBlock:cursor},dependencies));
  });
  await t.test('writer cannot bypass the verifier or reuse altered/cross-domain claims',async()=>{
    const p=await claim();const signature=await sign(p);
    await assert.rejects(contract.connect(other).registerPublication.staticCall(sourceURL,p,signature));
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,{...p,documentHash:hash('tampered')},signature));
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,await Wallet.createRandom().signTypedData(publicationDomain(31337,contract.target),publicationTypes,p)));
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,await sign(p,publicationDomain(648629,contract.target))));
    const another=await factory.deploy(writer.address,attester.address);await another.waitForDeployment();
    await assert.rejects(another.registerPublication.staticCall(sourceURL,p,signature));
    await assert.rejects(contract.registerPublication.staticCall(sourceURL+'x',p,signature));
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,'0x'));
    const sig=Signature.from(signature),order=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const malleable=sig.r+(order-BigInt(sig.s)).toString(16).padStart(64,'0')+(sig.v===27?'1c':'1b');
    await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,malleable));
  });
  await t.test('expired/future evidence, zero hashes and malformed civil dates fail closed',async()=>{
    for(const overrides of [{validUntil:(await now())-1},{observedAt:(await now())+120},{documentHash:ZeroHash},{evidenceHash:ZeroHash},{editionDate:20260229},{publicationDate:20261301}]){
      const p=await claim(overrides);await assert.rejects(contract.registerPublication.staticCall(sourceURL,p,await sign(p)));
    }
    await assert.rejects(factory.deploy(ZeroAddress,attester.address));await assert.rejects(factory.deploy(writer.address,ZeroAddress));
  });
});

test('new link app is local, protects APIs and does not accept untrusted links',async t=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const html=await(await fetch(base)).text();assert.match(html,/Data da edição/);assert.match(html,/notary local/);
  const response=await fetch(base+'/api/publication/inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://127.0.0.1/secret',date:'2026-11-14'})});assert.equal(response.status,400);
  const cross=await fetch(base+'/api/publication/prove',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(cross.status,403);
  assert.equal((await fetch(base+'/state/notary.key')).status,404);
  assert.equal((await fetch(base+'/state/verifier.key')).status,404);
  assert.equal((await fetch(base+'/PublicationRegistry.sol')).status,200);
  assert.equal((await fetch(base+'/hash')).status,200);
});
