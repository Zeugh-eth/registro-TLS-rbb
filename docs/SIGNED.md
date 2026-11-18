# Respostas assinadas pelo servidor (RFC 9421)

Modo alternativo ao TLSNotary, para fontes que cooperam: o próprio servidor
assina cada resposta com uma chave Ed25519 publicada no domínio. Não há notary.
Guia de instalação para outra organização: [AGENT_INSTALL.md](AGENT_INSTALL.md).

## O que é provado

> O detentor da chave de `<domínio>` assinou os bytes com SHA-256 `H` em `<caminho>`
> depois do bloco N da RBB e antes do bloco M da RBB.

- **Depois de N**: a requisição envia o hash do bloco N da RBB como `nonce`; o
  servidor o inclui no que assina. O contrato confere `blockhash(N)` no registro,
  então N precisa ter no máximo 256 blocos (cerca de 17 minutos na testnet).
- **Antes de M**: a transação `recordObservation` entra no bloco M.
- **Mesmo documento**: `sha256(PDF)` = `Content-Digest` assinado. A assinatura
  PAdES/ICP-Brasil do próprio PDF continua indicando a autoria.
- O relógio do servidor (`created`) é informativo e não entra no intervalo.

## Componentes

| Caminho | Papel |
| --- | --- |
| `signed-origin/server.mjs` | Servidor de exemplo (Node) que assina `/publicacoes/<nome>.pdf` e publica `/.well-known/publication-key.json` |
| `registry/contracts/SignedPublicationRegistry.sol` | Registro na RBB: chaves por domínio e observações por URL |
| `registry/scripts/signed-observe.mjs` | Observador: busca o nonce, baixa, verifica, guarda a evidência e registra |
| `registry/relayer/server.mjs` | Relayer de referência: carteira permissionada que registra para quem tem chave de API |
| `registry/scripts/signed-verify.mjs` | Verificação completa (assinatura, hashes, blocos N e M, chave) |
| `registry/verifier/server.mjs` | Site local de verificação e explicação, com proxy RPC somente leitura |
| `signed-origin/site/` | Páginas estáticas: explicação (`index.html`, `relayer.html`) e consulta por URL (`verificar/`) |

## Assinatura do servidor

Texto assinado (signature base, RFC 9421):

```
"@authority";req: apolinar.io
"@path";req: /publicacoes/diario-teste.pdf
"content-digest": sha-256=:VuSgsA9HJKmu4adIXgxJv5IKFYxxUooMhiBqR0IqZEQ=:
"@signature-params": ("@authority";req "@path";req "content-digest");created=…;nonce="0x<bloco N>";keyid="…";alg="ed25519"
```

A resposta traz `Content-Digest`, `Signature-Input` e `Signature`, com
`Cache-Control: no-store, no-transform`, `Accept-Ranges: none` e CORS expondo os
cabeçalhos de assinatura. O servidor de exemplo gera a chave na primeira execução
(`signed-origin/state/ed25519.pem`, modo 0600):

```sh
cd signed-origin
PUBLICATION_AUTHORITIES=exemplo.gov.br PUBLICATION_KEY_ID=exemplo-2026-1 node server.mjs
```

| Variável | Padrão |
| --- | --- |
| `PORT`, `HOST` | `8791`, `127.0.0.1` |
| `PUBLICATION_DOCUMENTS` | `signed-origin/documentos` |
| `PUBLICATION_PREFIX` | `/publicacoes/` |
| `PUBLICATION_KEY_FILE` | `signed-origin/state/ed25519.pem` |
| `PUBLICATION_KEY_ID` | `publication-1` |
| `PUBLICATION_AUTHORITIES` | `localhost:<porta>,127.0.0.1:<porta>`; em produção, o domínio público |

Atrás de um proxy reverso, o proxy deve preservar `Host` e não recomprimir nem
armazenar em cache as respostas.

## Contrato

Solidity 0.8.30, EVM Paris.

