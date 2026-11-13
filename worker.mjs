import {DurableObject} from 'cloudflare:workers';
import {Coordinator, commandMode, connectionTarget, documentName, deliveryCaption, REPORTS, analysisModes, ANALYSIS_LABELS} from './coordinator.mjs';
import {AnalysisCache} from './analysis-cache.mjs';
import {generateAnalysis,validatePlan,renderAnalysis,compactAnalysis} from './gemini.mjs';

async function github(env, path, options={}) {
  if (!env.GITHUB_TOKEN) throw new Error('Dispatch credential is not configured');
  const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    ...options, signal:AbortSignal.timeout(20000), headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,
      Accept:'application/vnd.github+json','User-Agent':'Rosstat-Private-Coordinator','Content-Type':'application/json'}
  });
  if (!response.ok) throw new Error(`Dispatch HTTP ${response.status}`);
  return response.status===204 ? null : response.json();
}

async function telegram(env, method, options) {
  const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method:'POST',...options,signal:AbortSignal.timeout(85000)
  });
  const result=await response.json();
  if (!response.ok || !result.ok) throw new Error('Telegram did not confirm the request');
  return result.result;
}

export class CoordinatorObject extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.storage=ctx.storage;this.env=env;
    this.analyses=new AnalysisCache(ctx.storage,plan=>generateAnalysis(env,plan));
    this.coordinator=new Coordinator(ctx.storage,{...JSON.parse(env.SCHEDULE_JSON || '{"targets":[]}'),analysisEnabled:env.ANALYSIS_ENABLED==='true'&&!!env.GEMINI_API_KEY},{
      now:()=>Date.now(),
      dispatch:id=>github(env,'actions/workflows/download.yml/dispatches',{
        method:'POST',body:JSON.stringify({ref:'main',inputs:{job_id:id}})
      }),
      send:async(bytes,item,mode)=>{
        const destination=await ctx.storage.get('destination')||{chatId:env.TELEGRAM_CHAT_ID};
        const form=new FormData();
        form.append('chat_id',destination.chatId);
        if (destination.threadId) form.append('message_thread_id',String(destination.threadId));
        form.append('caption',deliveryCaption(item,mode));
        form.append('document',new Blob([bytes],{type:'application/pdf'}),documentName(item.title));
        return telegram(env,'sendDocument',{body:form});
      }
    });
  }
  async invoke(method,args=[]) {
    if (method==='analyzeJob') return this.analyzeJob(...args);
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
      const plan=args[0];validatePlan(plan,{kind:plan.kind,mode:plan.mode});return this.analyses.get(plan);
    }
    if (method==='analysisReview') {
      const [plan,action]=args;validatePlan(plan,{kind:plan.kind,mode:plan.mode});return this.analyses.review(plan,action,renderAnalysis);
    }
    if (method==='analysisStatus') return {enabled:this.env.ANALYSIS_ENABLED==='true',keyConfigured:!!this.env.GEMINI_API_KEY,model:this.env.GEMINI_MODEL||null};
    if (!['manual','tick','claim','deliver','backoff','waiting','release','summary','importCompleted','connect','destination','analysisMenu','selectAnalysis'].includes(method)) throw new Error('Unknown operation');
    return this.coordinator[method](...args);
  }

  async analyzeJob(id,owner,plan,reason=null) {
    const selection=await this.coordinator.analysisAccess(id,owner);
    let text,status='failed';
    if (reason==='incomplete_archive') text='PDF доставлен. Для выбранного периода не удалось собрать полный набор выпусков с распознаваемыми датами. Анализ не запускался. Можно выбрать «Последний выпуск».';
    else {
      validatePlan(plan,selection);
      try {
        const result=await this.analyses.get(plan);
        text=compactAnalysis(result.text)+`\n\n${result.cached?'Сохранённый анализ':'Новый анализ'} · ${new Date(result.createdAt+5*3600000).toISOString().replace('T',' ').slice(0,19)} (UTC+5)`;
        status=result.cached?'cached':'generated';
      } catch {
        text='PDF доставлен. Анализ сейчас недоступен: провайдер отказал в запросе, исчерпана квота либо ответ не удалось проверить. Подтверждённые результаты сохраняются; запросы с неопределённым исходом автоматически не повторяются.';
      }
    }
    const deliveryKey='analysis-delivery:'+id,saved=await this.storage.get(deliveryKey);
    if (!saved) {
      // Reserve before Telegram: a lost acknowledgement must not cause silent duplicates.
      await this.storage.put(deliveryKey,{status:'sending',at:Date.now()});
      const destination=await this.coordinator.destination()||{chatId:this.env.TELEGRAM_CHAT_ID};
      try {
        const chunks=[text];
        for (const chunk of chunks) await telegram(this.env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
          chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{}),text:chunk,link_preview_options:{is_disabled:true}})});
        await this.storage.put(deliveryKey,{status:'sent',at:Date.now()});
      } catch {
        await this.storage.put(deliveryKey,{status:'uncertain',at:Date.now()});status='delivery_uncertain';
      }
    }
    return this.coordinator.finishAnalysis(id,owner,status);
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
        if (connectionTarget(update,env.TELEGRAM_CHAT_ID,env.BOT_USERNAME)) {
          const connected=await object.invoke('connect',[update,env.TELEGRAM_CHAT_ID,env.BOT_USERNAME||'']);
          if (!connected.replay) {
            try {
              await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({
                chat_id:connected.target.chatId,...(connected.target.threadId?{message_thread_id:connected.target.threadId}:{}),
                text:'Этот чат подключён. Автоматические PDF будут приходить сюда. Для ручной загрузки выберите тип отчёта в меню команд бота.'
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
          await object.invoke('manual',['callback:'+callback.id,choice.kind,choice.mode==='pdf'?null:choice.mode]);
          await object.invoke('tick');return new Response('OK');
        }
        const selected=commandMode(update,env.TELEGRAM_CHAT_ID,destination,env.BOT_USERNAME);
        if (!selected) return new Response('OK');
        const kind=selected==='latest'?'inflation':selected;
        if (env.ANALYSIS_ENABLED==='true' && env.GEMINI_API_KEY) {
          const menu=await object.invoke('analysisMenu',[update,kind]);
          if (!menu.replay) await telegram(env,'sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:update.message.chat.id,
            ...(update.message.message_thread_id?{message_thread_id:update.message.message_thread_id}:{}),
            text:REPORTS.find(r=>r.kind===kind).label+'\nЗа какой период нужен анализ? Периоды отсчитываются от последнего выпуска. Повторный запрос готового анализа не обращается к нейронке.',
            reply_markup:{inline_keyboard:[...analysisModes(kind).map(mode=>[{text:ANALYSIS_LABELS[mode],callback_data:`an:${menu.id}:${mode}`}]),[{text:'Только PDF — без анализа',callback_data:`an:${menu.id}:pdf`}]]}})});
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
        if (path==='/admin/summary' && request.method==='GET') return reply(await object.invoke('summary'));
        if (path==='/admin/analysis-status' && request.method==='GET') return reply(await object.invoke('analysisStatus'));
        if (request.method!=='POST') return new Response('Method not allowed',{status:405});
        if (path==='/admin/analysis-preview') return reply(await object.invoke('analysisPreview',[await request.json()]));
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
          return reply(await object.invoke('manual',[data.request_id,data.kind||'inflation',data.analysis_mode||null]));
        }
        if (path==='/admin/tick') return reply(await object.invoke('tick'));
      }
      if (runner && request.method==='POST') {
        if (Number(request.headers.get('Content-Length')||0)>25*1024*1024+65536) return new Response('Too large',{status:413});
        const form=path==='/runner/deliver' ? await request.formData() : null;
        const data=form ? Object.fromEntries(form) : await request.json();
        if (!validId(data.job_id) || !validId(data.run_id)) return new Response('Invalid request',{status:400});
        if (path==='/runner/claim') return reply(await object.invoke('claim',[data.job_id,data.run_id]));
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
      if (admin && ['/admin/analysis-preview','/admin/analysis-review'].includes(path)) return reply({ok:false,providerStatus:error.providerStatus||null,error:error.name==='TimeoutError'?'timeout':error.message?.includes('uncertain')?'uncertain':error.message?.includes('evidence')?'evidence_validation':'analysis_failed',...(error.review?{review:error.review}:{})});
      return new Response('Retry later',{status:503});
    }
  },
  async scheduled(controller,env) {
    await env.COORDINATOR.getByName('private-delivery-state').invoke('tick');
  }
};
