"""Cloud-only email test. The recipient comes from the protected configuration."""
import contextlib
import io
import json
import os
import sys

from report_email import forecast_model_note, gmail_connection, message


def main():
    if sys.argv[1:] == ['--connection-only']:
        with gmail_connection() as smtp:
            print('Verified Gmail SMTP TLS on port', smtp.port, flush=True)
        return

    from engine_client import load_engine
    config = json.loads(os.environ['REPORT_EMAIL_SMTP'])
    sender, recipient = config['sender'], config['test_recipient']
    if not isinstance(recipient,str) or '@' not in recipient or recipient not in config['recipients']:
        raise ValueError('The dedicated test inbox must be configured')
    module, _, _ = load_engine()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result, files = module.prepare_forecast(refresh=False)
    note = None
    if sys.argv[1:] == ['--with-model-note']:
        job = os.environ['REPORT_EMAIL_MODEL_NOTE_JOB']
        note = forecast_model_note(job, 'forecast')
        if note is None:
            raise ValueError('No model PDF was configured for the test')
    mail = message(sender,[recipient],'forecast',result,files,model_note=note)
    mail.replace_header('Subject','[Тест] '+str(mail['Subject']))
    with gmail_connection() as smtp:
        smtp.login(sender,config['app_password'])
        if smtp.send_message(mail,from_addr=sender,to_addrs=[recipient]):
            raise RuntimeError('The designated test inbox was rejected')
        attachment_types = ', '.join(part.get_content_type() for part in mail.iter_attachments())
        print('Gmail accepted one test email. Attachments:', attachment_types, flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code=getattr(error,'smtp_code',None)
        print('Gmail test failed:',type(error).__name__,f'(SMTP {code})' if isinstance(code,int) else '',flush=True)
        sys.exit(1)
