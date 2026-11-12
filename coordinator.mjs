export function commandMode(update, owner) {
  const message = update.message || {}, chat = message.chat || {};
  const command = (message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  return Number.isSafeInteger(update.update_id) && String(chat.id) === String(owner) &&
    chat.type === 'private' && command === '/latest' ? 'latest' : null;
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
  try {
    const end=reportEnd(text);
    const start=text.match(new RegExp('(?:^| )с\\s+(\\d{1,2})(?:\\s+('+months.join('|')+'))?(?:\\s+(\\d{4})(?:\\s+года?)?)?\\s+по\\s'));
    if (!end || !start) return 'Rosstat.pdf';
    const endMonth=Number(end.slice(5,7)),month=start[2]?months.indexOf(start[2])+1:endMonth;
    const year=start[3]?Number(start[3]):Number(end.slice(0,4))-(month>endMonth?1:0);
    const first=`${year}-${String(month).padStart(2,'0')}-${start[1].padStart(2,'0')}`;
    const date=new Date(first+'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0,10)!==first || first>end) return 'Rosstat.pdf';
    const format=value=>value.split('-').reverse().join('.');
    const prefix=text.startsWith('об оценке индекса потребительских цен')?'Инфляция':'Росстат';
    return `${prefix}_${format(first)}–${format(end)}.pdf`;
  } catch {return 'Rosstat.pdf';}
}

function expectedEnd(start) {
  const date=new Date(start.slice(0,10)+'T00:00:00Z');
  date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
  return date.toISOString().slice(0,10);
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

  async manual(updateId) {
    return this.serial(async () => {
      const state=await this.state(), key=String(updateId);
      if (state.requests[key] && state.jobs[state.requests[key]]) return {id: state.requests[key], created: false};
      const id=crypto.randomUUID();
      state.jobs[id]={id,kind:'inflation',mode:'latest',phase:'queued',createdAt:this.effects.now(),lastDispatch:0};
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
          ...(target.kind==='inflation'?{report_end:target.report_end||expectedEnd(target.start)}:{}),
          start:target.start,targetId:target.id,phase:'queued',createdAt:now,lastDispatch:0};
      }
      await this.save(state);
      for (const job of Object.values(state.jobs)) {
        if (!['queued','running'].includes(job.phase) || (job.retryUntil||0)>now || (job.leaseUntil||0)>now) continue;
        // A dispatched but not-yet-started workflow gets 10 minutes to enter the queue.
        if (job.lastDispatch && now-job.lastDispatch<600000) continue;
        job.lastDispatch=now;
        await this.save(state);
        try { await this.effects.dispatch(job.id); }
        catch { job.lastDispatch=now-540000; await this.save(state); }
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
      const publicJob={id:job.id,kind:job.kind,mode:job.mode};
      if (job.mode==='scheduled') publicJob.not_before=job.not_before;
      if (job.report_end) publicJob.report_end=job.report_end;
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
      if (new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-' || bytes.length>25*1024*1024 || !sourceAllowed(item.url)) throw new Error('Invalid public document');
      if (job.report_end) {
        if (reportEnd(item.title)!==job.report_end) throw new Error('Wrong reporting period');
      } else if (job.mode==='scheduled' && (!Number.isFinite(item.stamp) || item.stamp*1000<Date.parse(job.not_before))) throw new Error('Stale release');
      job.phase='sending'; await this.save(state);
      try {
        const result=await this.effects.send(bytes,item,job.mode);
        job.phase='completed'; job.messageId=result.message_id; job.deliveredAt=this.effects.now();
        job.fileName=result.document?.file_name||null;
        job.sourceUrl=item.url;
        if (job.targetId && !state.completed.includes(job.targetId)) state.completed.push(job.targetId);
        await this.save(state);
        return {status:'completed'};
      } catch (error) {
        // A lost Telegram response is ambiguous. Do not silently send duplicates.
        job.phase='needs_review'; await this.save(state);
        throw new Error('Telegram confirmation missing');
      }
    });
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
    return {completed:state.completed.length,jobs:Object.values(state.jobs).map(j=>({id:j.id,kind:j.kind,mode:j.mode,phase:j.phase,createdAt:j.createdAt,deliveredAt:j.deliveredAt||null,fileName:j.fileName||null}))};
  }
}
