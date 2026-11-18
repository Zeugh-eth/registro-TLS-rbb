import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { signResponse, publicJwk, parseNonce } from '../registry/lib/signed-response.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const DOCUMENTS = path.resolve(process.env.PUBLICATION_DOCUMENTS || HERE + 'documentos');
const PREFIX = process.env.PUBLICATION_PREFIX || '/publicacoes/';
const KEY_FILE = path.resolve(process.env.PUBLICATION_KEY_FILE || HERE + 'state/ed25519.pem');
const KEY_ID = process.env.PUBLICATION_KEY_ID || 'publication-1';
const AUTHORITIES = new Set((process.env.PUBLICATION_AUTHORITIES || `localhost:${PORT},127.0.0.1:${PORT}`).split(',').map(a => a.trim().toLowerCase()));
const NAME = /^[a-z0-9][a-z0-9._-]{0,100}\.pdf$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Accept-Signature',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Digest, Signature-Input, Signature, Content-Length'
};

export function createSigner({ privateKey, keyId = KEY_ID, documents = DOCUMENTS, prefix = PREFIX, authorities = AUTHORITIES }) {
  const jwks = JSON.stringify({ keys: [publicJwk(privateKey, keyId)] }) + '\n';
  return http.createServer(async (req, res) => {
    const end = (status, headers, body) => { res.writeHead(status, { ...CORS, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(req.method === 'HEAD' ? undefined : body); };
    try {
      if (req.method === 'OPTIONS') return end(204, { 'Access-Control-Max-Age': '600' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, { 'Content-Type': 'text/plain' }, 'method not allowed\n');
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/.well-known/publication-key.json') return end(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, jwks);
      const authority = String(req.headers.host || '').toLowerCase();
      if (!authorities.has(authority)) return end(400, { 'Content-Type': 'text/plain' }, 'unknown host\n');
      const name = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
      if (!NAME.test(name)) return end(404, { 'Content-Type': 'text/plain' }, 'not found\n');
      let body;
      try { body = await fs.readFile(path.join(documents, name)); } catch { return end(404, { 'Content-Type': 'text/plain' }, 'not found\n'); }
      const signature = signResponse({ authority, path: pathname, body, nonce: parseNonce(req.headers['accept-signature']), keyId, privateKey });
      return end(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(body.length), ...signature,
        'Cache-Control': 'no-store, no-transform', 'Accept-Ranges': 'none', 'Vary': 'Accept-Signature' }, body);
    } catch { return end(500, { 'Content-Type': 'text/plain' }, 'internal error\n'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createSigner({ privateKey: await loadPrivateKey(KEY_FILE) });
  server.listen(PORT, HOST, () => console.log(`signer: http://${HOST}:${PORT}${PREFIX}<arquivo>.pdf · chave em /.well-known/publication-key.json`));
}

export async function loadPrivateKey(file) {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    await fs.writeFile(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  }
  return createPrivateKey(await fs.readFile(file));
}
