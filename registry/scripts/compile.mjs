import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function compile(name = 'DocumentRegistry') {
  const source = fs.readFileSync(root + `contracts/${name}.sol`, 'utf8');
  const input = {
    language: 'Solidity', sources: { [`${name}.sol`]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const c = output.contracts[`${name}.sol`][name];
  const artifact = { compiler: solc.version(), evmVersion: 'paris', abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    runtimeBytecode: '0x' + c.evm.deployedBytecode.object,
    immutableReferences: c.evm.deployedBytecode.immutableReferences,
    source, metadata: JSON.parse(c.metadata) };
  if (name === 'PublicationRegistry') {
    // Remix also supports the identical reviewed source with optimization disabled.
    // Accept only bytecode reproduced locally from this source and compiler.
    input.settings.optimizer.enabled = false;
    const plainOutput = JSON.parse(solc.compile(JSON.stringify(input)));
    const plainErrors = (plainOutput.errors || []).filter(e => e.severity === 'error');
    if (plainErrors.length) throw new Error(plainErrors.map(e => e.formattedMessage).join('\n'));
    const plain = plainOutput.contracts[`${name}.sol`][name];
    artifact.runtimeVariants = [{compiler:solc.version(),evmVersion:'paris',optimizer:{enabled:false,runs:200},
      bytecode:'0x'+plain.evm.bytecode.object,runtimeBytecode:'0x'+plain.evm.deployedBytecode.object}];
  }
  fs.mkdirSync(root + 'build', { recursive: true });
  fs.mkdirSync(root + '../reports/publication', { recursive: true });
  fs.writeFileSync(root + `build/${name}.json`, JSON.stringify(artifact, null, 2));
  fs.copyFileSync(root + 'node_modules/ethers/dist/ethers.min.js', root + 'public/ethers.js');
  return artifact;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  compile('PublicationRegistry');
  compile('SignedPublicationRegistry');
  const artifact = compile();
  console.log(`Compiled DocumentRegistry (${artifact.compiler}), EVM ${artifact.evmVersion}`);
}
