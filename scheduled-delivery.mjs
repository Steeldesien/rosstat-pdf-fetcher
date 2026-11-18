export function scheduledRelease(job){
  return job?.kind==='inflation'&&job.mode==='scheduled'&&!!job.targetId&&!job.repairOnly;
}

export class ScheduledDelivery {
  constructor(store,now=Date.now){this.store=store;this.now=now;}

  async invite(){
    const code=crypto.randomUUID().replaceAll('-','');
    await this.store.put('scheduled-invite',{code,expires:this.now()+30*60*1000});
    return code;
  }

  async connect(code,chat){
    if(!['group','supergroup'].includes(chat.type))return false;
    const invite=await this.store.get('scheduled-invite');
    if(!invite||invite.expires<=this.now()||invite.code!==code)return false;
    const {chatId,threadId}=chat;
    await this.store.put('scheduled-destination',{chatId,...(threadId?{threadId}:{}),version:crypto.randomUUID()});
    await this.store.delete('scheduled-invite');
    return true;
  }

  async disconnect(){
    await this.store.delete('scheduled-destination');
    await this.store.delete('scheduled-invite');
  }

  async send(id,eligible,part,deliver){
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
  }
}
