import fs from 'node:fs/promises';
import { Interface } from 'ethers';
import { PiProvider, ROOT } from '../lib/chain.mjs';
import { publicationConfig } from '../lib/publication.mjs';
import { validatePublicationContract, sourceId } from '../public/publication-wallet.js';
import { newPlan, validatePlan, discover, summary, saveJSON, TARGET, BATCH_ROOT } from '../lib/publication-batch.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--end') throw new Error('Uso: node scripts/plan-publication-batch.mjs --end YYYY-MM-DD');
const initial = newPlan(args[1]);
const directory = BATCH_ROOT + initial.window.start + '_' + initial.window.end;
const file = directory + '/plan.json';
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const lock = await fs.open(directory + '/plan.lock', 'wx', 0o600);
await lock.writeFile(String(process.pid));
const provider = new PiProvider();
try {
  let plan = initial;
  try { plan = validatePlan(JSON.parse(await fs.readFile(file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let checked = 0;
  await discover(plan, { persist: async value => {
    await saveJSON(file, value);
    if (++checked % 30 === 0) console.log(JSON.stringify(summary(value)));
  } });
  const config = { ...await publicationConfig(), ...TARGET };
  const artifact = JSON.parse(await fs.readFile(ROOT + 'build/PublicationRegistry.json', 'utf8'));
  const adapter = { request: ({ method, params = [] }) => provider.send(method, params) };
  await validatePublicationContract(adapter, config, artifact, TARGET.contract);
  const iface = new Interface(artifact.abi);
  for (let start = 0; start < plan.entries.length; start += 20) {
    const entries = plan.entries.slice(start, start + 20);
    const batch = await provider._send(entries.map((entry, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call',
      params: [{ to: TARGET.contract, data: iface.encodeFunctionData('getRecord', [sourceId(entry.url), Number(entry.date.replaceAll('-', ''))]) }, 'latest'] })));
    for (const [i, entry] of entries.entries()) {
      const response = batch.find(item => item.id === i + 1);
      if (!response?.result || response.error) throw new Error('Falha de leitura na RBB; inventário não marcado como pronto.');
      const [exists, record] = iface.decodeFunctionResult('getRecord', response.result);
      if (exists && entry.status !== 'confirmed') {
        entry.status = 'already_registered';
        entry.firstRegisteredAtISO = new Date(Number(record.registeredAt) * 1000).toISOString();
        entry.documentHash = record.documentHash; entry.evidenceHash = record.evidenceHash;
      }
    }
  }
  plan.chainCheckedAt = new Date().toISOString();
  await saveJSON(file, plan);
  const report = { ...summary(plan), target: TARGET, generatedAt: new Date().toISOString(),
    entries: plan.entries, calendar: plan.calendar, transactionBroadcast: false };
  await saveJSON(ROOT + '../reports/publication/batch-365-inventory.json', report);
  console.log(JSON.stringify({ ...summary(plan), file, transactionBroadcast: false }, null, 2));
} finally {
  provider.destroy(); await lock.close(); await fs.unlink(directory + '/plan.lock');
}
