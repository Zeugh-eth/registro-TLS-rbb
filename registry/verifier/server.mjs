import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGE = ROOT + '../signed-origin/site/verificar/index.html';
const EXPLAINER = ROOT + '../signed-origin/site/index.html';
const RELAYER = ROOT + '../signed-origin/site/relayer.html';
const ETHERS = ROOT + 'node_modules/ethers/dist/ethers.min.js';
const EVIDENCE = ROOT + 'state/signed/evidence/';
const UPSTREAM = process.env.RBB_RPC_URL || 'http://52.87.7.52:8545';
const STATE_CONFIG = ROOT + 'state/signed/config.json';
const PORT = Number(process.env.PORT || 8790);
async function siteConfig() {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(STATE_CONFIG, 'utf8')); } catch {}
  return { chainId: saved.chainId ?? 648629, contract: saved.contract ?? null, writer: saved.writer ?? null,
    networkLabel: saved.site?.networkLabel ?? 'RBB testnet', rpc: 'verificar/rpc', rpcUpstream: UPSTREAM,
    sampleURL: process.env.VERIFIER_SAMPLE_URL ?? saved.site?.sampleURL ?? null,
    publicEvidenceURL: saved.publish?.publicBaseURL ?? null };
}

const METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_call',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getCode', 'net_version']);
const TYPES = { '.json': 'application/json', '.pdf': 'application/pdf' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function readBody(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function rpc(req, res) {
  let request;
  try { request = JSON.parse(await readBody(req)); } catch { request = null; }
  const id = request?.id ?? null;
  const reply = (status, body) => send(res, status, JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  if (!request || Array.isArray(request)) return reply(400, { error: { code: -32600, message: 'single JSON-RPC request only' } });
  if (!METHODS.has(request.method) || !Array.isArray(request.params ?? [])) return reply(403, { error: { code: -32601, message: 'method not allowed' } });
  const params = request.params ?? [];
  if (request.method === 'eth_call' && params[1] === 'pending') params[1] = 'latest';
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: request.method, params });
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const upstream = await fetch(UPSTREAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(15000) });
      const decoded = await upstream.json();
      if (upstream.ok && decoded && ('result' in decoded || 'error' in decoded)) {
        const { jsonrpc, id: _, ...rest } = decoded;
        return reply(200, rest);
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
  }
  return reply(502, { error: { code: -32000, message: 'RBB RPC unavailable' } });
}

async function evidence(res, path) {
  const match = /^\/publicacoes\/evidencias\/(?:(index\.json)|([0-9a-f]{64})\/(bundle\.json|document\.pdf|anchor\.json|report\.json))$/.exec(path);
  if (!match) return send(res, 404, 'not found', 'text/plain');
  const [, index, hash, name] = match;
  const local = hash ? EVIDENCE + hash + '/' + name : null;
  if (local && existsSync(local)) return send(res, 200, await fs.readFile(local), TYPES[name.slice(name.lastIndexOf('.'))]);
  const mirror = (await siteConfig()).publicEvidenceURL;
  if (!mirror) return send(res, 404, 'not found', 'text/plain');
  try {
    const remote = await fetch(new URL(path.slice('/publicacoes/evidencias/'.length), mirror), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!remote.ok) return send(res, remote.status, 'not found', 'text/plain');
    return send(res, 200, Buffer.from(await remote.arrayBuffer()), TYPES[(index || name).slice((index || name).lastIndexOf('.'))]);
  } catch { return send(res, 502, 'evidence mirror unavailable', 'text/plain'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/' || pathname === '/publicacoes/verificar') {
      res.writeHead(302, { Location: '/publicacoes/verificar/' }); return res.end();
    }
    if (req.method === 'GET' && (pathname === '/publicacoes/verificar/' || pathname === '/publicacoes/verificar/index.html'))
      return send(res, 200, await fs.readFile(PAGE), 'text/html; charset=utf-8');
    if (req.method === 'GET' && (pathname === '/publicacoes/' || pathname === '/publicacoes/index.html'))
      return send(res, 200, await fs.readFile(EXPLAINER), 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/publicacoes/relayer.html')
      return send(res, 200, await fs.readFile(RELAYER), 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/publicacoes/verificar/ethers.min.js')
      return send(res, 200, await fs.readFile(ETHERS), 'text/javascript');
    if (req.method === 'GET' && pathname === '/publicacoes/config.json')
      return send(res, 200, JSON.stringify(await siteConfig(), null, 2));
    if (pathname === '/publicacoes/verificar/rpc')
      return req.method === 'POST' ? rpc(req, res) : send(res, 405, JSON.stringify({ error: 'POST only' }));
    if (req.method === 'GET' && pathname.startsWith('/publicacoes/evidencias/')) return evidence(res, pathname);
    send(res, 405, 'method not allowed', 'text/plain');
  } catch { send(res, 500, 'internal error', 'text/plain'); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`verifier: http://127.0.0.1:${PORT}/publicacoes/verificar/`));
