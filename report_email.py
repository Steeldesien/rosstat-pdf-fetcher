"""Send the same three weekly artifacts through a privately configured SMTP account."""
import base64
import json
import os
import smtplib
import ssl
from datetime import date
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

MONTHS = ('января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')
KINDS = {'png': ('image', 'png'), 'short': ('text', 'html'), 'full': ('text', 'html')}


def gmail_connection():
    """Try the alternate transport only before any authentication or delivery."""
    context=ssl.create_default_context()
    hostname='smtp.gmail.com'
    try:
        smtp=smtplib.SMTP_SSL(hostname,465,timeout=15,context=context)
        smtp.port=465
        return smtp
    except (OSError,smtplib.SMTPServerDisconnected):
        smtp=smtplib.SMTP(hostname,587,timeout=15)
        try:
            smtp.starttls(context=context)
        except Exception:
            smtp.close()
            raise
        smtp.port=587
        return smtp


def period(start, end):
    first, last = date.fromisoformat(start), date.fromisoformat(end)
    if first > last:
        raise ValueError('Invalid reporting period')
    if first.year == last.year and first.month == last.month:
        return f'{first.day}–{last.day} {MONTHS[last.month-1]} {last.year}'
    if first.year == last.year:
        return f'{first.day} {MONTHS[first.month-1]} — {last.day} {MONTHS[last.month-1]} {last.year}'
    return f'{first:%d.%m.%Y} — {last:%d.%m.%Y}'


def forecast_model_note(job_id, mode):
    target = os.environ.get('REPORT_EMAIL_MODEL_NOTE_JOB')
    if mode != 'forecast' or not target or job_id != target:
        return None
    parts = [os.environ.get(f'REPORT_EMAIL_MODEL_NOTE_{index}', '') for index in range(1, 4)]
    if not all(parts):
        raise ValueError('Forecast model PDF configuration is incomplete')
    pdf = base64.b64decode(''.join(parts), validate=True)
    if not pdf.startswith(b'%PDF-'):
        raise ValueError('Invalid forecast model PDF')
    return pdf


def message(sender, recipients, mode, data, files, *, model_note=None):
    if not recipients:
        raise ValueError('No report email recipients configured')
    span = period(data['start'], data['end'])
    if mode == 'forecast':
        fmt = lambda value: f'{float(value):+.2f}%'.replace('.', ',')
        subject = f'Недельная инфляция • предварительный прогноз за {span}'
        asof = date.fromisoformat(data['asof'])
        body = (f'Направляем предварительный прогноз недельной инфляции за {span}.\n\n'
                f'Ожидаемый прирост цен — {fmt(data["point"])}. '
                f'Прогнозный интервал 80% — от {fmt(data["lo80"])} до {fmt(data["hi80"])}. '
                f'Расчёт выполнен по данным на {asof:%d.%m.%Y}.')
    elif mode == 'actual':
        subject = f'Недельная инфляция • фактический выпуск за {span}'
        body = f'Направляем отчёт по недельной инфляции за {span} на основе опубликованных данных Росстата.'
    else:
        raise ValueError('Invalid report email mode')
    mail = EmailMessage()
    mail['From'] = sender
    mail['To'] = ', '.join(recipients)
    mail['Date'] = formatdate(localtime=False)
    mail['Message-ID'] = make_msgid(domain=sender.rsplit('@', 1)[-1])
    mail['Subject'] = subject
    attachments = 'Во вложениях — PNG-карточка, краткий и полный отчёты в HTML.'
    if 'short_email' in files and 'full_email' in files:
        attachments += ' Для интерактивных графиков скачайте HTML и откройте его в браузере.'
    if model_note is not None:
        attachments += ' Также прилагаем описание модели прогноза в PDF.'
    mail.set_content('Коллеги, добрый день!\n\n' + body + '\n\n' + attachments + '\n\nАвтоматическая рассылка по недельной инфляции.')
    for kind, (main, sub) in KINDS.items():
        path = files.get(f'{kind}_email', files[kind]) if sub == 'html' else files[kind]
        if path.suffix.lower() != '.' + sub:
            raise ValueError('Unexpected report attachment type')
        mail.add_attachment(path.read_bytes(), maintype=main, subtype=sub, filename=path.name)
    if model_note is not None:
        mail.add_attachment(model_note, maintype='application', subtype='pdf', filename='Модель прогноза недельной инфляции.pdf')
    return mail


def send_report(broker, identity, mode, data, files, *, eligible):
    raw = os.environ.get('REPORT_EMAIL_SMTP')
    if not eligible or not raw:
        return
    ticket = {**identity, 'mode':mode}
    try:
        config = json.loads(raw)
        recipients = json.loads(os.environ['REPORT_EMAIL_RECIPIENTS'])
        if not isinstance(recipients, list) or not recipients:
            raise ValueError('No report email recipients configured')
        claim = broker.call('email-status', json=ticket)
        if claim['status'] != 'ready':
            return
        note = forecast_model_note(identity.get('job_id'), mode)
        mail = message(config['sender'], recipients, mode, data, files(), model_note=note)
        with gmail_connection() as smtp:
            smtp.login(config['sender'], config['app_password'])
            if broker.call('email-reserve', json=ticket)['status'] != 'reserved':
                return
            try:
                refused = smtp.send_message(mail, from_addr=config['sender'], to_addrs=recipients)
                status = 'partial' if refused else 'accepted'
            except (smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError):
                status = 'rejected'
            except Exception:
                status = 'uncertain'
            broker.call('email-result', json={**ticket,'status':status})
            if status == 'accepted':
                types = ', '.join(part.get_content_type() for part in mail.iter_attachments())
                print('Gmail accepted report email. Attachments:', types, flush=True)
            else:
                print('Report email:',status,flush=True)
    except Exception as error:
        print('Report email could not be confirmed:',type(error).__name__,flush=True)
