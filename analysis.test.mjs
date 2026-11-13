import test from 'node:test';
import assert from 'node:assert/strict';
let api={};
try {api=await import('./analysis-cache.mjs');} catch {}
const doc=(hash='a')=>({title:'Release',url:'https://rosstat.gov.ru/a.pdf',sha256:hash.repeat(64),period_start:'2026-11-03',period_end:'2026-11-09',role:'selected',pages:[{page:1,text:'123'}],pdf:'JVBERi0='});
const plan=(mode='release',hash='a')=>({kind:'inflation',mode,start:'2026-11-03',end:'2026-11-09',documents:[doc(hash)]});
function fixture() {
  const data=new Map();let calls=0;
  const store={async get(k){return structuredClone(data.get(k));},async put(k,v){data.set(k,structuredClone(v));}};
  return {store,get calls(){return calls;},generate:async()=>{calls++;return {text:'Проверенный разбор',model:'test'};}};
}
test('same content and mode generate once across requests and object restarts',async()=>{
  assert.equal(typeof api.AnalysisCache,'function','Analysis cache is not implemented');
  const f=fixture(),cache=new api.AnalysisCache(f.store,f.generate);
  const first=await cache.get(plan());
  const second=await new api.AnalysisCache(f.store,f.generate).get(plan());
  assert.equal(first.cached,false);assert.equal(second.cached,true);assert.equal(f.calls,1);
  assert.equal(second.text,first.text);
});
test('different mode, new release or same-URL correction create distinct analyses',async()=>{
  assert.equal(typeof api.AnalysisCache,'function');const f=fixture(),cache=new api.AnalysisCache(f.store,f.generate);
  await cache.get(plan());await cache.get(plan('m1'));await cache.get(plan());await cache.get(plan('release','b'));
  assert.equal(f.calls,3);
});
test('simultaneous requests share one inference',async()=>{
  assert.equal(typeof api.AnalysisCache,'function');const f=fixture(),cache=new api.AnalysisCache(f.store,f.generate);
  await Promise.all([cache.get(plan()),cache.get(plan()),cache.get(plan())]);assert.equal(f.calls,1);
});
test('ambiguous interrupted request is never silently submitted again',async()=>{
  assert.equal(typeof api.AnalysisCache,'function');const f=fixture(),cache=new api.AnalysisCache(f.store,async()=>{throw Error('timeout');});
  await assert.rejects(cache.get(plan()));
  await assert.rejects(new api.AnalysisCache(f.store,f.generate).get(plan()),/uncertain/i);assert.equal(f.calls,0);
});
test('failed explicit quota response can be retried without caching an error as analysis',async()=>{
  assert.equal(typeof api.AnalysisCache,'function');const f=fixture(),cache=new api.AnalysisCache(f.store,async()=>{throw Object.assign(Error('quota'),{retryable:true});});
  await assert.rejects(cache.get(plan()));
  assert.equal((await new api.AnalysisCache(f.store,f.generate).get(plan())).cached,false);
});
test('cache records contain neither source PDFs nor private Telegram identifiers',async()=>{
  assert.equal(typeof api.AnalysisCache,'function');const f=fixture();await new api.AnalysisCache(f.store,f.generate).get(plan());
  const key=await api.analysisKey(plan()),stored=await f.store.get('analysis:'+key);
  assert.ok(!JSON.stringify(stored).includes('JVBERi0='));assert.equal(stored.status,'ready');
});

test('Gemini request contains public reports only, has no external tools and checks source references',async()=>{
  let gemini={};try{gemini=await import('./gemini.mjs');}catch{}
  assert.equal(typeof gemini.generateAnalysis,'function');
  let payload;
  const result=await gemini.generateAnalysis({GEMINI_API_KEY:'secret',GEMINI_MODEL:'gemini-2.5-flash'},plan(),async(url,options)=>{
    payload=JSON.parse(options.body);
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({
      summary:'Краткий итог',metrics:[{label:'Показатель',value:'123',document:1,page:1,evidence:'123'}],
      changes:[],caveats:['Нет данных для сравнения.']})}]}}]});
  });
  assert.ok(result.text.includes('123'));assert.ok(!payload.tools);
  assert.ok(!JSON.stringify(payload).includes('secret'));
});

