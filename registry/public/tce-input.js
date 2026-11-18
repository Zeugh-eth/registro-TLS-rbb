export const TCE_ORIGIN = 'https://doe.tce.sp.gov.br';

export function editionDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Informe a data da edição no calendário do TCE.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '1995-05-17') {
    throw new Error('Data da edição inválida.');
  }
  return Number(value.replaceAll('-', ''));
}

export function parseTceInput(value, date = '') {
  let url;
  try { url = new URL(value); } catch { throw new Error('Cole um link HTTPS do Diário Oficial do TCE-SP.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search) throw new Error('Use um link HTTPS oficial, sem credenciais, porta ou parâmetros.');
  const calendar = (url.hostname === 'www.tce.sp.gov.br' && /^\/diariooficial\/?$/.test(url.pathname)) ||
    (url.origin === TCE_ORIGIN && url.pathname === '/');
  let canonicalURL = null;
  if (!calendar) {
    if (url.origin !== TCE_ORIGIN) throw new Error('Domínio não autorizado. Use o Diário Oficial do TCE-SP.');
    const path = url.pathname.replace(/^\/v\/pdf\//, '/pdf/');
    const match = /^\/pdf\/(\d{4})\/(\d{2})\/doe-tce-(\d{4}-\d{2}-\d{2})(?:[-_][a-zA-Z0-9_-]+)?\.pdf$/.exec(path);
    if (!match || match[1] !== match[3].slice(0, 4) || match[2] !== match[3].slice(5, 7)) throw new Error('Link de PDF do TCE não reconhecido. Use o calendário oficial e selecione a edição.');
    if (date && date !== match[3]) throw new Error('A data escolhida difere da edição no link.');
    date = match[3];
    canonicalURL = TCE_ORIGIN + path;
  }
  const dateCode = editionDate(date);
  const [year, month, day] = date.split('-').map(Number);
  return { canonicalURL, date, dateCode, calendarURL: `${TCE_ORIGIN}/json/file/${year}/${month}/${day}` };
}

export function calendarSources(json, date) {
  const files = Array.isArray(json.file) ? json.file : json.file == null ? [] : [json.file];
  if (files.length > 16) throw new Error('Calendário retornou edições demais; revisão necessária.');
  return [...new Set(files.map(file => {
    if (typeof file !== 'string') throw new Error('Resposta inesperada do calendário.');
    const url = new URL(file, TCE_ORIGIN).href;
    return parseTceInput(url, date).canonicalURL;
  }))];
}
