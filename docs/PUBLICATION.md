# Publicação autenticada e primeira data

## Fluxo do aplicativo

1. Cole uma URL oficial do TCE-SP e informe a data da edição no calendário.
2. A prévia HTTPS confere calendário, PDF e datas declaradas; ainda não é a prova.
3. A coleta TLSNotary autentica o calendário e o PDF em trechos de 64 KiB.
4. O adaptador verifica apresentações, certificado/identidade do servidor,
   requisições, respostas e intervalos. ETag forte e If-Match vinculam os trechos
   à mesma versão do PDF.
5. O manifesto recebe SHA-256. O verificador revalida as apresentações e assina uma
   atestação EIP-712 vinculada a fonte, edição, publicação, hashes, observação,
   expiração, nonce, chain ID e contrato.
6. MetaMask ou o executor de lote assina a transação. O contrato exige o writer e
   o verificador autorizados.
7. Recibo, evento e leitura posterior confirmam a inclusão e a primeira data.

O conteúdo usa SHA-256; a identidade da URL canônica usa Keccak-256. A normalização
aceita o PDF e seu visualizador, mantendo a edição extra como fonte distinta.

## Contrato

`registry/contracts/PublicationRegistry.sol` é um arquivo único para Remix.
Compile com Solidity **0.8.30**, EVM **Paris**, `viaIR` desligado. A aplicação
reproduz e aceita o mesmo fonte com otimização desligada ou habilitada em 200 runs.

Construtor:

- `authorizedWriter`: endereço autorizado a enviar registros.
- `trustedVerifier`: endereço público exibido pelo setup local.

Após publicar, preencha `contract` e `deploymentBlock` em
`registry/state/publication-config.json`, preservando os campos gerados pelo setup.
Valide o contrato pela interface antes de escrever. O aplicativo e o lote desta
versão usam o writer de referência; para outra implantação, revise explicitamente
`WRITER`, `TARGET` e a configuração pública correspondente.

Leituras públicas:

- `hashAlgorithm()` retorna `SHA-256`.
- `getRecord(sourceId, editionDate)` retorna o primeiro registro da URL/edição.
- `getVersion(sourceId, editionDate, documentHash)` retorna o primeiro registro
  de uma versão do conteúdo.
- `firstDigestRegisteredAt(documentHash)` retorna a primeira inclusão do digest.
- `sourceCount(editionDate)` e `sourceAt(editionDate, index)` enumeram as fontes.

Uma nova observação ou versão não sobrescreve a primeira data da URL/edição.
O código da edição é um inteiro `YYYYMMDD`. A data declarada de publicação pode
ser posterior à data de disponibilização no calendário, inclusive em fins de semana.

## Limites de confiança

O contrato verifica uma assinatura do verificador, não verifica TLSNotary dentro
da EVM. Notary e verificador locais são uma hipótese de confiança explícita.
O certificado TLS isolado não prova que um PDF estava publicado numa data passada.
A sessão autenticada observa o conteúdo no momento da coleta; o timestamp do
bloco demonstra quando ele foi registrado neste contrato.

O fluxo é limitado ao host oficial `doe.tce.sp.gov.br`, PDFs suportados pelo parser,
ETag forte, tamanho máximo configurado e janelas de coleta/atestação. Falhas de
integridade, datas ambíguas ou divergentes e provas expiradas impedem o registro.

## Persistir e verificar

`state/evidence/<hash>/` conserva PDF, manifesto, calendário e apresentações de
cada trecho. O manifesto é vinculado ao `evidenceHash` do contrato. Os arquivos
não são servidos por caminho arbitrário; downloads passam pelas rotas validadas.

Para validar um job recente em uma EVM Anvil efêmera, sem escrever na RBB:

```sh
cd registry
node scripts/check-live-publication.mjs /caminho/para/job.json
```

Esse comando depende das evidências e das chaves locais correspondentes ao job;
não é necessário para consultar a implantação pública. Consulte também o
[arquivo de declarações](DECLARATIONS.md) e o [executor de lotes](BATCH.md).
