import {DurableObject} from 'cloudflare:workers';
import {Coordinator, commandMode, connectionTarget, documentName, deliveryCaption, REPORTS} from './coordinator.mjs';

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
    this.coordinator=new Coordinator(ctx.storage,JSON.parse(env.SCHEDULE_JSON || '{"targets":[]}'),{
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
    if (!['manual','tick','claim','deliver','backoff','waiting','release','summary','importCompleted','connect','destination'].includes(method)) throw new Error('Unknown operation');
    return this.coordinator[method](...args);
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
        const selected=commandMode(update,env.TELEGRAM_CHAT_ID,destination,env.BOT_USERNAME);
        if (!selected) return new Response('OK');
        const kind=selected==='latest'?'inflation':selected;
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
        if (request.method!=='POST') return new Response('Method not allowed',{status:405});
        if (path==='/admin/import') {
          const data=await request.json();
          if (!Array.isArray(data.completed) || data.completed.length>2000) return new Response('Invalid import',{status:400});
          return reply(await object.invoke('importCompleted',[data.completed]));
        }
        if (path==='/admin/manual') {
          const data=await request.json();
          if (!validId(data.request_id)) return new Response('Invalid request',{status:400});
          return reply(await object.invoke('manual',[data.request_id,data.kind||'inflation']));
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
        if (form && data.document instanceof File) {
          const bytes=new Uint8Array(await data.document.arrayBuffer());
          return reply(await object.invoke('deliver',[data.job_id,data.run_id,bytes,
            {title:String(data.title||'Росстат'),url:String(data.source_url||''),stamp:data.publication_stamp?Number(data.publication_stamp):NaN,
              catalogueDate:String(data.catalogue_date||''),
              receivedStamp:Number.isFinite(Number(data.received_stamp))?Number(data.received_stamp):Date.now()/1000}]));
        }
      }
      return new Response('Not found',{status:404});
    } catch {
      console.log('Private coordinator operation failed');
      return new Response('Retry later',{status:503});
    }
  },
  async scheduled(controller,env) {
    await env.COORDINATOR.getByName('private-delivery-state').invoke('tick');
  }
};
