import test from 'node:test';import assert from 'node:assert/strict';
let api={};try{api=await import('./status-messages.mjs');}catch{}

test('reports-only errors never claim that PDF or neural text was published',()=>{
 for(const stage of ['analysis_error','card_error']){
  const text=api.statusText({kind:'inflation',sourceOnly:true},stage);assert.doesNotMatch(text,/PDF|текст анализа уже/);assert.match(text,/Исходный файл получен/);
 }
});
test('scheduled status sends once into topic and edits that same message thereafter',async()=>{
  assert.equal(typeof api.reportProgress,'function');const calls=[];
  const transport=async(method,payload)=>{calls.push({method,payload});return {message_id:77};};
  const job={kind:'gdp',mode:'scheduled',gdp_period:'2026-Q3'};
  let receipt=null;
  for(const stage of ['search','downloading','loaded'])receipt=await api.reportProgress(transport,{chatId:'-100123',threadId:9},job,stage,receipt);
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','editMessageText','editMessageText']);
  assert.equal(calls[0].payload.message_thread_id,9);assert.ok(calls[0].payload.text.includes('III квартал 2026'));
  assert.equal(calls[1].payload.message_id,77);assert.equal(calls[2].payload.message_id,77);
  assert.ok(calls[2].payload.text.startsWith('Файл загружен'));
});
test('a destination change does not redirect edits to another chat',async()=>{
  assert.equal(typeof api.reportProgress,'function');let payload;
  await api.reportProgress(async(m,p)=>{payload=p;return true;},{chatId:'new'},{kind:'inflation'},'error',{chatId:'old',messageId:77});
  assert.equal(payload.chat_id,'old');assert.ok(payload.text.startsWith('Ошибка при получении'));
});
