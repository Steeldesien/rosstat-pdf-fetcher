import test from 'node:test';
import assert from 'node:assert/strict';
let api;
try { api = await import('./coordinator.mjs'); }
catch { assert.fail('The private coordinator has not been implemented yet'); }

function fixture(nowIso='2026-11-18T17:00:00Z') {
  const data = new Map();
  const store = {
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async list({prefix}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).map(([k,v]) => [k,structuredClone(v)])); }
  };
  let now = Date.parse(nowIso);
  const sent = [], dispatched = [];
  const config = {targets: [{id:'weekly-18',kind:'inflation',start:'2026-11-18T21:00:00+05:00'}], recurring: false};
  const coordinator = new api.Coordinator(store, config, {
    now: () => now,
    dispatch: async id => dispatched.push(id),
    send: async (...args) => { sent.push(args); return {message_id: 55}; }
  });
  return {coordinator, store, sent, dispatched, advance: ms => {now += ms;}};
}

test('late automatic release stays pending after midnight and keeps the same job', async () => {
  const f=fixture(); await f.coordinator.tick();
  const first=f.dispatched[0];
  f.advance(10*3600000); await f.coordinator.tick();
  assert.equal(f.dispatched.at(-1), first);
  assert.equal((await f.coordinator.claim(first,'run-1')).job.not_before,'2026-11-18T00:00:00+05:00');
});

test('claims expose only source selection, not Telegram state or identifiers', async () => {
  const f=fixture(); const job=await f.coordinator.manual(12345);
  const response=await f.coordinator.claim(job.id,'run-1');
  assert.deepEqual(Object.keys(response.job).sort(), ['id','kind','mode']);
  assert.ok(!JSON.stringify(response).includes('12345'));
});

test('webhook retries reuse the manual job', async () => {
  const f=fixture(); const one=await f.coordinator.manual(12345); const two=await f.coordinator.manual(12345);
  assert.equal(one.id,two.id);
});

test('only the runner holding the lease can upload a PDF', async () => {
  const f=fixture(); const job=await f.coordinator.manual(1);
  await f.coordinator.claim(job.id,'owner');
  assert.equal((await f.coordinator.claim(job.id,'other')).status,'busy');
  await assert.rejects(f.coordinator.deliver(job.id,'other',new Uint8Array([37,80,68,70,45]),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1}));
  assert.equal(f.sent.length,0);
});

test('confirmed delivery is stored privately and retries do not send a duplicate', async () => {
  const f=fixture(); const job=await f.coordinator.manual(1); await f.coordinator.claim(job.id,'owner');
  const bytes=new TextEncoder().encode('%PDF-test');
  await f.coordinator.deliver(job.id,'owner',bytes,{title:'t',url:'https://rosstat.gov.ru/a',stamp:1});
  await f.coordinator.deliver(job.id,'owner',bytes,{title:'t',url:'https://rosstat.gov.ru/a',stamp:1});
  assert.equal(f.sent.length,1);
  assert.equal((await f.coordinator.claim(job.id,'another')).status,'completed');
});

test('automatic completion stops future polling dispatches for that target', async () => {
  const f=fixture(); await f.coordinator.tick(); const id=f.dispatched[0];
  await f.coordinator.claim(id,'owner');
  await f.coordinator.deliver(id,'owner',new TextEncoder().encode('%PDF-test'),{title:'Об оценке индекса потребительских цен с 10 по 16 ноября 2026 года',url:'https://rosstat.gov.ru/a',stamp:Date.parse('2026-11-18T20:00:00Z')/1000});
  const count=f.dispatched.length; f.advance(3600000); await f.coordinator.tick();
  assert.equal(f.dispatched.length,count);
});

test('unconfirmed Telegram response holds the job for review instead of duplicate delivery', async () => {
  const f=fixture(); f.coordinator.effects.send=async () => {throw new Error('Response lost');};
  const job=await f.coordinator.manual(1); await f.coordinator.claim(job.id,'owner');
  await assert.rejects(f.coordinator.deliver(job.id,'owner',new TextEncoder().encode('%PDF-test'),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1}));
  assert.equal((await f.coordinator.claim(job.id,'owner')).status,'needs_review');
});

