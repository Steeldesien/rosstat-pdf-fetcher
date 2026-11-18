import {ReportFiles,validateReportFile} from './report-files.mjs';
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s));
const pct=n=>(n>=0?'+':'')+n.toFixed(2).replace('.',',')+'%';
export class ForecastJobs{
  constructor(store,effects){this.store=store;this.effects=effects;}
  async tick(){
    const now=this.effects.now(),local=new Date(now+3*3600000);
    if(local.getUTCDay()!==3||local.getUTCHours()<14||local.getUTCHours()>=19)return {scheduled:false};
    const day=local.toISOString().slice(0,10),id='forecast-'+day;
    const existing=await this.store.get('forecast-job:'+id);
    if(existing){
      if(['failed','dispatch_uncertain'].includes(existing.status)&&(existing.attempts||1)<2&&now-(existing.lastDispatch||existing.createdAt)>=15*60000){
        existing.owner=null;existing.status='queued';existing.attempts=(existing.attempts||1)+1;existing.lastDispatch=now;await this.store.put('forecast-job:'+id,existing);
        try{await this.effects.dispatch(id);}catch{existing.status='dispatch_uncertain';await this.store.put('forecast-job:'+id,existing);}
        return {id,scheduled:true};
      }
      return {scheduled:false};
    }
    return this.enqueue(id,day,false);
  }
  async enqueue(id,day,dry=false){
    const end=new Date(Date.parse(day)-2*86400000).toISOString().slice(0,10);
    const job={id,day,expected_end:end,cutoff:Date.parse(day+'T19:00:00+03:00'),dry,status:'queued',createdAt:this.effects.now(),lastDispatch:this.effects.now(),attempts:1};
    await this.store.put('forecast-job:'+id,job);
    try{await this.effects.dispatch(id);}catch{job.status='dispatch_uncertain';await this.store.put('forecast-job:'+id,job);}
    return {id,scheduled:true};
  }
  async claim(id,owner){
    const job=await this.store.get('forecast-job:'+id);
    if(!job)throw Error('Unknown forecast job');
    if(job.status==='completed'||job.status==='late')return {status:'completed'};
    if(job.owner&&job.owner!==owner)throw Error('Forecast job is already owned');
    job.owner=owner;job.status='running';await this.store.put('forecast-job:'+id,job);
    return {status:'ready',expected_end:job.expected_end,dry:job.dry};
  }
  async access(id,owner){const job=await this.store.get('forecast-job:'+id);if(!job||job.owner!==owner)throw Error('Invalid forecast owner');return job;}
  async fail(id,owner,type){const job=await this.access(id,owner);job.status='failed';job.error=/^[A-Za-z]{1,50}$/.test(type)?type:'Failure';await this.store.put('forecast-job:'+id,job);return {ok:true};}
  async finish(id,owner,data){
    const job=await this.access(id,owner);
    if(!date(data.asof)||!date(data.start)||!date(data.end)||data.end!==job.expected_end||data.asof>=data.start||data.start>data.end||!['v1','v2'].includes(data.model)||![data.point,data.lo80,data.hi80].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<100)||data.lo80>data.hi80||!/^[a-f0-9]{64}$/.test(data.key))throw Error('Invalid forecast period or values');
    job.result={format:data.format===2?2:1,asof:data.asof,start:data.start,end:data.end,point:data.point,lo80:data.lo80,hi80:data.hi80,model:data.model,key:data.key,shadow:!!data.shadow};
    if(this.effects.now()>=job.cutoff&&!job.dry){job.status='late';await this.store.put('forecast-job:'+id,job);return {status:'late'};}
    if(data.format===2&&!job.analysis){
      // The provider cache retains pending/uncertain outcomes and blocks automatic resubmission.
      try{const result=await this.effects.analyze(data);job.analysis={status:'ready',text:result.text,key:result.key,model:result.model,cached:!!result.cached,usage:result.usage};}
      catch{job.analysis={status:'unavailable'};}
      await this.store.put('forecast-job:'+id,job);
    }
    if(this.effects.now()>=job.cutoff&&!job.dry){job.status='late';await this.store.put('forecast-job:'+id,job);return {status:'late'};}
    if(!job.summary){
      job.summary=job.dry?'dry':'sending';await this.store.put('forecast-job:'+id,job);
      if(!job.dry){
        const text=`Предварительный прогноз инфляции · ${data.start} — ${data.end}\n\nОжидаемый прирост: ${pct(data.point)}. Интервал прогноза 80%: ${pct(data.lo80)} … ${pct(data.hi80)}.\n\nДанные по ${data.asof}. Это прогноз до публикации Росстата; вечером будет сопоставление с фактом.`;
        try{await this.effects.sendSummary(text);job.summary='sent';}catch{job.summary='uncertain';}
      }
    }
    job.status='files';await this.store.put('forecast-job:'+id,job);return {status:'computed',dry:job.dry,analysisStatus:job.analysis?.status||'disabled'};
  }
  async file(id,owner,kind,file=null){
    const job=await this.access(id,owner);
    if(!job.result||!['short','full','png'].includes(kind))throw Error('Forecast is not computed');
    let result;
    if(job.dry){
      if(!file&&!job.files?.[kind])return {status:'needs_file'};
      if(file){validateReportFile(file,kind);job.files={...job.files,[kind]:{status:'sent',bytes:file.bytes.length}};}
      result={status:'completed'};
    }else{
      if(this.effects.now()>=job.cutoff){job.status='late';await this.store.put('forecast-job:'+id,job);return {status:'late'};}
      const files=new ReportFiles(this.store,payload=>this.effects.sendFile(payload));
      result=await files.deliver(id,job.result.key,kind,file);
      if(result.status==='completed')job.files={...job.files,[kind]:{status:'sent'}};
    }
    const required=job.result.format===2?['short','full','png']:['short','full'];
    if(required.every(k=>job.files?.[k]?.status==='sent'))job.status=job.summary==='uncertain'?'needs_review':'completed';
    await this.store.put('forecast-job:'+id,job);return result;
  }
  async summary(){const records=await this.store.list({prefix:'forecast-job:'});return [...records.values()].map(j=>({id:j.id,day:j.day,status:j.status,dry:j.dry,result:j.result||null,summary:j.summary||null,analysis:j.analysis?{status:j.analysis.status,key:j.analysis.key,cached:j.analysis.cached,usage:j.analysis.usage}:null,files:j.files||{}}));}
}
