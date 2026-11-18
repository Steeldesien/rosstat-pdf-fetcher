export function scheduledRelease(job){
  return job?.kind==='inflation'&&job.mode==='scheduled'&&!!job.targetId&&!job.repairOnly;
}

const ALERT_PREFIX='scheduled-alert:';
const ALERT_DELAYS=[5,15,30].map(minutes=>minutes*60000);
const MODEL_NOTE='scheduled-model-note';

export class ScheduledDelivery {
  constructor(store,now=Date.now){this.store=store;this.now=now;}

  async invite(){
    const code=crypto.randomUUID().replaceAll('-','');
    await this.store.put('scheduled-invite',{code,expires:this.now()+30*60*1000});
    return code;
  }

  async destinations(){
    const current=await this.store.get('scheduled-destinations');
    if(current)return current;
    const previous=await this.store.get('scheduled-destination');
    return previous?[previous]:[];
  }

  async connect(code,chat,confirm){
    if(!['group','supergroup'].includes(chat.type))return false;
    const invite=await this.store.get('scheduled-invite');
    if(!invite||invite.expires<=this.now()||invite.code!==code)return false;
    const {chatId,threadId,title}=chat;
    await confirm({chatId,threadId});
    const destinations=[...await this.destinations()];
    const index=destinations.findIndex(d=>d.chatId===chatId);
    const previous=destinations[index];
    const destination={chatId,...(threadId?{threadId}:{}),...(title?{title}:{}),...(previous?.mode?{mode:previous.mode}:{}),
      version:previous&&previous.threadId===threadId?previous.version:crypto.randomUUID()};
    if(index<0)destinations.push(destination);
    else destinations[index]=destination;
    await this.store.put('scheduled-destinations',destinations);
    await this.store.delete('scheduled-invite');
    return true;
  }

  async disconnect(){
    const destinations=[...await this.destinations()];
    const removed=destinations.pop();
    await this.store.put('scheduled-destinations',destinations);
    await this.store.delete('scheduled-invite');
    return removed??null;
  }

  async configureModes(fullId,pngId,note){
    const destinations=await this.destinations();
    if(fullId===pngId||!destinations.some(d=>d.chatId===fullId)||!destinations.some(d=>d.chatId===pngId))throw Error('Expected two distinct connected groups');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(note.day)||typeof note.name!=='string'||note.name.length>180||/[\\/\x00-\x1f]/.test(note.name)||!note.name.endsWith('.pdf')||!(note.bytes instanceof Uint8Array)||note.bytes.length>100000||new TextDecoder().decode(note.bytes.slice(0,5))!=='%PDF-')throw Error('Invalid model PDF');
    const full=destinations.find(d=>d.chatId===fullId);
    const existing=await this.store.get(MODEL_NOTE);
    if(existing&&(existing.day!==note.day||existing.version!==full.version))throw Error('A different one-time PDF is already configured');
    await this.store.put('scheduled-destinations',destinations.map(d=>d.chatId===fullId?{...d,mode:'full'}:d.chatId===pngId?{...d,mode:'actual_png'}:d));
    if(!existing||existing.status==='pending')await this.store.put(MODEL_NOTE,{...note,version:full.version,status:'pending'});
    return {day:note.day,modelNote:existing?.status??'pending'};
  }

  async modelNoteStatus(){
    const note=await this.store.get(MODEL_NOTE);
    if(!note)return null;
    const status={day:note.day,status:note.status};
    if(note.bytes){
      const digest=await crypto.subtle.digest('SHA-256',note.bytes);
      status.sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    return status;
  }

  async send(id,eligible,part,deliver,notify){
    if(!eligible)return;
    const destinations=(await this.destinations()).filter(d=>d.mode!=='actual_png'||(!id.startsWith('forecast-')&&part==='png'));
    const results=await Promise.allSettled(destinations.map(destination=>this.sendTo(id,part,destination,deliver,notify)));
    if(results.some(result=>result.status==='rejected'))throw Error('Could not record one or more scheduled deliveries');
  }

  async sendTo(id,part,destination,deliver,notify){
    const key=`scheduled-mirror:${id}:${destination.version}`;
    let receipt=await this.store.get(key);
    if(!receipt){
      const legacy=await this.store.get(`scheduled-mirror:${id}`);
      if(legacy?.version===destination.version)receipt=legacy;
    }
    const pngOnly=destination.mode==='actual_png';
    if((part==='summary'||pngOnly)&&!receipt){
      receipt={version:destination.version,[part]:'sending'};
      await this.store.put(key,receipt);
    }else{
      if(!receipt||receipt.version!==destination.version||receipt[part]||(!pngOnly&&receipt.summary!=='sent'))return;
      receipt[part]='sending';
      await this.store.put(key,receipt);
    }
    const {chatId,threadId,title}=destination;
    const chat={chatId,...(threadId?{threadId}:{})};
    try{await deliver(chat);receipt[part]='sent';}
    catch{receipt[part]='uncertain';}
    await this.store.put(key,receipt);
    if(receipt[part]==='uncertain'){
      const alert={id,part,chat:{...chat,title},attempts:0,nextAt:this.now()};
      const alertKey=`${ALERT_PREFIX}${id}:${destination.version}:${part}`;
      await this.store.put(alertKey,alert);
      await this.tryAlert(alertKey,alert,notify);
    }
  }

  async sendModelNote(id,deliver,notify){
    const note=await this.store.get(MODEL_NOTE);
    if(note?.status!=='pending'||id!==`forecast-${note.day}`)return;
    const destination=(await this.destinations()).find(d=>d.version===note.version&&d.mode==='full');
    if(!destination)return;
    const receipt=await this.store.get(`scheduled-mirror:${id}:${destination.version}`);
    if(!['summary','png','short','full'].every(part=>receipt?.[part]==='sent'))return;
    const marker={day:note.day,version:note.version,status:'sending'};
    await this.store.put(MODEL_NOTE,marker);
    try{await deliver(destination,{name:note.name,bytes:note.bytes});}
    catch{
      await this.store.put(MODEL_NOTE,{...marker,status:'uncertain'});
      if(notify){
        const key=`${ALERT_PREFIX}${id}:${note.version}:model`;
        const alert={id,part:'model',chat:{title:destination.title},attempts:0,nextAt:this.now()};
        await this.store.put(key,alert);
        await this.tryAlert(key,alert,notify);
      }
      return;
    }
    await this.store.put(MODEL_NOTE,{...marker,status:'sent'});
  }

  async tryAlert(key,alert,notify){
    if(alert.nextAt>this.now())return;
    try{await notify(alert.id,alert.part,alert.chat);}
    catch{
      const delay=ALERT_DELAYS[alert.attempts];
      if(delay!==undefined){
        await this.store.put(key,{...alert,attempts:alert.attempts+1,nextAt:this.now()+delay});
        return;
      }
      console.log('Scheduled delivery alert exhausted its retries');
    }
    await this.store.delete(key);
  }

  async retryAlerts(notify){
    const records=await this.store.list({prefix:ALERT_PREFIX});
    for(const [key,alert] of records){
      if(alert.nextAt>this.now())continue;
      await this.tryAlert(key,alert,notify);
      break;
    }
  }
}
