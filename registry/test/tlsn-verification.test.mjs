import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/chain.mjs';
import { runFile, assertRequest, parseHttpResponse } from '../lib/tce.mjs';

test('real TLSNotary presentation verifies offline; wrong key and damaged proof are rejected',async t=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'rbb-tlsn-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const binary=ROOT+'tlsn-adapter/target/release/rbb-tlsn-adapter';
  const proof=ROOT+'test/fixtures/tce-calendar.presentation.tlsn';
  const metadata=JSON.parse(await fs.readFile(ROOT+'test/fixtures/tce-calendar.metadata.json','utf8'));
  const invoke=(file,key,out)=>runFile(binary,['verify',file,key,out],{timeout:30000,maxBuffer:65536});
  await invoke(proof,metadata.notaryPublicKey,dir+'/valid');
  const result=JSON.parse(await fs.readFile(dir+'/valid/verified.json','utf8'));
  assert.equal(result.completeTranscript,true);assert.equal(result.serverName,'doe.tce.sp.gov.br');assert.equal(result.observedAt,metadata.observedAt);
  assertRequest(await fs.readFile(dir+'/valid/sent.http'),'https://doe.tce.sp.gov.br/json/file/2026/11/14');
  const json=JSON.parse(parseHttpResponse(await fs.readFile(dir+'/valid/received.http')).body.toString());
  assert.equal(json.file,'/pdf/2026/11/doe-tce-2026-11-14.pdf');
  await assert.rejects(invoke(proof,'02'+'11'.repeat(32),dir+'/wrong-key'));
  const bytes=await fs.readFile(proof);bytes[Math.floor(bytes.length/2)]^=1;await fs.writeFile(dir+'/damaged.tlsn',bytes);
  await assert.rejects(invoke(dir+'/damaged.tlsn',metadata.notaryPublicKey,dir+'/damaged'));
});
