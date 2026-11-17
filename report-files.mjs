export const usesMultipart=path=>['/runner/deliver','/runner/card-upload','/runner/report-upload','/runner/forecast-upload'].includes(path);
export const receiptResult=receipt=>({status:receipt.status==='sent'?'completed':'delivery_uncertain'});
export function validateHtmlFile(file){
  if(typeof file?.name!=='string'||file.name.length>180||/[\/\\\x00-\x1f]/.test(file.name)||!file.name.endsWith('.html')||!(file.bytes instanceof Uint8Array)||file.bytes.length>8*1024*1024||!/^\s*<!doctype html>|^\s*<html/i.test(new TextDecoder().decode(file.bytes.slice(0,150))))throw Error('Invalid HTML report');
}
export function validateReportFile(file,kind){
  if(kind!=='png')return validateHtmlFile(file);
  const b=file?.bytes;
  if(typeof file?.name!=='string'||file.name.length>180||/[\/\\\x00-\x1f]/.test(file.name)||!file.name.endsWith('.png')||!(b instanceof Uint8Array)||b.length<24||b.length>8*1024*1024||![137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)||new TextDecoder().decode(b.slice(12,16))!=='IHDR')throw Error('Invalid PNG report');
  const view=new DataView(b.buffer,b.byteOffset,b.byteLength),w=view.getUint32(16),h=view.getUint32(20);
  if(!w||!h||w>10000||h>10000)throw Error('Invalid PNG dimensions');
}
export class ReportFiles{
  constructor(store,send){this.store=store;this.send=send;}
  async deliver(job,key,kind,file=null){
    if(!/^[a-f0-9]{64}$/.test(key)||!['short','full','png'].includes(kind))throw Error('Invalid report file identity');
    const receiptKey=`report-file-delivery:${job}:${kind}:${key}`,cacheKey=`report-file:${key}:${kind}`;
    const previous=await this.store.get(receiptKey);
    if(previous)return receiptResult(previous);
    const cached=await this.store.get(cacheKey);
    if(!cached&&!file)return {status:'needs_file'};
    if(!cached){
      validateReportFile(file,kind);
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
