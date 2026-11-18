import test from 'node:test';import assert from 'node:assert/strict';
import {ForecastJobs} from './forecast-jobs.mjs';
function fixture(){const map=new Map(),calls=[],effects={now:()=>Date.parse('2026-11-18T14:01:00+03:00'),dispatch:async id=>calls.push(id),sendSummary:async()=>({message_id:1}),sendFile:async()=>({document:{file_id:'html'}})};const store={get:async k=>map.get(k),put:async(k,v)=>map.set(k,structuredClone(v)),list:async({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix)))};return {map,calls,effects,jobs:new ForecastJobs(store,effects)};}
test('pre-release forecast dispatches once Wednesday at 14 MSK',async()=>{const f=fixture();await f.jobs.tick();await f.jobs.tick();assert.deepEqual(f.calls,['forecast-2026-11-18']);const j=await f.jobs.claim('forecast-2026-11-18','run');assert.equal(j.status,'ready');assert.equal(j.expected_end,'2026-11-16');});
test('pre-release job is not scheduled before its time or on another day',async()=>{const f=fixture();f.effects.now=()=>Date.parse('2026-11-18T13:59:00+03:00');await f.jobs.tick();f.effects.now=()=>Date.parse('2026-11-19T14:01:00+03:00');await f.jobs.tick();assert.equal(f.calls.length,0);});
test('forecast file delivery requires the claimed owner and correct target period',async()=>{const f=fixture();await f.jobs.tick();await f.jobs.claim('forecast-2026-11-18','owner');const data={asof:'2026-11-09',start:'2026-11-10',end:'2026-11-16',point:.147,lo80:.043,hi80:.232,model:'v2',key:'a'.repeat(64),shadow:true};await assert.rejects(f.jobs.finish('forecast-2026-11-18','other',data));await assert.rejects(f.jobs.finish('forecast-2026-11-18','owner',{...data,end:'2026-11-23'}));await f.jobs.finish('forecast-2026-11-18','owner',data);assert.equal((await f.jobs.file('forecast-2026-11-18','owner','short')).status,'needs_file');});
test('a failed forecast can retry with a new runner after a bounded delay',async()=>{const f=fixture();await f.jobs.tick();await f.jobs.claim('forecast-2026-11-18','old');await f.jobs.fail('forecast-2026-11-18','old','RuntimeError');await f.jobs.tick();assert.equal(f.calls.length,1);f.effects.now=()=>Date.parse('2026-11-18T14:17:00+03:00');await f.jobs.tick();assert.equal(f.calls.length,2);assert.equal((await f.jobs.claim('forecast-2026-11-18','new')).status,'ready');});

test('new forecast delivery includes cached analysis and requires PNG as well as two HTML files',async()=>{
 const f=fixture();let sent='',calls=0;f.effects.analyze=async()=>{calls++;return {text:'Краткий разбор прогноза.',key:'b'.repeat(64),cached:false};};f.effects.sendSummary=async text=>{sent=text;};
 await f.jobs.tick();const id=f.calls[0];await f.jobs.claim(id,'run');
 const data={format:2,asof:'2026-11-09',start:'2026-11-10',end:'2026-11-16',point:.147,lo80:.043,hi80:.232,model:'v2',key:'a'.repeat(64)};
 await f.jobs.finish(id,'run',data);await f.jobs.finish(id,'run',data);assert.equal(calls,1);assert.doesNotMatch(sent,/Краткий разбор|Нейросетевой/);assert.match(sent,/Предварительный прогноз/);assert.match(sent,/2026-11-10 — 2026-11-16/);
 const html={name:'test.html',bytes:new TextEncoder().encode('<!doctype html><html>Прогноз</html>')};
 await f.jobs.file(id,'run','short',html);await f.jobs.file(id,'run','full',html);assert.notEqual((await f.jobs.summary())[0].status,'completed');
 assert.equal((await f.jobs.file(id,'run','png')).status,'needs_file');
 const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);new DataView(bytes.buffer).setUint32(16,840);new DataView(bytes.buffer).setUint32(20,1300);
 await f.jobs.file(id,'run','png',{name:'forecast.png',bytes});assert.equal((await f.jobs.summary())[0].status,'completed');
});

test('dry forecast validates three files but sends nothing and cannot accept HTML as PNG',async()=>{
 const f=fixture();f.effects.sendSummary=async()=>{throw Error('Unexpected Telegram call');};f.effects.sendFile=f.effects.sendSummary;
 await f.jobs.enqueue('dry','2026-11-18',true);await f.jobs.claim('dry','run');
 await f.jobs.finish('dry','run',{format:2,asof:'2026-11-09',start:'2026-11-10',end:'2026-11-16',point:.147,lo80:.043,hi80:.232,model:'v2',key:'a'.repeat(64)});
 await assert.rejects(f.jobs.file('dry','run','png',{name:'f.png',bytes:new TextEncoder().encode('<html></html>')}),/PNG/i);
});

test('an uncertain model request is not automatically repeated and the calculation still goes out',async()=>{
 const f=fixture();let calls=0,sent='';f.effects.analyze=async()=>{calls++;throw Error('Provider outcome uncertain');};f.effects.sendSummary=async text=>{sent=text;};
 await f.jobs.tick();const id=f.calls[0];await f.jobs.claim(id,'run');
 const data={format:2,asof:'2026-11-09',start:'2026-11-10',end:'2026-11-16',point:.147,lo80:.043,hi80:.232,model:'v2',key:'a'.repeat(64)};
 const result=await f.jobs.finish(id,'run',data);await f.jobs.finish(id,'run',data);
 assert.equal(result.analysisStatus,'unavailable');assert.equal(calls,1);assert.doesNotMatch(sent,/разбор недоступен|Нейросетевой/);assert.match(sent,/\+0,15%/);
});
