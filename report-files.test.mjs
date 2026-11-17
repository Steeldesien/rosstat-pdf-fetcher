import test from 'node:test';import assert from 'node:assert/strict';
import {ReportFiles} from './report-files.mjs';
test('uncertain file receipts cannot be reported as completed',async()=>{
 const {receiptResult}=await import('./report-files.mjs');
 assert.equal(receiptResult({status:'uncertain'}).status,'delivery_uncertain');
 assert.equal(receiptResult({status:'sending'}).status,'delivery_uncertain');
 assert.equal(receiptResult({status:'sent'}).status,'completed');
});
test('HTML upload is parsed as multipart, while report lookup is JSON',async()=>{
 const {usesMultipart}=await import('./report-files.mjs');
 assert.equal(usesMultipart('/runner/report-upload'),true);
 assert.equal(usesMultipart('/runner/card-upload'),true);
 assert.equal(usesMultipart('/runner/deliver'),true);
 assert.equal(usesMultipart('/runner/report'),false);
});
test('short and full HTML are cached independently and duplicate delivery is suppressed',async()=>{
 const map=new Map(),sent=[];const store={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)};
 const files=new ReportFiles(store,async payload=>{sent.push(payload);return {document:{file_id:'file-'+sent.length}};});
 assert.equal((await files.deliver('one','a'.repeat(64),'short')).status,'needs_file');
 await files.deliver('one','a'.repeat(64),'short',{name:'Инфляция — краткая.html',bytes:new TextEncoder().encode('<!doctype html><html><body>report</body></html>')});
 await files.deliver('one','a'.repeat(64),'short');assert.equal(sent.length,1);
 await files.deliver('two','a'.repeat(64),'short');assert.equal(sent.length,2);assert.equal(sent[1].fileId,'file-1');
 assert.equal((await files.deliver('two','a'.repeat(64),'full')).status,'needs_file');
});
test('unknown acknowledgements cannot trigger an automatic duplicate',async()=>{
 const map=new Map(),store={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)};let n=0;
 const files=new ReportFiles(store,async()=>{n++;throw Error('timeout');});
 const input={name:'report.html',bytes:new TextEncoder().encode('<!doctype html><html>report</html>')};
 assert.equal((await files.deliver('one','a'.repeat(64),'full',input)).status,'delivery_uncertain');
 assert.equal((await files.deliver('one','a'.repeat(64),'full',input)).status,'delivery_uncertain');assert.equal(n,1);
});
test('a recovered commentary revision refreshes files even within the same job',async()=>{
 const map=new Map(),sent=[],files=new ReportFiles({get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)},async p=>{sent.push(p);return {document:{file_id:'revision-'+sent.length}};});
 const file={name:'report.html',bytes:new TextEncoder().encode('<!doctype html><html>valid</html>')};
 await files.deliver('same-job','a'.repeat(64),'short',file);
 assert.equal((await files.deliver('same-job','b'.repeat(64),'short')).status,'needs_file');
 await files.deliver('same-job','b'.repeat(64),'short',file);assert.equal(sent.length,2);
});
