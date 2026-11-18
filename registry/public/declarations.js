import { parseTceInput } from './tce-input.js';
const $ = id => document.getElementById(id);
const brt = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' BRT' : '—';
const date = value => value ? value.split('-').reverse().join('/') : '—';
const short = value => value ? value.slice(0, 10) + '…' + value.slice(-8) : '—';
const duration = value => !Number.isFinite(value) ? '—' : value < 60 ? value.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s' : Math.floor(value / 60) + ' min ' + Math.round(value % 60) + ' s';
const size = bytes => !Number.isFinite(bytes) ? '—' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1048576).toFixed(2) + ' MiB';
let data, selected = null, refreshing = false, syncing = false, detailGeneration = 0, tableFingerprint = '', batchFingerprint = '';
function element(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function link(text, href, className) { const item = element('a', text, className); item.href = href; return item; }
function error(message = '') { $('page-error').textContent = message; $('page-error').hidden = !message; }
async function api(url, body) { const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Falha ao consultar o arquivo.'); return result; }

function renderBatches() {
  $('batches').replaceChildren(); $('batch-count').textContent = data.batches.length + ' lote(s) salvo(s)';
  if (!data.batches.length) $('batches').append(element('p', 'Nenhum lote preparado. Declarações individuais continuam no arquivo abaixo.', 'muted'));
  for (const batch of data.batches) {
    const done = (batch.counts.confirmed || 0) + (batch.counts.already_registered || 0);
    const card = element('article', undefined, 'batch-card'), top = element('div', undefined, 'batch-top');
    top.append(element('h3', date(batch.window.start) + ' — ' + date(batch.window.end)), element('span', batch.complete ? 'Concluído' : batch.processPresent ? 'Em execução' : 'Processo não ativo', 'state-pill ' + (batch.complete || batch.processPresent ? 'good' : 'warn')));
    const progress = element('progress'); progress.max = batch.total; progress.value = done; progress.setAttribute('aria-label', 'Documentos concluídos neste lote');
    const counts = element('div', undefined, 'batch-counts');
    for (const text of [done + ' de ' + batch.total + ' concluídos', (batch.counts.confirmed || 0) + ' novos', (batch.counts.already_registered || 0) + ' preexistentes', (batch.counts.failed || 0) + ' falhas']) counts.append(element('span', text));
    card.append(top, progress, counts);
    if (Number.isInteger(batch.daysWithoutEdition)) card.append(element('p', batch.daysWithoutEdition + ' dias do intervalo sem edição no calendário oficial.', 'small'));
    if (batch.failures?.length) {
      const failures = element('details'); failures.append(element('summary', 'Ver edições pendentes por falha (' + batch.failures.length + ')'));
      for (const item of batch.failures) {
        const line = element('p'); line.append(link(date(item.date) + ' · ' + item.url.split('/').pop(), parseTceInput(item.url, item.date).canonicalURL), element('br'), element('span', item.error)); failures.append(line);
      }
      card.append(failures);
    }
    if (batch.active) card.append(element('p', 'Edição ' + date(batch.active.date) + ' · ' + (batch.active.stage || ({ pending: 'Aguardando recibo e consulta.', proven: 'Prova pronta para o registro.' }[batch.active.status]) || 'Coleta em andamento.'), 'batch-current'));
    card.append(element('p', batch.archivedDeclarations + ' declaração(ões) deste lote já conferida(s) e arquivada(s) nesta página.', 'small'));
    const filter = element('button', 'Ver declarações deste lote', 'link'); filter.onclick = () => { $('filter-batch').value = batch.id; renderTable(true); $('catalog-title').scrollIntoView({ block: 'start' }); }; card.append(filter);
    $('batches').append(card);
  }
  const fingerprint = JSON.stringify(data.batches.map(batch => batch.id));
  if (fingerprint !== batchFingerprint) {
    const value = $('filter-batch').value; $('filter-batch').replaceChildren(element('option', 'Todos os lotes')); $('filter-batch').firstChild.value = '';
    for (const batch of data.batches) { const option = element('option', date(batch.window.start) + ' — ' + date(batch.window.end)); option.value = batch.id; $('filter-batch').append(option); }
    $('filter-batch').value = value; batchFingerprint = fingerprint;
  }
  $('time-proof').textContent = duration(data.performance.proofSeconds); $('time-prepare').textContent = duration(data.performance.preparationSeconds); $('time-chain').textContent = duration(data.performance.inclusionSeconds);
  $('timing-samples').textContent = data.performance.samples ? 'Medianas de ' + data.performance.samples + ' registro(s) com tempos locais. Coleta/prova observada: ' + duration(data.performance.minProofSeconds) + ' a ' + duration(data.performance.maxProofSeconds) + '.' : 'Ainda não há registros com tempos locais completos.';
}

function renderTable(force = false) {
  if (!data) return;
  const term = $('search').value.trim().toLowerCase(), edition = $('filter-date').value, batch = $('filter-batch').value;
  const records = data.records.filter(record => (!edition || record.source.editionDate === edition) && (!batch || record.batchIds.includes(batch)) && (!term || [record.id, record.source.url, record.source.editionDate, date(record.source.editionDate), record.hashes.document, record.hashes.evidence, record.source.sourceId].some(value => value.toLowerCase().includes(term))));
  const fingerprint = JSON.stringify([selected, records.map(record => [record.id, record.evidenceIntegrity])]);
  if (!force && fingerprint === tableFingerprint) return;
  tableFingerprint = fingerprint;
  const focused = document.activeElement?.dataset?.record;
  $('declarations-rows').replaceChildren(); $('declarations-table').hidden = !records.length; $('empty-state').hidden = !!records.length;
  $('empty-state').textContent = data.records.length ? 'Nenhuma declaração corresponde aos filtros. Limpe a busca para ver o arquivo completo.' : data.caughtUp ? 'Ainda não há declarações confirmadas arquivadas neste contrato.' : 'Preparando o arquivo a partir dos eventos da RBB. Os registros aparecerão conforme forem conferidos.';
  for (const record of records) {
    const row = element('tr'); if (record.id === selected) row.className = 'selected';
    const source = element('td'); source.append(element('span', date(record.source.editionDate) + (record.source.editionNumber ? ' · nº ' + record.source.editionNumber : ''), 'edition'));
    const pdf = link(record.source.url.split('/').pop(), parseTceInput(record.source.url, record.source.editionDate).canonicalURL); pdf.target = '_blank'; pdf.rel = 'noopener noreferrer'; source.append(pdf);
    const first = element('td'); first.append(element('span', brt(record.dates.firstRegisteredAtISO).replace(' BRT', ''), 'date'), element('span', 'Horário de Brasília', 'small')); first.title = record.dates.firstRegisteredAtISO;
    const tx = element('td'); tx.append(element('code', short(record.id), 'tx'), element('span', 'Bloco ' + record.blockNumber.toLocaleString('pt-BR'), 'small')); tx.title = record.id;
    const proof = element('td'); proof.append(element('span', record.evidenceAvailable ? 'PDF + provas' : 'Arquivo incompleto', 'state-pill ' + (record.evidenceAvailable ? 'good' : 'warn')), element('span', size(record.pdfBytes) + ' · ' + (record.pdfParts || 0) + ' trechos', 'small'));
    const action = element('td'), button = element('button', 'Ver declaração', 'secondary'); button.dataset.record = record.id; button.setAttribute('aria-label', 'Ver declaração de ' + record.source.url.split('/').pop()); button.onclick = () => openRecord(record.id); action.append(button);
    row.append(source, first, tx, proof, action); $('declarations-rows').append(row);
  }
  if (focused) document.querySelector(`[data-record="${focused}"]`)?.focus({ preventScroll: true });
  $('archive-summary').textContent = records.length + ' de ' + data.records.length + ' declaração(ões) arquivada(s). Cada item tem recibo de sucesso conferido na RBB.';
}

async function refresh() {
  if (refreshing || syncing) return; refreshing = true;
  try {
    data = await api('/api/declarations'); error(); renderBatches(); renderTable();
    $('sync-status').textContent = data.sync.error ? 'Consulta à RBB indisponível: ' + data.sync.error + ' Exibindo a última cópia preservada.' : data.verifiedAt ? 'Conferido até o bloco ' + data.cursor.toLocaleString('pt-BR') + ' · ' + brt(data.verifiedAt) + (data.caughtUp ? '.' : ' · Recuperando histórico anterior…') : 'A indexação inicial ainda está em andamento.';
  } catch (cause) { error(cause.message + (data ? ' A última lista carregada foi mantida.' : ' Tente atualizar novamente.')); }
  finally { refreshing = false; }
}

async function copy(value, button) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(value); button.textContent = 'Copiado'; }
  catch { button.textContent = 'Selecione e copie o texto'; }
  setTimeout(() => { button.textContent = label; }, 2000);
}
function field(container, label, value, { copyable = false, href = null } = {}) {
  const group = element('div', undefined, 'field'); group.append(element('dt', label)); const definition = element('dd'); definition.append(href ? link(value || '—', href) : element('span', value ?? '—')); group.append(definition);
  if (copyable && value) { const button = element('button', 'Copiar', 'link copy'); button.setAttribute('aria-label', 'Copiar ' + label); button.onclick = () => copy(String(value), button); group.append(button); }
  container.append(group);
}
function fieldsSection(parent, title, items) { parent.append(element('h3', title)); const list = element('dl', undefined, 'fields'); for (const [label, value, options] of items) field(list, label, value, options); parent.append(list); }

