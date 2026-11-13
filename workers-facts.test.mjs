import test from 'node:test';import assert from 'node:assert/strict';
let api={};try{api=await import('./workers-facts.mjs');}catch{}
const doc=(rate,start,end,role='selected')=>({role,title:'Росстат',period_start:start,period_end:end,pages:[{page:1,text:`За период индекс потребительских цен, по оценке Росстата, составил ${rate}%, с начала месяца – 100,11%, с начала года – 106,33%.`} ]});
test('weekly facts retain exact quotes and compound selected weeks only',()=>{
  assert.equal(typeof api.inflationFacts,'function');
  const p={kind:'inflation',mode:'m1',start:'2026-10-27',end:'2026-11-09',documents:[doc('100,99','2026-10-20','2026-10-26','baseline'),doc('100,20','2026-10-27','2026-11-02'),doc('100,12','2026-11-03','2026-11-09')]};
  const f=api.inflationFacts(p);assert.equal(f.points.length,2);assert.ok(Math.abs(f.chainPercent-0.32024)<1e-8);
  assert.equal(f.metrics[0].document,2);assert.ok(f.metrics.every(m=>p.documents[m.document-1].pages[m.page-1].text.includes(m.evidence)&&m.evidence.includes(m.value)));
});
test('no partial range calculation when a selected weekly index is missing',()=>{
  const p={kind:'inflation',mode:'m1',start:'2026-10-27',end:'2026-11-09',documents:[doc('100,20','2026-10-27','2026-11-02'),{...doc('100,12','2026-11-03','2026-11-09'),pages:[{page:1,text:'unreadable'}]}]};
  assert.throws(()=>api.inflationFacts(p));
});
test('model narrative cannot introduce new numerical claims',()=>{
  assert.throws(()=>api.factsResult({metrics:[],changes:[],caveats:[]},{summary:'Инфляция 99%.',observations:[]}));
});
test('model narrative cannot replace the requested range with year-to-date or month end',()=>{
  for(const summary of ['С начала года цены выросли.','К концу месяца цены растут.'])assert.throws(()=>api.factsResult({metrics:[],changes:[],caveats:[]},{summary,observations:[]}));
});
