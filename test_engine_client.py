import unittest
from unittest.mock import Mock,patch
import engine_client as e

class EngineClientTests(unittest.TestCase):
    def test_pinned_old_issue_is_not_replaced_by_newer_private_archive_entries(self):
        import runner,analysis
        from unittest.mock import patch
        old={'title':'Об оценке индекса потребительских цен с 27 октября по 2 ноября 2026 года','url':'https://rosstat.gov.ru/old.pdf','stamp':1}
        new={'title':'Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года','url':'https://rosstat.gov.ru/new.pdf','stamp':2}
        broker=runner.Broker.__new__(runner.Broker);broker.run_id='run';broker.call=Mock(return_value={'documents':[new]})
        job={'id':'old','kind':'inflation','mode':'latest','analysis_mode':'release','resume_source':old}
        with patch.object(analysis,'prepare_plan',side_effect=lambda plan,*a:plan),patch.object(e,'analyze',return_value={'status':'completed'}) as run:
            broker.analyze(job,[old],{},lambda url:self.fail('Unexpected archive fetch'))
        self.assertEqual(run.call_args.args[2]['end'],'2026-11-02')
    def test_host_key_pin_matches_the_official_github_ed25519_fingerprint(self):
        import hashlib,base64
        from pathlib import Path
        line=next(x for x in (Path(e.__file__).parent/'github_known_hosts').read_text().splitlines() if x.startswith('github.com ssh-ed25519 '))
        fingerprint=base64.b64encode(hashlib.sha256(base64.b64decode(line.split()[2])).digest()).decode().rstrip('=')
        self.assertEqual(fingerprint,'+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU')
    def test_a_cached_analysis_does_not_load_private_code_or_run_ai(self):
        broker=Mock();broker.run_id='run';job={'id':'job','kind':'inflation','analysis_mode':'release'}
        broker.call.side_effect=[{'enabled':True,'status':'ready'},{'status':'completed','card':{'key':'a'*64,'text':'saved'}},{'status':'completed'},{'status':'completed'},{'status':'completed'}]
        with patch.object(e,'load_engine',side_effect=AssertionError('Unexpected calculation')):
            result=e.analyze(broker,job,{'kind':'inflation','mode':'release'})
        self.assertEqual(result['status'],'completed')
        self.assertEqual([c.args[0] for c in broker.call.call_args_list],['engine-status','analyze','card','report','report'])
    def test_a_disabled_engine_preserves_existing_analysis_route(self):
        broker=Mock();broker.run_id='run';broker.call.return_value={'enabled':False}
        self.assertIsNone(e.analyze(broker,{'id':'job'},{}))

if __name__=='__main__':unittest.main()
