import {DurableObject} from 'cloudflare:workers';
import {Coordinator, commandMode, connectionTarget, documentName, deliveryCaption, REPORTS, analysisModes, ANALYSIS_LABELS} from './coordinator.mjs';
import {AnalysisCache,analysisKey} from './analysis-cache.mjs';
import {AgyAuth} from './agy-auth.mjs';
import {generateWorkersAnalysis} from './workers-ai.mjs';
import {normalizeGrowthNarrative} from './workers-weekly.mjs';
import {reportProgress} from './status-messages.mjs';
import {generateEngineAnalysis,computedEngineSummary,engineArtifactKey,renderEngineAnalysis,validateEngineBundle} from './engine-analysis.mjs';
import {ReportFiles,usesMultipart,receiptResult} from './report-files.mjs';
import {ForecastJobs} from './forecast-jobs.mjs';
import {forecastAnalysisPlan,generateForecastAnalysis,renderForecastAnalysis} from './forecast-analysis.mjs';
import {publishSource,publishNarrative} from './report-delivery.mjs';
import {ScheduledDelivery,scheduledRelease} from './scheduled-delivery.mjs';
import {generateAnalysis,validatePlan,renderAnalysis,compactAnalysis,probeGemini} from './gemini.mjs';

const analysisAvailable=env=>env.ANALYSIS_ENABLED==='true'&&(env.ANALYSIS_PROVIDER==='workers-ai'?!!env.AI:!!env.GEMINI_API_KEY);
const richWeekly=(env,plan)=>env.ANALYSIS_PROVIDER==='workers-ai'&&env.WORKERS_AI_RICH_WEEKLY==='true'&&plan.kind==='inflation'&&plan.mode==='release';
const engineEnabled=(env,plan)=>env.INFLATION_ENGINE_ENABLED==='true'&&plan.kind==='inflation'&&plan.mode==='release';
const cachePlan=(env,plan)=>engineEnabled(env,plan)?{...plan,analysis_format:'private-wcpi-engine-v1'}:richWeekly(env,plan)?{...plan,analysis_format:'workers-weekly-full-v1'}:plan;

async function github(env, path, options={}) {
  if (!env.GITHUB_TOKEN) throw new Error('Dispatch credential is not configured');
  const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    ...options, signal:AbortSignal.timeout(20000), headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,
      Accept:'application/vnd.github+json','User-Agent':'Rosstat-Private-Coordinator','Content-Type':'application/json'}
  });
  if (!response.ok) throw new Error(`Dispatch HTTP ${response.status}`);
  return response.status===204 ? null : response.json();
}

async function telegram(env, method, options, timeout=85000) {
  const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method:'POST',...options,signal:AbortSignal.timeout(timeout)
  });
  const result=await response.json();
  if (!response.ok || !result.ok) throw Object.assign(new Error('Telegram did not confirm the request'),{telegramNotModified:method==='editMessageText'&&result.description?.includes('message is not modified')});
  return result.result;
}

function sendText(env,destination,text){
  return telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
    chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{}),text,
    link_preview_options:{is_disabled:true}})},10000);
}

function sendReportDocument(env,destination,payload,timeout=85000){
  const target={chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{})};
  if(payload.fileId)return telegram(env,'sendDocument',{headers:{'Content-Type':'application/json'},body:JSON.stringify({...target,document:payload.fileId})},timeout);
  const form=new FormData();
  for(const [key,value] of Object.entries(target))form.append(key,String(value));
  form.append('document',new Blob([payload.bytes],{type:payload.name.endsWith('.png')?'image/png':'text/html'}),payload.name);
  return telegram(env,'sendDocument',{body:form},timeout);
}

