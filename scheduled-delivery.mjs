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

  async connect(code,chat,confirm){
    if(!['group','supergroup'].includes(chat.type))return false;
    const invite=await this.store.get('scheduled-invite');
    if(!invite||invite.expires<=this.now()||invite.code!==code)return false;
    const {chatId,threadId}=chat;
    await confirm({chatId,threadId});
    await this.store.put('scheduled-destination',{chatId,...(threadId?{threadId}:{}),version:crypto.randomUUID()});
    await this.store.delete('scheduled-invite');
    return true;
  }

  async disconnect(){
    await this.store.delete('scheduled-destination');
    await this.store.delete('scheduled-invite');
  }

  async send(id,eligible,part,deliver,notify){
    if(!eligible)return;
    const destination=await this.store.get('scheduled-destination');
    if(!destination)return;
    const key=`scheduled-mirror:${id}`;
    let receipt=await this.store.get(key);
    if(part==='summary'&&!receipt){
      receipt={version:destination.version,summary:'sending'};
      await this.store.put(key,receipt);
    }else{
      if(!receipt||receipt.version!==destination.version||receipt[part]||receipt.summary!=='sent')return;
      receipt[part]='sending';
      await this.store.put(key,receipt);
    }
    const {version,...chat}=destination;
    try{await deliver(chat);receipt[part]='sent';}
    catch{receipt[part]='uncertain';}
    await this.store.put(key,receipt);
    if(receipt[part]==='uncertain'){
      const alert={id,part,attempts:0,nextAt:this.now()};
      const alertKey=`${ALERT_PREFIX}${id}:${part}`;
      await this.store.put(alertKey,alert);
      await this.tryAlert(alertKey,alert,notify);
    }
  }

  async tryAlert(key,alert,notify){
    if(alert.nextAt>this.now())return;
    try{await notify(alert.id,alert.part);}
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
