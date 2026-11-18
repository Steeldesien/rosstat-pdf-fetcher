import test from 'node:test';import assert from 'node:assert/strict';
import {publishSource,publishNarrative} from './report-delivery.mjs';
import {deliveryCaption} from './coordinator.mjs';
const item={title:'Об оценке индекса потребительских цен с 10 по 16 ноября 2026 года',url:'https://rosstat.gov.ru/a.pdf',stamp:1795100000,receivedStamp:1795100060};
test('reports-only delivery preserves the dated announcement but never uploads the Rosstat PDF',async()=>{
 const calls=[],transport=async(method,options)=>{calls.push({method,options});return {message_id:2};};
 const result=await publishSource({artifactsOnly:true,transport,destination:{chatId:'test',threadId:9},bytes:new TextEncoder().encode('%PDF-test'),item,mode:'scheduled'});
 assert.equal(result.source_only,true);assert.equal(calls.length,1);assert.equal(calls[0].method,'sendMessage');
 const body=JSON.parse(calls[0].options.body);assert.equal(body.text,deliveryCaption(item,'scheduled'));assert.equal(body.message_thread_id,9);assert.ok(body.text.includes('10 по 16 ноября'));assert.ok(body.text.includes('Получено ботом'));assert.equal(body.document,undefined);
 await publishNarrative({artifactsOnly:true,transport,destination:{chatId:'test'},text:'Нейросетевой разбор'});assert.equal(calls.length,1);
});
test('legacy PDF transport remains available when reports-only policy is off',async()=>{
 let method,options;await publishSource({artifactsOnly:false,transport:async(m,o)=>{method=m;options=o;return {message_id:1};},destination:{chatId:'test'},bytes:new TextEncoder().encode('%PDF-test'),item,mode:'latest'});
 assert.equal(method,'sendDocument');assert.ok(options.body instanceof FormData);assert.equal(options.body.get('document').type,'application/pdf');
});
