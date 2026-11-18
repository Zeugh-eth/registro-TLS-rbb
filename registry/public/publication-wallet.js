import { Interface, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from './ethers.js';
import { verifyNetwork, normalizeRuntime } from './wallet.js';
export const publicationTypes = { Publication: [
  {name:'sourceId',type:'bytes32'}, {name:'documentHash',type:'bytes32'}, {name:'evidenceHash',type:'bytes32'},
  {name:'editionDate',type:'uint32'}, {name:'publicationDate',type:'uint32'},
  {name:'observedAt',type:'uint64'}, {name:'validUntil',type:'uint64'}, {name:'nonce',type:'bytes32'}
] };
export const publicationDomain = (chainId,address) => ({name:'RBBPublicationRegistry',version:'1',chainId,verifyingContract:address});
export const sourceId = url => keccak256(toUtf8Bytes(url));

export async function validatePublicationContract(provider, config, artifact, address) {
  await verifyNetwork(provider, config);
  const target = getAddress(address.trim());
  const code = await provider.request({method:'eth_getCode',params:[target,'latest']});
  const expected = [artifact.runtimeBytecode,...(artifact.runtimeVariants || []).map(v=>v.runtimeBytecode)];
  const normalized = normalizeRuntime(code,{});
  if (!expected.some(runtime=>normalizeRuntime(runtime,{})===normalized)) throw new Error('Bytecode diferente do PublicationRegistry fornecido (Solidity 0.8.30, Paris, otimização 200 ou desligada).');
  const abi = new Interface(artifact.abi);
  for (const [name, expected] of [['writer',config.writer],['verifier',config.verifier],['hashAlgorithm','SHA-256']]) {
    const raw = await provider.request({method:'eth_call',params:[{to:target,data:abi.encodeFunctionData(name)},'latest']});
    const actual = abi.decodeFunctionResult(name,raw)[0];
    if (actual.toLowerCase() !== expected?.toLowerCase()) throw new Error('Contrato com '+name+' diferente da configuração.');
  }
  return target;
}

export async function preparePublication(provider, config, artifact, address, attestation) {
  const target = await validatePublicationContract(provider,config,artifact,address);
  const accounts = await provider.request({method:'eth_accounts'});
  if (accounts[0]?.toLowerCase() !== config.writer.toLowerCase()) throw new Error('Selecione a carteira escritora autorizada.');
  const {claim,signature,sourceURL} = attestation;
  if (claim.sourceId !== sourceId(sourceURL) ||
      verifyTypedData(publicationDomain(config.chainId,target),publicationTypes,claim,signature).toLowerCase() !== config.verifier.toLowerCase()) {
    throw new Error('Atestação inválida para esta rede/contrato.');
  }
  const tx = {from:accounts[0],to:target,data:new Interface(artifact.abi).encodeFunctionData('registerPublication',[sourceURL,claim,signature]),value:'0x0'};
  await provider.request({method:'eth_call',params:[tx,'pending']});
  const estimate = BigInt(await provider.request({method:'eth_estimateGas',params:[tx]}));
  const gas = (estimate*120n+99n)/100n;
  const block = await provider.request({method:'eth_getBlockByNumber',params:['latest',false]});
  if (gas > BigInt(block.gasLimit)) throw new Error('Gas acima do limite do bloco.');
  const gasPrice = await provider.request({method:'eth_gasPrice'});
  const balance = await provider.request({method:'eth_getBalance',params:[accounts[0],'pending']});
  if (BigInt(balance) < gas*BigInt(gasPrice)) throw new Error('Saldo insuficiente para gas.');
  return {...tx,chainId:'0x'+config.chainId.toString(16),type:'0x0',gas:'0x'+gas.toString(16),gasPrice};
}