function renderDetail(record) {
  const container = $('detail-content'); container.replaceChildren();
  $('record-title').textContent = 'Edição ' + date(record.source.editionDate) + (record.source.editionNumber ? ' · nº ' + record.source.editionNumber : '');
  container.append(element('p', 'Primeiro registro desta URL e edição', 'small'), element('p', brt(record.dates.firstRegisteredAtISO), 'detail-date'));
  const actions = element('div', undefined, 'detail-actions');
  actions.append(link('Baixar dossiê JSON', '/api/declarations/' + record.id + '/export', 'secondary download'));
  if (record.evidence.available) actions.append(link('Baixar PDF preservado', '/api/declarations/' + record.id + '/pdf', 'secondary download'), link('PDF + provas + manifesto', '/api/publication/evidence/' + record.hashes.evidence, 'secondary download'));
  container.append(actions);
  fieldsSection(container, 'Identidade e metadados de consulta', [
    ['URL canônica', record.source.url, { copyable: true, href: parseTceInput(record.source.url, record.source.editionDate).canonicalURL }],
    ['Data da edição usada na consulta', record.source.editionDate, { copyable: true }],
    ['SHA-256 do PDF original', record.hashes.document, { copyable: true }], ['SHA-256 do manifesto de evidência', record.hashes.evidence, { copyable: true }],
    ['sourceId · Keccak-256 da URL canônica', record.source.sourceId, { copyable: true }], ['Algoritmo do conteúdo', record.hashes.algorithm + ' · bytes originais do arquivo']]);
  fieldsSection(container, 'Transação confirmada na RBB', [
    ['Hash da transação', record.transaction.hash, { copyable: true }], ['Bloco / resultado', record.transaction.blockNumber.toLocaleString('pt-BR') + ' · sucesso (0x1)'],
    ['Hash do bloco', record.transaction.blockHash, { copyable: true }], ['Inclusão desta transação', brt(record.dates.includedAtISO)],
    ['Contrato', record.chain.contract, { copyable: true }], ['Rede', 'RBB Testnet · chain ID ' + record.chain.id],
    ['Carteira escritora', record.transaction.from, { copyable: true }], ['Verificador da atestação', record.chain.verifier, { copyable: true }],
    ['Gas utilizado / preço por gas', Number(BigInt(record.transaction.gasUsed)).toLocaleString('pt-BR') + ' / ' + BigInt(record.transaction.gasPrice).toString() + ' wei'], ['Conferência e persistência', brt(record.verifiedAt)]]);
  fieldsSection(container, 'Datas da edição, coleta e registro', [
    ['Edição no calendário do TCE', date(record.source.editionDate)], ['Publicação declarada no documento', date(record.source.publicationDate)],
    ['Início da coleta do PDF', brt(record.dates.collectionStartedAtISO)], ['Última sessão autenticada', brt(record.dates.observedAtISO)],
    ['Primeiro registro desta versão', brt(record.dates.versionFirstRegisteredAtISO)], ['Primeiro registro · UTC', record.dates.firstRegisteredAtISO, { copyable: true }]]);
  container.append(element('h3', 'Consultar novamente na blockchain'));
  const check = element('button', 'Consultar este link + data na RBB', 'secondary'), answer = element('p'); answer.setAttribute('role', 'status');
  check.onclick = async () => { check.disabled = true; answer.className = ''; answer.textContent = 'Consultando o contrato…';
    try { const result = await api('/api/publication/read', record.query.application); if (!result.registered) throw new Error('O contrato não retornou o registro.');
      answer.className = 'query-result'; answer.textContent = 'Primeiro registro retornado: ' + brt(result.firstRegisteredAtISO) + '\n' + (result.firstRegisteredAtISO === record.dates.firstRegisteredAtISO ? 'A data coincide com o dossiê preservado.' : 'A data difere do dossiê; confira a rede e a sincronização.') + '\nConsulta somente à blockchain; o PDF não foi buscado novamente.';
    } catch (cause) { answer.className = 'notice error-notice'; answer.textContent = cause.message; } finally { check.disabled = false; } };
  container.append(check, answer);
  const query = element('details'); query.append(element('summary', 'Metadados para integrar a consulta em outra aplicação'));
  query.append(element('p', 'POST /api/publication/read', 'small'), element('pre', JSON.stringify(record.query.application, null, 2)), element('p', 'Contrato: getRecord(sourceId, editionDate)', 'small'), element('pre', JSON.stringify(record.query.getRecord, null, 2)));
  const queryCopy = element('button', 'Copiar parâmetros da consulta', 'link'); queryCopy.onclick = () => copy(JSON.stringify(record.query.application, null, 2), queryCopy); query.append(queryCopy); container.append(query);
  container.append(element('h3', 'Arquivos e partes preservados'));
  container.append(element('p', record.evidence.available ? 'PDF, calendário e todos os trechos conferem com os hashes do manifesto ancorado.' : 'O registro está confirmado na cadeia, mas o pacote local está ausente, incompleto ou não confere com seus hashes.', record.evidence.available ? 'small' : 'notice'));
  const parts = element('details'); parts.append(element('summary', 'Ver arquivos, intervalos e hashes de cada parte (' + record.evidence.parts.length + ')'));
  const wrap = element('div', undefined, 'table-wrap'), table = element('table', undefined, 'parts-table'), head = element('thead'), header = element('tr');
  for (const text of ['Arquivo / intervalo', 'SHA-256', 'Cópia local']) header.append(element('th', text)); head.append(header); table.append(head); const body = element('tbody');
  for (const part of record.evidence.parts) {
    const row = element('tr'), name = element('td'); name.append(element('strong', part.file), element('p', part.kind === 'part' ? 'Bytes ' + part.start + '–' + part.end + ' · ' + size(part.size) : size(part.size), 'small'));
    const hash = element('td'); hash.append(element('code', part.hash)); const status = element('td');
    if (part.valid) status.append(link('Baixar', '/api/declarations/' + record.id + '/' + (part.file === 'document.pdf' ? 'pdf' : part.file.replace('.tlsn', ''))));
    else status.append(element('span', part.present ? 'Hash divergente' : 'Ausente'));
    row.append(name, hash, status); body.append(row);
  }
  table.append(body); wrap.append(table); parts.append(wrap); container.append(parts);
  const technical = element('details'); technical.append(element('summary', 'Manifesto e atestação utilizados no registro'), element('pre', JSON.stringify({ manifest: record.evidence.manifest || null, attestation: record.attestation, batches: record.batches, timing: record.timing }, null, 2))); container.append(technical);
}

