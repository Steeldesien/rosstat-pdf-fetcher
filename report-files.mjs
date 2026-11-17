export const usesMultipart=path=>['/runner/deliver','/runner/card-upload','/runner/report-upload'].includes(path);
export class ReportFiles{
  constructor(store,send){this.store=store;this.send=send;}
  async deliver(job,key,kind,file=null){
    if(!/^[a-f0-9]{64}$/.test(key)||!['short','full'].includes(kind))throw Error('Invalid report file identity');
    const receiptKey=`report-file-delivery:${job}:${kind}`,cacheKey=`report-file:${key}:${kind}`;
    const previous=await this.store.get(receiptKey);
    if(previous)return {status:previous.status==='sent'?'completed':'delivery_uncertain'};
    const cached=await this.store.get(cacheKey);
    if(!cached&&!file)return {status:'needs_file'};
    if(!cached){
      if(typeof file.name!=='string'||file.name.length>180||/[\/\\\x00-\x1f]/.test(file.name)||!file.name.endsWith('.html')||!(file.bytes instanceof Uint8Array)||file.bytes.length>8*1024*1024||!/^\s*<!doctype html>|^\s*<html/i.test(new TextDecoder().decode(file.bytes.slice(0,150))))throw Error('Invalid HTML report');
    }
    await this.store.put(receiptKey,{status:'sending',at:Date.now()});
    try{
      const result=await this.send(cached?{fileId:cached.fileId,name:cached.name}:file);
      if(result.document?.file_id)await this.store.put(cacheKey,{fileId:result.document.file_id,name:cached?.name||file.name,at:Date.now()});
      await this.store.put(receiptKey,{status:'sent',at:Date.now()});return {status:'completed'};
    }catch{
      await this.store.put(receiptKey,{status:'uncertain',at:Date.now()});return {status:'delivery_uncertain'};
    }
  }
}