test('non-PDF uploads never reach Telegram', async () => {
  const f=fixture(); const job=await f.coordinator.manual(1); await f.coordinator.claim(job.id,'owner');
  await assert.rejects(f.coordinator.deliver(job.id,'owner',new TextEncoder().encode('<html>'),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1}));
  assert.equal(f.sent.length,0);
});

test('backoff persists across runner restarts', async () => {
  const f=fixture(); const job=await f.coordinator.manual(1); await f.coordinator.claim(job.id,'owner');
  await f.coordinator.backoff(job.id,'owner',900);
  await f.coordinator.release(job.id,'owner');
  assert.equal((await f.coordinator.claim(job.id,'new-run')).status,'backoff');
  f.advance(901000);
  assert.equal((await f.coordinator.claim(job.id,'new-run')).status,'ready');
});

test('owner command validation rejects other chats and non-private messages', () => {
  assert.equal(api.commandMode({update_id:1,message:{chat:{id:7,type:'private'},text:'/latest'}},'7'), 'latest');
  assert.equal(api.commandMode({update_id:1,message:{chat:{id:8,type:'private'},text:'/latest'}},'7'), null);
  assert.equal(api.commandMode({update_id:1,message:{chat:{id:7,type:'group'},text:'/latest'}},'7'), null);
});

test('outside the daily evening window missing publications use hourly checks for several days', async () => {
  const f=fixture(); await f.coordinator.tick(); const id=f.dispatched[0];
  await f.coordinator.claim(id,'owner');
  assert.equal((await f.coordinator.waiting(id,'owner')).interval_seconds,60);
  f.advance(4*86400000+3*3600000); await f.coordinator.claim(id,'owner');
  assert.equal((await f.coordinator.waiting(id,'owner')).interval_seconds,3600);
  await f.coordinator.release(id,'owner');
  const count=f.dispatched.length;
  f.advance(3590000); await f.coordinator.tick();
  assert.equal(f.dispatched.length,count);
  f.advance(10000); await f.coordinator.tick();
  assert.equal(f.dispatched.length,count+1);
  assert.equal(f.dispatched.at(-1),id);
});

test('the minute schedule resumes on each following evening', async () => {
  const f=fixture(); await f.coordinator.tick(); const id=f.dispatched[0];
  await f.coordinator.claim(id,'owner'); await f.coordinator.waiting(id,'owner');
  f.advance(24*3600000); await f.coordinator.claim(id,'owner');
  assert.equal((await f.coordinator.waiting(id,'owner')).interval_seconds,60);
});

test('at 23:00 the runner cannot continue minute polling', async () => {
  const f=fixture(); await f.coordinator.tick(); const id=f.dispatched[0];
  f.advance(59*60000); await f.coordinator.claim(id,'owner'); await f.coordinator.waiting(id,'owner');
  f.advance(60000);
  const response=await f.coordinator.claim(id,'owner');
  assert.equal(response.status,'backoff');
  assert.ok(response.retry_after>3500);
});

test('an hourly wait is shortened at the next 21:00 boundary', async () => {
  const f=fixture(); const job=await f.coordinator.manual(7);
  f.advance(22*3600000+45*60000);
  await f.coordinator.claim(job.id,'owner');
  assert.equal((await f.coordinator.waiting(job.id,'owner')).interval_seconds,3600);
  await f.coordinator.release(job.id,'owner');
  f.advance(15*60000); await f.coordinator.tick();
  assert.ok(f.dispatched.includes(job.id));
});

