import test from 'node:test';
import assert from 'node:assert/strict';
let api;
try { api = await import('./coordinator.mjs'); }
catch { assert.fail('The private coordinator has not been implemented yet'); }

test('analysis menu offers frequency-specific windows and a PDF-only option',()=>{
  assert.equal(typeof api.analysisModes,'function');
  assert.deepEqual(api.analysisModes('inflation'),['release','m1','m2','m3']);
  assert.deepEqual(api.analysisModes('gdp'),['release','m6','m12']);
});

test('menu callbacks are bound to requester, chat, topic and expiry',async()=>{
  const f=fixture();
  assert.equal(typeof f.coordinator.analysisMenu,'function');
  const message={chat:{id:-100123,type:'supergroup'},from:{id:42},message_thread_id:3};
  const menu=await f.coordinator.analysisMenu({update_id:50,message},'inflation');
  const make=(from=42,chat=-100123,topic=3)=>({update_id:51,callback_query:{id:'cb',from:{id:from},data:`an:${menu.id}:m1`,message:{chat:{id:chat},message_thread_id:topic}}});
  assert.equal(await f.coordinator.selectAnalysis(make(43)),null);
  assert.equal(await f.coordinator.selectAnalysis(make(42,-100124)),null);
  assert.equal(await f.coordinator.selectAnalysis(make(42,-100123,4)),null);
  const accepted=await f.coordinator.selectAnalysis(make());
  assert.equal(accepted.kind,'inflation');assert.equal(accepted.mode,'m1');
  f.advance(3600001);assert.equal(await f.coordinator.selectAnalysis(make()),null);
});

test('PDF is delivered once while analysis remains recoverable after runner restart',async()=>{
  const f=fixture();
  const job=await f.coordinator.manual(999,'inflation','m1');
  const claim=await f.coordinator.claim(job.id,'run');
  assert.equal(claim.job.analysis_mode,'m1');
  const bytes=new TextEncoder().encode('%PDF-test'),item={title:'t',url:'https://rosstat.gov.ru/a',stamp:1};
  await f.coordinator.deliver(job.id,'run',bytes,item);
  await f.coordinator.deliver(job.id,'run',bytes,item);
  assert.equal(f.sent.length,1);
  await f.coordinator.release(job.id,'run');f.advance(3600001);
  assert.equal((await f.coordinator.claim(job.id,'new-run')).status,'ready');
  assert.equal(typeof f.coordinator.analysisAccess,'function');
  assert.equal((await f.coordinator.analysisAccess(job.id,'new-run')).mode,'m1');
  await f.coordinator.finishAnalysis(job.id,'new-run','done');
  assert.equal((await f.coordinator.claim(job.id,'another')).status,'completed');
});

test('only the matching completed analysis runner can attach a summary image',async()=>{
  const f=fixture(),job=await f.coordinator.manual(777,'inflation','release');
  await f.coordinator.claim(job.id,'runner');
  await f.coordinator.deliver(job.id,'runner',new TextEncoder().encode('%PDF-test'),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1});
  assert.equal(typeof f.coordinator.cardAccess,'function');
  await assert.rejects(f.coordinator.cardAccess(job.id,'runner','a'.repeat(64)));
  await f.coordinator.finishAnalysis(job.id,'runner','cached','a'.repeat(64));
  await assert.rejects(f.coordinator.cardAccess(job.id,'other','a'.repeat(64)));
  await assert.rejects(f.coordinator.cardAccess(job.id,'runner','b'.repeat(64)));
  assert.equal((await f.coordinator.cardAccess(job.id,'runner','a'.repeat(64))).kind,'inflation');
});

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
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года'), 'Инфляция_03.11.2026-09.11.2026.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 27 октября по 2 ноября 2026 года'), 'Инфляция_27.10.2026-02.11.2026.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 29 декабря 2026 года по 11 января 2027 года'), 'Инфляция_29.12.2026-11.01.2027.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 29 декабря по 11 января 2027 года'), 'Инфляция_29.12.2026-11.01.2027.pdf');
  assert.equal(api.documentName('Неизвестный период'), 'Rosstat.pdf');
  assert.equal(api.documentName('Об оценке индекса потребительских цен с 31 февраля по 9 марта 2026 года'), 'Rosstat.pdf');
});

test('the GDP test PDF is named with the quarter date range', () => {
  assert.equal(api.documentName('Справка о предварительной оценке динамики ВВП в III квартале 2026 года'), 'ВВП_01.07.2026-30.09.2026.pdf');
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
  f.coordinator.effects.send=async()=>({message_id:56,document:{file_name:'Инфляция_03.11.2026-09.11.2026.pdf'}});
  await f.coordinator.deliver(job.id,'owner',new TextEncoder().encode('%PDF-test'),{title:'t',url:'https://rosstat.gov.ru/a',stamp:1});
  assert.equal((await f.coordinator.summary()).jobs[0].fileName,'Инфляция_03.11.2026-09.11.2026.pdf');
});

