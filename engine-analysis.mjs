// Generic transport contract for a separately hosted, private calculation engine.
export function validateEngineBundle(plan,bundle=plan.engine){
  if(!bundle||bundle.version!==1||plan.kind!=='inflation')throw Error('Invalid engine bundle');
  if(bundle.mode!==plan.mode||bundle.start!==plan.start||bundle.end!==plan.end)throw Error('Engine period mismatch');
  const expected=plan.documents.map(d=>d.sha256).sort();
  if(JSON.stringify([...bundle.sourceHashes||[]].sort())!==JSON.stringify(expected))throw Error('Engine source mismatch');
  if(!Array.isArray(bundle.facts)||!bundle.facts.length||bundle.facts.length>256)throw Error('Invalid engine facts');
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
  facts.set('period',{value:`${plan.start} — ${plan.end}`});
  const expand=text=>{
    const a=plan.start.split('-').map(Number),b=plan.end.split('-').map(Number);
    const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    // Only the exact manifest dates are accepted as metadata, never arbitrary model-written figures.
    if(a[0]===b[0]&&a[1]===b[1])text=text.replace(new RegExp(`(?:с\\s*)?0?${a[2]}\\s*(?:[-–—‑−]|по)\\s*0?${b[2]}\\s+${months[b[1]-1]}\\s+${b[0]}\\s*(?:г(?:ода)?\\.?)?`,'giu'),'{{period}}');
    if(a[0]!==b[0]||a[1]!==b[1])text=text.replace(new RegExp(`(?:с\\s*)?0?${a[2]}\\s+${months[a[1]-1]}(?:\\s+${a[0]})?\\s*(?:[-–—‑−]|по)\\s*0?${b[2]}\\s+${months[b[1]-1]}\\s+${b[0]}\\s*(?:г(?:ода)?\\.?)?`,'giu'),'{{period}}');
    for(const ref of text.matchAll(/\{\{(ytd|yoy|mtd)\}\}/g)){
      const before=text.slice(0,ref.index),clause=before.slice(Math.max(before.lastIndexOf('.'),before.lastIndexOf(';'),before.lastIndexOf(','))+1);
      if(ref[1]==='ytd'&&/годов[а-яё]*\s+инфляц|г\s*\/\s*г/iu.test(clause)&&!/с\s+начала\s+года/iu.test(clause))throw Error('Metric period meaning mismatch: ytd');
      if(ref[1]==='yoy'&&/с\s+начала\s+года/iu.test(clause)&&!/годов[а-яё]*\s+инфляц|г\s*\/\s*г/iu.test(clause))throw Error('Metric period meaning mismatch: yoy');
      if(ref[1]==='mtd'&&/за\s+(?:весь|полный)\s+месяц/iu.test(clause))throw Error('Metric period meaning mismatch: mtd');
    }
    text=text.replace(/[+−–-]\s*(\{\{(item_[a-z0-9_]+)\}\})/g,(whole,token,id)=>/^[+−-]/.test(facts.get(id)?.value||'')?token:whole);
    const stripped=text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g,(_,id)=>{if(!facts.has(id))throw Error('Unknown engine fact');return '';});
    let numeric=stripped;
    for(const horizon of [4,13])if(facts.has('ma'+horizon))numeric=numeric.replace(new RegExp(`\\b${horizon}[-‑– ]*(?:недел[а-яё]*|week[a-z]*)`,'giu'),'горизонт');
    numeric=numeric.replace(/АИ[-‑–− ]?(\d{2,3})/giu,(label,grade)=>[...facts.values()].some(f=>new RegExp(`АИ[-‑–− ]?${grade}(?!\\d)`,'iu').test(f.label||''))?'проверенная марка бензина':label);
    if(/[\p{N}{}]/u.test(numeric))throw Error('Unsupported numeric narrative');
    if(!/[А-Яа-яЁё]/.test(stripped))throw Error('Russian commentary required');
    return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g,(_,id)=>facts.get(id).value).trim();
  };
  const text=[`Недельная инфляция · ${plan.start} — ${plan.end}`,expand(raw.summary),...raw.observations.map(s=>'• '+expand(s)),expand(raw.conclusion),...bundle.warnings].filter(Boolean).join('\n\n');
  if(text.length>3000)throw Error('Engine narrative exceeds Telegram budget');
  return text;
}
export async function engineArtifactKey(sourceKey,text,computed=false){
  const manifest=JSON.stringify({version:2,sourceKey,text,computed:!!computed});
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(manifest));
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export function computedEngineSummary(plan,bundle=plan.engine){
  validateEngineBundle(plan,bundle);
  const priority=['change','week','norm','ytd','yoy','ma4','ma13','next_forecast'];
  const selected=priority.map(id=>bundle.facts.find(f=>f.id===id)).filter(Boolean).slice(0,7);
  return [`Недельная инфляция · ${plan.start} — ${plan.end}`,'Расчётная сводка. Нейросетевой комментарий недоступен; показатели и отчёты рассчитаны кодом.',...selected.map(f=>'• '+f.label+': '+f.value),...bundle.warnings].join('\n\n');
}
export async function generateEngineAnalysis(env,plan){
  const bundle=validateEngineBundle(plan),model=env.WORKERS_AI_MODEL||'@cf/openai/gpt-oss-120b';
  if(model!=='@cf/openai/gpt-oss-120b'||!env.AI?.run)throw Object.assign(Error('Engine analysis provider unavailable'),{retryable:true});
  let data;try{data=await env.AI.run(model,{messages:[
    {role:'system',content:'Пиши ТОЛЬКО НА РУССКОМ ЯЗЫКЕ. Ты аналитик инфляции для российского рабочего чата. Код уже выполнил все вычисления. Верни JSON {summary:string,observations:string[],conclusion:string}; все значения строк — на русском. Кратко: summary до 250 символов, до трёх observations по 200 символов, conclusion до 200 символов. Любые числа разрешены ТОЛЬКО как {{id}} из facts. Не пиши дату: она уже будет в заголовке. Горизонты пиши словами: четыре недели, тринадцать недель. Показатель ytd означает только рост с начала года, yoy — оценку год к году, mtd — с начала месяца. Не называй ytd годовой инфляцией. Не добавляй знак перед плейсхолдером: значения уже подписаны. Нельзя самостоятельно считать, менять период или приписывать модельные оценки Росстату. Сравни динамику с сезонной нормой, если норма дана в facts, отметь устойчивость и ограничения. Не придумывай причины, исторические сравнения или прогноз ставки. Оценку и прогноз называй оценкой и прогнозом. При mode не release обсуждай весь диапазон, не последнюю неделю.'},
    {role:'user',content:JSON.stringify(bundle)}],temperature:0.1,max_tokens:4096,store:false,
    response_format:{type:'json_schema',json_schema:{type:'object',properties:{summary:{type:'string'},observations:{type:'array',items:{type:'string'},maxItems:3},conclusion:{type:'string'}},required:['summary','observations','conclusion'],additionalProperties:false}}});}
  catch(error){
    if(/3036|3040|5035|5028/.test(error.message||''))error.retryable=true;
    error.review={model,stage:'provider',diagnostic:String(error.message||'Provider error').slice(0,1200)};throw error;
  }
  const content=data.choices?.[0]?.message?.content??data.response;
  if(data.choices?.[0]&&data.choices[0].finish_reason!=='stop')throw Object.assign(Error('Incomplete engine analysis'),{review:{model,stage:'completion',finishReason:data.choices[0].finish_reason}});
  let raw,text;
  try{raw=typeof content==='string'?JSON.parse(content.replace(/^```json\s*|\s*```$/g,'')):content;text=renderEngineAnalysis(plan,bundle,raw);}
  catch(error){error.review={model,stage:'validation',validation:error.message,...(raw?{output:raw}:{responseType:typeof content})};throw error;}
  const p=data.usage?.prompt_tokens,c=data.usage?.completion_tokens;
  return {model,text,...(Number.isSafeInteger(p)&&Number.isSafeInteger(c)?{usage:{promptTokens:p,completionTokens:c,estimatedNeurons:Math.round((p*31818+c*68182)/1000)/1000}}:{})};
}
