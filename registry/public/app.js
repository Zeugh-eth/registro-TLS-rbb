import { validateContract, lookup, prepareRegistration, readHashAlgorithm } from './wallet.js';
import { hashDocument, SUPPORTED_HASH_ALGORITHM } from './hashing.js';
let hashAlgorithm = SUPPORTED_HASH_ALGORITHM;
const $ = id => document.getElementById(id);
let config, artifact, wallet, account, address, digest, documentInfo, proof, generation = 0, busy = false;
let validated = false;
const discovered = [];
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.info?.rdns === 'io.metamask' && !discovered.includes(event.detail.provider)) discovered.push(event.detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const pendingKey = (target, hash) => `rbb:648629:${target.toLowerCase()}:${hash.toLowerCase()}`;
function readPending(target, hash) { try { return JSON.parse(localStorage.getItem(pendingKey(target, hash)) || 'null'); } catch { return null; } }
function invalidate() {
  generation++; validated = false; proof = null; $('proof').hidden = true;
  $('hash-algorithm').textContent = SUPPORTED_HASH_ALGORITHM + ' · prévia local';
  $('contract-status').textContent = 'Rede ou carteira alterada. Valide o contrato novamente.';
  $('wallet-status').textContent = 'Reconecte a carteira para conferir conta e rede.';
  buttons();
}
function status(message, error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
function buttons() {
  $('register').disabled = busy || !digest || !validated || account?.toLowerCase() !== config?.writer.toLowerCase();
  $('verify').disabled = busy || !digest || !validated;
  $('attach').disabled = busy || !wallet || !config;
  $('connect').disabled = busy || !config;
  $('copy').disabled = !digest;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Serviço indisponível.');
  return data;
}
function render(result) {
  proof = { ...result, document: documentInfo, verifiedAt: new Date().toISOString() };
  $('proof').hidden = !result.registered;
  if (result.registered) {
    $('timestamp').textContent = new Date(result.registeredAtISO).toLocaleString('pt-BR') + ' · ' + result.registeredAtISO;
    $('transaction').textContent = result.inclusion?.transactionHash || 'Hash confirmado no contrato; transação de origem não disponível neste dispositivo.';
    status('Registro encontrado. Este arquivo corresponde ao hash registrado.');
  } else if (result.submissionStatus === 'failed') status('A transação falhou. O documento não foi registrado.', true);
  else if (result.submissionStatus) status('Transação enviada ou com resposta incerta. Aguardando inclusão: ' + result.transactionHash);
  else status('Este documento ainda não tem registro neste contrato.');
}
$('document').addEventListener('change', async event => {
  const current = ++generation;
  digest = null; proof = null; $('proof').hidden = true; $('digest').textContent = 'Calculando…'; buttons();
  const file = event.target.files[0];
  if (!file) { $('digest').textContent = 'O hash aparecerá aqui.'; $('filename').textContent = 'Nenhum arquivo selecionado'; return; }
  $('filename').textContent = file.name + ' · ' + file.size.toLocaleString('pt-BR') + ' bytes';
  if (file.size > 50 * 1024 * 1024) { $('digest').textContent = 'Arquivo acima do limite.'; status('Escolha um arquivo de até 50 MB.', true); return; }
  try {
    const hash = await hashDocument(file, hashAlgorithm);
    if (current !== generation) return;
    digest = hash;
    documentInfo = { name: file.name, size: file.size };
    $('digest').textContent = digest;
    status(validated ? 'Hash calculado. Pronto para registrar ou verificar.' : 'Hash calculado localmente. Conecte MetaMask e valide o contrato para registrar.');
  } catch { if (current === generation) status('Não foi possível ler o arquivo.', true); }
  buttons();
});
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(digest); status('Hash copiado.'); } catch { status('Selecione e copie o hash exibido.', true); } };
$('connect').onclick = async () => {
  busy = true; buttons();
  try {
    const selected = discovered[0] || window.ethereum?.providers?.find(p => p.isMetaMask) || (window.ethereum?.isMetaMask ? window.ethereum : null);
    if (!selected) throw new Error('Abra esta página no Chrome/Dia com a extensão MetaMask instalada e habilitada.');
    if (wallet !== selected) {
      wallet?.removeListener?.('accountsChanged', invalidate); wallet?.removeListener?.('chainChanged', invalidate);
      wallet = selected; wallet.on?.('accountsChanged', invalidate); wallet.on?.('chainChanged', invalidate);
    }
    const chainId = '0x' + config.chainId.toString(16);
    await wallet.request({method:'eth_requestAccounts'});
    if (await wallet.request({method:'eth_chainId'}) !== chainId) {
      try { await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]}); }
      catch (error) {
        if (error.code !== 4902) throw error;
        await wallet.request({method:'wallet_addEthereumChain',params:[{chainId,chainName:'RBB Testnet',nativeCurrency:{name:'RBB',symbol:'RBB',decimals:18},rpcUrls:[config.rpcUrl]}]});
        await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]});
      }
    }
    account = (await wallet.request({method:'eth_accounts'}))[0];
    validated = false;
    $('wallet-status').textContent = account + (account?.toLowerCase() === config.writer.toLowerCase() ? ' · escritora autorizada' : ' · somente consulta; selecione a carteira escritora para registrar');
    $('mode').textContent = 'MetaMask · confirme o contrato';
    status('Carteira conectada. Cole e valide o endereço publicado no Remix.');
  } catch (error) { status(error.code === 4001 ? 'Conexão cancelada na carteira.' : error.message, true); }
  finally { busy = false; buttons(); }
};
$('contract-address').addEventListener('input', () => { generation++; validated = false; proof = null; $('proof').hidden = true; $('hash-algorithm').textContent = SUPPORTED_HASH_ALGORITHM + ' · prévia local'; buttons(); });
$('attach').onclick = async () => {
  const current = ++generation; busy = true; buttons();
  $('contract-status').textContent = 'Verificando rede, código e carteira escritora…';
  try {
    const target = await validateContract(wallet, config, artifact, $('contract-address').value);
    if (current !== generation) return;
    account = (await wallet.request({method:'eth_accounts'}))[0];
    if (current !== generation) return;
    hashAlgorithm = await readHashAlgorithm(wallet, artifact, target);
    if (current !== generation) return;
    $('hash-algorithm').textContent = hashAlgorithm + ' · confirmado no contrato';
    address = target; validated = true; localStorage.setItem('rbb:contract', address);
    $('contract-status').textContent = 'Contrato validado: ' + address;
    $('mode').textContent = 'RBB Testnet · MetaMask';
    $('network').textContent = 'TESTNET 648629 · ' + address;
    status('Contrato pronto. Selecione um arquivo para registrar ou verificar.');
  } catch (error) { validated = false; $('contract-status').textContent = error.message; }
  finally { busy = false; buttons(); }
};
$('verify').onclick = async () => {
  const current = generation, hash = digest, target = address; busy = true; proof = null; $('proof').hidden = true; buttons(); status('Consultando o registro na testnet…');
  try {
    const pasted = $('txhash').value.trim();
    if (pasted && !/^0x[0-9a-fA-F]{64}$/.test(pasted)) throw new Error('Hash de transação inválido.');
    const transactionHash = pasted || readPending(target, hash)?.transactionHash || null;
    const result = await lookup(wallet, config, artifact, target, hash, transactionHash);
    if (pasted && result.inclusion) localStorage.setItem(pendingKey(target, hash), JSON.stringify({transactionHash:pasted}));
    if (current === generation) render(result);
  } catch (e) { if (current === generation) status(e.message, true); }
  finally { busy = false; buttons(); }
};
$('register').onclick = async () => {
  const current = generation, hash = digest, target = address; busy = true; buttons(); status('Verificando antes de abrir MetaMask…');
  let submitted = false;
  try {
    let pending = readPending(target, hash);
    let result = await lookup(wallet, config, artifact, target, hash, pending?.transactionHash || null);
    if (current !== generation) return;
    if (result.registered) { render(result); return; }
    if (pending && !pending.transactionHash) throw new Error('Há uma tentativa sem resposta. Confira a atividade do MetaMask e cole o hash em “Recuperar uma transação”. Não reenvie sem conferir.');
    if (result.submissionStatus === 'failed') { render(result); return; }
    if (!pending) {
      const tx = await prepareRegistration(wallet, config, artifact, target, hash);
      if (current !== generation) return;
      status('Confira e confirme a transação no MetaMask.');
      localStorage.setItem(pendingKey(target, hash), JSON.stringify({requestedAt:new Date().toISOString()}));
      try {
        const transactionHash = await wallet.request({method:'eth_sendTransaction',params:[tx]});
        submitted = true;
        if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error('Resposta sem hash de transação. Confira o MetaMask.');
        pending = {transactionHash}; localStorage.setItem(pendingKey(target, hash), JSON.stringify(pending));
      } catch (error) {
        if (error.code === 4001) localStorage.removeItem(pendingKey(target, hash));
        throw error;
      }
    }
    if (current === generation) status('Transação enviada: ' + pending.transactionHash);
    for (let i = 0; i < 24; i++) {
      if (current !== generation) break;
      result = await lookup(wallet, config, artifact, target, hash, pending.transactionHash);
      if (current === generation) render(result);
      if (result.registered || result.submissionStatus === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    if (current === generation && !result.registered && result.submissionStatus !== 'failed') status('Ainda sem confirmação. Use “Verificar registro” mais tarde; não reenvie.');
  } catch (e) {
    if (current === generation) status(e.code === 4001 ? 'Você cancelou a assinatura no MetaMask.' : (submitted ? 'Envio realizado; consulte a atividade do MetaMask. ' : '') + e.message, true);
  } finally { busy = false; buttons(); }
};
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'registro-' + proof.digest.slice(2, 14) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
Promise.all([api('/api/config'), api('/contract.json')]).then(([data, compiled]) => {
  config = data; artifact = compiled;
  $('mode').textContent = 'Assinatura via MetaMask';
  $('network').textContent = 'TESTNET ' + data.chainId;
  try { $('contract-address').value = localStorage.getItem('rbb:contract') || ''; } catch {}
  buttons();
}).catch(() => { $('mode').textContent = 'Serviço indisponível'; status('Execute npm run build e recarregue a página.', true); });
