// Deterministic source extraction. The model cannot select or invent numeric metrics.
const percent=n=>(Math.abs(n)<0.00000001?0:n).toFixed(2).replace('.',',')+'%';
const signed=n=>(n>=0?'+':'')+percent(n);
function metric(document,index,pattern,label){
  for(const p of document.pages){
    const m=p.text.match(pattern);
    if(m)return {label,value:m[1]+'%',document:index+1,page:p.page,evidence:m[0]};
  }
  throw Error('Required source index not found');
}
function weekly(d,i){return metric(d,i,/индекс\s+потребительских\s+цен[\s\S]{0,180}?составил\s+(\d{2,3}[,.]\d+)\s*%/i,'ИПЦ за неделю');}
function ytd(d,i){return metric(d,i,/с\s+начала\s+года\s*[–—-]\s*(\d{2,3}[,.]\d+)\s*%/i,'ИПЦ с начала года');}
function month(d,i){return metric(d,i,/с\s+начала\s+месяца\s*[–—-]\s*(\d{2,3}[,.]\d+)\s*%/i,'ИПЦ с начала месяца');}
const number=m=>Number(m.value.replace('%','').replace(',','.'));
export function inflationFacts(plan){
  if(plan.kind!=='inflation')throw Error('Structured extraction is available for weekly inflation');
  if(plan.weekly_history){
    const metrics=[],goods=[];let aggregate=null;
    plan.documents.forEach((d,i)=>{if(d.format==='table')for(const p of d.pages){
      const m=p.text.match(/Цепная оценка общего изменения цен[^\n]*?:\s*(-?\d+[,.]\d+)%/);
      if(m)aggregate={label:'Изменение цен за диапазон, цепная оценка',value:m[1]+'%',document:i+1,page:p.page,evidence:m[0]};
      for(const line of p.text.split('\n')){
        const row=line.match(/^(.+?)\s*\| изменение[^\n]*:\s*(-?\d+[,.]\d+)%/);
        if(row)goods.push({label:row[1],value:row[2]+'%',document:i+1,page:p.page,evidence:line});
      }
    }});
    if(!goods.length)throw Error('No verified historical goods calculations');
    goods.sort((a,b)=>number(b)-number(a));
    if(aggregate)metrics.push(aggregate);
    metrics.push(goods[0],goods.at(-1));
    return {metrics,points:[],chainPercent:aggregate?number(aggregate):null,context:{scope:'Только выбранный диапазон недель',from:plan.start,to:plan.end,weeks:plan.weekly_history.dates.length,method:'Изменение цен за выбранный диапазон; отдельные товары по произведению недельных индексов',metrics},
      changes:['Охвачено недельных наблюдений: '+plan.weekly_history.dates.length+'. Общий ИПЦ не усредняется по товарам.'],caveats:['Цепные оценки за выбранный диапазон не являются официальной инфляцией календарного месяца.']};
  }
  const selected=plan.documents.map((d,i)=>({d,i})).filter(x=>x.d.role==='selected').sort((a,b)=>a.d.period_end.localeCompare(b.d.period_end));
  if(!selected.length)throw Error('No selected weekly issues');
  const points=selected.map(({d,i})=>({end:d.period_end,metric:weekly(d,i)}));
  const latest=selected.at(-1),latestWeek=points.at(-1).metric,latestYear=ytd(latest.d,latest.i),latestMonth=month(latest.d,latest.i);
  const chainPercent=100*(points.reduce((a,p)=>a*number(p.metric)/100,1)-1);
  const metrics=plan.mode==='release'?[latestWeek,latestMonth,latestYear]:[{...points[0].metric,label:'ИПЦ первой недели диапазона'},{...latestWeek,label:'ИПЦ последней недели диапазона'},latestYear];
  const changes=plan.mode==='release'?['Изменение цен за неделю: '+signed(number(latestWeek)-100)+'; с начала года: '+signed(number(latestYear)-100)+'.']:
    ['Цепная оценка изменения цен за '+points.length+' недель: '+signed(chainPercent)+' (произведение недельных индексов, без базового выпуска).',
     'Недельный прирост: '+signed(number(points[0].metric)-100)+' в начале диапазона → '+signed(number(latestWeek)-100)+' в конце.'];
  return {metrics,points,chainPercent,changes,context:{scope:plan.mode==='release'?'Только последняя отчётная неделя':'Только выбранный диапазон недель',from:plan.start,to:plan.end,weeklyGrowth:points.map(p=>({end:p.end,percent:number(p.metric)-100})),chainPercent},
    caveats:[plan.mode==='release'?'Недельная оценка Росстата; показатели с начала месяца и года имеют другие базы сравнения.':'Выбранный диапазон недель и цепная оценка не равны официальному ИПЦ календарного месяца.']};
}
export const factsSchema={type:'object',properties:{summary:{type:'string',maxLength:500},observations:{type:'array',maxItems:1,items:{type:'string',maxLength:350}}},required:['summary','observations'],additionalProperties:false};
export function factsMessages(facts){return [{role:'system',content:'Сформулируй краткий русский вывод по готовым расчетам Росстата: summary — одно предложение, observations — максимум одно наблюдение. Не используй цифры, даты и проценты: все численные показатели добавит программа. Говори только о scope: выбранном диапазоне или одной неделе. Не говори «с начала года», «с начала месяца», «к концу месяца» и не подменяй период календарным месяцем. Не придумывай причины, товары, сравнения с другими периодами, ускорение или замедление без подтверждения в готовых данных. Ответ JSON с ключами summary, observations.'},{role:'user',content:JSON.stringify(facts.context)}];}
export function factsResult(facts,result){
  if(typeof result?.summary!=='string'||!result.summary.trim()||result.summary.length>500||!Array.isArray(result.observations)||result.observations.length>1||result.observations.some(s=>typeof s!=='string'||s.length>350)||/\p{N}/u.test([result.summary,...result.observations].join(' ')))throw Error('Unsupported model narrative');
  if(/с\s+начала\s+(года|месяца)|к\s+концу\s+месяца|годов[а-я]*/iu.test([result.summary,...result.observations].join(' ')))throw Error('Unsupported model period');
  return {summary:result.summary,metrics:facts.metrics,changes:[...facts.changes,...result.observations],caveats:facts.caveats};
}
