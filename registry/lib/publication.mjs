import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Wallet, Contract } from 'ethers';
import { ROOT, WRITER, CHAIN_ID, GENESIS, PiProvider } from './chain.mjs';
import { parseTceInput, calendarSources, parseHttpResponse, assertRequest, fetchOfficial, inspectPdf, sha256, runFile } from './tce.mjs';
import { sourceId, publicationTypes, publicationDomain, validatePublicationContract } from '../public/publication-wallet.js';

const state = ROOT+'state/';
const publicReadConfig = JSON.parse(await fs.readFile(ROOT+'config/publication.testnet.json', 'utf8'));
const binary = ROOT+'tlsn-adapter/target/release/rbb-tlsn-adapter';
const jobs = new Map();
let activeJob = null;
let pi;
const rpc = () => { pi ||= new PiProvider(); return pi; };
const rpcWallet = () => ({request:({method,params=[]})=>rpc().send(method,params)});
const childOptions = {timeout:610000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME}};

export async function publicationConfig() {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(state+'publication-config.json','utf8')); } catch {}
  return {writer:WRITER,chainId:CHAIN_ID,genesis:GENESIS,...publicReadConfig,...saved,
    proofReady:existsSync(binary) && !!saved.verifier && existsSync(state+'notary.key'),
    transactionSigning:'metamask',maxPdfBytes:8*1024*1024-65536};
}

