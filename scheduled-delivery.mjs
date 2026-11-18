export function scheduledRelease(job){
  return job?.kind==='inflation'&&job.mode==='scheduled'&&!!job.targetId&&!job.repairOnly;
}

const ALERT_PREFIX='scheduled-alert:';
const ALERT_DELAYS=[5,15,30].map(minutes=>minutes*60000);

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
    const destination={chatId,...(threadId?{threadId}:{}),...(title?{title}:{}),
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

  async send(id,eligible,part,deliver,notify){
    if(!eligible)return;
    const destinations=await this.destinations();
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
    if(part==='summary'&&!receipt){
      receipt={version:destination.version,summary:'sending'};
      await this.store.put(key,receipt);
    }else{
      if(!receipt||receipt.version!==destination.version||receipt[part]||receipt.summary!=='sent')return;
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
