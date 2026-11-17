import unittest
from unittest.mock import Mock,patch
import engine_client as e

class EngineClientTests(unittest.TestCase):
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
