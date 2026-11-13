// Credentials are opaque ciphertext here; only the ephemeral runner decrypts them.
export class AgyAuth {
  constructor(storage,now=()=>Date.now()){this.storage=storage;this.now=now;}
  async start(action){
    if(!['login','verify'].includes(action))throw Error('Invalid auth action');
    if(action==='verify'&&!await this.storage.get('agy:candidate'))throw Error('No candidate');
    const s={id:crypto.randomUUID(),action,expires:this.now()+20*60000,phase:'queued',owner:null};
    await this.storage.put('agy:session:'+s.id,s);return this.public(s);
  }
  public(s){return {id:s.id,action:s.action,phase:s.phase,expires:s.expires,url:s.url||null,restorationVerified:!!s.restorationVerified,files:s.files||0};}
  async get(id){const s=await this.storage.get('agy:session:'+id);if(!s||s.expires<=this.now())throw Error('Auth session expired');return s;}
  async status(id){return this.public(await this.get(id));}
  async diagnostic(id){await this.get(id);return await this.storage.get('agy:diagnostic:'+id)||null;}
  encrypted(p){
    if(!p||!/^[-_A-Za-z0-9=+/]{16,32}$/.test(p.nonce)||!/^[-_A-Za-z0-9=+/]{32,120000}$/.test(p.ciphertext))throw Error('Invalid encrypted payload');
    return {nonce:p.nonce,ciphertext:p.ciphertext};
  }
  async submit(id,code){
    const s=await this.get(id);
    if(s.phase!=='awaiting_code'||typeof code!=='string'||code.length<4||code.length>4096||/[\r\n\x00]/.test(code))throw Error('Invalid authorization code');
    if(code.startsWith('https://')){
      const callback=new URL(code),login=new URL(s.url),expected=new URL(login.searchParams.get('redirect_uri'));
      if(callback.origin!==expected.origin||callback.pathname!==expected.pathname||!callback.searchParams.get('state')||callback.searchParams.get('state')!==login.searchParams.get('state')||!callback.searchParams.get('code'))throw Error('OAuth state mismatch');
      code=callback.searchParams.get('code');
    }
    s.code=code;s.phase='code_submitted';await this.storage.put('agy:session:'+id,s);return {ok:true};
  }
  async runner(id,owner,op,data){
    const s=await this.get(id);
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(owner)||s.owner&&s.owner!==owner)throw Error('Wrong runner');
    if(op==='claim'){
      if(s.phase!=='queued')throw Error('Already claimed');
      s.owner=owner;s.phase='running';await this.storage.put('agy:session:'+id,s);
      return {action:s.action,...(s.action==='verify'?{profile:await this.storage.get('agy:candidate')}:{})};
    }
    if(!s.owner||['completed','failed'].includes(s.phase))throw Error('Inactive auth session');
    let result={ok:true};
    if(op==='url'){
      const u=new URL(data.url);
      if(s.action!=='login'||u.protocol!=='https:'||u.username||u.password||u.port||!['accounts.google.com','antigravity.google','antigravity.google.com'].includes(u.hostname)||data.url.length>16000)throw Error('Invalid login URL');
      s.url=data.url;s.phase='awaiting_code';
    }else if(op==='code'){result={code:s.code||null};delete s.code;
    }else if(op==='checkpoint'){
      if(s.action!=='login')throw Error('Invalid checkpoint');
      await this.storage.put('agy:candidate',this.encrypted(data.profile));s.files=Number(data.files)||0;
    }else if(op==='diagnostic'){
      await this.storage.put('agy:diagnostic:'+id,this.encrypted(data.profile));
    }else if(op==='complete'){
      s.phase=data.ok===true?'completed':'failed';delete s.code;delete s.url;
      if(data.ok===true&&s.action==='login'){
        const p=this.encrypted(data.profile);
        await this.storage.put('agy:candidate',p);s.files=Number(data.files)||0;
      }
      if(data.ok===true&&s.action==='verify')s.restorationVerified=true;
    }else throw Error('Unknown auth operation');
    await this.storage.put('agy:session:'+id,s);return result;
  }
}
