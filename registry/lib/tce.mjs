import https from 'node:https';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TCE_ORIGIN, parseTceInput, calendarSources, editionDate } from '../public/tce-input.js';
export { parseTceInput, calendarSources };
export const runFile = promisify(execFile);
export const sha256 = bytes => '0x' + createHash('sha256').update(bytes).digest('hex');
export const MAX_PDF_BYTES = 8 * 1024 * 1024 - 65536;

export function parseHttpResponse(bytes, range = null) {
  const split = bytes.indexOf('\r\n\r\n');
  if (split < 0 || split > 65536) throw new Error('Cabeçalhos HTTP ausentes ou excessivos.');
  const lines = bytes.subarray(0, split).toString('latin1').split('\r\n');
  const status = lines.shift();
  if (!(range ? /^HTTP\/1\.[01] 206(?: |$)/ : /^HTTP\/1\.[01] 200(?: |$)/).test(status)) throw new Error('A fonte oficial retornou um status HTTP inesperado.');
  const headers = {};
  for (const line of lines) {
    const m = /^([!#$%&'*+.^_`|~0-9a-zA-Z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!m) throw new Error('Cabeçalho HTTP inválido.');
    const key = m[1].toLowerCase();
    if (key in headers && ['content-length','transfer-encoding','content-type','content-encoding','content-range'].includes(key)) throw new Error('Cabeçalho HTTP ambíguo.');
    headers[key] = m[2].trim();
  }
  if ((!range && headers['content-range']) || (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) throw new Error('Conteúdo parcial ou comprimido não aceito.');
  if (range && (headers['content-range'] !== `bytes ${range.start}-${range.end}/${range.total}` || headers.etag !== range.etag)) throw new Error('Trecho ou versão do PDF não corresponde ao esperado.');
  let body = bytes.subarray(split + 4);
  if (headers['transfer-encoding']) {
    if (headers['transfer-encoding'].toLowerCase() !== 'chunked' || headers['content-length']) throw new Error('Enquadramento HTTP ambíguo.');
    const chunks = []; let size = 0;
    for (;;) {
      const end = body.indexOf('\r\n');
      if (end < 1 || end > 16 || !/^[0-9a-f]+$/i.test(body.subarray(0, end).toString())) throw new Error('Chunk HTTP inválido.');
      const length = parseInt(body.subarray(0, end).toString(), 16);
      body = body.subarray(end + 2);
      if (length === 0) { if (!body.equals(Buffer.from('\r\n'))) throw new Error('Final HTTP inesperado.'); break; }
      size += length;
      if (size > MAX_PDF_BYTES || body.length < length + 2 || !body.subarray(length, length + 2).equals(Buffer.from('\r\n'))) throw new Error('Resposta HTTP truncada ou excessiva.');
      chunks.push(body.subarray(0, length)); body = body.subarray(length + 2);
    }
    body = Buffer.concat(chunks);
  } else if (headers['content-length'] && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) !== body.length)) {
    throw new Error('O corpo HTTP não corresponde ao tamanho declarado.');
  }
  if (body.length > MAX_PDF_BYTES) throw new Error('PDF acima do limite de coleta.');
  if (range && (body.length !== range.end-range.start+1 || !/^application\/pdf(?:;|$)/i.test(headers['content-type'] || ''))) throw new Error('Trecho truncado ou não identificado como PDF.');
  return { headers, body };
}

export function assertRequest(bytes, url, range = null) {
  const target = new URL(url);
  if (target.origin !== TCE_ORIGIN) throw new Error('Origem não autorizada.');
  const request = bytes.toString('ascii');
  const lines = request.split('\r\n');
  const hosts = lines.filter(line => /^host:/i.test(line));
  const ranges = lines.filter(line => /^range:/i.test(line));
  const conditions = lines.filter(line => /^if-match:/i.test(line));
  if (range ? (ranges.length !== 1 || ranges[0] !== `Range: bytes=${range.start}-${range.end}` || conditions.length !== 1 || conditions[0] !== `If-Match: ${range.etag}`) : ranges.length !== 0) throw new Error('Pedido de intervalo/versionamento inválido.');
  if (lines[0] !== `GET ${target.pathname} HTTP/1.1` || hosts.length !== 1 ||
      hosts[0].toLowerCase() !== 'host: doe.tce.sp.gov.br' || !request.endsWith('\r\n\r\n') ||
      request.indexOf('\r\n\r\n') !== request.length - 4) throw new Error('A prova não corresponde à URL solicitada.');
}

// Ordinary HTTPS inspection. This is explicitly NOT a TLSNotary proof.
export async function fetchOfficial(url) {
  const target = new URL(url);
  if (target.origin !== TCE_ORIGIN || target.search || target.username || target.password ||
      !/^\/(json\/file\/[0-9/]+|pdf\/[a-zA-Z0-9/_.-]+)$/.test(target.pathname)) throw new Error('URL não autorizada.');
  return new Promise((resolve, reject) => {
    const req = https.get(target, { minVersion:'TLSv1.2', maxVersion:'TLSv1.2',
      headers:{'Accept-Encoding':'identity','Connection':'close','User-Agent':'RBB-Publication-Prototype/1'} }, res => {
      const chunks = []; let size = 0;
      if (res.statusCode !== 200) { res.resume(); reject(new Error('A fonte oficial não retornou HTTP 200.')); return; }
      res.on('data', chunk => { size += chunk.length; if (size > MAX_PDF_BYTES) req.destroy(new Error('PDF acima do limite de coleta.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (!res.complete || res.headers['content-range'] ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
            (res.headers['content-length'] && Number(res.headers['content-length']) !== body.length)) return reject(new Error('Resposta parcial ou comprimida.'));
        resolve({headers:res.headers, body});
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('A fonte oficial demorou para responder.')));
    req.on('error', reject);
  });
}

export function parseEditionText(text, expectedDate) {
  const months = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  function extract(label) {
    const matches = [...text.matchAll(new RegExp(label + ':\\s*[^,\\n]*,\\s*(\\d{1,2})(?:º)? de (\\p{L}+) de (\\d{4})', 'giu'))];
    if (matches.length !== 1) throw new Error('Data da edição ausente ou ambígua no PDF.');
    const [,day,month,year] = matches[0];
    const index = months.indexOf(month.toLowerCase()) + 1;
    if (!index) throw new Error('Mês não reconhecido no PDF.');
    const iso = `${year}-${String(index).padStart(2,'0')}-${day.padStart(2,'0')}`;
    return {iso, code:editionDate(iso)};
  }
  const available = extract('Data de disponibilização');
  const publication = extract('Data de publicação');
  const number = /\b(\d+)ª\s+edição/iu.exec(text)?.[1];
  if (!number || available.iso !== expectedDate) throw new Error('O PDF não corresponde à edição/data solicitada.');
  return {editionNumber:Number(number), availabilityDate:available.iso, publicationDate:publication.iso, publicationDateCode:publication.code};
}

export async function inspectPdf(response, date, directory) {
  if (!/^application\/pdf(?:;|$)/i.test(response.headers['content-type'] || '') ||
      !response.body.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      !response.body.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new Error('A resposta não contém um PDF completo reconhecível.');
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const file = directory + '/document.pdf';
  await fs.writeFile(file, response.body, {mode:0o600});
  const {stdout} = await runFile('pdftotext', ['-f','1','-l','1','-layout',file,'-'], {timeout:15000,maxBuffer:2*1024*1024});
  return { ...parseEditionText(stdout,date), documentHash:sha256(response.body), size:response.body.length };
}
