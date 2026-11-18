import {REPORTS} from './coordinator.mjs';

export function statusText(job,stage){
  let label=REPORTS.find(r=>r.kind===job.kind)?.label||'Отчёт Росстата';
  const quarter=job.gdp_period?.match(/^(\d{4})-Q([1-4])$/);
  if(quarter)label+=` (${['I','II','III','IV'][Number(quarter[2])-1]} квартал ${quarter[1]} года)`;
  const source=job.sourceOnly?'Исходный файл получен.':'PDF уже отправлен.';
  const texts={search:`Начат поиск файла: ${label}.`,downloading:`Начата выгрузка файлов: ${label}.`,loaded:`Файл загружен: ${label}.`,error:`Ошибка при получении: ${label}.`,analysis_error:`Ошибка при получении анализа: ${label}. ${source}`};
  if(stage==='card_error')return job.sourceOnly?`Ошибка при получении изображения: ${label}. Исходный файл получен.`:`Ошибка при получении изображения: ${label}. PDF и текст анализа уже отправлены.`;
  if(!texts[stage])throw Error('Unknown report progress');return texts[stage];
}

export async function reportProgress(transport,destination,job,stage,previous){
  const text=statusText(job,stage);
  if(previous){
    try{await transport('editMessageText',{chat_id:previous.chatId,message_id:previous.messageId,text,link_preview_options:{is_disabled:true}});}
    catch(error){if(!error.telegramNotModified)throw error;}
    return previous;
  }
  const result=await transport('sendMessage',{chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{}),text,link_preview_options:{is_disabled:true}});
  if(!result?.message_id)throw Error('Progress send not confirmed');
  return {chatId:destination.chatId,messageId:result.message_id,...(destination.threadId?{threadId:destination.threadId}:{})};
}
