import test from 'node:test';import assert from 'node:assert/strict';
import {ReportFiles} from './report-files.mjs';
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
