# Instalação para outra organização (guia para agentes)

Roteiro para um agente de código instalar a prova de publicação assinada
([SIGNED.md](SIGNED.md)) para uma organização. Siga em ordem, confirme cada
verificação e pare para perguntar quando um passo depender de decisão ou
credencial do usuário.

## 0. Perguntar antes de começar

1. **Papel da organização**: publica os documentos (servidor que assina), observa
   e registra, ou ambos?
2. **Modo de registro**: conta própria autorizada na RBB (**direto**) ou chave de
   API de um provedor permissionado (**relayer**, por exemplo a Plexos)?
3. **Rede**: testnet (`648629`) ou produção. Peça o RPC e confirme que a máquina
   de registro alcança esse RPC (provedores de hospedagem compartilhada costumam
   bloquear a porta 8545).
4. **Onde publicar a evidência** (`bundle.json`, PDF, `anchor.json`): precisa ser
   público e durável.
5. **URL(s) a observar** e frequência.

Nunca peça para colar chaves privadas ou de API no chat; peça que o usuário as
coloque nos arquivos indicados.

## 1. Preparar o repositório

```sh
git clone https://github.com/Zeugh-eth/registro-TLS-rbb.git
cd registro-TLS-rbb/registry
npm ci
npm run build
node --test test/signed-response.test.mjs
```

Os testes precisam de `anvil` (Foundry) no PATH e devem passar antes de seguir.

## 2. Servidor que assina (se a organização publica)

Opção A, servidor de exemplo:

```sh
cd signed-origin
PUBLICATION_AUTHORITIES=<domínio> PUBLICATION_KEY_ID=<org>-<ano>-1 \
PUBLICATION_DOCUMENTS=/caminho/dos/pdfs node server.mjs
```

Opção B, integrar ao servidor existente: para cada `GET` de PDF, calcular
`Content-Digest`, ler o `nonce` de `Accept-Signature`, montar o texto de quatro
linhas e assinar com Ed25519 (ver `signResponse` em
`registry/lib/signed-response.mjs` e o exemplo em SIGNED.md). Publicar a chave
pública em `https://<domínio>/.well-known/publication-key.json` (JWKS com `kid`).

Requisitos que costumam falhar atrás de CDN ou proxy:

- `Host` preservado; sem recompressão (`Cache-Control: no-store, no-transform`).
- CORS: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Accept-Signature`,
  `Access-Control-Expose-Headers: Content-Digest, Signature-Input, Signature`,
  inclusive no arquivo `/.well-known/publication-key.json`.
- Chave secreta fora da raiz pública, modo 0600, gerada no próprio servidor.

Verificação:

```sh
curl -sD - -o /tmp/doc.pdf -H 'Accept-Encoding: identity' \
  -H 'Accept-Signature: sig1=("@authority";req "@path";req "content-digest");nonce="0x'$(openssl rand -hex 32)'"' \
  https://<domínio>/publicacoes/<arquivo>.pdf | grep -iE 'content-digest|signature'
```

Os três cabeçalhos devem aparecer, o nonce deve voltar dentro de
`Signature-Input`, e `cf-cache-status` (ou equivalente) não pode ser `HIT`.

## 3. Contrato e registro

### Modo direto

1. `npm run signed:deploy` cria `state/signed/writer.key` e mostra o endereço.
2. Se a rede responder `Sender account not authorized`, o usuário precisa pedir a
   autorização desse endereço à governança da RBB. O endereço pode ser
   compartilhado; `writer.key` não.
3. Rode de novo após a autorização. O resultado fica em `state/signed/config.json`.

### Modo relayer

- **Provedor real**: obtenha a documentação da API. Se ela aceitar chamadas ao
  contrato, o contrato precisa ter o endereço do provedor como `writer`. Se ela
  só grava hashes, registre `evidenceHash` (ver SIGNED.md). Adapte o trecho
  `recorder.mode === 'relayer'` de `scripts/signed-observe.mjs` sem inventar
  endpoints.
- **Relayer de referência** (operado por quem tem a conta autorizada):
  `npm run signed:deploy`, `npm run relayer -- add-key <observador>`,
  `npm run relayer`. Exponha-o com HTTPS.
- No observador, configure `recorder` e `contract` em `state/signed/config.json`
  e coloque a chave de API em um arquivo 0600 referenciado por `apiKeyFile`.

## 4. Primeira observação

```sh
npm run signed:observe -- https://<domínio>/publicacoes/<arquivo>.pdf
npm run signed:verify -- state/signed/evidence/<hash>
```

O verificador deve retornar `"ok": true`, `"anchored": true` e um intervalo de
poucos segundos entre `notBeforeISO` e `notAfterISO`. Depois configure `publish`
e use `--publish`; verifique pela URL pública da evidência.

## 5. Site de verificação

`npm run verifier` serve as páginas localmente com proxy RPC. Para hospedar,
copie `signed-origin/site/` e `node_modules/ethers/dist/ethers.min.js`
(para `verificar/`), publique um `config.json` com:

```json
{
  "chainId": 648629,
  "contract": "0x…",
  "writer": "0x…",
  "networkLabel": "RBB testnet",
  "rpc": "<URL HTTPS de um proxy RPC somente leitura>",
  "rpcUpstream": "<RPC da RBB>",
  "sampleURL": "https://<domínio>/publicacoes/<arquivo>.pdf",
  "publicEvidenceURL": "https://<domínio>/publicacoes/evidencias/"
}
```

O proxy deve aceitar só métodos de leitura (lista em `registry/verifier/server.mjs`).

## 6. Agendamento

Cada execução é uma amostra. Agende `signed:observe --publish` numa máquina sempre
ligada, com novas tentativas espaçadas (o RPC pode falhar) e alerta em caso de
erro. Observadores independentes da organização que publica fortalecem a prova de
disponibilidade pública.

## Checklist final

- [ ] Testes passam.
- [ ] Resposta assinada com nonce, sem cache nem recompressão.
- [ ] Chave pública com CORS; chave secreta fora da raiz pública.
- [ ] Contrato publicado; chave registrada; primeira observação ancorada.
- [ ] `signed:verify` pela URL pública retorna `ok`.
- [ ] Nenhuma chave (`writer.key`, chave de API, chave do servidor, credenciais de
      publicação) dentro do Git.