async function openRecord(id) {
  if (!/^0x[0-9a-f]{64}$/.test(id)) return;
  const generation = ++detailGeneration; selected = id; renderTable(true); $('record-details').hidden = false; $('detail-status').textContent = 'Carregando o dossiê preservado…'; $('detail-content').replaceChildren();
  history.replaceState(null, '', '/declaracoes#' + id); $('record-details').scrollIntoView({ block: 'start' });
  try { const record = await api('/api/declarations/' + id); if (generation !== detailGeneration) return; renderDetail(record); $('detail-status').textContent = 'Recibo, metadados e evidências salvos neste projeto.'; }
  catch (cause) { if (generation === detailGeneration) $('detail-status').textContent = cause.message; }
}
$('close-record').onclick = () => { const previous = selected; selected = null; detailGeneration++; $('record-details').hidden = true; history.replaceState(null, '', '/declaracoes'); renderTable(true); document.querySelector(`[data-record="${previous}"]`)?.focus(); };
for (const id of ['search', 'filter-date', 'filter-batch']) $(id).addEventListener('input', () => renderTable(true));
$('clear-filters').onclick = () => { $('search').value = ''; $('filter-date').value = ''; $('filter-batch').value = ''; renderTable(true); };
$('sync').onclick = async () => { if (syncing) return; syncing = true; $('sync').disabled = true; $('sync-status').textContent = 'Conferindo recibos, eventos e estado do contrato…';
  try { await api('/api/declarations/sync', {}); error(); } catch (cause) { error(cause.message + ' O arquivo anterior foi preservado.'); }
  finally { syncing = false; $('sync').disabled = false; await refresh(); } };
await refresh();
if (/^#0x[0-9a-f]{64}$/.test(location.hash)) await openRecord(location.hash.slice(1));
setInterval(() => { if ($('auto-refresh').checked && !document.hidden) void refresh(); }, 15000);
