# Declarações e consultas preservadas

A subaba `/declaracoes` mostra lotes, progresso, falhas e declarações confirmadas.
Busca por URL/nome do PDF, transação, hash, data da edição ou lote. Não exige
conectar carteira. O indexador roda no servidor, inclusive com a página fechada.

## O que fica salvo

Todos os caminhos abaixo são relativos a `registry/` e ficam fora do Git:

| Caminho | Conteúdo |
| --- | --- |
| `state/declarations/index.json` | Catálogo, cursor e bloco de referência |
| `state/declarations/records/<txhash>.json` | Dossiê de cada transação confirmada |
| `state/declarations/status.json` | Última tentativa de sincronização e erro |
| `state/evidence/<evidenceHash>/` | PDF, manifesto e apresentações TLSNotary |
| `state/batches/<início>_<fim>/` | Inventário, progresso, transações e recibos |

O dossiê reúne URL canônica, `sourceId`, edição, publicação declarada, coleta,
inclusão, primeira data, SHA-256 do documento e evidência, transação, recibo,
rede/contrato, atestação e parâmetros de consulta. Cada parte da prova inclui hash
e intervalo de bytes. Downloads verificam a integridade contra o hash esperado.

A indexação exige rede, contrato, evento, recibo de sucesso e leitura coerentes.
Falhas de RPC preservam o último arquivo e são mostradas na interface. Mudanças
na cadeia exigem nova conferência; transações revertidas não são declarações.

Um clone do repositório pode reconstruir metadados da implantação pública, mas
os PDFs e provas não são recuperados da blockchain. Os pacotes precisam ser
preservados ou importados pelo operador. A interface distingue registro on-chain
de disponibilidade do arquivo local.

## APIs locais

| Método e rota | Resultado |
| --- | --- |
| `GET /api/declarations` | Índice, lotes, progresso e tempos medidos |
| `POST /api/declarations/sync` | Confere novamente na RBB; corpo JSON |
| `GET /api/declarations/export.json` | Dossiês e inventários dos lotes |
| `GET /api/declarations/export.csv` | Tabela de metadados |
| `GET /api/declarations/<txhash>` | Dossiê individual |
| `GET /api/declarations/<txhash>/export` | Download do dossiê JSON |
| `GET /api/declarations/<txhash>/pdf` | PDF preservado |
| `GET /api/declarations/<txhash>/calendar` | Apresentação do calendário |
| `GET /api/declarations/<txhash>/pdf-N` | Apresentação do trecho N, começando em 0 |
| `GET /api/publication/evidence/<evidenceHash>` | Pacote de evidência JSON/base64 |

`query.application`, presente no dossiê, pode ser enviado a
`POST /api/publication/read`. Exemplo de consulta à implantação pública:

```json
{
  "url": "https://doe.tce.sp.gov.br/pdf/2026/10/doe-tce-2026-10-14.pdf",
  "date": "2026-10-14",
  "contract": "0xdC0c47925AD2d85626027cE773A4db9d19Cac569"
}
```

A leitura retorna a primeira data da URL e edição. Não coleta o PDF novamente e
não assina transações.

- `verification.source: "rpc"`: resposta conferida agora no contrato;
  `verification.verifiedAt` informa quando essa consulta terminou.
- `verification.source: "archive"`: o RPC falhou e a resposta usa um primeiro
  registro confirmado anteriormente. O dossiê precisa pertencer à mesma rede,
  contrato, URL e edição, com integridade conferida. A interface mostra a origem
  local e a data da última conferência do índice na rede.
- Sem resposta do RPC e sem confirmação preservada, a API retorna HTTP 503,
  com `code: "RPC_UNAVAILABLE"`. Isso não indica ausência de registro.
- Uma consulta ao calendário pode retornar apenas as fontes já preservadas;
  nesse caso `verification.partial` é `true`. O link exato do PDF evita essa
  ambiguidade. O caminho do visualizador `/v/pdf/` identifica o mesmo PDF.
- Somente leituras RPC permitidas repetem falhas transitórias, até três tentativas.
  Envios de transação, métodos desconhecidos e lotes contendo escrita não são
  repetidos automaticamente. Uma reorganização detectada invalida o índice
  anterior antes da reconstrução, inclusive quando ela não consegue terminar.

`query.getRecord`, `query.getVersion` e
`query.firstDigestRegisteredAt` preservam os parâmetros para acesso direto ao
contrato; `hashAlgorithm` informa SHA-256.

JSON/CSV permitem consultar e arquivar metadados posteriormente. Para backup
completo do acervo público, preserve também os pacotes de evidência. Não inclua
`state/secrets/`, `state/notary.key` ou `state/verifier.key` nesses pacotes.
