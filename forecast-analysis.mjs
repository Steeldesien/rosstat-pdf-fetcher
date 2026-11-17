import {validateEngineBundle,renderEngineAnalysis} from './engine-analysis.mjs';

export function forecastAnalysisPlan(data){
  if(!/^[a-f0-9]{64}$/.test(data.key)||!/^\d{4}-\d{2}-\d{2}$/.test(data.asof)||data.asof>=data.start)throw Error('Invalid forecast identity');
  const plan={kind:'inflation',mode:'forecast',start:data.start,end:data.end,
    analysis_format:'pre-release-factors-v1',documents:[{sha256:data.key,period_start:data.start,period_end:data.end,role:'forecast'}],engine:data.bundle};
  const b=validateEngineBundle(plan);
  if(b.context?.asof!==data.asof||!Array.isArray(b.context?.history_dates)||b.context.history_dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||d>data.asof))throw Error('Future observations cannot enter a pre-release analysis');
  return plan;
}

export function renderForecastAnalysis(plan,bundle,raw){
  if(!raw||typeof raw.summary!=='string'||raw.summary.length>400||!Array.isArray(raw.observations)||raw.observations.length>3||raw.observations.some(s=>typeof s!=='string'||s.length>300)||typeof raw.conclusion!=='string'||raw.conclusion.length>300)throw Error('Invalid forecast narrative');
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const a=plan.start.split('-').map(Number),b=plan.end.split('-').map(Number),asof=bundle.context.asof.split('-').map(Number);
  const facts=[...bundle.facts,{id:'asof_date',label:'Дата последнего известного факта',value:`${asof[2]} ${months[asof[1]-1]} ${asof[0]}`,origin:'official'}];
  const checked={...bundle,facts};
  const normalize=text=>{
    if(a[0]===b[0]&&a[1]===b[1])text=text.replace(new RegExp(`(?:с\\s*)?0?${a[2]}\\s*[-–—‑−]\\s*0?${b[2]}\\s+${months[b[1]-1]}(?:\\s+${b[0]}(?:\\s*г\\.?)?)?`,'giu'),'{{period}}');
    text=text.replace(new RegExp(`(?<![\\d–—‑−-])0?${asof[2]}\\s+${months[asof[1]-1]}(?:\\s+${asof[0]}(?:\\s*г\\.?)?)?`,'giu'),'{{asof_date}}');
    if(facts.some(f=>f.id==='coverage'))text=text.replace(/\b80\s*%/g,'{{coverage}}');
    for(const f of facts){
      const unit=f.value.endsWith('п.п.')?'п\\.\\s*п\\.':f.value.endsWith('%')?'%':null;
      if(unit)text=text.replace(new RegExp(`(\\{\\{${f.id}\\}\\})\\s*${unit}`,'g'),'$1');
    }
    return text;
  };
  const summary=normalize(raw.summary),observations=[];
  // Keep the main forecast strict; omit individual unsupported model claims instead of laundering them.
  const valid=line=>renderEngineAnalysis(plan,checked,{summary:line,observations:[],conclusion:'Прогноз.'});
  valid(summary);
  for(const line of raw.observations){
    const normalized=normalize(line);
    if(/вероятност|гарантир/iu.test(normalized))continue;
    try{valid(normalized);observations.push(normalized);}catch{}
  }
  const caveat='Прогноз не является фактом; модельный интервал не гарантирует будущий результат.';
  let conclusion=normalize(raw.conclusion);
  try{if(/вероятност|гарантир/iu.test(conclusion))throw Error('Unsupported probability claim');valid(conclusion);}
  catch{conclusion='';}
  conclusion=conclusion&&conclusion.length+caveat.length+1<=300?conclusion+' '+caveat:caveat;
  return renderEngineAnalysis(plan,checked,{summary,observations,conclusion}).replace(/^Недельная инфляция/,'Предрелизный прогноз инфляции');
}

export async function generateForecastAnalysis(env,plan){
  const bundle=validateEngineBundle(plan),model=env.WORKERS_AI_MODEL||'@cf/openai/gpt-oss-120b';
  if(model!=='@cf/openai/gpt-oss-120b'||!env.AI?.run)throw Object.assign(Error('Forecast analysis unavailable'),{retryable:true});
  let result;
  try{result=await env.AI.run(model,{messages:[
    {role:'system',content:'Ты аналитик инфляции. На русском объясни ПРЕДРЕЛИЗНЫЙ прогноз, а не факт будущей недели. Все вычисления уже выполнены кодом; ты не пересчитываешь и не меняешь прогноз. Верни JSON {summary:string,observations:string[],conclusion:string}: summary до 220 символов, до двух observations по 200 символов, conclusion до 160 символов. Все числа ТОЛЬКО плейсхолдеры {{id}} из facts, без дополнительного знака. Даты и заголовок не пиши. Объясни направленность среднесрочного темпа, сезонной поправки и текущей динамики цен. Их вклады измеряются в процентных пунктах. Последний известный факт относится только к данным по asof; он не является фактом прогнозируемой недели. Не утверждай, что будущий выпуск уже опубликован. Не добавляй внешних событий, новостей, причин, прогнозов ставки или вероятностей сверх данных. Не трактуй модельный интервал как гарантию. Цифры в context — справочная методика, копировать их в ответ нельзя. Краткий вывод должен содержать ограничение прогноза.'},
    {role:'user',content:JSON.stringify(bundle)}],temperature:0.1,max_tokens:4096,store:false,
    response_format:{type:'json_schema',json_schema:{type:'object',properties:{summary:{type:'string'},observations:{type:'array',items:{type:'string'},maxItems:2},conclusion:{type:'string'}},required:['summary','observations','conclusion'],additionalProperties:false}}});}
  catch(error){if(/3036|3040|5035|5028/.test(error.message||''))error.retryable=true;throw error;}
  if(result.choices?.[0]&&result.choices[0].finish_reason!=='stop')throw Error('Incomplete forecast analysis');
  const content=result.choices?.[0]?.message?.content??result.response;
  let raw,text;
  try{raw=typeof content==='string'?JSON.parse(content.replace(/^```json\s*|\s*```$/g,'')):content;
    text=renderForecastAnalysis(plan,bundle,raw);}
  catch(error){error.review={model,stage:'validation',validation:error.message,...(raw?{output:raw}:{responseType:typeof content})};throw error;}
  const p=result.usage?.prompt_tokens,c=result.usage?.completion_tokens;
  return {text,model,...(Number.isSafeInteger(p)&&Number.isSafeInteger(c)?{usage:{promptTokens:p,completionTokens:c}}:{})};
}
