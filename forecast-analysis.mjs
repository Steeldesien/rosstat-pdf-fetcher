import {validateEngineBundle,renderEngineAnalysis} from './engine-analysis.mjs';

export function forecastAnalysisPlan(data){
  if(!/^[a-f0-9]{64}$/.test(data.key)||!/^\d{4}-\d{2}-\d{2}$/.test(data.asof)||data.asof>=data.start)throw Error('Invalid forecast identity');
  const plan={kind:'inflation',mode:'forecast',start:data.start,end:data.end,
    analysis_format:'pre-release-factors-v1',documents:[{sha256:data.key,period_start:data.start,period_end:data.end,role:'forecast'}],engine:data.bundle};
  const b=validateEngineBundle(plan);
  if(b.context?.asof!==data.asof||!Array.isArray(b.context?.history_dates)||b.context.history_dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||d>data.asof))throw Error('Future observations cannot enter a pre-release analysis');
  return plan;
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
    text=renderEngineAnalysis(plan,bundle,raw).replace(/^Недельная инфляция/,'Предрелизный прогноз инфляции');}
  catch(error){error.review={model,stage:'validation',validation:error.message,...(raw?{output:raw}:{responseType:typeof content})};throw error;}
  const p=result.usage?.prompt_tokens,c=result.usage?.completion_tokens;
  return {text,model,...(Number.isSafeInteger(p)&&Number.isSafeInteger(c)?{usage:{promptTokens:p,completionTokens:c}}:{})};
}
