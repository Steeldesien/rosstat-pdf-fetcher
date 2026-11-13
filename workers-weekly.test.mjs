import test from 'node:test';import assert from 'node:assert/strict';
let api={};try{api=await import('./workers-weekly.mjs');}catch{}
const plan={kind:'inflation',mode:'release',start:'2026-11-03',end:'2026-11-09',documents:[{role:'selected',title:'Росстат',url:'https://rosstat.gov.ru/a.pdf',period_start:'2026-11-03',period_end:'2026-11-09',pages:[{page:1,text:'Индекс потребительских цен составил 100,12%, с начала месяца – 100,11%, с начала года – 106,33%.\nИзменение цен на плодоовощную продукцию в среднем составило +1,6%.'},{page:2,text:'Огурцы свежие          109,38 111,26 67,29\nБензин автомобильный    99,22 98,63 115,24\nДизельное топливо       100,26 100,29 113,52\nПолный текст последней страницы.'}]}]};
test('full weekly input includes every page and derived changes use only first index column',()=>{
  assert.equal(typeof api.weeklyBundle,'function');const b=api.weeklyBundle(plan);
  assert.equal(b.facts.find(x=>x.label==='Огурцы свежие').value,'+9,38%');
  assert.equal(b.facts.find(x=>x.label==='Бензин автомобильный').value,'-0,78%');
  assert.ok(JSON.stringify(api.weeklyMessages(plan,b)).includes('Полный текст последней страницы.'));
});
test('figures in final text must resolve to verified facts; unsupported evaluation is rejected',()=>{
  const b=api.weeklyBundle(plan),fuel=b.facts.find(f=>f.label==='Бензин автомобильный').id,good={summary:'За неделю цены выросли на {{week}}.',observations:['Овощи и фрукты: {{fruit}}.',`Бензин: {{${fuel}}}.`],conclusion:'Изменения цен по наблюдаемым позициям неоднородны.'};
  const result=api.weeklyResult(plan,b,good);assert.ok(result.summary.includes('+0,12%'));assert.ok(result.changes[0].includes('+1,6%'));
  assert.throws(()=>api.weeklyResult(plan,b,{...good,summary:'Цены выросли на 99%.'}));
  assert.throws(()=>api.weeklyResult(plan,b,{...good,summary:'Итог {{unknown}}.'}));
  assert.throws(()=>api.weeklyResult(plan,b,{...good,conclusion:'Показатели улучшились.'}));
});
test('exact reporting dates may be removed from model prose; arbitrary numbers remain forbidden',()=>{
  const b=api.weeklyBundle(plan),good={summary:'За неделю с 3 по 9 ноября 2026 г. цены выросли на {{week}}.',observations:['Плодоовощи: {{fruit}}.','Недельный рост: {{week}}.'],conclusion:'Изменения цен неоднородны.'};
  assert.ok(!api.weeklyResult(plan,b,good).summary.includes('2026'));
  assert.throws(()=>api.weeklyResult(plan,b,{...good,summary:'За неделю с 2 по 8 ноября 2026 г. цены выросли.'}));
});
test('a numeric hotel category is allowed only when present in the source catalog',()=>{
  const b=api.weeklyBundle(plan);b.facts.push({id:'hotel',label:'Проживание в гостинице 2*',value:'+0,30%',document:1,page:2});
  const good={summary:'Рост за неделю {{week}}.',observations:['В гостинице 2* изменение {{hotel}}.','Плодоовощи: {{fruit}}.'],conclusion:'Динамика неоднородна.'};
  assert.ok(api.weeklyResult(plan,b,good).changes[0].includes('2*'));
  assert.throws(()=>api.weeklyResult(plan,b,{...good,observations:['В гостинице 5* изменение {{hotel}}.','Плодоовощи {{fruit}}.']}));
});
test('growth percentages are described as changes, not price levels',()=>{
  assert.equal(api.normalizeGrowthNarrative('Огурцы подскочили до +9,38%; бензин упал до -0,78%; яблоки подешевели на -0,96%.'),'Огурцы подскочили на 9,38%; бензин упал на 0,78%; яблоки подешевели на 0,96%.');
});
