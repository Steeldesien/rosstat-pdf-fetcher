import test from 'node:test';
import assert from 'node:assert/strict';
let api={};try{api=await import('./agy-auth.mjs');}catch{}
function fixture(){const data=new Map();let now=1000;return {data,store:{async get(k){return structuredClone(data.get(k));},async put(k,v){data.set(k,structuredClone(v));}},now:()=>now,advance:ms=>now+=ms};}
test('cloud auth is bound to its first runner and expires',async()=>{
  assert.equal(typeof api.AgyAuth,'function');const f=fixture(),auth=new api.AgyAuth(f.store,f.now);
  const s=await auth.start('login');assert.equal((await auth.runner(s.id,'run-1','claim',{})).action,'login');
  await assert.rejects(auth.runner(s.id,'run-2','claim',{}));
  f.advance(25*60000);await assert.rejects(auth.runner(s.id,'run-1','claim',{}));
});
test('only official login URLs are exposed and authorization codes are consumed once',async()=>{
  assert.equal(typeof api.AgyAuth,'function');const f=fixture(),auth=new api.AgyAuth(f.store,f.now),s=await auth.start('login');
  await auth.runner(s.id,'run','claim',{});
  await assert.rejects(auth.runner(s.id,'run','url',{url:'https://accounts.google.com.attacker.test/a'}));
  await auth.runner(s.id,'run','url',{url:'https://accounts.google.com/o/oauth2/auth?state=example'});
  await auth.submit(s.id,'private-code');
  assert.equal((await auth.runner(s.id,'run','code',{})).code,'private-code');
  assert.equal((await auth.runner(s.id,'run','code',{})).code,null);
  assert.ok(!JSON.stringify(await auth.status(s.id)).includes('private-code'));
});
test('a second fresh runner can restore a candidate only in an approved verify session',async()=>{
  assert.equal(typeof api.AgyAuth,'function');const f=fixture(),auth=new api.AgyAuth(f.store,f.now),s=await auth.start('login');
  await auth.runner(s.id,'first','claim',{});
  await auth.runner(s.id,'first','complete',{ok:true,profile:{nonce:'a'.repeat(16),ciphertext:'b'.repeat(64)},files:2});
  const v=await auth.start('verify');const claim=await auth.runner(v.id,'fresh','claim',{});
  assert.equal(claim.profile.ciphertext,'b'.repeat(64));
  assert.ok(!JSON.stringify(await auth.status(v.id)).includes('bbbb'));
  await auth.runner(v.id,'fresh','complete',{ok:true});
  assert.equal((await auth.status(v.id)).restorationVerified,true);
});
test('successful sign-in checkpoint survives a subsequent provider-probe failure',async()=>{
  const f=fixture(),auth=new api.AgyAuth(f.store,f.now),s=await auth.start('login');
  await auth.runner(s.id,'first','claim',{});
  const profile={nonce:'a'.repeat(16),ciphertext:'b'.repeat(64)};
  await auth.runner(s.id,'first','checkpoint',{profile,files:2});
  await auth.runner(s.id,'first','diagnostic',{profile});
  await auth.runner(s.id,'first','complete',{ok:false});
  assert.deepEqual(await auth.diagnostic(s.id),profile);
  const v=await auth.start('verify');
  assert.deepEqual((await auth.runner(v.id,'fresh','claim',{})).profile,profile);
});
