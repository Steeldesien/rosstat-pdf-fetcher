import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCache} from './analysis-cache.mjs';
let api={};try{api=await import('./workers-ai.mjs');}catch{}
const plan={kind:'inflation',mode:'release',start:'2026-11-03',end:'2026-11-09',documents:[{title:'Public release',role:'selected',period_start:'2026-11-03',period_end:'2026-11-09',url:'https://rosstat.gov.ru/a.pdf',sha256:'a'.repeat(64),pdf:'JVBERi0=',pages:[{page:1,text:'Рост цен за неделю 0,12%.'}]}]};
const output={summary:'Цены выросли.',metrics:[{label:'За неделю',value:'0,12%',document:1,page:1,evidence:'Рост цен за неделю 0,12%.'}],changes:[],caveats:[]};
test('Workers AI sends extracted public text only and retains verified usage',async()=>{
  assert.equal(typeof api.generateWorkersAnalysis,'function');let calls=0;
  const result=await api.generateWorkersAnalysis({AI:{run:async(model,body)=>{
    calls++;assert.equal(model,'@cf/zai-org/glm-4.7-flash');
    assert.equal(body.response_format.type,'json_schema');
    assert.equal(body.response_format.json_schema.schema.type,'object');
    assert.equal(body.response_format.json_schema.schema.properties.metrics.maxItems,4);
    assert.ok(JSON.stringify(body).includes('Рост цен за неделю'));assert.ok(!JSON.stringify(body).includes('JVBERi0='));
    assert.equal(body.tools,undefined);assert.equal(body.store,false);
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:1000,completion_tokens:500}};
  }}},plan);
  assert.equal(calls,1);assert.ok(result.text.includes('0,12%'));assert.equal(result.usage.promptTokens,1000);
  assert.equal(result.usage.estimatedNeurons,23.7);
});
test('paid models are blocked before inference; unsupported quotes never pass',async()=>{
  assert.equal(typeof api.generateWorkersAnalysis,'function');let calls=0;
  const AI={run:async()=>{calls++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({...output,metrics:[{...output.metrics[0],value:'9,99%'}]})}}]};}};
  await assert.rejects(api.generateWorkersAnalysis({AI,WORKERS_AI_MODEL:'@cf/zai-org/glm-5.3'},plan));assert.equal(calls,0);
  await assert.rejects(api.generateWorkersAnalysis({AI},plan),/evidence/);
});
test('truncated and ambiguous requests are not automatically retryable',async()=>{
  assert.equal(typeof api.generateWorkersAnalysis,'function');
  await assert.rejects(api.generateWorkersAnalysis({AI:{run:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})}},plan),e=>!e.retryable);
});
test('Cloudflare-hosted open-weight model uses its own quota and native JSON response',async()=>{
  const result=await api.generateWorkersAnalysis({WORKERS_AI_MODEL:'@cf/openai/gpt-oss-120b',AI:{run:async(model,body)=>{
    assert.equal(body.max_tokens,8192);assert.equal(body.response_format.json_schema.type,'object');
    return {response:output,usage:{prompt_tokens:1000,completion_tokens:500}};
  }}},plan);
  assert.equal(result.model,'@cf/openai/gpt-oss-120b');assert.equal(result.usage.estimatedNeurons,65.909);
});
test('Workers AI cached result and usage survive restart without another inference',async()=>{
  const data=new Map(),store={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>{data.set(k,structuredClone(v));}};
  let calls=0;const env={WORKERS_AI_MODEL:'@cf/openai/gpt-oss-120b',AI:{run:async()=>{calls++;return {response:output,usage:{prompt_tokens:1000,completion_tokens:500}};}}};
  await new AnalysisCache(store,p=>api.generateWorkersAnalysis(env,p)).get(plan);
  const saved=await new AnalysisCache(store,p=>api.generateWorkersAnalysis(env,p)).get(plan);
  assert.equal(calls,1);assert.equal(saved.cached,true);assert.equal(saved.usage.estimatedNeurons,65.909);
});