- `registerKey(authority, keyId, fingerprint)`: SHA-256 da chave pública do domínio.
- `recordObservation(sourceURL, documentHash, evidenceHash, nonceBlockNumber, nonceBlockHash, keyFingerprint)`:
  exige URL `https://`, chave registrada para o domínio e, com nonce da mesma rede, `blockhash` correto.
- Leituras: `observationCount`, `observationAt`, `firstSeen`, `evidenceRegisteredAt`, `keyRegisteredAt`.

A assinatura Ed25519 é verificada fora da cadeia (não há pré-compilado na EVM Paris).
Só o `writer` do construtor grava.

## Dois modos de registro

### Direto

O observador tem a própria conta autorizada na RBB e é o `writer` do contrato.

```sh
cd registry
npm run signed:deploy
npm run signed:observe -- https://exemplo.gov.br/publicacoes/diario.pdf
```

`signed:deploy` cria `state/signed/writer.key` e `state/signed/config.json`. Sem
autorização da governança da RBB, a rede responde
`Sender account not authorized to send transactions`.

### Intermediado (relayer)

Um provedor permissionado (por exemplo, a Plexos) detém a
carteira e oferece uma chave de API. O observador não grava na RBB.

Operador do relayer:

```sh
cd registry
npm run signed:deploy
npm run relayer -- add-key observador-1
npm run relayer
```

`add-key` mostra a chave uma única vez e guarda apenas o SHA-256 em
`state/signed/relayer-keys.json`. Reinicie o relayer depois de criar chaves.

Observador, em `state/signed/config.json`:

```json
{
  "contract": "0x…",
  "recorder": { "mode": "relayer", "url": "https://relayer.exemplo/", "apiKeyFile": "/caminho/privado/api.key" }
}
```

`POST /v1/observations` recebe os bytes exatos de `bundle.json`
(`Authorization: Bearer rbbk_…`). Antes de gravar, o relayer verifica a
assinatura do servidor, confere que o nonce é um bloco canônico recente e, na
primeira observação de um domínio, compara a chave com a publicada no próprio
domínio. Devolve o `anchor.json`. `GET /v1/health` informa rede, contrato e writer.

Esta é a API do relayer de referência. A API de um provedor real pode ser outra;
nesse caso, adapte o trecho `recorder.mode === 'relayer'` de `signed-observe.mjs`.
Se o provedor só grava hashes no próprio contrato, registre `evidenceHash` lá; a
prova continua válida, mas a checagem de `blockhash(N)` passa a ser só fora da
cadeia e a consulta por URL precisa de um índice próprio.

O relayer não consegue forjar conteúdo, antedatar observações nem alterar
evidências. Ele pode recusar ou atrasar registros, e todos os registros aparecem
na RBB com a carteira dele. O vínculo chave–domínio é público (eventos
`KeyRegistered`) e verificável enquanto o domínio publicar a chave; para que
continue verificável após uma troca de chave, o domínio pode assinar o arquivo da
chave com seu certificado ICP-Brasil (e-CNPJ).

## Publicar e verificar

Com `publish` em `state/signed/config.json`, `--publish` envia a pasta da
evidência e atualiza `index.json`:

```json
"publish": {
  "ftpURL": "ftp://host/caminho/evidencias/",
  "netrc": "/caminho/privado/ftp.netrc",
  "publicBaseURL": "https://exemplo.gov.br/publicacoes/evidencias/"
}
```

Verificação completa:

```sh
npm run signed:verify -- https://exemplo.gov.br/publicacoes/evidencias/<hash>/
```

Site local, com as mesmas páginas e um proxy RPC somente leitura:

```sh
npm run verifier
```

Abre `http://127.0.0.1:8790/publicacoes/` (explicação), `relayer.html` e
`verificar/` (colar uma URL e verificar todas as observações). As páginas leem
`config.json`; o servidor local o gera a partir de `state/signed/config.json`
(`site.sampleURL`, `publish.publicBaseURL`). Uma página HTTPS não alcança o RPC
HTTP da RBB; para hospedar a verificação, sirva um proxy somente leitura com
HTTPS e aponte `rpc` do `config.json` para ele.

Cada observação é uma amostra: prova que a URL estava no ar naquele momento, não
continuamente entre amostras.