export class CoordinatorObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.storage=ctx.storage;this.env=env;
    this.scheduledDelivery=new ScheduledDelivery(ctx.storage);
    this.agyAuth=new AgyAuth(ctx.storage);
    this.analyses=new AnalysisCache(ctx.storage,plan=>{
      if(engineEnabled(env,plan))return generateEngineAnalysis(env,plan);
      if(richWeekly(env,plan)){const {analysis_format,...sourcePlan}=plan;return this.workersFullAnalyses.get(sourcePlan).then(result=>({...result,text:normalizeGrowthNarrative(result.text)}));}
      return env.ANALYSIS_PROVIDER==='workers-ai'&&plan.kind==='inflation'?generateWorkersAnalysis(env,plan):generateAnalysis(env,plan);
    });
    const probeStore={get:key=>ctx.storage.get('workers-ai-facts-v2:'+key),put:(key,value)=>ctx.storage.put('workers-ai-facts-v2:'+key,value)};
    this.workersAnalyses=new AnalysisCache(probeStore,plan=>generateWorkersAnalysis(env,plan));
    const fullStore={get:key=>ctx.storage.get('workers-full-week-v1:'+key),put:(key,value)=>ctx.storage.put('workers-full-week-v1:'+key,value)};
    this.workersFullAnalyses=new AnalysisCache(fullStore,plan=>generateWorkersAnalysis({...env,WORKERS_AI_RICH_WEEKLY:'true'},plan));
    this.coordinator=new Coordinator(ctx.storage,{...JSON.parse(env.SCHEDULE_JSON || '{"targets":[]}'),analysisEnabled:analysisAvailable(env)},{
      now:()=>Date.now(),
      progress:async(job,stage,previous)=>reportProgress(
        (method,payload)=>telegram(env,method,{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},10000),
        await ctx.storage.get('destination')||{chatId:env.TELEGRAM_CHAT_ID},job,stage,previous),
      dispatch:id=>github(env,'actions/workflows/download.yml/dispatches',{
        method:'POST',body:JSON.stringify({ref:'main',inputs:{job_id:id}})
      }),
      send:async(bytes,item,mode,job)=>{
        const destination=await ctx.storage.get('destination')||{chatId:env.TELEGRAM_CHAT_ID};
        const result=await publishSource({artifactsOnly:env.REPORT_ARTIFACTS_ONLY==='true',transport:(method,options)=>telegram(env,method,options),destination,bytes,item,mode});
        await this.mirror(job.id,scheduledRelease(job),'summary',destination,d=>sendText(env,d,deliveryCaption(item,mode)));
        return result;
      }
    });
    this.forecasts=new ForecastJobs(ctx.storage,{
      now:()=>Date.now(),
      analyze:data=>this.forecastAnalyses.get(forecastAnalysisPlan(data)),
      dispatch:id=>github(env,'actions/workflows/forecast.yml/dispatches',{method:'POST',body:JSON.stringify({ref:'main',inputs:{forecast_id:id}})}),
      sendSummary:async(text,job)=>{
        const d=await this.coordinator.destination()||{chatId:env.TELEGRAM_CHAT_ID};
        const result=await sendText(env,d,text);
        await this.mirror(job.id,!job.dry,'summary',d,target=>sendText(env,target,text));
        return result;
      },
      sendFile:async(payload,job,kind)=>{
        const d=await this.coordinator.destination()||{chatId:env.TELEGRAM_CHAT_ID};
        const result=await sendReportDocument(env,d,payload);
        await this.mirrorDocument(job.id,!job.dry,kind,d,result,payload);
        return result;
      }
    });
    const forecastStore={get:key=>ctx.storage.get('forecast-analysis-v1:'+key),put:(key,value)=>ctx.storage.put('forecast-analysis-v1:'+key,value)};
    this.forecastAnalyses=new AnalysisCache(forecastStore,plan=>generateForecastAnalysis(env,plan));
  }
  async mirror(id,eligible,part,primary,deliver){
    try{
      await this.scheduledDelivery.send(id,eligible,part,async target=>{
        if(String(target.chatId)===String(primary.chatId)&&target.threadId===primary.threadId)return;
        return deliver(target);
      });
    }catch{console.log('Additional scheduled delivery could not be recorded');}
  }
  async mirrorDocument(id,eligible,part,primary,result,payload){
    const fileId=result.document?.file_id;
    return this.mirror(id,eligible,part,primary,d=>sendReportDocument(this.env,d,fileId?{fileId}:payload,12000));
  }
  async invoke(method,args=[]) {
    if(method==='scheduledInvite')return this.coordinator.serial(()=>this.scheduledDelivery.invite());
    if(method==='scheduledConnect')return this.coordinator.serial(()=>this.scheduledDelivery.connect(...args));
    if(method==='scheduledDisconnect')return this.coordinator.serial(()=>this.scheduledDelivery.disconnect());
    if(method==='tick'){
      if(this.env.PRE_RELEASE_FORECAST_ENABLED==='true')await this.coordinator.serial(()=>this.forecasts.tick());
      return this.coordinator.tick();
    }
    if(method==='forecastTest')return this.coordinator.serial(()=>{
      const local=new Date(Date.now()+3*3600000),offset=(3-local.getUTCDay()+7)%7+(local.getUTCDay()===3&&local.getUTCHours()>=19?7:0);
      const day=new Date(Date.parse(local.toISOString().slice(0,10))+offset*86400000).toISOString().slice(0,10);
      return this.forecasts.enqueue('forecast-test-'+crypto.randomUUID(),day,true);
    });
    if(method==='forecastSummary')return this.forecasts.summary();
    if(method==='forecastAnalysisReview')return this.forecastAnalyses.review(forecastAnalysisPlan(args[0]),args[1]||'inspect',(p,raw)=>renderForecastAnalysis(p,p.engine,raw));
    if(method==='forecastClaim')return this.coordinator.serial(()=>this.forecasts.claim(...args));
    if(method==='forecastFinish')return this.coordinator.serial(()=>this.forecasts.finish(...args));
    if(method==='forecastFailure')return this.coordinator.serial(()=>this.forecasts.fail(...args));
    if(method==='forecastFile')return this.coordinator.serial(()=>this.forecasts.file(...args));
    if(method==='engineStatus'){
      const [id,owner,plan]=args,selection=await this.coordinator.analysisAccess(id,owner);
      validatePlan(plan,selection);
      if(!engineEnabled(this.env,plan))return {enabled:false};
      const saved=await this.analyses.review(cachePlan(this.env,plan),'inspect');
      const computed=await this.storage.get('engine-computed:'+saved.key);
      return {enabled:true,status:saved.record?.status==='ready'||computed?'ready':saved.record?.status||'missing'};
    }
    if(method==='reportFile'){
      const [id,owner,key,kind,file]=args;
      const selection=await this.coordinator.cardAccess(id,owner,key);
      return this.coordinator.serial(async()=>{
        const files=new ReportFiles(this.storage,async payload=>{
          const destination=await this.coordinator.destination()||{chatId:this.env.TELEGRAM_CHAT_ID};
          const result=await sendReportDocument(this.env,destination,payload);
          await this.mirrorDocument(id,scheduledRelease(selection.mirrorJob),kind,destination,result,payload);
          return result;
        });
        try{return await files.deliver(id,key,kind,file);}
        catch(error){
          await this.storage.put('report-diagnostic:'+id,{kind,error:error.message,at:Date.now(),metadata:file?{nameLength:file.name?.length,byteLength:file.bytes?.length,isUint8:file.bytes instanceof Uint8Array,prefix:new TextDecoder().decode(file.bytes?.slice(0,100))}:null});
          throw error;
        }
      });
    }
    if(method==='reportDiagnostic')return await this.storage.get('report-diagnostic:'+args[0])||null;
    if(method==='agyAuth')return this.coordinator.serial(()=>this.agyAuth[args[0]](...args.slice(1)));
    if(method==='workersPreview'){
      const plan=args[0];validatePlan(plan,{kind:plan.kind,mode:plan.mode});return this.workersAnalyses.get(plan);
    }
    if(method==='workersReview'){
      const [plan,action]=args;validatePlan(plan,{kind:plan.kind,mode:plan.mode});return this.workersAnalyses.review(plan,action,renderAnalysis);
    }
    if(method==='workersFullPreview'){
      const [plan,action]=args;validatePlan(plan,{kind:'inflation',mode:'release'});
      const result=await (action?this.workersFullAnalyses.review(plan,action,renderAnalysis):this.workersFullAnalyses.get(plan));
      return result?.text?{...result,text:normalizeGrowthNarrative(result.text)}:result;
    }
    if (method==='analyzeJob') return this.analyzeJob(...args);
    if (method==='sendAnalysisCard') return this.sendAnalysisCard(...args);
    if (method==='sourceArchive') {
      const [id,owner,documents]=args,selection=await this.coordinator.analysisAccess(id,owner);
      return this.coordinator.serial(async()=>{
        const storageKey='source-archive:'+selection.kind;
        const previous=await this.storage.get(storageKey)||[];
        if (documents) {
          if (!Array.isArray(documents)||documents.length>60) throw Error('Invalid archive');
          const safe=documents.map(d=>{
            const url=new URL(d.url),definition=REPORTS.find(r=>r.kind===selection.kind);
            if (url.protocol!=='https:'||url.username||url.password||url.port||url.hostname!=='rosstat.gov.ru'&& !url.hostname.endsWith('.rosstat.gov.ru')||
                typeof d.title!=='string'||d.title.length>1000||!definition.prefixes.some(p=>d.title.toLowerCase().startsWith(p))) throw Error('Invalid archive document');
            return {title:d.title,url:d.url,stamp:null};
          });
          const merged=[...new Map([...previous,...safe].map(d=>[d.url,d])).values()].slice(-160);
          await this.storage.put(storageKey,merged);return {ok:true};
        }
        return {documents:previous};
      });
    }
    if (method==='analysisPreview') {
      const plan=args[0];validatePlan(plan,{kind:plan.kind,mode:plan.mode});return this.analyses.get(cachePlan(this.env,plan));
    }
    if (method==='analysisReview') {
      const [plan,action]=args;validatePlan(plan,{kind:plan.kind,mode:plan.mode});
      const renderer=engineEnabled(this.env,plan)?(p,raw)=>renderEngineAnalysis(p,validateEngineBundle(p),raw):renderAnalysis;
      return this.analyses.review(cachePlan(this.env,plan),action,renderer);
    }
    if (method==='analysisStatus') return {enabled:analysisAvailable(this.env),keyConfigured:!!this.env.GEMINI_API_KEY,provider:this.env.ANALYSIS_PROVIDER||'gemini',workersBinding:!!this.env.AI,model:this.env.ANALYSIS_PROVIDER==='workers-ai'?this.env.WORKERS_AI_MODEL:this.env.GEMINI_MODEL||null,...(this.env.ANALYSIS_PROVIDER==='workers-ai'?{workersReports:['inflation'],otherReportsProvider:'gemini'}:{})};
    if (method==='cardSummary') {
      const cache=await this.storage.list({prefix:'summary-card:'}),deliveries=await this.storage.list({prefix:'summary-card-delivery:'});
      const reports=await this.storage.list({prefix:'report-file:'}),reportDeliveries=await this.storage.list({prefix:'report-file-delivery:'});
      return {cachedImages:cache.size,sent:[...deliveries.values()].filter(v=>v.status==='sent').length,reused:[...deliveries.values()].filter(v=>v.status==='sent'&&v.cached).length,
        cachedHtmlReports:reports.size,htmlDeliveries:[...reportDeliveries.entries()].map(([key,v])=>({job:key.split(':')[1],kind:key.split(':')[2],status:v.status})),
        imageDeliveries:[...deliveries.entries()].map(([key,v])=>({job:key.split(':')[1],status:v.status,format:v.format||'photo',cached:!!v.cached}))};
    }
    if (!['manual','resumeReports','tick','claim','deliver','backoff','waiting','release','progress','summary','importCompleted','connect','destination','analysisMenu','selectAnalysis'].includes(method)) throw new Error('Unknown operation');
    return this.coordinator[method](...args);
  }

  async analyzeJob(id,owner,plan,reason=null) {
    const selection=await this.coordinator.analysisAccess(id,owner);
    let text,status='failed',card=null;
    if (reason==='incomplete_archive') text='PDF доставлен. Для выбранного периода не удалось собрать полный набор выпусков с распознаваемыми датами. Анализ не запускался. Можно выбрать «Последний выпуск».';
    else {
      validatePlan(plan,selection);
      try {
        let result;
        try{result=await this.analyses.get(cachePlan(this.env,plan));}
        catch(error){
          if(!engineEnabled(this.env,plan))throw error;
          const key=await analysisKey(cachePlan(this.env,plan)),fallback=await this.storage.get('engine-computed:'+key);
          result=fallback||{key,text:computedEngineSummary(plan),createdAt:Date.now(),computed:true,cached:false};
          if(!fallback)await this.storage.put('engine-computed:'+key,{...result,cached:true});
        }
        const concise=engineEnabled(this.env,plan)?normalizeGrowthNarrative(result.text).replace(/без\s+уч[её]та\s+сезонности/giu,'с исключением сезонности'):compactAnalysis(result.text);
        text=concise+`\n\n${result.computed?'Расчётный отчёт':result.cached?'Сохранённый анализ':'Новый анализ'} · ${new Date(result.createdAt+5*3600000).toISOString().replace('T',' ').slice(0,19)} (UTC+5)`;
        status=result.computed?'calculated_without_ai':result.cached?'cached':'generated';
        card={key:engineEnabled(this.env,plan)?await engineArtifactKey(result.key,concise,result.computed):result.key,text:concise};
      } catch {
        text='PDF доставлен. Анализ сейчас недоступен: провайдер отказал в запросе, исчерпана квота либо ответ не удалось проверить. Подтверждённые результаты сохраняются; запросы с неопределённым исходом автоматически не повторяются.';
      }
    }
    if(selection.scheduled&&status==='failed'){
      const finished=await this.coordinator.finishAnalysis(id,owner,status);
      if(finished.progressUpdated)return finished;
    }
    const deliveryKey='analysis-delivery:'+id+(card&&engineEnabled(this.env,plan)?':'+card.key:''),saved=await this.storage.get(deliveryKey);
    if (!saved) {
      // Reserve before Telegram: a lost acknowledgement must not cause silent duplicates.
      await this.storage.put(deliveryKey,{status:'sending',at:Date.now()});
      const destination=await this.coordinator.destination()||{chatId:this.env.TELEGRAM_CHAT_ID};
      try {
        const publication=await publishNarrative({artifactsOnly:this.env.REPORT_ARTIFACTS_ONLY==='true',transport:(method,options)=>telegram(this.env,method,options),destination,text});
        await this.storage.put(deliveryKey,{status:publication.status,at:Date.now()});
      } catch {
        await this.storage.put(deliveryKey,{status:'uncertain',at:Date.now()});status='delivery_uncertain';
      }
    }
    const finished=await this.coordinator.finishAnalysis(id,owner,status,card?.key);
    return {...finished,...(card?{card}:{})};
  }

  async sendAnalysisCard(id,owner,key,bytes=null,name='Rosstat_summary.png') {
    const selection=await this.coordinator.cardAccess(id,owner,key);
    const documentPng=engineEnabled(this.env,selection);
    if(typeof name!=='string'||name.length>180||/[\/\\\x00-\x1f]/.test(name)||!name.endsWith('.png'))throw Error('Invalid PNG name');
    const cacheKey='summary-card:'+(documentPng?'engine-png-v1:':selection.mode==='release'?'neutral-v1:':'range-v2:')+key,deliveryKey='summary-card-delivery:'+id+(documentPng?':'+key:'');
    return this.coordinator.serial(async()=>{
      const receipt=await this.storage.get(deliveryKey);
      if(receipt)return receiptResult(receipt);
      const cached=await this.storage.get(cacheKey);
      if (!cached&&!bytes) return {status:'needs_image'};
      if (!cached&&(bytes.length>2*1024*1024||!bytes.slice(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i]))) throw Error('Invalid summary PNG');
      const destination=await this.coordinator.destination()||{chatId:this.env.TELEGRAM_CHAT_ID};
      await this.storage.put(deliveryKey,{status:'sending',at:Date.now()});
      try {
        let result;
        if (cached) result=await telegram(this.env,documentPng?'sendDocument':'sendPhoto',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
          chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{}),[documentPng?'document':'photo']:cached.fileId})});
        else {
          const form=new FormData();form.append('chat_id',destination.chatId);
          if(destination.threadId)form.append('message_thread_id',String(destination.threadId));
          form.append(documentPng?'document':'photo',new Blob([bytes],{type:'image/png'}),name);
          result=await telegram(this.env,documentPng?'sendDocument':'sendPhoto',{body:form});
        }
        const fileId=documentPng?result.document?.file_id:result.photo?.at(-1)?.file_id;
        if(documentPng)await this.mirrorDocument(id,scheduledRelease(selection.mirrorJob),'png',destination,result,cached?{fileId:cached.fileId}:{bytes,name});
        if(fileId)await this.storage.put(cacheKey,{fileId,createdAt:Date.now()});
        await this.storage.put(deliveryKey,{status:'sent',at:Date.now(),cached:!!cached,messageId:result.message_id,...(documentPng?{format:'png-document'}:{})});
        return {status:'completed'};
      } catch {
        await this.storage.put(deliveryKey,{status:'uncertain',at:Date.now()});
        return {status:'delivery_uncertain'};
      }
    });
  }
}

