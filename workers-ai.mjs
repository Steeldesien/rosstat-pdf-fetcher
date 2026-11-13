import {analysisParts,schema,renderAnalysis} from './gemini.mjs';
import {inflationFacts,factsMessages,factsResult,factsSchema} from './workers-facts.mjs';
import {weeklyBundle,weeklyMessages,weeklyResult,weeklySchema,normalizeGrowthNarrative} from './workers-weekly.mjs';

export const WORKERS_MODEL='@cf/zai-org/glm-4.7-flash';
const rates={
  [WORKERS_MODEL]:[5500,36400],
  '@cf/openai/gpt-oss-120b':[31818,68182]
};
function jsonSchema(value){
  if(Array.isArray(value))return value.map(jsonSchema);
  if(!value||typeof value!=='object')return value;
  const result=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='type'?v.toLowerCase():jsonSchema(v)]));
  if(result.type==='object')result.additionalProperties=false;
  return result;
}
const outputSchema=jsonSchema(schema);
outputSchema.properties.metrics.maxItems=4;outputSchema.properties.metrics.minItems=1;
outputSchema.properties.changes.maxItems=3;outputSchema.properties.caveats.maxItems=1;
export function workersMessages(plan){
  const text=analysisParts(plan).filter(p=>p.text).map(p=>p.text).join('\n\n');
  if(text.length>320000)throw Object.assign(Error('Workers AI context bound exceeded'),{retryable:true});
  return [{role:'system',content:'Верни JSON-объект с ключами summary, metrics, changes, caveats. Не возвращай схему и не оборачивай ответ в properties. Максимум 4 метрики, 3 изменения и 1 ограничение. В metrics копируй value ТОЧНО из цитаты evidence, без пересчета индекса в прирост и без добавления единиц, которых нет в цитате. Индекс 106,33% соответствует росту 6,33%, а НЕ инфляции 106,33%. Не выполняй собственные вычисления, если их не предоставил код. При неоднозначном столбце не используй показатель. Для месяца сопоставляй все selected-выпуски, а не только последнюю неделю.'},
    {role:'user',content:text}];
}
export async function generateWorkersAnalysis(env,plan){
  const model=env.WORKERS_AI_MODEL||WORKERS_MODEL;
  // Keep the free-only deployment explicit. Never fall back to a paid model.
  if(!rates[model]||!env.AI?.run)throw Object.assign(Error('Workers AI not configured'),{retryable:true});
  const native=model==='@cf/openai/gpt-oss-120b';
  const rich=env.WORKERS_AI_RICH_WEEKLY==='true'&&plan.kind==='inflation'&&plan.mode==='release'?weeklyBundle(plan):null;
  const facts=!rich&&env.WORKERS_AI_FACTS==='true'?inflationFacts(plan):null,formatSchema=rich?weeklySchema:facts?factsSchema:outputSchema;
  const body={messages:rich?weeklyMessages(plan,rich):facts?factsMessages(facts):workersMessages(plan),temperature:0.1,store:false,
    ...(native?{max_tokens:8192,response_format:{type:'json_schema',json_schema:formatSchema}}:
      {max_completion_tokens:facts?4096:8192,response_format:{type:'json_schema',json_schema:{name:'rosstat_analysis',strict:true,schema:formatSchema}},chat_template_kwargs:{enable_thinking:false}})};
  let data;
  try{data=await env.AI.run(model,body);}catch(error){
    const code=String(error.message||'').match(/\b(3036|3040|5035|5028)\b/)?.[1];
    if(code){error.retryable=true;error.providerStatus=Number(code);}throw error;
  }
  const p=data.usage?.prompt_tokens,c=data.usage?.completion_tokens;
  const usage=Number.isSafeInteger(p)&&p>=0&&Number.isSafeInteger(c)&&c>=0?{promptTokens:p,completionTokens:c,estimatedNeurons:Math.round((p*rates[model][0]+c*rates[model][1])/1000)/1000}:null;
  const choice=data.choices?.[0];
  if(choice?choice.finish_reason!=='stop'||typeof choice.message?.content!=='string':!native||!data.response)throw Object.assign(Error('Incomplete Workers AI response'),{review:{model,finishReason:choice?.finish_reason||null,...(usage?{usage}:{})}});
  const content=choice?.message.content??data.response;
  const raw=typeof content==='string'?JSON.parse(content):content;
  let text;try{const parsed=rich?weeklyResult(plan,rich,raw):facts?factsResult(facts,raw):raw;text=renderAnalysis(plan,parsed);}catch(error){error.review={model,output:raw,validation:error.message,...(usage?{usage}:{})};throw error;}
  return {model,text:rich?normalizeGrowthNarrative(text):text,...(usage?{usage}:{})};
}
