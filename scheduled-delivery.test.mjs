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
  assert.equal(await route.connect(code,{type:'private',chatId:'1'}),false);
  assert.equal(await route.connect(code,{type:'supergroup',chatId:'-2',threadId:3}),true);
  assert.equal(await route.connect(code,{type:'group',chatId:'-3'}),false);
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
