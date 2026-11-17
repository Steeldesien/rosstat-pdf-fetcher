import test from 'node:test';
import assert from 'node:assert/strict';
const plan={kind:'inflation',mode:'release',start:'2026-11-03',end:'2026-11-09',documents:[{sha256:'a'.repeat(64),role:'selected'}]};
const bundle={version:1,mode:'release',start:plan.start,end:plan.end,sourceHashes:['a'.repeat(64)],facts:[{id:'week',label:'Рост цен за неделю',value:'+0,12%',origin:'official'},{id:'saar',label:'Темп с исключением сезонности',value:'4,4%',origin:'estimate'}],warnings:['Модельные оценки не являются официальными показателями.']};
test('computed figures must match the selected release and period',async()=>{
 const m=await import('./engine-analysis.mjs');
 assert.equal(m.validateEngineBundle(plan,bundle).facts.length,2);
 assert.throws(()=>m.validateEngineBundle(plan,{...bundle,end:'2026-11-02'}),/period/i);
 assert.throws(()=>m.validateEngineBundle(plan,{...bundle,sourceHashes:['b'.repeat(64)]}),/source/i);
});
test('model commentary may use only declared values and cannot invent numbers',async()=>{
 const m=await import('./engine-analysis.mjs');
 const raw={summary:'Цены выросли на {{week}}.',observations:['Темп с исключением сезонности — {{saar}}.'],conclusion:'Для вывода о тренде нужна история.'};
 const text=m.renderEngineAnalysis(plan,bundle,raw);
 assert.match(text,/0,12%/);assert.match(text,/4,4%/);assert.match(text,/Модельные оценки/);
 assert.throws(()=>m.renderEngineAnalysis(plan,bundle,{...raw,summary:'Рост составил 99%.'}),/numeric/i);
 assert.throws(()=>m.renderEngineAnalysis(plan,bundle,{...raw,conclusion:'Прогноз {{unknown}}.'}),/fact/i);
});
test('failed generation never silently falls back to the old PDF-only method',async()=>{
 const m=await import('./engine-analysis.mjs');
 await assert.rejects(m.generateEngineAnalysis({AI:{run:async()=>({response:{summary:'Рост {{week}}.',observations:[],conclusion:'Наблюдаем динамику.'}})},WORKERS_AI_MODEL:'@cf/openai/gpt-oss-120b'},plan),/bundle/i);
});
