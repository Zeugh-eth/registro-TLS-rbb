# Dependências e avisos

- **TLSNotary / tlsn**: submódulo de https://github.com/tlsnotary/tlsn, fixado no
  commit `9a3d73c5bdeeab0255bdb05c89116554cebf6dbe`. Licenças e avisos permanecem
  no repositório upstream e nos arquivos de cada crate.
- **ethers** e **solc**: versões e integridade fixadas em
  `registry/package-lock.json`. O JavaScript distribuído no navegador é gerado
  por `npm run build`; as dependências instaladas não são vendorizadas aqui.
  O override de `tmp` para `0.2.7` mantém a versão de Solidity necessária para
  reproduzir o bytecode e corrige os avisos npm da dependência de arquivos temporários.
- Os contratos preservam seus cabeçalhos SPDX. Este repositório não altera as
  licenças das dependências nem acrescenta uma licença global aos demais arquivos.
- `registry/test/fixtures/tce-calendar.presentation.tlsn` contém uma apresentação
  de uma resposta pública do calendário TCE-SP, usada somente para verificar o
  adaptador offline. O arquivo de metadados contém a chave **pública** do notary;
  a chave privada não é distribuída. O fixture textual conserva apenas o cabeçalho
  da edição necessário aos testes de data.