test('only the owner can connect a group and group IDs never enter runner claims', async () => {
  const f=fixture();
  const message=from=>({update_id:10,message:{from:{id:from},chat:{id:-1007654321,type:'supergroup'},text:'/connect@TestBot'}});
  await assert.rejects(f.coordinator.connect(message(8),'7','TestBot'));
  assert.equal(await f.coordinator.destination(),null);
  const connected=await f.coordinator.connect(message(7),'7','TestBot');
  assert.equal(connected.target.chatId,'-1007654321');
  assert.equal((await f.coordinator.destination()).chatId,'-1007654321');
  assert.equal((await f.coordinator.connect(message(7),'7','TestBot')).replay,true);
  const job=await f.coordinator.manual(11);const claim=await f.coordinator.claim(job.id,'runner');
  assert.ok(!JSON.stringify(claim).includes('-1007654321'));
});

test('latest is allowed in the connected group but not an unrelated group', () => {
  const destination={chatId:'-1007654321'};
  const update=id=>({update_id:12,message:{from:{id:8},chat:{id,type:'supergroup'},text:'/latest@TestBot'}});
  assert.equal(api.commandMode(update(-1007654321),'7',destination,'TestBot'),'latest');
  assert.equal(api.commandMode(update(-1009876543),'7',destination,'TestBot'),null);
  const wrong=update(-1007654321);wrong.message.text='/latest@OtherBot';
  assert.equal(api.commandMode(wrong,'7',destination,'TestBot'),null);
});

test('group connection can target a forum topic and can be reverted by its owner', async () => {
  const f=fixture();
  await f.coordinator.connect({update_id:20,message:{from:{id:7},chat:{id:-1007654321,type:'supergroup'},text:'/connect',message_thread_id:42}},'7');
  assert.equal((await f.coordinator.destination()).threadId,42);
  await f.coordinator.connect({update_id:21,message:{from:{id:7},chat:{id:7,type:'private'},text:'/connect'}},'7');
  assert.equal((await f.coordinator.destination()).chatId,'7');
});

test('document caption distinguishes publication time from completed download time in Yekaterinburg', () => {
  const caption=api.deliveryCaption({title:'Выпуск инфляции',url:'https://rosstat.gov.ru/a',
    stamp:Date.parse('2026-11-11T16:00:00Z')/1000,receivedStamp:Date.parse('2026-11-12T12:34:56Z')/1000},'latest');
  assert.ok(caption.includes('Опубликовано Росстатом: 11.11.2026 21:00:00'));
  assert.ok(caption.includes('Получено ботом: 12.11.2026 17:34:56'));
  assert.ok(caption.includes('Екатеринбург (UTC+5)'));
});

test('long source captions preserve both time labels within the Telegram length limit', () => {
  const caption=api.deliveryCaption({title:'x'.repeat(2000),url:'https://rosstat.gov.ru/a',stamp:1,receivedStamp:2},'scheduled');
  assert.ok(caption.length<=1024);
  assert.ok(caption.includes('Опубликовано Росстатом:'));
  assert.ok(caption.includes('Получено ботом:'));
});

test('delivery history records the timestamps and the caption confirmed by Telegram', async () => {
  const f=fixture();const job=await f.coordinator.manual(30);await f.coordinator.claim(job.id,'owner');
  f.coordinator.effects.send=async()=>({message_id:90,caption:'Confirmed caption'});
  await f.coordinator.deliver(job.id,'owner',new TextEncoder().encode('%PDF-test'),{
    title:'t',url:'https://rosstat.gov.ru/a',stamp:100,receivedStamp:200});
  const stored=(await f.coordinator.summary()).jobs[0];
  assert.equal(stored.publicationStamp,100);assert.equal(stored.receivedStamp,200);assert.equal(stored.caption,'Confirmed caption');
});

test('menu report commands select distinct kinds without adding automatic schedules', async () => {
  for(const kind of ['inflation','cpi','gdp','fuel','gasoline','industry','ppi','finance','business','wages']) {
    const update={update_id:40,message:{chat:{id:7,type:'private'},text:'/'+kind}};
    assert.equal(api.commandMode(update,'7'),kind);
    const f=fixture();const created=await f.coordinator.manual(40,kind);
    assert.equal((await f.coordinator.claim(created.id,'owner')).job.kind,kind);
    assert.equal(f.coordinator.config.targets.length,1);
  }
});

test('monthly and cumulative report names include their date ranges', () => {
  assert.equal(api.documentName('Об индексе потребительских цен в сентябре 2026 года'),'ИПЦ_01.09.2026-30.09.2026.pdf');
  assert.equal(api.documentName('О промышленном производстве в январе-сентябре 2026 года'),'Промышленность_01.01.2026-30.09.2026.pdf');
  assert.equal(api.documentName('О финансовых результатах деятельности организаций в январе-августе 2026 года'),'Финрезультаты_01.01.2026-31.08.2026.pdf');
  assert.equal(api.documentName('О просроченной задолженности по заработной плате на конец сентября 2026 года'),'Долги_по_зарплате_на_30.09.2026.pdf');
  assert.equal(api.documentName('О финансовых результатах деятельности организаций в 2026 году'),'Финрезультаты_01.01.2026-31.12.2026.pdf');
});

test('catalogue dates do not invent an exact publication time', () => {
  const caption=api.deliveryCaption({title:'GDP',url:'https://rosstat.gov.ru/a',stamp:null,catalogueDate:'2026-10-02',receivedStamp:1},'latest');
  assert.ok(caption.includes('Дата файла в каталоге: 02.10.2026'));
  assert.ok(caption.includes('Опубликовано Росстатом: время не указано'));
});
