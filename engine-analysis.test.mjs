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
test('provider and validation failures preserve a safe diagnostic without discarding the response',async()=>{
 const m=await import('./engine-analysis.mjs');
 const env={AI:{run:async()=>({response:{summary:'Рост 99%.',observations:[],conclusion:'Наблюдаем.'}})}};
 await assert.rejects(m.generateEngineAnalysis(env,{...plan,engine:bundle}),e=>e.review?.validation==='Unsupported numeric narrative');
});
test('the exact selected reporting date is metadata, while a different date is rejected',async()=>{
 const m=await import('./engine-analysis.mjs');
 const raw={summary:'За период 03‑09 ноября 2026 г. инфляция изменилась на {{week}}.',observations:[],conclusion:'Следим за динамикой.'};
 assert.match(m.renderEngineAnalysis(plan,bundle,raw),/0,12%/);
 assert.throws(()=>m.renderEngineAnalysis(plan,bundle,{...raw,summary:'За период 02‑09 ноября 2026 г. рост {{week}}.'}),/numeric/i);
});
test('declared rolling horizons are metadata and the commentary must be Russian',async()=>{
 const m=await import('./engine-analysis.mjs'),b={...bundle,facts:[...bundle.facts,{id:'ma13',label:'Тринадцать недель',value:'7,9%',origin:'estimate'}]};
 const raw={summary:'Рост {{week}}.',observations:['Темп за 13 недель — {{ma13}}.'],conclusion:'Следим за динамикой.'};
 assert.match(m.renderEngineAnalysis(plan,b,raw),/13 недель/);
 assert.throws(()=>m.renderEngineAnalysis(plan,b,{...raw,summary:'Prices rose {{week}}.'}),/Russian/i);
});
test('report files can use an explicitly calculated summary when the model is unavailable',async()=>{
 const m=await import('./engine-analysis.mjs');
 const text=m.computedEngineSummary(plan,bundle);
 assert.match(text,/Нейросетевой комментарий недоступен/);assert.match(text,/0,12%/);assert.match(text,/Расчётная сводка/);
});
test('verified gasoline grades are categories, while unlisted grades remain forbidden',async()=>{
 const m=await import('./engine-analysis.mjs'),b={...bundle,facts:[...bundle.facts,{id:'item_gasoline_92',label:'Бензин автомобильный марки АИ-92',value:'-2,22%',origin:'official'}]};
 const raw={summary:'Бензин АИ‑92 — {{item_gasoline_92}}.',observations:[],conclusion:'Динамика неоднородна.'};
 assert.match(m.renderEngineAnalysis(plan,b,raw),/2,22%/);
 assert.throws(()=>m.renderEngineAnalysis(plan,b,{...raw,summary:'Бензин АИ-95 — {{item_gasoline_92}}.'}),/numeric/i);
});
test('year-to-date and annual rates cannot exchange meanings or duplicate a sign',async()=>{
 const m=await import('./engine-analysis.mjs'),b={...bundle,facts:[...bundle.facts,{id:'ytd',label:'С начала года',value:'6,20%',origin:'official'},{id:'yoy',label:'Годовая инфляция',value:'6,96%',origin:'estimate'},{id:'item_cucumber',label:'Огурцы',value:'+6,15%',origin:'official'}]};
 const raw={summary:'Рост с начала года {{ytd}}, годовая инфляция {{yoy}}.',observations:['Огурцы +{{item_cucumber}}.'],conclusion:'Динамика неоднородна.'};
 assert.doesNotMatch(m.renderEngineAnalysis(plan,b,raw),/\+\+/);
 assert.throws(()=>m.renderEngineAnalysis(plan,b,{...raw,summary:'Годовая инфляция к текущему моменту {{ytd}}.'}),/period|meaning/i);
 assert.throws(()=>m.renderEngineAnalysis(plan,b,{...raw,summary:'Рост с начала года {{yoy}}.'}),/period|meaning/i);
});
test('artifact identity changes on commentary recovery without changing inference identity',async()=>{
 const m=await import('./engine-analysis.mjs'),source='a'.repeat(64);
 const a=await m.engineArtifactKey(source,'Расчётная сводка.',true),b=await m.engineArtifactKey(source,'Проверенный комментарий.',false);
 assert.notEqual(a,b);assert.equal(b,await m.engineArtifactKey(source,'Проверенный комментарий.',false));
});
