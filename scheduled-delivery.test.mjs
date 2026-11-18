import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduledDelivery,scheduledRelease} from './scheduled-delivery.mjs';

test('only scheduled weekly releases can reach the additional group',()=>{
  const job={kind:'inflation',mode:'scheduled',targetId:'inflation:2026-11-18'};
  assert.equal(scheduledRelease(job),true);
  assert.equal(scheduledRelease({...job,mode:'latest'}),false);
  assert.equal(scheduledRelease({...job,repairOnly:true}),false);
  assert.equal(scheduledRelease({...job,targetId:null}),false);
});

test('a code connects one group topic once, and only new eligible jobs use it',async()=>{
  const data=new Map();
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,v),delete:k=>data.delete(k)},()=>0);
  const code=await route.invite();
  const confirm=async()=>{};
  assert.equal(await route.connect(code,{type:'private',chatId:'1'},confirm),false);
  assert.equal(await route.connect(code,{type:'supergroup',chatId:'-2',threadId:3},confirm),true);
  assert.equal(await route.connect(code,{type:'group',chatId:'-3'},confirm),false);
  const calls=[];
  const send=async d=>calls.push(d);
  await route.send('test',false,'summary',send);
  await route.send('release',true,'short',send);
  await route.send('release',true,'summary',send);
  await route.send('release',true,'short',send);
  await route.send('release',true,'short',send);
  assert.deepEqual(calls,[{chatId:'-2',threadId:3},{chatId:'-2',threadId:3}]);
  await route.disconnect();
  await route.send('release',true,'full',send);
  assert.equal(calls.length,2);
});

test('a rejected group confirmation preserves the existing destination and the invitation',async()=>{
  const data=new Map();
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)});
  const old={chatId:'-1',version:'old'};
  data.set('scheduled-destination',old);
  const code=await route.invite(),target={type:'supergroup',chatId:'-2',threadId:3};
  await assert.rejects(route.connect(code,target,async()=>{throw Error('Forbidden');}),/Forbidden/);
  assert.deepEqual(data.get('scheduled-destination'),old);
  assert.equal(await route.connect(code,target,async()=>{}),true);
  assert.equal(data.has('scheduled-invite'),false);
});

test('an unconfirmed secondary attachment alerts the owner once and allows other files',async()=>{
  const data=new Map([['scheduled-destination',{chatId:'-2',version:'v'}]]),alerts=[];
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)});
  const notify=async(id,part)=>alerts.push(part);
  await route.send('job',true,'summary',async()=>{},notify);
  await route.send('job',true,'png',async()=>{throw Error('Unconfirmed');},notify);
  await route.send('job',true,'png',async()=>assert.fail('Duplicate send'),notify);
  await route.send('job',true,'full',async()=>{},notify);
  assert.deepEqual(alerts,['png']);
  assert.equal(data.get('scheduled-mirror:job:v').png,'uncertain');
  assert.equal(data.get('scheduled-mirror:job:v').full,'sent');
});

test('failed owner notification survives restart and retries without resending the attachment',async()=>{
 let now=0,attempts=0;const data=new Map([['scheduled-destination',{chatId:'-2',version:'v'}]]);
 const store={get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k),list:({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)))};
 const route=new ScheduledDelivery(store,()=>now);
 const notify=async(id,part)=>{assert.equal(id,'job');assert.equal(part,'png');if(++attempts===1)throw Error('Telegram unavailable');};
 await route.send('job',true,'summary',async()=>{},notify);
 await route.send('job',true,'png',async()=>{throw Error('Unconfirmed');},notify);
 const restarted=new ScheduledDelivery(store,()=>now);
 await restarted.retryAlerts(notify);assert.equal(attempts,1);
 now+=5*60*1000;await restarted.retryAlerts(notify);await restarted.retryAlerts(notify);
 assert.equal(attempts,2);assert.equal(data.get('scheduled-mirror:job:v').png,'uncertain');
});

test('a new invitation keeps the existing group and attachment receipts are independent',async()=>{
  const data=new Map([['scheduled-destination',{chatId:'-2',version:'v'}]]);
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)});
  const code=await route.invite();
  await route.connect(code,{type:'supergroup',chatId:'-3',threadId:7,title:'Third group'},async()=>{});
  const calls=[],alerts=[];
  await route.send('manual',false,'summary',async d=>calls.push(d.chatId));
  await route.send('weekly',true,'summary',async d=>calls.push(d.chatId));
  await route.send('weekly',true,'png',async d=>{if(d.chatId==='-2')throw Error('Unavailable');calls.push(d.chatId);},async(id,part,chat)=>alerts.push([part,chat.chatId]));
  await route.send('weekly',true,'png',async()=>assert.fail('Duplicate delivery'));
  assert.deepEqual(calls.sort(),['-2','-3','-3']);
  assert.deepEqual(alerts,[['png','-2']]);
  const removed=await route.disconnect();
  assert.equal(removed.chatId,'-3');
  assert.deepEqual((await route.destinations()).map(d=>d.chatId),['-2']);
});

test('deployment keeps an in-flight delivery receipt from the previous version',async()=>{
  const data=new Map([
    ['scheduled-destination',{chatId:'-2',version:'v'}],
    ['scheduled-mirror:release',{version:'v',summary:'sent',png:'sent'}],
  ]);
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v))});
  const sent=[];
  for(const part of ['summary','png','short','full'])await route.send('release',true,part,async()=>sent.push(part));
  assert.deepEqual(sent,['short','full']);
});

test('the configured PNG-only group receives only actual PNG, and the model note goes to the full group once',async()=>{
  const data=new Map([['scheduled-destinations',[{chatId:'-2',version:'full'},{chatId:'-3',version:'png'}]]]);
  const route=new ScheduledDelivery({get:k=>data.get(k),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k)});
  const note={day:'2026-11-18',name:'model.pdf',bytes:new Uint8Array([37,80,68,70,45,49])};
  await route.configureModes('-2','-3',note);
  const sent=[];
  for(const id of ['forecast-2026-11-18','actual']){
    for(const part of ['summary','png','short','full'])await route.send(id,true,part,async d=>sent.push(`${id}:${part}:${d.chatId}`));
  }
  assert.deepEqual(sent.filter(x=>x.endsWith(':-3')),['actual:png:-3']);
  assert.equal(sent.filter(x=>x.endsWith(':-2')).length,8);
  const deliver=async (d,file)=>sent.push(`${file.name}:${d.chatId}`);
  await route.configureModes('-2','-3',{...note,name:'updated.pdf'});
  await route.sendModelNote('forecast-2026-11-25',deliver);
  await route.sendModelNote('forecast-2026-11-18',deliver);
  await route.configureModes('-2','-3',{...note,name:'duplicate.pdf'});
  await route.sendModelNote('forecast-2026-11-18',deliver);
  assert.deepEqual(sent.filter(x=>x.endsWith('.pdf:-2')),['updated.pdf:-2']);
});