test('invented numeric evidence is rejected before delivery',async()=>{
  let gemini={};try{gemini=await import('./gemini.mjs');}catch{}
  assert.equal(typeof gemini.renderAnalysis,'function');
  assert.throws(()=>gemini.renderAnalysis(plan(),{summary:'x',metrics:[{label:'x',value:'999',document:1,page:1,evidence:'999'}],changes:[],caveats:[]}));
});

test('PDF layout spaces in words, parentheses and percent signs do not reject correct evidence',async()=>{
  const {renderAnalysis}=await import('./gemini.mjs');const p=plan();
  p.documents[0].pages=[{page:1,text:'Изменились тар ифы на проезд +1,0 %. Цены снизились ( -0,8%). ИПЦ составил 100,12%.'}];
  const text=renderAnalysis(p,{summary:'x',metrics:[
    {label:'Тарифы',value:'1,0%',document:1,page:1,evidence:'Изменились тарифы на проезд +1,0%.'},
    {label:'Оценка ИПЦ',value:'100,12%',document:1,page:1,evidence:'ИПЦ составил 100,12%.'}],changes:[],caveats:[]});
  assert.ok(text.includes('1,0%'));assert.ok(text.includes('+0,12%'));
});

test('normalization must not merge separate numeric table cells',async()=>{
  const {renderAnalysis}=await import('./gemini.mjs');const p=plan();p.documents[0].pages=[{page:1,text:'Показатель 1 23'}];
  assert.throws(()=>renderAnalysis(p,{summary:'x',metrics:[{label:'x',value:'123',document:1,page:1,evidence:'Показатель 123'}],changes:[],caveats:[]}));
});

test('brief delivery fits one Telegram message and prioritizes latest-release metrics',async()=>{
  const g=await import('./gemini.mjs');assert.equal(typeof g.compactAnalysis,'function');
  const original='Недельная инфляция\nПоследний месяц: 01.10.2026-09.11.2026\nВыпусков: 5\n\nГлавный итог.\n\nОсновные показатели\n'+
    Array.from({length:7},(_,i)=>`• Показатель ${i+1}: ${100+i}% [${i+1}, стр. 1]`).join('\n')+
    '\n\nДинамика\n'+Array.from({length:6},()=> '• '+ 'Проверенное изменение. '.repeat(20)).join('\n')+
    '\n\nОграничения\n• Недельная оценка не является месячным ИПЦ.\n\nИсточники\n[7] Последний выпуск\nhttps://rosstat.gov.ru/new.pdf';
  const brief=g.compactAnalysis(original);
  assert.ok(brief.length<=3300);assert.ok(brief.includes('Показатель 7'));
  assert.ok(!brief.includes('Показатель 1:'));
  assert.ok(brief.includes('https://rosstat.gov.ru/new.pdf'));
  assert.ok(original.includes('Показатель 1:'));
});

test('private review cannot replace a ready result or repeat its inference',async()=>{
  const f=fixture(),cache=new api.AnalysisCache(f.store,f.generate);await cache.get(plan());
  await assert.rejects(cache.review(plan(),'retry-failed'));
  assert.equal(f.calls,1);
});

test('a rejected output can be repaired from saved output without another model call',async()=>{
  const f=fixture(),cache=new api.AnalysisCache(f.store,async()=>{throw Object.assign(Error('validation'),{review:{model:'test',output:{text:'Recovered'}}});});
  await assert.rejects(cache.get(plan()));
  const repaired=await cache.review(plan(),'render',(_plan,output)=>output.text);
  assert.equal(repaired.text,'Recovered');assert.equal(repaired.cached,true);
  assert.equal((await cache.get(plan())).text,'Recovered');assert.equal(f.calls,0);
});