test('a newer publication window does not cancel an older delayed release', async () => {
  const f=fixture(); await f.coordinator.tick(); const older=f.dispatched[0];
  f.coordinator.config.targets.push({id:'weekly-25',kind:'inflation',start:'2026-11-25T21:00:00+05:00'});
  f.advance(7*86400000); await f.coordinator.tick();
  assert.equal((await f.coordinator.claim(older,'owner')).status,'ready');
  assert.equal((await f.coordinator.summary()).jobs.filter(j=>j.phase!=='cancelled').length,2);
});

test('an older delayed report cannot close the following reporting week', async () => {
  const f=fixture(); await f.coordinator.tick(); const id=f.dispatched[0]; await f.coordinator.claim(id,'owner');
  await assert.rejects(f.coordinator.deliver(id,'owner',new TextEncoder().encode('%PDF-test'),{
    title:'Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года',url:'https://rosstat.gov.ru/a',stamp:Date.parse('2026-11-18T20:00:00Z')/1000
  }));
  assert.equal(f.sent.length,0);
});

test('PDF filenames contain the complete reporting range', () => {
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года'), 'Инфляция_03.11.2026–09.11.2026.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 27 октября по 2 ноября 2026 года'), 'Инфляция_27.10.2026–02.11.2026.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 29 декабря 2026 года по 11 января 2027 года'), 'Инфляция_29.12.2026–11.01.2027.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 29 декабря по 11 января 2027 года'), 'Инфляция_29.12.2026–11.01.2027.pdf');
  assert.equal(api.documentName('Неизвестный период'), 'Rosstat.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 31 февраля по 9 марта 2026 года'), 'Rosstat.pdf');
});

test('the GDP test PDF is named with the quarter date range', () => {
  assert.equal(api.documentName('Справка о предварительной оценке динамики ВВП в III квартале 2026 года'), 'ВВП_01.07.2026–30.09.2026.pdf');
});

test('the November 13 GDP test starts at 21:00 Yekaterinburg and waits for the fresh release', async () => {
  const f=fixture('2026-11-13T15:59:00Z');
  f.coordinator.config.targets=[{id:'gdp:2026-Q3',kind:'gdp',start:'2026-11-13T21:00:00+05:00'}];
  await f.coordinator.tick(); assert.equal(f.dispatched.length,0);
  f.advance(60000); await f.coordinator.tick(); assert.equal(f.dispatched.length,1);
  const claim=await f.coordinator.claim(f.dispatched[0],'owner');
  assert.equal(claim.job.kind,'gdp');
  assert.equal(claim.job.not_before,'2026-11-13T00:00:00+05:00');
});

test('a completed inflation release causes no daily runs before the following Wednesday window', async () => {
  const f=fixture();f.coordinator.config.recurring=true;
  await f.coordinator.tick();const id=f.dispatched[0];await f.coordinator.claim(id,'owner');
  await f.coordinator.deliver(id,'owner',new TextEncoder().encode('%PDF-test'),{
    title:'Об оценке индекса потребительских цен с 10 по 16 ноября 2026 года',url:'https://rosstat.gov.ru/a',stamp:Date.parse('2026-11-18T17:00:00Z')/1000
  });
  const count=f.dispatched.length;
  for(let day=0;day<6;day++){f.advance(86400000);await f.coordinator.tick();assert.equal(f.dispatched.length,count);}
  f.advance(23*3600000-60000);await f.coordinator.tick();assert.equal(f.dispatched.length,count);
  f.advance(60000);await f.coordinator.tick();assert.equal(f.dispatched.length,count+1);
});

test('private delivery history retains the filename confirmed by Telegram', async () => {
  const f=fixture();const job=await f.coordinator.manual(8);await f.coordinator.claim(job.id,'owner');
  f.coordinator.effects.send=async()=>({message_id:56,document:{file_name:'Инфляция_03.11.2026–09.11.2026.pdf'}});
  await f.coordinator.deliver(job.id,'owner',new TextEncoder().encode('%PDF-test'),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1});
  assert.equal((await f.coordinator.summary()).jobs[0].fileName,'Инфляция_03.11.2026–09.11.2026.pdf');
});
