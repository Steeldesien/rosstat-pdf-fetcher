"""Generic private-engine pre-release workflow. No forecast maths or user secrets here."""
import contextlib,io,os,re
from runner import Broker
from engine_client import load_engine,_persist
from report_email import send_report

def main():
    job=os.environ['FORECAST_ID']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',job):raise ValueError('Invalid forecast ticket')
    broker=Broker();identity={'job_id':job,'run_id':broker.run_id}
    claim=broker.call('forecast-claim',json=identity)
    if claim['status']=='completed':return
    module,root,env=load_engine()
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        result,files=module.prepare_forecast()
    if result['end']!=claim['expected_end']:raise RuntimeError('Latest source history does not match the scheduled forecast period')
    if not _persist(root,env):raise RuntimeError('Published forecast history could not be persisted')
    done=broker.call('forecast-finish',json={**identity,'result':result})
    if done.get('status')=='late':print('Forecast saved after publication window; no pre-release notification sent');return
    send_report(broker,{**identity,'key':result['key']},'forecast',result,lambda:files,eligible=not claim.get('dry'))
    for kind in ['png','short','full']:
        status=broker.call('forecast-file',json={**identity,'kind':kind})
        if status['status']=='needs_file':
            path=files[kind];status=broker.call('forecast-upload',data={**identity,'kind':kind},files={'document':(path.name,path.read_bytes(),'image/png' if kind=='png' else 'text/html')})
        if status['status']!='completed':raise RuntimeError('Forecast file delivery unconfirmed')
    print('Pre-release forecast completed; dry verification:',bool(claim.get('dry')))

if __name__=='__main__':
    try:main()
    except Exception as error:
        try:
            broker=Broker();broker.call('forecast-failure',json={'job_id':os.environ.get('FORECAST_ID'),'run_id':broker.run_id,'error':type(error).__name__})
        except Exception:pass
        print('Forecast stopped:',type(error).__name__);raise SystemExit(1)
