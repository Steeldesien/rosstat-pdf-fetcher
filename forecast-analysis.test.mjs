import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisCache} from './analysis-cache.mjs';
import {forecastAnalysisPlan,generateForecastAnalysis} from './forecast-analysis.mjs';
const data={asof:'2026-11-09',start:'2026-11-10',end:'2026-11-16',key:'a'.repeat(64),bundle:{version:1,mode:'forecast',start:'2026-11-10',end:'2026-11-16',sourceHashes:['a'.repeat(64)],facts:[{id:'point',label:'Прогноз прироста за неделю',value:'+0,15%',origin:'forecast'}],warnings:['Это прогноз до публикации Росстата.'],context:{asof:'2026-11-09',history_dates:['2026-11-09']}}};
test('forecast analysis is explicitly labelled and cached per forecast without repeated inference',async()=>{
 let calls=0;const map=new Map(),env={AI:{run:async()=>{calls++;return {response:{summary:'Прогноз прироста цен — {{point}}.',observations:[],conclusion:'Факт пока неизвестен.'}};}}};
 const cache=new AnalysisCache({get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)},p=>generateForecastAnalysis(env,p));
 const plan=forecastAnalysisPlan(data),a=await cache.get(plan),b=await cache.get(plan);
 assert.match(a.text,/Предрелизный прогноз инфляции/);assert.match(a.text,/\+0,15%/);assert.equal(calls,1);assert.equal(b.cached,true);
 await cache.get(forecastAnalysisPlan({...data,key:'b'.repeat(64),bundle:{...data.bundle,sourceHashes:['b'.repeat(64)]}}));assert.equal(calls,2);
});
test('future facts and unsupported model figures cannot enter the pre-release analysis',async()=>{
 assert.throws(()=>forecastAnalysisPlan({...data,bundle:{...data.bundle,context:{asof:data.asof,history_dates:['2026-11-16']}}}),/future/i);
 await assert.rejects(generateForecastAnalysis({AI:{run:async()=>({response:{summary:'Рост 99%.',observations:[],conclusion:'Прогноз.'}})}},forecastAnalysisPlan(data)),/numeric/i);
});