export async function inspectLink(input) {
  const parsed = parseTceInput(input.url,input.date);
  const calendar = await fetchOfficial(parsed.calendarURL);
  const sources = calendarSources(JSON.parse(calendar.body.toString('utf8')),parsed.date);
  if (!sources.length) throw new Error('O calendário não apresenta edição nessa data.');
  if (parsed.canonicalURL && !sources.includes(parsed.canonicalURL)) throw new Error('Este PDF não está associado à data no calendário oficial.');
  if (!parsed.canonicalURL && sources.length > 1) return {...parsed,sources,needsSelection:true,proofVerified:false};
  const canonicalURL = parsed.canonicalURL || sources[0];
  const dir = state+'previews/'+randomUUID();
  try {
    const pdf = await fetchOfficial(canonicalURL);
    const metadata = await inspectPdf(pdf,parsed.date,dir);
    return {...parsed,canonicalURL,sources,...metadata,proofVerified:false,status:'https-preview'};
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}

async function collectSession(url, directory, config, range = null) {
  const args = ['local-prove',new URL(url).pathname,state+'notary.key',directory];
  if (range) args.push(`bytes=${range.start}-${range.end}`,range.etag);
  await runFile(binary,args,childOptions);
  // Verify independently of the producer output, using our pinned deployment key.
  await runFile(binary,['verify',directory+'/presentation.tlsn',config.notaryPublicKey,directory],childOptions);
  const session = JSON.parse(await fs.readFile(directory+'/verified.json','utf8'));
  if (session.serverName !== 'doe.tce.sp.gov.br' || !session.completeTranscript || session.notaryPublicKey !== config.notaryPublicKey) throw new Error('Sessão TLSNotary inconsistente.');
  const now = Math.floor(Date.now()/1000);
  if (session.observedAt > now+30 || now-session.observedAt > 1200) throw new Error('Horário da sessão fora do intervalo aceito.');
  assertRequest(await fs.readFile(directory+'/sent.http'),url,range);
  const response = parseHttpResponse(await fs.readFile(directory+'/received.http'),range);
  const proof = await fs.readFile(directory+'/presentation.tlsn');
  return {session,response,proofHash:sha256(proof)};
}

export async function startProof(input) {
  if (activeJob) throw new Error('Uma coleta está em andamento. Aguarde sua conclusão.');
  const parsed = parseTceInput(input.url,input.date);
  const config = await publicationConfig();
  if (!config.proofReady) throw new Error('TLSNotary não configurado. Execute a preparação local descrita no README.');
  const id = randomUUID();
  const job = {id,status:'running',stage:'Autenticando o calendário com TLSNotary…',startedAt:new Date().toISOString()};
  jobs.set(id,job); activeJob = id;
  void (async () => {
    const dir = state+'jobs/'+id;
    try {
      const calendar = await collectSession(parsed.calendarURL,dir+'/calendar',config);
      const sources = calendarSources(JSON.parse(calendar.response.body.toString('utf8')),parsed.date);
      const canonicalURL = parsed.canonicalURL || (sources.length === 1 ? sources[0] : null);
      if (!canonicalURL || !sources.includes(canonicalURL)) throw new Error('Escolha o PDF exato da edição; o calendário não confirmou a seleção.');
      const preview = await fetchOfficial(canonicalURL);
      const etag = preview.headers.etag;
      if (!/^"[a-zA-Z0-9_.:-]+"$/.test(etag || '')) throw new Error('PDF sem ETag forte suportado; não é seguro combinar intervalos.');
      const total = preview.body.length, chunkSize = 65536;
      const parts = [], chunks = [];
      for (let start = 0; start < total; start += chunkSize) {
        if (Date.now()-Date.parse(job.startedAt)>1200000) throw new Error('Tempo máximo da coleta excedido.');
        const range = {start,end:Math.min(start+chunkSize,total)-1,total,etag};
        job.stage = 'Autenticando o PDF com TLSNotary: trecho '+(parts.length+1)+' de '+Math.ceil(total/chunkSize)+'…';
        const part = await collectSession(canonicalURL,dir+'/pdf-'+parts.length,config,range);
        parts.push({...range,proofHash:part.proofHash,observedAt:part.session.observedAt});
        chunks.push(part.response.body);
      }
      if (!parts.length || parts.at(-1).observedAt-calendar.session.observedAt>1200) throw new Error('Janela de coleta excedida.');
      const body = Buffer.concat(chunks);
      if (sha256(body)!==sha256(preview.body)) throw new Error('PDF mudou entre prévia e prova.');
      const metadata = await inspectPdf({headers:{'content-type':'application/pdf'},body},parsed.date,dir);
      const manifest = {schema:'rbb-publication-evidence/v2',policy:config.policy,trustModel:config.trustModel,
        tlsnVersion:'0.1.0-alpha.14',tlsnCommit:'9a3d73c5bdeeab0255bdb05c89116554cebf6dbe',
        notaryPublicKey:config.notaryPublicKey,sourceURL:canonicalURL,calendarURL:parsed.calendarURL,
        editionDate:parsed.date,editionDateCode:parsed.dateCode,...metadata,
        observedAt:parts.at(-1).observedAt,observationStartedAt:parts[0].observedAt,calendarObservedAt:calendar.session.observedAt,
        calendarProofHash:calendar.proofHash,pdfParts:parts,serverName:'doe.tce.sp.gov.br',tlsVersion:'V1_2'};
      const encoded = Buffer.from(JSON.stringify(manifest));
      const evidenceHash = sha256(encoded);
      const destination = state+'evidence/'+evidenceHash.slice(2);
      await fs.mkdir(destination,{recursive:true,mode:0o700});
      await fs.writeFile(destination+'/manifest.json',encoded,{mode:0o600,flag:'wx'});
      await fs.copyFile(dir+'/calendar/presentation.tlsn',destination+'/calendar.tlsn');
      await fs.copyFile(dir+'/document.pdf',destination+'/document.pdf');
      for(let i=0;i<parts.length;i++) await fs.copyFile(dir+'/pdf-'+i+'/presentation.tlsn',destination+'/pdf-'+i+'.tlsn');
      job.status = 'verified'; job.stage = 'Prova validada; registro na blockchain ainda não realizado.';
      job.result = {...manifest,evidenceHash,proofVerified:true,registered:false};
    } catch (error) {
      job.status = 'failed'; job.stage = 'Falha na coleta ou verificação. Nenhuma atestação emitida.';
      job.error = error.code || error.killed ? 'O adaptador TLSNotary falhou ou excedeu o tempo. Consulte o diagnóstico local.' : String(error.message).slice(0,300);
      // Local diagnostics are not served as application data and never contain signing keys.
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      await fs.writeFile(dir+'/failure.txt',String(error.stderr || error.message).slice(0,6000),{mode:0o600});
    } finally {
      activeJob = null;
      try {
        await fs.mkdir(dir,{recursive:true,mode:0o700});
        await fs.writeFile(dir+'/job.json',JSON.stringify(job),{mode:0o600});
      } catch { console.error('Não foi possível persistir o histórico local da coleta.'); }
    }
  })();
  return {id,status:job.status};
}

export async function getJob(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Identificador inválido.');
  const job = jobs.get(id) || JSON.parse(await fs.readFile(state+'jobs/'+id+'/job.json','utf8'));
  if (job.status === 'verified') await evidence(job.result.evidenceHash);
  return job;
}

async function evidence(hash) {
  if (!/^0x[0-9a-f]{64}$/.test(hash || '')) throw new Error('Identificador de prova inválido.');
  const directory = state+'evidence/'+hash.slice(2);
  const encoded = await fs.readFile(directory+'/manifest.json');
  if (sha256(encoded) !== hash) throw new Error('Manifesto alterado.');
  const manifest = JSON.parse(encoded);
  return {directory,manifest};
}

export async function downloadEvidence(hash) {
  const {directory,manifest} = await evidence(hash);
  const calendar = await fs.readFile(directory+'/calendar.tlsn');
  const document = await fs.readFile(directory+'/document.pdf');
  const parts = [];
  for(let i=0;i<manifest.pdfParts.length;i++) {
    const bytes = await fs.readFile(directory+'/pdf-'+i+'.tlsn');
    if (sha256(bytes)!==manifest.pdfParts[i].proofHash) throw new Error('Trecho da prova alterado.');
    parts.push(bytes.toString('base64'));
  }
  if (sha256(calendar)!==manifest.calendarProofHash || sha256(document)!==manifest.documentHash) throw new Error('Arquivos da prova alterados.');
  return {schema:'rbb-publication-bundle/v2',evidenceHash:hash,manifest,
    calendarPresentation:calendar.toString('base64'),pdfPresentations:parts,pdf:document.toString('base64')};
}

async function checkedContract(address, dependencies = {}) {
  const config = {...await publicationConfig(),...dependencies.chainConfig};
  const artifact = JSON.parse(await fs.readFile(ROOT+'build/PublicationRegistry.json','utf8'));
  const provider = dependencies.provider || rpc();
  const adapter = {request:({method,params=[]})=>provider.send(method,params)};
  const target = await validatePublicationContract(adapter,config,artifact,address);
  return {config,target,provider,contract:new Contract(target,artifact.abi,provider)};
}

export async function attestEvidence(input, dependencies = {}) {
  const {config,target} = await checkedContract(input.contract, dependencies);
  const {directory,manifest} = await evidence(input.evidenceHash);
  if (manifest.notaryPublicKey !== config.notaryPublicKey || manifest.policy !== config.policy || manifest.trustModel !== config.trustModel) throw new Error('Política/notary diferentes da configuração atual.');
  // Revalidate stored presentations, request paths, full PDF and dates before signing anything.
  const scratch = state+'verification/'+randomUUID();
  try {
    async function verifyPart(name,url,hash,range=null) {
      const file = directory+'/'+name+'.tlsn';
      if (sha256(await fs.readFile(file))!==hash) throw new Error('Prova alterada.');
      await runFile(binary,['verify',file,config.notaryPublicKey,scratch+'/'+name],childOptions);
      const session = JSON.parse(await fs.readFile(scratch+'/'+name+'/verified.json','utf8'));
      assertRequest(await fs.readFile(scratch+'/'+name+'/sent.http'),url,range);
      return {session,response:parseHttpResponse(await fs.readFile(scratch+'/'+name+'/received.http'),range)};
    }
    const calendar = await verifyPart('calendar',manifest.calendarURL,manifest.calendarProofHash);
    const parsed = parseTceInput(manifest.sourceURL,manifest.editionDate);
    if (manifest.calendarURL!==parsed.calendarURL || !calendarSources(JSON.parse(calendar.response.body),parsed.date).includes(manifest.sourceURL)) throw new Error('Vínculo com o calendário inválido.');
    if (!Array.isArray(manifest.pdfParts) || !manifest.pdfParts.length || manifest.pdfParts.length>128) throw new Error('Intervalos ausentes ou excessivos.');
    const chunks = []; let offset=0;
    for(let i=0;i<manifest.pdfParts.length;i++) {
      const part = manifest.pdfParts[i];
      if (part.start!==offset || part.total!==manifest.size || part.end<part.start || part.end>=part.total || part.end-part.start>=65536 ||
          part.etag!==manifest.pdfParts[0].etag || !/^"[a-zA-Z0-9_.:-]+"$/.test(part.etag)) throw new Error('Intervalos/versões inconsistentes.');
      const verified = await verifyPart('pdf-'+i,manifest.sourceURL,part.proofHash,part);
      if (verified.session.observedAt!==part.observedAt) throw new Error('Horário do intervalo inconsistente.');
      chunks.push(verified.response.body); offset=part.end+1;
    }
    if(offset!==manifest.size) throw new Error('PDF incompleto.');
    const metadata = await inspectPdf({headers:{'content-type':'application/pdf'},body:Buffer.concat(chunks)},parsed.date,scratch);
    if (metadata.documentHash!==manifest.documentHash || metadata.publicationDateCode!==manifest.publicationDateCode ||
        manifest.pdfParts.at(-1).observedAt!==manifest.observedAt || manifest.pdfParts[0].observedAt!==manifest.observationStartedAt || calendar.session.observedAt!==manifest.calendarObservedAt ||
        parsed.dateCode!==manifest.editionDateCode || manifest.pdfParts.some(p=>Math.abs(p.observedAt-manifest.observedAt)>1200)) throw new Error('Metadados não correspondem à prova autenticada.');
    const now = Math.floor(Date.now()/1000);
    if (manifest.observedAt > now+30 || now-manifest.observedAt>1200 || Math.abs(manifest.observedAt-manifest.calendarObservedAt)>1200) throw new Error('Prova antiga demais para novo registro. Faça outra coleta.');
    const key = await fs.readFile(state+'verifier.key');
    const signer = new Wallet('0x'+key.toString('hex'));
    if (signer.address !== config.verifier) throw new Error('Chave do verificador não corresponde à configuração.');
    const claim = {sourceId:sourceId(manifest.sourceURL),documentHash:manifest.documentHash,evidenceHash:input.evidenceHash,
      editionDate:parsed.dateCode,publicationDate:metadata.publicationDateCode,observedAt:manifest.observedAt,validUntil:now+900,nonce:'0x'+randomBytes(32).toString('hex')};
    const signature = await signer.signTypedData(publicationDomain(config.chainId,target),publicationTypes,claim);
    return {claim,signature,sourceURL:manifest.sourceURL,verifier:config.verifier,trustModel:config.trustModel};
  } finally { await fs.rm(scratch,{recursive:true,force:true}); }
}

function jsonRecord(record) {
  return {registeredAt:Number(record.registeredAt),registeredAtISO:new Date(Number(record.registeredAt)*1000).toISOString(),
    observedAt:Number(record.observedAt),observedAtISO:new Date(Number(record.observedAt)*1000).toISOString(),
    publicationDateCode:Number(record.publicationDate),documentHash:record.documentHash,evidenceHash:record.evidenceHash};
}

export async function readPublication(input, dependencies = {}) {
  const parsed = parseTceInput(input.url,input.date);
  const {contract,target,config} = await checkedContract(input.contract, dependencies);
  let sources = parsed.canonicalURL ? [parsed.canonicalURL] : [];
  if (!parsed.canonicalURL) {
    const count = Number(await contract.sourceCount(parsed.dateCode));
    if (count > 32) throw new Error('Há muitas fontes nesta data; consulte usando o link exato do PDF.');
    sources = await Promise.all(Array.from({length:count},(_,i)=>contract.sourceAt(parsed.dateCode,i)));
  }
  const records = [];
  for (const url of sources) {
    const [exists,record] = await contract.getRecord(sourceId(url),parsed.dateCode);
    if (exists) records.push({sourceURL:url,editionDate:parsed.date,...jsonRecord(record),
      evidenceAvailable:existsSync(state+'evidence/'+record.evidenceHash.slice(2)+'/manifest.json')});
  }
  records.sort((a,b)=>a.registeredAt-b.registeredAt);
  const readAt = new Date().toISOString();
  return {schema:'rbb-publication-history/v1',chainId:config.chainId,contract:target,algorithm:'SHA-256',
    registered:records.length>0,editionDate:parsed.date,records,firstRegisteredAtISO:records[0]?.registeredAtISO || null,
    sourceFetched:false,readAt,verification:{source:'rpc',verifiedAt:readAt,networkAvailable:true,partial:false}};
}

export async function listPublications(input, dependencies = {}) {
  const {contract,target,config,provider} = await checkedContract(input.contract,dependencies);
  const head = await provider.send('eth_getBlockByNumber',['latest',false]);
  const latest = Number(BigInt(head.number));
  const before = input.beforeBlock;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || before > latest+1)) throw new Error('Página de histórico inválida.');
  const configuredFloor = target.toLowerCase()===config.contract?.toLowerCase() ? config.deploymentBlock : 0;
  const floor = Number.isSafeInteger(configuredFloor) && configuredFloor>=0 ? configuredFloor : 0;
  const toBlock = before === undefined ? latest : before-1;
  if (toBlock<floor) throw new Error('Página anterior ao deploy do contrato.');
  const fromBlock = Math.max(floor,toBlock-4999);
  const topic = contract.interface.getEvent('PublicationRecorded').topicHash;
  const ranges=[];for(let from=fromBlock;from<=toBlock;from+=1000)ranges.push({address:target,fromBlock:'0x'+from.toString(16),toBlock:'0x'+Math.min(toBlock,from+999).toString(16),topics:[topic]});
  const pages = await Promise.all(ranges.map(filter=>provider.send('eth_getLogs',[filter])));
  if(pages.some(page=>!Array.isArray(page)))throw new Error('O RPC não devolveu o histórico de eventos.');
  const logs=pages.flat().filter(log=>!log.removed).sort((a,b)=>Number(BigInt(a.blockNumber))-Number(BigInt(b.blockNumber)) || Number(BigInt(a.logIndex))-Number(BigInt(b.logIndex)));
  const sources = new Map();
  for(const log of logs){
    if(log.address.toLowerCase()!==target.toLowerCase())throw new Error('Evento de outro contrato.');
    const event=contract.interface.parseLog(log);const p=event.args;
    const date=String(p.editionDate).replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3');
    const parsed=parseTceInput(p.sourceURL,date);
    if(parsed.canonicalURL!==p.sourceURL || sourceId(p.sourceURL)!==p.sourceId)throw new Error('Origem inconsistente no evento registrado.');
    const key=p.sourceId+':'+p.editionDate;
    if(!sources.has(key))sources.set(key,{sourceURL:p.sourceURL,editionDate:date,sourceId:p.sourceId,dateCode:Number(p.editionDate),events:[]});
    sources.get(key).events.push({documentHash:p.documentHash,registeredAt:Number(p.registeredAt),transactionHash:log.transactionHash,blockNumber:Number(BigInt(log.blockNumber))});
  }
  if(sources.size>200)throw new Error('Há mais de 200 fontes nesta página; reduza o intervalo de consulta.');
  const records=[];
  for(const source of sources.values()){
    const [exists,record]=await contract.getRecord(source.sourceId,source.dateCode);
    if(!exists)throw new Error('O evento não corresponde ao estado atual do contrato.');
    const first=source.events.find(event=>event.documentHash===record.documentHash && event.registeredAt===Number(record.registeredAt));
    records.push({sourceURL:source.sourceURL,editionDate:source.editionDate,...jsonRecord(record),transactionHash:first?.transactionHash||null,blockNumber:first?.blockNumber||null,
      evidenceAvailable:existsSync(state+'evidence/'+record.evidenceHash.slice(2)+'/manifest.json')});
  }
  const checkedHead=await provider.send('eth_getBlockByNumber',[head.number,false]);
  if(checkedHead?.hash!==head.hash)throw new Error('A cadeia mudou durante a consulta. Atualize a lista.');
  records.sort((a,b)=>b.registeredAt-a.registeredAt || a.sourceURL.localeCompare(b.sourceURL));
  return {schema:'rbb-publication-list/v1',chainId:config.chainId,contract:target,algorithm:'SHA-256',records,fromBlock,toBlock,
    nextBeforeBlock:fromBlock>floor?fromBlock:null,complete:fromBlock===floor,snapshotBlock:latest,snapshotHash:head.hash,sourceFetched:false,readAt:new Date().toISOString()};
}
