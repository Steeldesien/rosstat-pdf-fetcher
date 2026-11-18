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
  const notify=async part=>alerts.push(part);
  await route.send('job',true,'summary',async()=>{},notify);
  await route.send('job',true,'png',async()=>{throw Error('Unconfirmed');},notify);
  await route.send('job',true,'png',async()=>assert.fail('Duplicate send'),notify);
  await route.send('job',true,'full',async()=>{},notify);
  assert.deepEqual(alerts,['png']);
  assert.equal(data.get('scheduled-mirror:job').png,'uncertain');
  assert.equal(data.get('scheduled-mirror:job').full,'sent');
});
