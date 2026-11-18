import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const SCHEMA = 'rbb-signed-response/v1';
export const COMPONENTS = '("@authority";req "@path";req "content-digest")';
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const RBB_NONCE_SOURCE = Object.freeze({
  name: 'rbb-testnet', chainId: 648629, rpcUrl: 'http://52.87.7.52:8545', confirmations: 1
});
export const ETHEREUM_NONCE_SOURCE = Object.freeze({
  name: 'ethereum-mainnet', chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com', confirmations: 3
});
export const DEFAULT_NONCE_SOURCE = RBB_NONCE_SOURCE;

export const sha256Hex = bytes => '0x' + createHash('sha256').update(bytes).digest('hex');
export const contentDigest = bytes => 'sha-256=:' + createHash('sha256').update(bytes).digest('base64') + ':';

export function parseSignatureInput(value) {
  const match = /^sig1=(\([^()]*\))((?:;[a-z]+=(?:"[^"\\]*"|\d+))*)$/.exec(value || '');
  if (!match) throw new Error('Signature-Input inválido.');
  const params = {};
  for (const [, name, text, number] of match[2].matchAll(/;([a-z]+)=(?:"([^"\\]*)"|(\d+))/g)) {
    if (Object.hasOwn(params, name)) throw new Error('Parâmetro de assinatura repetido.');
    params[name] = text ?? Number(number);
  }
  return { components: match[1], params, serialized: match[1] + match[2] };
}

export function parseSignature(value) {
  const match = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(value || '');
  if (!match) throw new Error('Signature inválido.');
  return Buffer.from(match[1], 'base64');
}

export function signatureBase({ authority, path, digest, serializedParams }) {
  return `"@authority";req: ${authority}\n"@path";req: ${path}\n"content-digest": ${digest}\n"@signature-params": ${serializedParams}`;
}

export function publicKeyFromJwk(jwk) {
  if (jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('Chave pública não é Ed25519.');
  if (Buffer.from(jwk.x, 'base64url').length !== 32) throw new Error('Chave pública Ed25519 inválida.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
}

export const jwkFingerprint = jwk => {
  publicKeyFromJwk(jwk);
  return sha256Hex(Buffer.from(jwk.x, 'base64url'));
};

export function keyURLFor(sourceURL) {
  return new URL('/.well-known/publication-key.json', sourceURL).href;
}

async function rpc(url, method, params, fetcher, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetcher(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`RPC do nonce respondeu HTTP ${response.status}.`);
      const body = await response.json();
      if (body.error || !Object.hasOwn(body, 'result')) throw Object.assign(new Error('RPC do nonce devolveu erro.'), { final: true });
      return body.result;
    } catch (error) {
      if (error.final || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

export async function fetchNonce(source = DEFAULT_NONCE_SOURCE, fetcher = globalThis.fetch) {
  const chainId = Number(BigInt(await rpc(source.rpcUrl, 'eth_chainId', [], fetcher)));
  if (chainId !== source.chainId) throw new Error('RPC do nonce está em outra rede.');
  const latest = Number(BigInt(await rpc(source.rpcUrl, 'eth_blockNumber', [], fetcher)));
  const blockNumber = latest - (source.confirmations ?? 0);
  const block = await rpc(source.rpcUrl, 'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false], fetcher);
  if (!block || !/^0x[0-9a-f]{64}$/.test(block.hash)) throw new Error('Bloco do nonce inválido.');
  return { source: source.name, chainId, blockNumber, blockHash: block.hash, blockTimestamp: Number(BigInt(block.timestamp)) };
}

export async function checkNonce(nonce, source = DEFAULT_NONCE_SOURCE, fetcher = globalThis.fetch) {
  if (nonce.chainId !== source.chainId) throw new Error('Nonce de outra rede.');
  const chainId = Number(BigInt(await rpc(source.rpcUrl, 'eth_chainId', [], fetcher)));
  if (chainId !== source.chainId) throw new Error('RPC do nonce está em outra rede.');
  const block = await rpc(source.rpcUrl, 'eth_getBlockByNumber', ['0x' + nonce.blockNumber.toString(16), false], fetcher);
  if (block?.hash !== nonce.blockHash) throw new Error('O hash do nonce não é o bloco canônico desse número.');
  const timestamp = Number(BigInt(block.timestamp));
  if (timestamp !== nonce.blockTimestamp) throw new Error('Timestamp do bloco do nonce diverge.');
  return { blockNumber: nonce.blockNumber, blockHash: block.hash, timestamp };
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error('Documento grande demais.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Documento grande demais.');
  return bytes;
}

export async function fetchKey(keyURL, keyId, fetcher = globalThis.fetch) {
  const response = await fetcher(keyURL, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Chave pública indisponível (HTTP ${response.status}).`);
  const set = JSON.parse((await readLimited(response)).toString('utf8'));
  const jwk = (set.keys || []).find(key => key.kid === keyId);
  if (!jwk) throw new Error('A chave usada na assinatura não está publicada pelo domínio.');
  const { kty, crv, x, kid } = jwk;
  return { kty, crv, x, kid };
}

export async function observe(sourceURL, { nonceSource = DEFAULT_NONCE_SOURCE, fetcher = globalThis.fetch,
  nonceFetcher = fetcher, keyURL = keyURLFor(sourceURL), allowInsecure = false, now = () => new Date() } = {}) {
  const url = new URL(sourceURL);
  if (url.protocol !== 'https:' && !allowInsecure) throw new Error('A URL precisa usar HTTPS.');
  if (url.search || url.hash || url.username || url.password) throw new Error('Use uma URL sem query, fragmento ou credenciais.');
  const nonce = await fetchNonce(nonceSource, nonceFetcher);
  const acceptSignature = `sig1=${COMPONENTS};nonce="${nonce.blockHash}"`;
  const response = await fetcher(url.href, {
    redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'Accept-Signature': acceptSignature, 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }
  });
  if (response.status !== 200) throw new Error(`A URL respondeu HTTP ${response.status}.`);
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') throw new Error('Resposta com codificação de conteúdo; o digest não seria comparável.');
  const body = await readLimited(response);
  const signatureInput = response.headers.get('signature-input');
  const { params } = parseSignatureInput(signatureInput);
  const jwk = await fetchKey(keyURL, params.keyid, fetcher);
  const bundle = {
    schema: SCHEMA,
    sourceURL: url.href,
    authority: url.host,
    path: url.pathname,
    nonce,
    request: { method: 'GET', acceptSignature },
    response: {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentDigest: response.headers.get('content-digest'),
      signatureInput,
      signature: response.headers.get('signature')
    },
    document: { sha256: sha256Hex(body), size: body.length },
    key: { url: keyURL, jwk, fingerprint: jwkFingerprint(jwk) },
    fetchedAt: now().toISOString()
  };
  const offline = verifyBundle(bundle, body);
  return { bundle, body, offline };
}

export function verifyBundleSignature(bundle) {
  if (bundle?.schema !== SCHEMA) throw new Error('Formato de evidência desconhecido.');
  const url = new URL(bundle.sourceURL);
  if (bundle.authority !== url.host || bundle.path !== url.pathname) throw new Error('Domínio ou caminho divergem da URL.');
  const digest = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/.exec(bundle.response?.contentDigest || '');
  if (!digest || '0x' + Buffer.from(digest[1], 'base64').toString('hex') !== bundle.document?.sha256) throw new Error('Content-Digest não corresponde ao hash do documento.');
  const input = parseSignatureInput(bundle.response.signatureInput);
  if (input.components !== COMPONENTS) throw new Error('A assinatura não cobre domínio, caminho e digest.');
  const { alg, keyid, nonce, created } = input.params;
  if (alg !== 'ed25519') throw new Error('Algoritmo de assinatura não suportado.');
  if (!Number.isSafeInteger(created)) throw new Error('Parâmetro created ausente.');
  if (nonce !== bundle.nonce.blockHash) throw new Error('A assinatura não contém o nonce do bloco.');
  if (bundle.request.acceptSignature !== `sig1=${COMPONENTS};nonce="${bundle.nonce.blockHash}"`) throw new Error('Requisição diverge do nonce.');
  if (keyid !== bundle.key.jwk.kid) throw new Error('Identificador da chave diverge.');
  if (jwkFingerprint(bundle.key.jwk) !== bundle.key.fingerprint) throw new Error('Impressão digital da chave diverge.');
  const base = signatureBase({ authority: url.host, path: url.pathname, digest: bundle.response.contentDigest, serializedParams: input.serialized });
  const ok = verify(null, Buffer.from(base), publicKeyFromJwk(bundle.key.jwk), parseSignature(bundle.response.signature));
  if (!ok) throw new Error('Assinatura do servidor inválida.');
  return { sourceURL: url.href, authority: url.host, documentHash: bundle.document.sha256, keyId: keyid,
    keyFingerprint: bundle.key.fingerprint, nonceBlockNumber: bundle.nonce.blockNumber, nonceBlockHash: nonce, serverCreated: created };
}

export function verifyBundle(bundle, body) {
  if (sha256Hex(body) !== bundle?.document?.sha256 || body.length !== bundle.document.size) throw new Error('O documento não corresponde ao hash da evidência.');
  if (bundle.response.contentDigest !== contentDigest(body)) throw new Error('Content-Digest não corresponde ao documento.');
  return verifyBundleSignature(bundle);
}

export function parseNonce(acceptSignature) {
  const match = /(?:^|;)\s*nonce="(0x[0-9a-f]{64})"/.exec(acceptSignature || '');
  return match ? match[1] : null;
}

export function signResponse({ authority, path, body, nonce, keyId, privateKey, created = Math.floor(Date.now() / 1000) }) {
  const digest = contentDigest(body);
  const serializedParams = `${COMPONENTS};created=${created}${nonce ? `;nonce="${nonce}"` : ''};keyid="${keyId}";alg="ed25519"`;
  const signature = sign(null, Buffer.from(signatureBase({ authority, path, digest, serializedParams })), privateKey).toString('base64');
  return { 'Content-Digest': digest, 'Signature-Input': 'sig1=' + serializedParams, 'Signature': `sig1=:${signature}:` };
}

export function publicJwk(privateKey, keyId) {
  const { kty, crv, x } = createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty, crv, x, kid: keyId, alg: 'EdDSA', use: 'sig' };
}
