import { parseTceInput } from './tce-input.js';
import { validatePublicationContract, preparePublication } from './publication-wallet.js';
const $ = id => document.getElementById(id);
let config,artifact,wallet,account,validated=false,target=null,result=null,history=null,busy=false,generation=0;
let registeredRecords=new Map(),listCursor=null;
const providers=[];
window.addEventListener('eip6963:announceProvider',e=>{if(e.detail?.info?.rdns==='io.metamask'&&!providers.includes(e.detail.provider))providers.push(e.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const input = () => ({url:$('source-url').value.trim(),date:$('edition-date').value,contract:$('contract-address').value.trim()});
const pendingKey = () => 'rbb:publication:pending:'+config.chainId+':'+input().contract.toLowerCase()+':'+(result?.evidenceHash||'');
function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':'';}
function buttons(){
  for(const id of ['inspect','read','example'])$(id).disabled=busy||!config;
  $('prove').disabled=busy||!config?.proofReady;
  $('connect').disabled=busy||!config;
  $('attach').disabled=busy||!wallet||!input().contract;
  $('register').disabled=busy||!result?.proofVerified||!validated||account?.toLowerCase()!==config?.writer?.toLowerCase();
  $('evidence').disabled=!result?.evidenceHash;
  $('list-records').disabled=busy||!config||!input().contract;
  $('list-more').disabled=busy||listCursor===null;
  $('source-url').disabled=busy;$('edition-date').disabled=busy;$('contract-address').disabled=busy;
}
async function api(path,data){const res=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const json=await res.json();if(!res.ok)throw new Error(json.error||'Falha no serviço.');return json;}
function clearDocument(){generation++;result=null;history=null;$('pending-tx').value='';$('pending-tx').closest('details').open=false;$('document-result').hidden=true;$('history').hidden=true;$('choices').hidden=true;buttons();}
function invalidateWallet(){generation++;validated=false;account=null;$('contract-status').textContent='Carteira ou rede mudou. Conecte e valide novamente.';buttons();}
function renderDocument(data){
  result=data;$('document-result').hidden=false;
  $('proof-state').textContent=data.proofVerified?'TLSNotary validado · notary local':'Prévia HTTPS · ainda sem prova TLSNotary';
  $('proof-state').className='badge'+(data.proofVerified?' verified':'');
  $('document-dates').textContent=`Edição ${data.editionNumber} · disponibilização ${data.availabilityDate} · publicação ${data.publicationDate}`;
  $('document-url').textContent=data.sourceURL||data.canonicalURL;
  $('document-hash').textContent=data.documentHash;
  restorePending();
  $('session-info').textContent=data.proofVerified?`${data.serverName} · TLS 1.2 · ${data.pdfParts.length} trechos · ${new Date(data.observationStartedAt*1000).toLocaleString('pt-BR')} → ${new Date(data.observedAt*1000).toLocaleString('pt-BR')} · UTC: ${new Date(data.observedAt*1000).toISOString()}`:'A consulta comum confirmou o PDF; uma prova ainda precisa ser gerada.';
  buttons();
}
function renderHistory(data){
  history=data;$('history').hidden=false;$('history-records').replaceChildren();
  const archived=data.verification?.source==='archive';
  const brt=value=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' BRT';
  $('history-title').textContent=data.registered?(archived?'Registro confirmado anteriormente.':'Primeiro registro encontrado.'):'Nenhum registro para esta edição.';
  $('history-source').textContent=archived
    ? 'A RBB está indisponível nesta consulta. Exibindo a cópia preservada, conferida na rede em '+brt(data.verification.verifiedAt)+'.'+(data.verification.partial?' A lista desta data pode estar incompleta.':'')
    : 'Consulta ao contrato na RBB Testnet · '+brt(data.verification?.verifiedAt||data.readAt)+'.';
  for(const record of data.records){
    const item=document.createElement('article');item.className='history-record';
    for(const [tag,value] of [['h3',brt(record.registeredAtISO)],['p','Primeiro registro na blockchain · '+record.registeredAtISO],['p',record.sourceURL],['p','Edição no calendário: '+record.editionDate+' · publicação declarada: '+String(record.publicationDateCode).replace(/(\d{4})(\d{2})(\d{2})/,'$3/$2/$1')],['p','Coleta autenticada em: '+record.observedAtISO],['code','SHA-256: '+record.documentHash]]){const el=document.createElement(tag);el.textContent=value;item.append(el);}
    if(record.transactionHash){const tx=document.createElement('p');tx.textContent='Transação: '+record.transactionHash;item.append(tx);}
    if(record.declarationURL){const link=document.createElement('a');link.href=record.declarationURL;link.textContent='Ver transação, recibo e metadados';item.append(link,document.createElement('br'));}
    if(record.evidenceAvailable){const link=document.createElement('a');link.href='/api/publication/evidence/'+record.evidenceHash;link.textContent='Baixar evidência preservada';item.append(document.createElement('br'),link);}
    else{const note=document.createElement('p');note.textContent='A cópia da prova não foi encontrada neste servidor.';item.append(note);}
    $('history-records').append(item);
  }
  status(data.registered
    ? (archived?'Registro encontrado no acervo salvo. A conferência atual na rede não foi concluída.':'Registro confirmado na RBB agora. O site do TCE não precisou ser acessado.')
    : 'A consulta atual ao contrato não encontrou registro desta URL/edição.');
}
function restorePending(){
  $('pending-tx').value='';$('pending-tx').closest('details').open=false;
  if(!result?.evidenceHash)return;
  try{const pending=JSON.parse(localStorage.getItem(pendingKey())||'null');if(pending?.hash){$('pending-tx').value=pending.hash;$('pending-tx').closest('details').open=true;}}catch{}
}
function renderRegisteredList(){
  $('registered-rows').replaceChildren();$('registered-table').hidden=registeredRecords.size===0;
  for(const record of [...registeredRecords.values()].sort((a,b)=>b.registeredAt-a.registeredAt || a.sourceURL.localeCompare(b.sourceURL))){
    const row=document.createElement('tr');const edition=document.createElement('td');edition.textContent=record.editionDate.split('-').reverse().join('/');
    const file=document.createElement('td');const link=document.createElement('a');link.href=parseTceInput(record.sourceURL,record.editionDate).canonicalURL;link.target='_blank';link.rel='noopener noreferrer';link.textContent=record.sourceURL.split('/').pop();file.append(link);
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Hash e evidência';details.append(summary);
    const digest=document.createElement('p');digest.textContent='SHA-256: '+record.documentHash;details.append(digest);
    if(record.transactionHash){const tx=document.createElement('p');tx.textContent='Transação: '+record.transactionHash;details.append(tx);}
    if(record.evidenceAvailable){const proof=document.createElement('a');proof.href='/api/publication/evidence/'+record.evidenceHash;proof.textContent='Baixar PDF + provas';details.append(proof);}file.append(details);
    const date=document.createElement('td');date.textContent=new Date(record.registeredAtISO).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' BRT';date.title=record.registeredAtISO;
    const action=document.createElement('td'),button=document.createElement('button');button.className='secondary';button.textContent='Consultar edição';button.onclick=()=>{if(busy)return;$('source-url').value=record.sourceURL;$('edition-date').value=record.editionDate;clearDocument();$('read').click();};action.append(button);
    row.append(edition,file,date,action);$('registered-rows').append(row);
  }
}
async function loadRegisteredList(append=false){
  if(!input().contract)throw new Error('Informe o contrato para consultar os registros.');
  if(!append){registeredRecords.clear();listCursor=null;renderRegisteredList();}
  $('list-status').textContent='Consultando os registros confirmados na RBB…';
  try{
    const query={contract:input().contract};if(append&&listCursor!==null)query.beforeBlock=listCursor;
    const data=await api('/api/publication/list',query);
    for(const record of data.records){const key=record.sourceURL+':'+record.editionDate;const existing=registeredRecords.get(key);registeredRecords.set(key,existing?{...existing,...record,transactionHash:existing.transactionHash||record.transactionHash,blockNumber:existing.blockNumber||record.blockNumber}:record);}
    listCursor=data.nextBeforeBlock;renderRegisteredList();$('list-more').hidden=listCursor===null;
    $('list-status').textContent=registeredRecords.size+' documento(s) registrado(s). '+(data.complete?'Histórico do contrato consultado até o bloco '+data.snapshotBlock+'.':'Há histórico anterior; use “Carregar registros anteriores”.');
  }catch(error){$('list-status').textContent=error.message;throw error;}
}
$('list-records').onclick=()=>task(()=>loadRegisteredList());
$('list-more').onclick=()=>task(()=>loadRegisteredList(true));
async function task(action){if(busy)return;busy=true;buttons();try{await action();}catch(e){status(e.code===4001?'Você cancelou no MetaMask.':e.message,true);}finally{busy=false;buttons();}}
async function watchProof(id,job=null){
  for(;;){
    job=job||await api('/api/publication/jobs/'+encodeURIComponent(id));status(job.stage);
    if(job.status==='failed')throw new Error(job.error);
    if(job.status==='verified'){$('source-url').value=job.result.sourceURL;$('edition-date').value=job.result.editionDate;renderDocument(job.result);status('Prova TLSNotary validada com notary local. Falta registrar a evidência na RBB.');return;}
    await new Promise(resolve=>setTimeout(resolve,2000));job=null;
  }
}
$('source-url').addEventListener('input',()=>{clearDocument();try{const parsed=parseTceInput($('source-url').value.trim());$('edition-date').value=parsed.date;}catch{}});
$('edition-date').addEventListener('input',clearDocument);
$('contract-address').addEventListener('input',()=>{generation++;validated=false;history=null;$('history').hidden=true;registeredRecords.clear();listCursor=null;renderRegisteredList();$('list-more').hidden=true;$('list-status').textContent='Atualize a lista para consultar este contrato.';buttons();});
$('example').onclick=()=>{$('source-url').value='https://doe.tce.sp.gov.br/v/pdf/2026/11/doe-tce-2026-11-14.pdf';$('edition-date').value='2026-11-14';clearDocument();status('Exemplo preenchido. Escolha buscar, provar ou consultar.');};
$('inspect').onclick=()=>task(async()=>{clearDocument();parseTceInput(input().url,input().date);status('Buscando o PDF e conferindo a edição na fonte oficial…');const data=await api('/api/publication/inspect',input());if(data.needsSelection){$('choices').hidden=false;$('edition-choice').replaceChildren();for(const url of data.sources){const option=document.createElement('option');option.value=url;option.textContent=url.split('/').pop();$('edition-choice').append(option);}status('O calendário tem mais de uma edição. Selecione o PDF.');return;}renderDocument(data);status('PDF e datas conferidos via HTTPS. Falta gerar a prova TLSNotary.');});
$('choose').onclick=()=>{const url=$('edition-choice').value;$('source-url').value=url;clearDocument();status('Edição selecionada. Gere a prova ou faça uma nova prévia.');};
$('prove').onclick=()=>task(async()=>{
  clearDocument();parseTceInput(input().url,input().date);status('Iniciando coleta TLSNotary. Pode levar alguns minutos…');
  const {id}=await api('/api/publication/prove',input());
  window.history.replaceState(null,'','/?job='+encodeURIComponent(id));
  await watchProof(id);
});
$('read').onclick=()=>task(async()=>{history=null;$('history').hidden=true;parseTceInput(input().url,input().date);if(!input().contract)throw new Error('Informe abaixo o endereço do PublicationRegistry publicado no Remix.');status('Consultando o primeiro registro na blockchain…');renderHistory(await api('/api/publication/read',input()));$('history').scrollIntoView({block:'center',behavior:'smooth'});});
$('connect').onclick=()=>task(async()=>{
  const selected=providers[0]||window.ethereum?.providers?.find(p=>p.isMetaMask)||(window.ethereum?.isMetaMask?window.ethereum:null);
  if(!selected)throw new Error('Abra no Chrome/Dia com a extensão MetaMask.');
  if(wallet!==selected){wallet?.removeListener?.('accountsChanged',invalidateWallet);wallet?.removeListener?.('chainChanged',invalidateWallet);wallet=selected;wallet.on?.('accountsChanged',invalidateWallet);wallet.on?.('chainChanged',invalidateWallet);}
  await wallet.request({method:'eth_requestAccounts'});
  const chainId='0x'+config.chainId.toString(16);
  if(await wallet.request({method:'eth_chainId'})!==chainId){try{await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]});}catch(e){if(e.code!==4902)throw e;await wallet.request({method:'wallet_addEthereumChain',params:[{chainId,chainName:'RBB Testnet',nativeCurrency:{name:'RBB',symbol:'RBB',decimals:18},rpcUrls:['http://52.87.7.52:8545']}]});await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]});}}
  account=(await wallet.request({method:'eth_accounts'}))[0];validated=false;$('wallet-status').textContent=account||'Nenhuma conta selecionada.';status('Carteira conectada. Valide o contrato para escrita.');
});
$('attach').onclick=()=>task(async()=>{const current=++generation;target=await validatePublicationContract(wallet,config,artifact,input().contract);if(current!==generation)return;account=(await wallet.request({method:'eth_accounts'}))[0];validated=true;localStorage.setItem('rbb:publication:contract',target);$('contract-status').textContent='Contrato, rede e verificador validados.';status('Contrato pronto para receber a evidência após sua confirmação na carteira.');});
async function checkReceipt(hash,expectedTx=null){
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new Error('Hash de transação inválido.');
  const receipt=await wallet.request({method:'eth_getTransactionReceipt',params:[hash]});
  if(!receipt)return false;
  if(receipt.to?.toLowerCase()!==input().contract.toLowerCase()||receipt.from?.toLowerCase()!==config.writer.toLowerCase())throw new Error('Recibo de outra carteira/contrato.');
  if(BigInt(receipt.status)!==1n)throw new Error('A transação falhou. Consulte a atividade do MetaMask.');
  if(expectedTx){const tx=await wallet.request({method:'eth_getTransactionByHash',params:[hash]});if(tx?.input?.toLowerCase()!==expectedTx.data.toLowerCase())throw new Error('A transação não corresponde à evidência enviada.');}
  renderHistory(await api('/api/publication/read',input()));return true;
}
$('register').onclick=()=>task(async()=>{
  const current=generation;const key=pendingKey();let pending;try{pending=JSON.parse(localStorage.getItem(key)||'null');}catch{}
  if(pending){if(!pending.hash)throw new Error('Existe tentativa sem resposta. Confira o MetaMask e recupere o hash; não reenvie às cegas.');$('pending-tx').value=pending.hash;if(await checkReceipt(pending.hash,pending.tx))return;throw new Error('Transação ainda pendente. Use a recuperação de recibo.');}
  status('Revalidando a prova e preparando a atestação para este contrato…');
  const attestation=await api('/api/publication/attest',{contract:input().contract,evidenceHash:result.evidenceHash});
  const tx=await preparePublication(wallet,config,artifact,input().contract,attestation);if(current!==generation)throw new Error('Carteira ou rede mudou durante a preparação.');
  status('Confira e confirme a transação no MetaMask até '+new Date(Number(attestation.claim.validUntil)*1000).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})+' BRT. Depois desse prazo, a atestação expira.');localStorage.setItem(key,JSON.stringify({requestedAt:Date.now(),validUntil:attestation.claim.validUntil,tx}));
  let hash;try{hash=await wallet.request({method:'eth_sendTransaction',params:[tx]});}catch(e){if(e.code===4001)localStorage.removeItem(key);throw e;}
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new Error('MetaMask não retornou um hash válido. Confira a atividade da carteira.');
  localStorage.setItem(key,JSON.stringify({hash,tx}));$('pending-tx').value=hash;status('Transação enviada; aguardando confirmação: '+hash);
  for(let i=0;i<24;i++){if(current!==generation)throw new Error('Rede/carteira mudou. Consulte o envio na atividade do MetaMask.');if(await checkReceipt(hash,tx))return;await new Promise(resolve=>setTimeout(resolve,3000));}
  status('Ainda sem recibo. Consulte novamente mais tarde; não reenvie.');
});
$('receipt').onclick=()=>task(async()=>{if(!wallet)throw new Error('Conecte MetaMask para consultar o recibo.');await validatePublicationContract(wallet,config,artifact,input().contract);if(!await checkReceipt($('pending-tx').value.trim()))status('Transação ainda sem recibo.');});
$('evidence').onclick=()=>{const a=document.createElement('a');a.href='/api/publication/evidence/'+result.evidenceHash;a.download='evidencia-tce.json';a.click();};
$('history-download').onclick=()=>{if(!history)return;const url=URL.createObjectURL(new Blob([JSON.stringify(history,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='historico-tce-'+history.editionDate+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
Promise.all([api('/api/publication/config'),api('/publication-contract.json')]).then(async ([settings,compiled])=>{config=settings;artifact=compiled;$('writer-address').textContent=settings.writer;$('verifier-address').textContent=settings.verifier||'Configuração local pendente.';$('mode').textContent=settings.proofReady?'TLSNotary local · MetaMask':'TLSNotary não configurado';$('contract-address').value=settings.contract||'';try{if(!settings.contract)$('contract-address').value=localStorage.getItem('rbb:publication:contract')||'';}catch{}if(settings.contract)$('contract-status').textContent='Contrato configurado na RBB. Conecte a carteira e valide para escrever; consultas já estão disponíveis.';buttons();const jobId=new URL(location.href).searchParams.get('job');if(jobId)await task(()=>watchProof(jobId));if(location.hash==='#registros')await task(()=>loadRegisteredList());}).catch(e=>{status(e.message,true);$('mode').textContent='Serviço indisponível';});
