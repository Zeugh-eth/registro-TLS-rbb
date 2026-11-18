import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOT, WRITER, CHAIN_ID, GENESIS } from './lib/chain.mjs';
import { publicationConfig, inspectLink, startProof, getJob, attestEvidence, listPublications, downloadEvidence } from './lib/publication.mjs';

import { createDeclarationArchive } from './lib/declarations.mjs';

export function createServer({ archive = createDeclarationArchive() } = {}) {
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
    function reply(code, body) { res.writeHead(code, headers); res.end(JSON.stringify(body)); }
    if (req.headers.host !== new URL(origin).host) return reply(403, { error: 'Origem não autorizada.' });
    const url = new URL(req.url, origin);
    // Opening the public page from another app/site is navigation, not an API request.
    const publicNavigation = req.method === 'GET' && ['/', '/hash', '/declaracoes'].includes(url.pathname) &&
      req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (!publicNavigation && ((req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site')) return reply(403, { error: 'Origem não autorizada.' });
    const files = {
      '/': ['public/publication.html', 'text/html; charset=utf-8'],
      '/hash': ['public/index.html', 'text/html; charset=utf-8'],
      '/declaracoes': ['public/declarations.html', 'text/html; charset=utf-8'],
      '/declarations.js': ['public/declarations.js', 'text/javascript'],
      '/declarations.css': ['public/declarations.css', 'text/css'],
      '/publication.js': ['public/publication.js', 'text/javascript'],
      '/publication-wallet.js': ['public/publication-wallet.js', 'text/javascript'],
      '/tce-input.js': ['public/tce-input.js', 'text/javascript'],
      '/publication.css': ['public/publication.css', 'text/css'],
      '/publication-contract.json': ['build/PublicationRegistry.json', 'application/json'],
      '/PublicationRegistry.sol': ['contracts/PublicationRegistry.sol', 'text/plain; charset=utf-8'],
      '/app.js': ['public/app.js', 'text/javascript'],
      '/wallet.js': ['public/wallet.js', 'text/javascript'],
      '/hashing.js': ['public/hashing.js', 'text/javascript'],
      '/ethers.js': ['public/ethers.js', 'text/javascript'],
      '/style.css': ['public/style.css', 'text/css'],
      '/contract.json': ['build/DocumentRegistry.json', 'application/json'],
      '/DocumentRegistry.sol': ['contracts/DocumentRegistry.sol', 'text/plain; charset=utf-8']
    };
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      headers['Content-Type'] = type;
      if (!fs.existsSync(ROOT + file)) return reply(503, { error: 'Execute npm run build.' });
      res.writeHead(200, headers); res.end(fs.readFileSync(ROOT + file)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return reply(200, {
      writer: WRITER, chainId: CHAIN_ID, genesis: GENESIS,
      rpcUrl: 'http://52.87.7.52:8545', mode: 'metamask', serverSigning: false
    });
    try {
      if (req.method === 'GET' && url.pathname === '/api/declarations') return reply(200, await archive.list());
      if (req.method === 'POST' && url.pathname === '/api/declarations/sync') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return reply(415, { error: 'Envie JSON.' });
        req.resume(); await archive.sync(); return reply(200, await archive.list());
      }
      if (req.method === 'GET' && url.pathname === '/api/declarations/export.json') {
        headers['Content-Disposition'] = 'attachment; filename="declaracoes-rbb.json"';
        return reply(200, await archive.exportJSON());
      }
      if (req.method === 'GET' && url.pathname === '/api/declarations/export.csv') {
        headers['Content-Type'] = 'text/csv; charset=utf-8'; headers['Content-Disposition'] = 'attachment; filename="declaracoes-rbb.csv"';
        const csv = await archive.exportCSV(); res.writeHead(200, headers); res.end(csv); return;
      }
      const declaration = /^\/api\/declarations\/(0x[0-9a-f]{64})(?:\/(export|pdf|calendar|pdf-\d{1,3}))?$/.exec(url.pathname);
      if (req.method === 'GET' && declaration) {
        const [, id, part] = declaration;
        if (!part || part === 'export') {
          if (part) headers['Content-Disposition'] = 'attachment; filename="declaracao-'+id.slice(2,14)+'.json"';
          return reply(200, await archive.detail(id));
        }
        const file = await archive.attachment(id, part === 'pdf' ? 'document.pdf' : part + '.tlsn');
        headers['Content-Type'] = file.contentType; headers['Content-Disposition'] = 'attachment; filename="'+file.name+'"';
        res.writeHead(200, headers); res.end(file.bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/publication/config') return reply(200, await publicationConfig());
      if (req.method === 'GET' && /^\/api\/publication\/jobs\/[0-9a-f-]{36}$/.test(url.pathname)) return reply(200,await getJob(url.pathname.split('/').pop()));
      if (req.method === 'GET' && /^\/api\/publication\/evidence\/0x[0-9a-f]{64}$/.test(url.pathname)) {
        const hash = url.pathname.split('/').pop();
        headers['Content-Disposition'] = 'attachment; filename="publication-'+hash.slice(2,14)+'.json"';
        return reply(200,await downloadEvidence(hash));
      }
      const actions = {'/api/publication/inspect':inspectLink,'/api/publication/prove':startProof,
        '/api/publication/attest':attestEvidence,'/api/publication/read':archive.readPublication,'/api/publication/list':listPublications};
      if (req.method === 'POST' && Object.hasOwn(actions,url.pathname)) {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return reply(415,{error:'Envie JSON.'});
        let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw)>8192) throw new Error('Requisição excessiva.'); }
        const input = JSON.parse(raw);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Entrada inválida.');
        return reply(200,await actions[url.pathname](input));
      }
    } catch (error) { return reply(error.code === 'RPC_UNAVAILABLE' ? 503 : 400,{code:error.code === 'RPC_UNAVAILABLE' ? error.code : undefined,error:error.code === 'ENOENT' ? 'Prova ou configuração não encontrada.' : String(error.message).slice(0,300)}); }
    // Blockchain transaction signing and broadcasting are exclusively handled by the browser wallet.
    if (req.method !== 'GET') return reply(405, { error: 'Use MetaMask to sign in your browser.' });
    return reply(404, { error: 'Não encontrado.' });
  });
  server.declarationArchive = archive;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const server = createServer();
    const port = Number(process.env.PORT || 8787);
    server.listen(port, '127.0.0.1', () => { server.declarationArchive.start(); console.log(`Registro RBB: http://127.0.0.1:${port} (MetaMask; no server signing)`); });
    const stop = () => { server.declarationArchive.stop(); server.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch { console.error('Não foi possível iniciar. Verifique a configuração e a correspondência da carteira.'); process.exitCode = 1; }
}
