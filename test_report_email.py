import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import Mock, patch

from report_email import message, send_report


class ReportEmailTests(unittest.TestCase):
    def test_forecast_subject_body_and_exact_attachments(self):
        with tempfile.TemporaryDirectory() as folder:
            files = {}
            for kind in ('png', 'short', 'full'):
                path = Path(folder) / (kind + ('.png' if kind == 'png' else '.html'))
                path.write_bytes(kind.encode())
                files[kind] = path
            mail = message('sender@example.com', ['one@example.com', 'two@example.com'], 'forecast',
                           {'start':'2026-11-10','end':'2026-11-16','asof':'2026-11-09','point':0.147,'lo80':0.043,'hi80':0.232}, files)
            self.assertEqual(mail['Subject'], 'Недельная инфляция • предварительный прогноз за 10–16 ноября 2026')
            self.assertIn('+0,15%', mail.get_body().get_content())
            self.assertIn('09.11.2026', mail.get_body().get_content())
            self.assertIsNone(mail['Bcc'])
            self.assertEqual([p.get_payload(decode=True) for p in mail.iter_attachments()], [b'png', b'short', b'full'])

    def test_manual_and_dry_runs_do_not_load_files_or_send(self):
        broker=Mock();files=Mock(side_effect=AssertionError('Attempt to render test email'))
        with patch.dict('os.environ',{'REPORT_EMAIL_SMTP':'configured'}):
            send_report(broker,{},'forecast',{},files,eligible=False)
            send_report(broker,{},'actual',{},files,eligible=False)
        broker.call.assert_not_called();files.assert_not_called()

    def test_scheduled_email_uses_private_recipients_and_reserves_before_sending(self):
        broker=Mock();broker.call.side_effect=[{'status':'ready'},{'status':'reserved'},{'status':'accepted'}]
        recipients=['one@example.com','two@example.com'];sender='sender@gmail.com'
        settings=json.dumps({'sender':sender,'recipients':recipients,'app_password':'fixture'})
        with tempfile.TemporaryDirectory() as folder,patch.dict('os.environ',{'REPORT_EMAIL_SMTP':settings}),patch('report_email.smtplib.SMTP_SSL') as connection:
            paths={kind:Path(folder)/filename for kind,filename in [('png','summary.png'),('short','short.html'),('full','full.html')]}
            for path in paths.values():path.write_bytes(b'report')
            smtp=connection.return_value.__enter__.return_value
            def accept(mail,**kwargs):
                self.assertEqual([call.args[0] for call in broker.call.call_args_list],['email-status','email-reserve'])
                self.assertEqual(kwargs['to_addrs'],recipients)
                self.assertEqual(mail['Subject'],'Недельная инфляция • фактический выпуск за 27 октября — 2 ноября 2026')
                self.assertIn('Росстата',mail.get_body().get_content())
                self.assertNotIn(recipients[0],str(mail))
                return {}
            smtp.send_message.side_effect=accept
            send_report(broker,{'job_id':'opaque'},'actual',{'start':'2026-10-27','end':'2026-11-02'},lambda:paths,eligible=True)
            smtp.send_message.assert_called_once()
            self.assertEqual(broker.call.call_args.kwargs['json']['status'],'accepted')
