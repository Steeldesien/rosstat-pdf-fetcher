// Generic transport contract for a separately hosted, private calculation engine.
export function validateEngineBundle(plan,bundle=plan.engine){
  if(!bundle||bundle.version!==1||plan.kind!=='inflation')throw Error('Invalid engine bundle');
  if(bundle.mode!==plan.mode||bundle.start!==plan.start||bundle.end!==plan.end)throw Error('Engine period mismatch');
  const expected=plan.documents.map(d=>d.sha256).sort();
  if(JSON.stringify([...bundle.sourceHashes||[]].sort())!==JSON.stringify(expected))throw Error('Engine source mismatch');
  if(!Array.isArray(bundle.facts)||!bundle.facts.length||bundle.facts.length>60)throw Error('Invalid engine facts');
  const ids=new Set();
  for(const f of bundle.facts){
    if(!/^[a-z][a-z0-9_]{0,45}$/.test(f.id)||ids.has(f.id)||typeof f.value!=='string'||f.value.length>100||typeof f.label!=='string'||f.label.length>180||!['official','estimate','forecast'].includes(f.origin))throw Error('Invalid engine fact');
    ids.add(f.id);
  }
  if(!Array.isArray(bundle.warnings)||bundle.warnings.length>5||bundle.warnings.some(s=>typeof s!=='string'||s.length>400))throw Error('Invalid engine warnings');
  return bundle;
}
export function renderEngineAnalysis(plan,bundle,raw){
  validateEngineBundle(plan,bundle);
  if(!raw||typeof raw.summary!=='string'||raw.summary.length>400||!Array.isArray(raw.observations)||raw.observations.length>3||raw.observations.some(s=>typeof s!=='string'||s.length>300)||typeof raw.conclusion!=='string'||raw.conclusion.length>300)throw Error('Invalid engine narrative');
  const facts=new Map(bundle.facts.map(f=>[f.id,f]));
  const expand=text=>{
    const stripped=text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g,(_,id)=>{if(!facts.has(id))throw Error('Unknown engine fact');return '';});
    if(/[\p{N}{}]/u.test(stripped))throw Error('Unsupported numeric narrative');
    return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g,(_,id)=>facts.get(id).value).trim();
  };
  const text=[`Недельная инфляция · ${plan.start} — ${plan.end}`,expand(raw.summary),...raw.observations.map(s=>'• '+expand(s)),expand(raw.conclusion),...bundle.warnings].filter(Boolean).join('\n\n');
  if(text.length>3000)throw Error('Engine narrative exceeds Telegram budget');
  return text;
}
export async function generateEngineAnalysis(env,plan){
  const bundle=validateEngineBundle(plan),model=env.WORKERS_AI_MODEL||'@cf/openai/gpt-oss-120b';
  if(model!=='@cf/openai/gpt-oss-120b'||!env.AI?.run)throw Object.assign(Error('Engine analysis provider unavailable'),{retryable:true});
  let data;try{data=await env.AI.run(model,{messages:[
    {role:'system',content:'Ты аналитик инфляции. Код уже выполнил все вычисления. Верни JSON {summary:string,observations:string[],conclusion:string}. Кратко: summary до 250 символов, до трёх observations по 200 символов, conclusion до 200 символов. Любые числа разрешены ТОЛЬКО как {{id}} из facts. Нельзя самостоятельно считать, менять период или приписывать модельные оценки Росстату. Сравни динамику с сезонной нормой, отметь устойчивость и ограничения. Не придумывай причины или прогноз ставки. Оценку и прогноз называй оценкой и прогнозом. При mode не release обсуждай весь диапазон, не последнюю неделю.'},
    {role:'user',content:JSON.stringify(bundle)}],temperature:0.1,max_tokens:4096,store:false,
    response_format:{type:'json_schema',json_schema:{type:'object',properties:{summary:{type:'string'},observations:{type:'array',items:{type:'string'},maxItems:3},conclusion:{type:'string'}},required:['summary','observations','conclusion'],additionalProperties:false}}});}
  catch(error){if(/3036|3040|5035|5028/.test(error.message||''))error.retryable=true;throw error;}
  const content=data.choices?.[0]?.message?.content??data.response;
  if(data.choices?.[0]&&data.choices[0].finish_reason!=='stop')throw Error('Incomplete engine analysis');
  const raw=typeof content==='string'?JSON.parse(content.replace(/^```json\s*|\s*```$/g,'')):content;
  const text=renderEngineAnalysis(plan,bundle,raw),p=data.usage?.prompt_tokens,c=data.usage?.completion_tokens;
  return {model,text,...(Number.isSafeInteger(p)&&Number.isSafeInteger(c)?{usage:{promptTokens:p,completionTokens:c,estimatedNeurons:Math.round((p*31818+c*68182)/1000)/1000}}:{})};
}
