import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SigningKey, Wallet } from 'ethers';
import { ROOT } from '../lib/chain.mjs';
const directory = ROOT+'state/';
fs.mkdirSync(directory,{recursive:true,mode:0o700});
for (const name of ['notary','verifier']) {
  const path = directory+name+'.key';
  if (!fs.existsSync(path)) fs.writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});
  fs.chmodSync(path,0o600);
}
const notaryKey = '0x'+fs.readFileSync(directory+'notary.key').toString('hex');
const publicKey = SigningKey.computePublicKey(notaryKey,true).slice(2);
fs.writeFileSync(directory+'notary.pub',publicKey+'\n',{mode:0o600});
const verifier = new Wallet('0x'+fs.readFileSync(directory+'verifier.key').toString('hex')).address;
let previous = {};
if (fs.existsSync(directory+'publication-config.json')) previous=JSON.parse(fs.readFileSync(directory+'publication-config.json','utf8'));
fs.writeFileSync(directory+'publication-config.json',JSON.stringify({...(previous.verifier===verifier?{contract:previous.contract,deploymentBlock:previous.deploymentBlock}:{}),schema:'rbb-publication-config/v1',
  trustModel:'local-notary',notaryPublicKey:publicKey,verifier,policy:'tce-sp-doe-tlsn-local/v1'},null,2),{mode:0o600});
console.log('Verificador de desenvolvimento (público): '+verifier);
console.log('Modelo: notary local; não é serviço independente da Ethereum Foundation. Chaves privadas não exibidas.');
