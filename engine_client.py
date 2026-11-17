"""Load a private calculation module only for an uncached release analysis."""
import contextlib,importlib.util,io,json,os,re,subprocess,sys,tempfile,threading
from pathlib import Path
import requests
_loaded=None

def load_engine():
    global _loaded
    if _loaded:return _loaded
    explicit=os.environ.get('INFLATION_ENGINE_ROOT')
    if explicit:
        root=Path(explicit).resolve();git_env=None
    else:
        repo=os.environ.get('INFLATION_ENGINE_REPOSITORY','')
        key=os.environ.get('INFLATION_ENGINE_DEPLOY_KEY','')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo) or not key:raise RuntimeError('Private calculation module is not configured')
        folder=Path(tempfile.mkdtemp(prefix='rosstat-engine-'));root=folder/'engine'
        private=folder/'key';private.write_text(key,encoding='utf-8');private.chmod(0o600)
        pins=(Path(__file__).parent/'github_known_hosts').read_text(encoding='utf-8')
        if not pins.strip() or any(not re.fullmatch(r'github\.com (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+',line) for line in pins.splitlines()):raise RuntimeError('GitHub SSH host key pin is invalid')
        hosts=folder/'known_hosts';hosts.write_text(pins,encoding='utf-8')
        git_env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_SSH_COMMAND':f'ssh -i "{private}" -o IdentitiesOnly=yes -o UserKnownHostsFile="{hosts}" -o StrictHostKeyChecking=yes'}
        run=subprocess.run(['git','clone','--depth=1','git@github.com:'+repo+'.git',str(root)],env=git_env,capture_output=True,timeout=180)
        if run.returncode:raise RuntimeError('Private calculation module checkout failed')
        install=subprocess.run([sys.executable,'-m','pip','install','-q','-r',str(root/'requirements.txt')],capture_output=True,timeout=300)
        if install.returncode:raise RuntimeError('Calculation dependencies could not be installed')
    spec=importlib.util.spec_from_file_location('rosstat_private_engine',root/'bot_bridge.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    _loaded=(module,root,git_env)
    return _loaded

def _persist(root,env):
    if env is None:return
    args=['git','-C',str(root)]
    subprocess.run(args+['config','user.name','rosstat-engine'],capture_output=True,check=True)
    subprocess.run(args+['config','user.email','rosstat-engine@users.noreply.github.com'],capture_output=True,check=True)
    subprocess.run(args+['add','--','data','report/out'],capture_output=True,check=True)
    diff=subprocess.run(args+['diff','--cached','--quiet'],capture_output=True)
    if diff.returncode==0:return
    subprocess.run(args+['commit','-m','Persist release calculations and reports'],capture_output=True,check=True)
    # A concurrent run must never overwrite another run's committed history.
    push=subprocess.run(args+['push','origin','HEAD:main'],env=env,capture_output=True,timeout=180)
    if push.returncode:print('Private history persistence deferred; delivered results remain cached',flush=True)

def analyze(broker,job,plan,known=None):
    identity={'job_id':job['id'],'run_id':broker.run_id}
    state=broker.call('engine-status',json={**identity,'plan':plan})
    if not state.get('enabled'):return None
    files=None;loaded=None;report=None
    if state.get('status')!='ready':
        stopped=threading.Event()
        def keep_lease():
            while not stopped.wait(45):
                try:broker.call('engine-status',json={**identity,'plan':plan})
                except Exception:pass
        keeper=threading.Thread(target=keep_lease,daemon=True);keeper.start()
        try:
            loaded=load_engine();module,root,_=loaded
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                report,bundle=module.prepare(plan,known or {})
        finally:stopped.set();keeper.join(timeout=1)
        plan={**plan,'engine':bundle}
    result=broker.call('analyze',json={**identity,'plan':plan})
    card=result.get('card')
    if not card:return result
    broker.reports_expected=True
    # Ask the broker first: Telegram file IDs allow all three files to be reused without rendering.
    statuses={'png':broker.call('card',json={**identity,'key':card['key']})}
    for kind in ['short','full']:
        statuses[kind]=broker.call('report',json={**identity,'key':card['key'],'kind':kind})
    if any(s.get('status') not in ('completed','needs_image','needs_file') for s in statuses.values()):raise RuntimeError('Report delivery outcome is uncertain')
    if any(s.get('status')=='needs_image' or s.get('status')=='needs_file' for s in statuses.values()):
        if not loaded:
            loaded=load_engine()
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                report,_=loaded[0].prepare(plan,known or {})
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            files=loaded[0].render_artifacts(plan,report,card['text'])
        for kind,status in statuses.items():
            if status.get('status') not in ('needs_image','needs_file'):continue
            path=files[kind]
            if kind=='png':
                delivered=broker.call('card-upload',data={**identity,'key':card['key']},files={'image':(path.name,path.read_bytes(),'image/png')})
            else:
                delivered=broker.call('report-upload',data={**identity,'key':card['key'],'kind':kind},files={'document':(path.name,path.read_bytes(),'text/html')})
            if delivered.get('status')!='completed':raise RuntimeError('Report delivery was not confirmed')
    if loaded:
        try:_persist(loaded[1],loaded[2])
        except Exception:print('Private history persistence deferred; report delivery retained',flush=True)
    broker.reports_expected=False
    return result
