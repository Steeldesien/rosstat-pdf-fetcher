function commandName(update,botUsername='') {
  const raw=(update.message?.text||'').trim().split(/\s+/)[0].toLowerCase();
  const [command,mention]=raw.split('@');
  return mention && botUsername && mention!==botUsername.toLowerCase() ? null : command;
}

export function connectionTarget(update,owner,botUsername='') {
  const message=update.message||{},chat=message.chat||{};
  if (!Number.isSafeInteger(update.update_id) || commandName(update,botUsername)!=='/connect' || String(message.from?.id)!==String(owner)) return null;
  if (!['group','supergroup','private'].includes(chat.type) || !Number.isSafeInteger(chat.id)) return null;
  if (chat.type==='private' && String(chat.id)!==String(owner)) return null;
  return {chatId:String(chat.id),type:chat.type,
    ...(Number.isSafeInteger(message.message_thread_id)&&message.message_thread_id>0?{threadId:message.message_thread_id}:{})};
}

export function commandMode(update, owner, destination=null, botUsername='') {
  const message = update.message || {}, chat = message.chat || {};
  const authorized=chat.type==='private' && String(chat.id)===String(owner) ||
    ['group','supergroup'].includes(chat.type) && String(chat.id)===destination?.chatId;
  if (!Number.isSafeInteger(update.update_id) || !authorized) return null;
  const command=commandName(update,botUsername);
  if (command==='/latest') return 'latest';
  return REPORTS.find(item=>command==='/'+item.command)?.kind||null;
}

function sourceAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password &&
      (!u.port || u.port === '443') && (u.hostname === 'rosstat.gov.ru' || u.hostname.endsWith('.rosstat.gov.ru'));
  } catch { return false; }
}

function dayStart(start) {
  return start.slice(0, 10) + 'T00:00:00' + (start.match(/(Z|[+-]\d\d:\d\d)$/)?.[1] || 'Z');
}