const reply=value=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
const validId=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if (path==='/health' && request.method==='GET') return reply({ok:true});
    const admin=path.startsWith('/admin/');
    const runner=path.startsWith('/runner/');
    if (path==='/telegram') {
      if (request.method!=='POST' || !env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
    } else if (admin || runner) {
      const expected=admin ? env.WEBHOOK_SECRET : env.BROKER_TOKEN;
      if (!expected || request.headers.get('Authorization')!==`Bearer ${expected}`) return new Response('Forbidden',{status:403});
    } else return new Response('Not found',{status:404});
    const object=env.COORDINATOR.getByName('private-delivery-state');
    try {
      if (path==='/telegram') {
        const update=await request.json();
        if (update.update_id<Number(env.MIN_UPDATE_ID||0)) return new Response('OK');
        const message=update.message,chat=message?.chat;
        const command=message?.text?.match(/^\/(invite_reports|disconnect_reports|connect)(?:@([a-z0-9_]+))?(?:\s+([a-f0-9]{32}))?\s*$/i);
        if(command&&(!command[2]||command[2].toLowerCase()===env.BOT_USERNAME?.replace(/^@/,'').toLowerCase())){
          const name=command[1].toLowerCase(),code=command[3];
          const isOwner=chat?.type==='private'&&String(message.from?.id)===String(env.TELEGRAM_CHAT_ID)&&String(chat.id)===String(env.TELEGRAM_CHAT_ID);
          if(isOwner&&name==='invite_reports'&&!code){
            const invite=await object.invoke('scheduledInvite');
            await sendText(env,{chatId:chat.id},`Код действует 30 минут и используется один раз. Передайте эту команду тому, кто добавит бота в группу:\n\n/connect@${env.BOT_USERNAME.replace(/^@/,'')} ${invite}`);
            return new Response('OK');
          }
          if(isOwner&&name==='disconnect_reports'&&!code){
            await object.invoke('scheduledDisconnect');
            await sendText(env,{chatId:chat.id},'Дополнительная группа отключена.');
            return new Response('OK');
          }
          if(name==='connect'&&code&&['group','supergroup'].includes(chat?.type)){
            const target={type:chat.type,chatId:String(chat.id),threadId:message.message_thread_id};
            const connected=await object.invoke('scheduledConnect',[code.toLowerCase(),target]);
            if(connected)await sendText(env,target,'Группа подключена к автоматической рассылке недельной инфляции. Здесь будут приходить предварительный прогноз и фактический выпуск по расписанию.');
            return new Response('OK');
          }
        }
        if (connectionTarget(update,env.TELEGRAM_CHAT_ID,env.BOT_USERNAME)) {
          const connected=await object.invoke('connect',[update,env.TELEGRAM_CHAT_ID,env.BOT_USERNAME||'']);
          if (!connected.replay) {
            try {
              await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
                chat_id:connected.target.chatId,...(connected.target.threadId?{message_thread_id:connected.target.threadId}:{}),
                text:'Этот чат подключён. Готовые отчёты будут приходить сюда. Для ручной загрузки выберите тип отчёта в меню команд бота.'
              })});
            } catch {
              await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,
                text:'Чат выбран, но бот не смог отправить туда подтверждение. Разрешите ему отправлять сообщения и документы, затем повторите /connect в группе.'})});
            }
          }
          return new Response('OK');
        }
        const destination=await object.invoke('destination');
        if (update.callback_query) {
          const callback=update.callback_query,chat=callback.message?.chat;
          const authorized=chat?.type==='private'&&String(chat.id)===String(env.TELEGRAM_CHAT_ID)||['group','supergroup'].includes(chat?.type)&&String(chat.id)===destination?.chatId;
          const choice=authorized?await object.invoke('selectAnalysis',[update]):null;
          try {await telegram(env,'answerCallbackQuery',{headers:{'Content-Type':'application/json'},body:JSON.stringify({callback_query_id:callback.id,text:choice?'Проверяю свежие выпуски…':'Меню устарело или открыто другим участником. Выберите команду заново.'})});}catch{}
          if (!choice) return new Response('OK');
          const selectedMode=choice.mode==='pdf'?(env.REPORT_ARTIFACTS_ONLY==='true'?'release':null):choice.mode;
          const job=await object.invoke('manual',['callback:'+callback.id,choice.kind,selectedMode]);
          if (job.created) {
            try {await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
              chat_id:chat.id,...(callback.message.message_thread_id?{message_thread_id:callback.message.message_thread_id}:{}),
              text:choice.mode==='pdf'?'Запрос на загрузку файла принят, ожидайте.':'Запрос передан на анализ, ожидайте.'
            })});}catch{console.log('Analysis acknowledgement unavailable');}
          }
          await object.invoke('tick');return new Response('OK');
        }
        const selected=commandMode(update,env.TELEGRAM_CHAT_ID,destination,env.BOT_USERNAME);
        if (!selected) return new Response('OK');
        const kind=selected==='latest'?'inflation':selected;
        if (analysisAvailable(env)) {
          const menu=await object.invoke('analysisMenu',[update,kind]);
          if (!menu.replay) await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:update.message.chat.id,
            ...(update.message.message_thread_id?{message_thread_id:update.message.message_thread_id}:{}),
            text:REPORTS.find(r=>r.kind===kind).label+'\nЗа какой период нужен анализ? Периоды отсчитываются от последнего выпуска. Повторный запрос готового анализа не обращается к нейронке.',
            reply_markup:{inline_keyboard:[...analysisModes(kind).map(mode=>[{text:ANALYSIS_LABELS[mode],callback_data:`an:${menu.id}:${mode}`}]),...(env.REPORT_ARTIFACTS_ONLY==='true'?[]:[[{text:'Только PDF — без анализа',callback_data:`an:${menu.id}:pdf`}]])]}})});
          return new Response('OK');
        }
        const job=await object.invoke('manual',[update.update_id,kind]);
        if (job.created) {
          try { await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:update.message.chat.id,
            ...(update.message.message_thread_id?{message_thread_id:update.message.message_thread_id}:{}),text:'Проверяю последний выпуск: '+REPORTS.find(r=>r.kind===kind).label+'. Файл поступит в подключённый чат.'})}); }
          catch {console.log('Command acknowledgement unavailable');}
        }
        await object.invoke('tick');
        return new Response('OK');
      }
      if (admin) {
        if(path==='/admin/gemini-probe'&&request.method==='POST')return reply(await probeGemini(env));
        if(path==='/admin/forecast-summary'&&request.method==='GET')return reply(await object.invoke('forecastSummary'));
        if(path==='/admin/forecast-analysis-review'&&request.method==='POST'){const d=await request.json();return reply(await object.invoke('forecastAnalysisReview',[d.data,d.action||'inspect']));}
        if(path==='/admin/forecast-test'&&request.method==='POST')return reply(await object.invoke('forecastTest'));
        if(path==='/admin/engine-probe'&&request.method==='POST'){
          try{return reply(await generateEngineAnalysis(env,await request.json()));}
          catch(error){return reply({ok:false,review:error.review||{stage:'bundle',validation:error.message}});}
        }
        if(path==='/admin/report-diagnostic'&&request.method==='POST'){
          const d=await request.json();return reply(await object.invoke('reportDiagnostic',[d.job_id]));
        }
        if(path==='/admin/agy-auth'&&request.method==='POST'){
          const d=await request.json();
          if(!['start','status','submit','diagnostic'].includes(d.op))return new Response('Invalid request',{status:400});
          return reply(await object.invoke('agyAuth',[d.op,...(d.op==='start'?[d.action]:d.op==='submit'?[d.session_id,d.code]:[d.session_id])]));
        }
        if (path==='/admin/summary' && request.method==='GET') return reply(await object.invoke('summary'));
        if (path==='/admin/analysis-status' && request.method==='GET') return reply(await object.invoke('analysisStatus'));
        if (path==='/admin/card-summary' && request.method==='GET') return reply(await object.invoke('cardSummary'));
        if (request.method!=='POST') return new Response('Method not allowed',{status:405});
        if (path==='/admin/analysis-preview') return reply(await object.invoke('analysisPreview',[await request.json()]));
        if (path==='/admin/workers-ai-preview') return reply(await object.invoke('workersPreview',[await request.json()]));
        if (path==='/admin/workers-ai-review') {const d=await request.json();return reply(await object.invoke('workersReview',[d.plan,d.action]));}
        if (path==='/admin/workers-ai-full-preview') {const d=await request.json();return reply(await object.invoke('workersFullPreview',[d.plan,d.action||null]));}
        if (path==='/admin/analysis-review') {
          const data=await request.json();return reply(await object.invoke('analysisReview',[data.plan,data.action]));
        }
        if (path==='/admin/import') {
          const data=await request.json();
          if (!Array.isArray(data.completed) || data.completed.length>2000) return new Response('Invalid import',{status:400});
          return reply(await object.invoke('importCompleted',[data.completed]));
        }
        if (path==='/admin/manual') {
          const data=await request.json();
          if (!validId(data.request_id)) return new Response('Invalid request',{status:400});
          return reply(await object.invoke('manual',[data.request_id,data.kind||'inflation',data.analysis_mode||null,data.source||null]));
        }
        if(path==='/admin/resume-reports'&&request.method==='POST'){
          const data=await request.json();if(!validId(data.job_id))return new Response('Invalid job',{status:400});
          return reply(await object.invoke('resumeReports',[data.job_id]));
        }
        if (path==='/admin/tick') return reply(await object.invoke('tick'));
      }
      if (runner && request.method==='POST') {
        if (Number(request.headers.get('Content-Length')||0)>25*1024*1024+65536) return new Response('Too large',{status:413});
        const form=usesMultipart(path) ? await request.formData() : null;
        const data=form ? Object.fromEntries(form) : await request.json();
        if(path==='/runner/agy-auth'&&validId(data.session_id)&&validId(data.run_id))return reply(await object.invoke('agyAuth',['runner',data.session_id,data.run_id,data.op,data]));
        if (!validId(data.job_id) || !validId(data.run_id)) return new Response('Invalid request',{status:400});
        if(path==='/runner/forecast-claim')return reply(await object.invoke('forecastClaim',[data.job_id,data.run_id]));
        if(path==='/runner/forecast-finish')return reply(await object.invoke('forecastFinish',[data.job_id,data.run_id,data.result]));
        if(path==='/runner/forecast-failure')return reply(await object.invoke('forecastFailure',[data.job_id,data.run_id,data.error]));
        if(path==='/runner/forecast-file')return reply(await object.invoke('forecastFile',[data.job_id,data.run_id,data.kind,null]));
        if(path==='/runner/forecast-upload'&&data.document instanceof File)return reply(await object.invoke('forecastFile',[data.job_id,data.run_id,data.kind,{name:data.document.name,bytes:new Uint8Array(await data.document.arrayBuffer())}]));
        if(path==='/runner/engine-status')return reply(await object.invoke('engineStatus',[data.job_id,data.run_id,data.plan]));
        if(path==='/runner/report')return reply(await object.invoke('reportFile',[data.job_id,data.run_id,data.key,data.kind,null]));
        if(path==='/runner/report-upload'&&data.document instanceof File)return reply(await object.invoke('reportFile',[data.job_id,data.run_id,data.key,data.kind,{name:data.document.name,bytes:new Uint8Array(await data.document.arrayBuffer())}]));
        if(path==='/runner/card')return reply(await object.invoke('sendAnalysisCard',[data.job_id,data.run_id,data.key]));
        if(path==='/runner/card-upload'&&data.image instanceof File)return reply(await object.invoke('sendAnalysisCard',[data.job_id,data.run_id,data.key,new Uint8Array(await data.image.arrayBuffer()),data.image.name]));
        if (path==='/runner/claim') return reply(await object.invoke('claim',[data.job_id,data.run_id]));
        if (path==='/runner/progress') return reply(await object.invoke('progress',[data.job_id,data.run_id,data.stage,data.key]));
        if (path==='/runner/release') return reply(await object.invoke('release',[data.job_id,data.run_id]));
        if (path==='/runner/backoff') return reply(await object.invoke('backoff',[data.job_id,data.run_id,data.seconds]));
        if (path==='/runner/waiting') return reply(await object.invoke('waiting',[data.job_id,data.run_id]));
        if (path==='/runner/archive') return reply(await object.invoke('sourceArchive',[data.job_id,data.run_id]));
        if (path==='/runner/archive-save') return reply(await object.invoke('sourceArchive',[data.job_id,data.run_id,data.documents]));
        if (path==='/runner/analyze') return reply(await object.invoke('analyzeJob',[data.job_id,data.run_id,data.plan]));
        if (path==='/runner/analysis-failure' && data.reason==='incomplete_archive') return reply(await object.invoke('analyzeJob',[data.job_id,data.run_id,null,data.reason]));
        if (form && data.document instanceof File) {
          const bytes=new Uint8Array(await data.document.arrayBuffer());
          return reply(await object.invoke('deliver',[data.job_id,data.run_id,bytes,
            {title:String(data.title||'Росстат'),url:String(data.source_url||''),stamp:data.publication_stamp?Number(data.publication_stamp):NaN,
              catalogueDate:String(data.catalogue_date||''),
              receivedStamp:Number.isFinite(Number(data.received_stamp))?Number(data.received_stamp):Date.now()/1000}]));
        }
      }
      return new Response('Not found',{status:404});
    } catch (error) {
      console.log('Private coordinator operation failed');
      if (admin && ['/admin/analysis-preview','/admin/analysis-review','/admin/workers-ai-preview','/admin/workers-ai-review','/admin/workers-ai-full-preview'].includes(path)) return reply({ok:false,providerStatus:error.providerStatus||null,error:error.name==='TimeoutError'?'timeout':error.message?.includes('uncertain')?'uncertain':error.message?.includes('evidence')?'evidence_validation':'analysis_failed',...(error.review?{review:error.review}:{})});
      return new Response('Retry later',{status:503});
    }
  },
  async scheduled(controller,env) {
    await env.COORDINATOR.getByName('private-delivery-state').invoke('tick');
  }
};
