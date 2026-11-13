// Durable application cache. Provider prompt caching is not used for deduplication.
export async function analysisKey(plan) {
  const manifest={version:1,kind:plan.kind,mode:plan.mode,start:plan.start,end:plan.end,
    ...(plan.analysis_format?{analysis_format:plan.analysis_format}:{}),
    documents:plan.documents.map(d=>[d.period_start,d.period_end,d.role,d.sha256]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(manifest)));
  return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
}

export class AnalysisCache {
  constructor(store,generate) {this.store=store;this.generate=generate;this.active=new Map();}
  async get(plan) {
    const key=await analysisKey(plan);
    if (this.active.has(key)) return this.active.get(key);
    const task=this.run(key,plan);
    this.active.set(key,task);
    try {return await task;} finally {this.active.delete(key);}
  }
  async review(plan,action='inspect',render=null) {
    const key=await analysisKey(plan),storageKey='analysis:'+key,saved=await this.store.get(storageKey);
    if (action==='inspect') return {key,record:saved||null};
    if (saved?.status==='ready'||saved?.status==='pending'||this.active.has(key)) throw Error('Cannot change ready or active analysis');
    if (action==='retry-failed') {
      // Explicit private operator action, never exposed in Telegram or the runner.
      await this.store.put(storageKey,{status:'retryable',reviewedAt:Date.now()});
      return this.get(plan);
    }
    if (action==='render'&&saved?.review?.output&&render) {
      const text=render(plan,saved.review.output),record={status:'ready',text,model:saved.review.model,createdAt:saved.failedAt,
        kind:plan.kind,mode:plan.mode,start:plan.start,end:plan.end,documents:plan.documents.map(d=>({title:d.title,url:d.url,sha256:d.sha256,role:d.role}))};
      await this.store.put(storageKey,record);return {...record,key,cached:true};
    }
    throw Error('No reviewable output');
  }
  async run(key,plan) {
    const storageKey='analysis:'+key,saved=await this.store.get(storageKey);
    if (saved?.status==='ready') return {...saved,key,cached:true};
    if (saved?.status==='pending' || saved?.status==='uncertain') throw Error('Analysis outcome uncertain; automatic resubmission blocked');
    await this.store.put(storageKey,{status:'pending',startedAt:Date.now()});
    let result;
    try {result=await this.generate(plan);}
    catch(error) {
      await this.store.put(storageKey,{status:error.retryable?'retryable':'uncertain',failedAt:Date.now(),...(error.review?{review:error.review}:{})});
      throw error;
    }
    if (!result || typeof result.text!=='string' || !result.text.trim() || result.text.length>24000) {
      await this.store.put(storageKey,{status:'uncertain',failedAt:Date.now()});
      throw Error('Invalid analysis output');
    }
    const record={status:'ready',text:result.text,model:result.model,createdAt:Date.now(),
      ...(result.usage?{usage:result.usage}:{}),
      kind:plan.kind,mode:plan.mode,start:plan.start,end:plan.end,documents:plan.documents.map(d=>({title:d.title,url:d.url,sha256:d.sha256,role:d.role}))};
    await this.store.put(storageKey,record);
    return {...record,key,cached:false};
  }
}