export function reportEnd(title) {
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const match=title.toLowerCase().match(new RegExp('по\\s+(\\d{1,2})\\s+('+months.join('|')+')\\s+(\\d{4})'));
  if (!match) return null;
  const result=`${match[3]}-${String(months.indexOf(match[2])+1).padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  return new Date(result+'T00:00:00Z').toISOString().slice(0,10)===result ? result : null;
}

export function documentName(title) {
  const text=String(title).replace(/\s+/g,' ').toLowerCase();
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const otherMonths=['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
  const monthMap=Object.fromEntries([...months.map((m,i)=>[m,i]),...otherMonths.map((m,i)=>[m,i])]);
  const monthPattern=Object.keys(monthMap).join('|');
  const prefix=REPORTS.find(item=>item.prefixes.some(p=>text.startsWith(p)))?.file_prefix||'Росстат';
  try {
    const format=value=>value.split('-').reverse().join('.');
    const quarter=text.match(/\b(iv|iii|ii|i)\s+квартал[а-я]*\s+(\d{4})/);
    if (quarter && (text.includes('ввп') || text.includes('валового внутреннего продукта'))) {
      const firstMonth=['i','ii','iii','iv'].indexOf(quarter[1])*3;
      const first=new Date(Date.UTC(Number(quarter[2]),firstMonth,1)).toISOString().slice(0,10);
      const last=new Date(Date.UTC(Number(quarter[2]),firstMonth+3,0)).toISOString().slice(0,10);
      return `ВВП_${format(first)}-${format(last)}.pdf`;
    }
    const end=reportEnd(text);
    const start=text.match(new RegExp('(?:^| )с\\s+(\\d{1,2})(?:\\s+('+months.join('|')+'))?(?:\\s+(\\d{4})(?:\\s+года?)?)?\\s+по\\s'));
    if (!end || !start) {
      const point=text.match(new RegExp('на\\s+конец\\s+('+monthPattern+')\\s+(\\d{4})'));
      if (point) {
        const last=new Date(Date.UTC(Number(point[2]),monthMap[point[1]]+1,0)).toISOString().slice(0,10);
        return `${prefix}_на_${format(last)}.pdf`;
      }
      const period=text.match(new RegExp('(?:^| )(?:в|за)\\s+('+monthPattern+')(?:\\s*[-–]\\s*('+monthPattern+'))?\\s+(\\d{4})'));
      if (!period) {
        const annual=text.match(/(?:^| )(?:в|за)\s+(20\d{2})\s+год/);
        return annual?`${prefix}_01.01.${annual[1]}-31.12.${annual[1]}.pdf`:'Rosstat.pdf';
      }
      const firstMonth=monthMap[period[1]],lastMonth=period[2]?monthMap[period[2]]:firstMonth,year=Number(period[3]);
      const first=new Date(Date.UTC(year-(firstMonth>lastMonth?1:0),firstMonth,1)).toISOString().slice(0,10);
      const last=new Date(Date.UTC(year,lastMonth+1,0)).toISOString().slice(0,10);
      return `${prefix}_${format(first)}-${format(last)}.pdf`;
    }
    const endMonth=Number(end.slice(5,7)),month=start[2]?months.indexOf(start[2])+1:endMonth;
    const year=start[3]?Number(start[3]):Number(end.slice(0,4))-(month>endMonth?1:0);
    const first=`${year}-${String(month).padStart(2,'0')}-${start[1].padStart(2,'0')}`;
    const date=new Date(first+'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0,10)!==first || first>end) return 'Rosstat.pdf';
    return `${prefix}_${format(first)}-${format(end)}.pdf`;
  } catch {return 'Rosstat.pdf';}
}

function expectedEnd(start) {
  const date=new Date(start.slice(0,10)+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
  return date.toISOString().slice(0,10);
}

export function deliveryCaption(item,mode) {
  const format=stamp=>{
    if (!Number.isFinite(stamp)) return 'не указано';
    const date=new Date((stamp+5*3600)*1000);
    if (!Number.isFinite(+date)) return 'не указано';
    const text=date.toISOString();
    return text.slice(0,10).split('-').reverse().join('.')+' '+text.slice(11,19);
  };
  const publication=Number.isFinite(item.stamp)?format(item.stamp):'время не указано';
  const catalogue=!Number.isFinite(item.stamp)&&/^\d{4}-\d{2}-\d{2}$/.test(item.catalogueDate||'')?
    '\nДата файла в каталоге: '+item.catalogueDate.split('-').reverse().join('.'):'';
  const footer=`Опубликовано Росстатом: ${publication}${catalogue}\nПолучено ботом: ${format(item.receivedStamp)}\nЕкатеринбург (UTC+5)\n${mode==='latest'?'Ручная загрузка':'Автоматическая доставка'}`;
  return `${String(item.title||'Росстат')+'\n'+String(item.url||'')}`.slice(0,1023-footer.length)+'\n'+footer;
}

export function dueTargets(config, now) {
  const targets = [...(config.targets || [])];
  if (config.recurring) {
    // Regular Wednesday window, 21:00 Asia/Yekaterinburg = 16:00 UTC.
    const date = new Date(now);
    date.setUTCHours(16, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - 3 + 7) % 7));
    if (+date > now) date.setUTCDate(date.getUTCDate() - 7);
    const explicitEnd = Math.max(0, ...targets.filter(t => t.kind === 'inflation').map(t => Date.parse(t.start)));
    const dates=[];
    if (!explicitEnd) dates.push(+date);
    else for(let stamp=explicitEnd+7*86400000;stamp<=+date;stamp+=7*86400000) dates.push(stamp);
    for(const stamp of dates) {
      const localDay=new Date(stamp+5*3600000).toISOString().slice(0,10);
      targets.push({id:`inflation:${localDay}`,kind:'inflation',start:`${localDay}T21:00:00+05:00`});
    }
  }
  return targets.filter(target=>Date.parse(target.start)<=now);
}

export class Coordinator {
  constructor(store, config, effects) {
    this.store = store; this.config = config; this.effects = effects;
    this.queue = Promise.resolve();
  }

  async serial(action) {
    const previous = this.queue;
    let unlock;
    this.queue = new Promise(resolve => {unlock = resolve;});
    await previous;
    try { return await action(); } finally { unlock(); }
  }

  async state() {
    return await this.store.get('coordinator') || {jobs: {}, requests: {}, completed: []};
  }

  async destination() {
    return await this.store.get('destination')||null;
  }

  async connect(update,owner,botUsername='') {
    const target=connectionTarget(update,owner,botUsername);
    if (!target) throw new Error('Only the owner can connect a chat');
    return this.serial(async()=>{
      const previous=await this.destination();
      if (previous?.updateId===update.update_id) return {target:previous,replay:true};
      const saved={...target,updateId:update.update_id};
      await this.store.put('destination',saved);
      return {target:saved,replay:false};
    });
  }

  cadence(now) {
    const shifted=new Date(now+5*3600000);
    const hour=shifted.getUTCHours();
    const interval=hour>=21 && hour<23 ? 60 : 3600;
    const next=new Date(+shifted); next.setUTCHours(21,0,0,0);
    if (+next<=+shifted) next.setUTCDate(next.getUTCDate()+1);
    return {interval,nextFastStart:+next-5*3600000};
  }

  async save(state) {
    // Keep active jobs; retain only the most recent 200 completed/held jobs.
    const old = Object.values(state.jobs).filter(j => ['completed','cancelled','needs_review'].includes(j.phase)).sort((a,b) => b.createdAt-a.createdAt);
    for (const job of old.slice(200)) delete state.jobs[job.id];
    const requests = Object.entries(state.requests);
    for (const [key] of requests.slice(0, Math.max(0, requests.length-500))) delete state.requests[key];
    state.completed = state.completed.slice(-1000);
    await this.store.put('coordinator', state);
  }

  async analysisMenu(update,kind) {
    if (!REPORT_KINDS.has(kind)) throw Error('Unsupported report');
    return this.serial(async()=>{
      const key='analysis-menu-update:'+update.update_id;
      const previous=await this.store.get(key);
      if (previous) return {...previous,replay:true};
      const id=crypto.randomUUID().replaceAll('-','').slice(0,16),message=update.message;
      const menu={id,kind,chatId:String(message.chat.id),userId:String(message.from.id),threadId:message.message_thread_id||0,expires:this.effects.now()+3600000};
      await this.store.put('analysis-menu:'+id,menu);
      await this.store.put(key,menu);
      return menu;
    });
  }

  async selectAnalysis(update) {
    const callback=update.callback_query,match=callback?.data?.match(/^an:([a-f0-9]{16}):(pdf|release|m1|m2|m3|m6|m12)$/);
    if (!match) return null;
    const menu=await this.store.get('analysis-menu:'+match[1]);
    if (!menu || menu.expires<this.effects.now() || String(callback.from?.id)!==menu.userId ||
        String(callback.message?.chat?.id)!==menu.chatId || (callback.message?.message_thread_id||0)!==menu.threadId ||
        match[2]!=='pdf'&&!analysisModes(menu.kind).includes(match[2])) return null;
    return {kind:menu.kind,mode:match[2]};
  }

  async manual(updateId,kind='inflation',analysisMode=null) {
    if (!REPORT_KINDS.has(kind)) throw new Error('Unsupported report');
    if (analysisMode && !analysisModes(kind).includes(analysisMode)) throw Error('Unsupported analysis mode');
    return this.serial(async () => {
      const state=await this.state(), key=String(updateId);
      if (state.requests[key] && state.jobs[state.requests[key]]) return {id: state.requests[key], created: false};
      const id=crypto.randomUUID();
      state.jobs[id]={id,kind,mode:'latest',phase:'queued',createdAt:this.effects.now(),lastDispatch:0};
      if (analysisMode) state.jobs[id].analysisMode=analysisMode;
      state.requests[key]=id;
      await this.save(state);
      return {id,created:true};
    });
  }

  async tick() {
    return this.serial(async () => {
      const state=await this.state(), now=this.effects.now();
      for (const target of dueTargets(this.config,now)) {
        if (state.completed.includes(target.id)) continue;
        const existing=Object.values(state.jobs).find(j=>j.targetId===target.id);
        if (existing) continue;
        const id=crypto.randomUUID();
        state.jobs[id]={id,kind:target.kind,mode:'scheduled',not_before:dayStart(target.start),
          ...(this.config.analysisEnabled?{analysisMode:'release'}:{}),
          ...(target.kind==='inflation'?{report_end:target.report_end||expectedEnd(target.start)}:{}),
          ...(target.kind==='gdp'?{gdp_period:target.gdp_period||target.id.match(/(\d{4}-Q[1-4])$/)?.[1]}:{}),
          start:target.start,targetId:target.id,phase:'queued',createdAt:now,lastDispatch:0};
      }
      await this.save(state);
      for (const job of Object.values(state.jobs)) {
        if (!['queued','running'].includes(job.phase) || (job.retryUntil||0)>now || (job.leaseUntil||0)>now) continue;
        // A dispatched but not-yet-started workflow gets 10 minutes to enter the queue.
        if (job.lastDispatch && now-job.lastDispatch<600000) continue;
        if(!job.pdfDelivered)await this.updateProgress(state,job,'search');
        job.lastDispatch=now;
        await this.save(state);
        try { await this.effects.dispatch(job.id); }
        catch { job.lastDispatch=now-540000; await this.save(state);await this.updateProgress(state,job,'error'); }
      }
      return {ok:true};
    });
  }

  async claim(id, owner) {
    return this.serial(async () => {
      const state=await this.state(), job=state.jobs[id], now=this.effects.now();
      if (!job) throw new Error('Unknown job');
      if (['completed','cancelled','needs_review'].includes(job.phase)) return {status:job.phase};
      if (job.phase==='sending') return {status:'needs_review'};
      if (job.owner && job.owner!==owner && job.leaseUntil>now) return {status:'busy'};
      if ((job.retryUntil||0)>now) return {status:'backoff',retry_after:Math.ceil((job.retryUntil-now)/1000)};
      if (job.lastCheck && job.lastCheck+this.cadence(now).interval*1000>now) {
        job.retryUntil=Math.min(job.lastCheck+this.cadence(now).interval*1000,this.cadence(now).nextFastStart);
        await this.save(state);
        return {status:'backoff',retry_after:Math.ceil((job.retryUntil-now)/1000)};
      }
      job.owner=owner; job.leaseUntil=now+180000; job.phase='running';job.lastCheck=now;
      await this.save(state);
      if(!job.pdfDelivered)await this.updateProgress(state,job,'search');
      const publicJob={id:job.id,kind:job.kind,mode:job.mode};
      if (job.analysisMode) publicJob.analysis_mode=job.analysisMode;
      if (job.mode==='scheduled') publicJob.not_before=job.not_before;
      if (job.report_end) publicJob.report_end=job.report_end;
      if (job.gdp_period) publicJob.gdp_period=job.gdp_period;
      return {status:'ready',job:publicJob};
    });
  }

  async backoff(id,owner,seconds) {
    return this.serial(async () => {
      const state=await this.state(), job=state.jobs[id];
      if (!job || job.owner!==owner) throw new Error('Invalid lease');
      job.retryUntil=this.effects.now()+Math.max(60,Math.min(86400,Number(seconds)||900))*1000;
      job.leaseUntil=0;
      await this.save(state);
      return {ok:true};
    });
  }

  async updateProgress(state,job,stage) {
    if(job.mode!=='scheduled'||!this.effects.progress||job.progressStage===stage)return;
    // An unknown initial send outcome must never create duplicate status messages.
    if(job.progressUncertain&&!job.progressMessage)return;
    if(!job.progressMessage){job.progressUncertain=true;await this.save(state);}
    try{
      const receipt=await this.effects.progress(job,stage,job.progressMessage||null);
      if(!receipt?.messageId)throw Error('Status message not confirmed');
      job.progressMessage=receipt;job.progressStage=stage;job.progressUncertain=false;job.progressError=false;
    }catch{job.progressError=true;job.progressUncertain=!job.progressMessage;}
    await this.save(state);
  }

  async progress(id,owner,stage,key=null) {
    return this.serial(async()=>{
      const state=await this.state(),job=state.jobs[id];
      if(!job||job.owner!==owner||!['downloading','error','card_error'].includes(stage))throw Error('Invalid progress lease');
      if(stage==='card_error'){
        if(job.phase!=='completed'||!job.pdfDelivered||!job.analysisKey||job.analysisKey!==key)throw Error('Invalid card progress');
        await this.updateProgress(state,job,stage);return {ok:true};
      }
      if(job.pdfDelivered||job.phase!=='running')return {ok:true};
      await this.updateProgress(state,job,stage);return {ok:true};
    });
  }

  async waiting(id,owner) {
    return this.serial(async()=>{
      const state=await this.state(),job=state.jobs[id],now=this.effects.now();
      if (!job || job.owner!==owner || job.phase!=='running') throw new Error('Invalid lease');
      const cadence=this.cadence(now),interval=cadence.interval;
      job.retryUntil=Math.max(now,Math.min((job.lastCheck||now)+interval*1000,cadence.nextFastStart));
      await this.save(state);
      return {interval_seconds:interval};
    });
  }

  async release(id,owner) {
    return this.serial(async () => {
      const state=await this.state(), job=state.jobs[id];
      if (job && job.owner===owner && job.phase==='running') {
        job.phase='queued'; job.owner=null; job.leaseUntil=0; job.lastDispatch=0;
        await this.save(state);
      }
      return {ok:true};
    });
  }

  async deliver(id,owner,bytes,item) {
    return this.serial(async () => {
      const state=await this.state(),job=state.jobs[id];
      if (!job) throw new Error('Unknown job');
      if (job.phase==='completed') return {status:'completed'};
      if (job.phase!=='running' || job.owner!==owner) throw new Error('Invalid lease');
      if (job.pdfDelivered) return {status:'completed'};
      if (new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-' || bytes.length>25*1024*1024 || !sourceAllowed(item.url)) throw new Error('Invalid public document');
      if (job.gdp_period) {
        const match=item.title.toLowerCase().match(/\b(iv|iii|ii|i)\s+квартал[а-я]*\s+(\d{4})/);
        if (!match || `${match[2]}-Q${['i','ii','iii','iv'].indexOf(match[1])+1}`!==job.gdp_period) throw new Error('Wrong GDP period');
      }
      if (job.report_end) {
        if (reportEnd(item.title)!==job.report_end) throw new Error('Wrong reporting period');
      } else if (job.mode==='scheduled' && (!Number.isFinite(item.stamp) || item.stamp*1000<Date.parse(job.not_before))) throw new Error('Stale release');
      await this.updateProgress(state,job,'downloading');
      await this.updateProgress(state,job,'loaded');
      job.phase='sending'; await this.save(state);
      try {
        const result=await this.effects.send(bytes,item,job.mode);
        job.phase=job.analysisMode?'running':'completed'; job.pdfDelivered=true;job.messageId=result.message_id; job.deliveredAt=this.effects.now();
        job.fileName=result.document?.file_name||null;
        job.publicationStamp=Number.isFinite(item.stamp)?item.stamp:null;
        job.receivedStamp=Number.isFinite(item.receivedStamp)?item.receivedStamp:null;
        job.caption=result.caption||null;
        job.sourceUrl=item.url;
        if (job.targetId && !state.completed.includes(job.targetId)) state.completed.push(job.targetId);
        await this.save(state);
        return {status:'completed'};
      } catch (error) {
        // A lost Telegram response is ambiguous. Do not silently send duplicates.
        job.phase='needs_review'; await this.save(state);
        await this.updateProgress(state,job,'error');
        throw new Error('Telegram confirmation missing');
      }
    });
  }

  async analysisAccess(id,owner) {
    return this.serial(async()=>{
      const state=await this.state(),job=state.jobs[id];
      if (!job || job.owner!==owner || !job.analysisMode || !job.pdfDelivered || job.phase!=='running') throw Error('Invalid analysis lease');
      job.leaseUntil=this.effects.now()+300000;await this.save(state);
      return {kind:job.kind,mode:job.analysisMode,scheduled:job.mode==='scheduled'};
    });
  }

  async finishAnalysis(id,owner,status,analysisKey=null) {
    return this.serial(async()=>{
      const state=await this.state(),job=state.jobs[id];
      if (!job || job.owner!==owner || !job.pdfDelivered || !job.analysisMode) throw Error('Invalid analysis lease');
      job.phase='completed';job.analysisStatus=String(status).slice(0,60);
      if (analysisKey && /^[a-f0-9]{64}$/.test(analysisKey)) job.analysisKey=analysisKey;
      await this.save(state);
      if(['failed','delivery_uncertain'].includes(status))await this.updateProgress(state,job,'analysis_error');
      return {status:'completed',progressUpdated:job.progressStage==='analysis_error'};
    });
  }

  async cardAccess(id,owner,key) {
    const state=await this.state(),job=state.jobs[id];
    if (!job || job.owner!==owner || job.phase!=='completed' || !job.analysisKey || job.analysisKey!==key) throw Error('Invalid card delivery');
    return {kind:job.kind,mode:job.analysisMode};
  }

  async importCompleted(ids) {
    return this.serial(async()=>{
      const state=await this.state();
      state.completed=[...new Set([...state.completed,...ids.filter(id=>typeof id==='string')])];
      await this.save(state); return {ok:true,completed:state.completed.length};
    });
  }

  async summary() {
    const state=await this.state();
    return {completed:state.completed.length,destination:await this.destination(),jobs:Object.values(state.jobs).map(j=>({id:j.id,kind:j.kind,mode:j.mode,phase:j.phase,createdAt:j.createdAt,deliveredAt:j.deliveredAt||null,fileName:j.fileName||null,publicationStamp:j.publicationStamp??null,receivedStamp:j.receivedStamp??null,caption:j.caption||null,analysisMode:j.analysisMode||null,analysisStatus:j.analysisStatus||null}))};
  }
}
import reportDefinitions from './reports.json' with {type:'json'};
export const REPORTS=reportDefinitions;
const REPORT_KINDS=new Set(REPORTS.map(item=>item.kind));
export function analysisModes(kind) {
  if (!REPORT_KINDS.has(kind)) throw Error('Unsupported report');
  return ['inflation','fuel'].includes(kind)?['release','m1','m2','m3']:kind==='gdp'?['release','m6','m12']:['release','m3','m6','m12'];
}
export const ANALYSIS_LABELS={release:'Последний выпуск',m1:'Последний месяц',m2:'Последние 2 месяца',m3:'Последние 3 месяца',m6:'Последние 6 месяцев',m12:'Последние 12 месяцев'};

