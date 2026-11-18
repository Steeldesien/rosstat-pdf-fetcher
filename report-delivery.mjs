import {deliveryCaption,documentName} from './coordinator.mjs';

export async function publishSource({artifactsOnly,transport,destination,bytes,item,mode}){
  const caption=deliveryCaption(item,mode),target={chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{})};
  if(artifactsOnly){
    const result=await transport('sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({...target,text:caption,link_preview_options:{is_disabled:true}})});
    return {...result,source_only:true};
  }
  const form=new FormData();form.append('chat_id',destination.chatId);
  if(destination.threadId)form.append('message_thread_id',String(destination.threadId));
  form.append('caption',caption);form.append('document',new Blob([bytes],{type:'application/pdf'}),documentName(item.title));
  return transport('sendDocument',{body:form});
}

export async function publishNarrative({artifactsOnly,transport,destination,text}){
  if(artifactsOnly)return {status:'suppressed'};
  await transport('sendMessage',{headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:destination.chatId,...(destination.threadId?{message_thread_id:destination.threadId}:{}),text,link_preview_options:{is_disabled:true}})});
  return {status:'sent'};
}
