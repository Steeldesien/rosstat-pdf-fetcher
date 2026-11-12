"""Public Rosstat downloader. Telegram credentials and delivery state stay in the broker."""
from datetime import datetime, date
from email.utils import parsedate_to_datetime
import os
from pathlib import Path
import re
import time
from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET
import requests

RSS = 'https://rosstat.gov.ru/central-news/rss'
MAX_BYTES = 25 * 1024 * 1024
ROOT = Path(__file__).resolve().parent


class RetryLater(RuntimeError):
    def __init__(self, seconds):
        super().__init__('Source requested a pause')
        self.seconds = max(60, seconds)


def validate_source(url):
    parsed = urlparse(url)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.username or parsed.password or
            parsed.port not in (None, 443) or
            not (host == 'rosstat.gov.ru' or host.endswith('.rosstat.gov.ru'))):
        raise ValueError('Download address is outside the allowed source')
    return url


def matches(title, kind):
    text = ' '.join(title.lower().split())
    if kind == 'inflation':
        return text.startswith('об оценке индекса потребительских цен')
    if kind == 'gdp':
        return ('ввп' in text or 'валового внутреннего продукта' in text) and 'iii квартал' in text and '2026' in text
    raise ValueError('Unsupported publication kind')


def report_end(title):
    months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
    match = re.search(r'по\s+(\d{1,2})\s+('+'|'.join(months)+r')\s+(\d{4})', title.lower())
    if not match:
        return None
    try:
        return date(int(match[3]),months.index(match[2])+1,int(match[1])).isoformat()
    except ValueError:
        return None


def entries(xml, kind):
    found = []
    for item in ET.fromstring(xml).findall('./channel/item'):
        title = ' '.join((item.findtext('title') or '').split())
        if not matches(title, kind):
            continue
        try:
            url = validate_source((item.findtext('link') or '').strip())
            stamp = parsedate_to_datetime(item.findtext('pubDate')).timestamp()
        except (ValueError, TypeError, AttributeError):
            continue
        found.append({'title': title, 'url': url, 'stamp': stamp, 'report_end': report_end(title)})
    return sorted(found, key=lambda item: item['stamp'])


def check_job(job, fetch, deliver):
    found = entries(fetch(RSS), job['kind'])
    if job['mode'] != 'latest':
        if job.get('report_end'):
            found = [item for item in found if item['report_end'] == job['report_end']]
        else:
            cutoff = datetime.fromisoformat(job['not_before']).timestamp()
            found = [item for item in found if item['stamp'] >= cutoff]
    if not found:
        return 'waiting'
    item = found[-1]
    data = fetch(item['url'])
    if not data.startswith(b'%PDF-') or len(data) > MAX_BYTES:
        raise ValueError('Source response is not an acceptable PDF')
    deliver(job, data, item)
    return 'delivered'


class Rosstat:
    def __init__(self):
        self.client = requests.Session()
        self.client.headers['User-Agent'] = 'RosstatPublicPDFDownloader/1.0'

    def fetch(self, url):
        # Validate each redirect before sending it. Never disable TLS validation.
        for _ in range(8):
            validate_source(url)
            with self.client.get(url, verify=str(ROOT / 'rosstat_ca.pem'),
                                 timeout=(15, 60), stream=True, allow_redirects=False) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.headers['Location'])
                    continue
                if response.status_code in (403, 429):
                    retry = response.headers.get('Retry-After', '900')
                    raise RetryLater(int(retry) if retry.isdigit() else 900)
                response.raise_for_status()
                parts, size = [], 0
                for part in response.iter_content(65536):
                    size += len(part)
                    if size > MAX_BYTES:
                        raise ValueError('Download exceeds size limit')
                    parts.append(part)
                return b''.join(parts)
        raise ValueError('Too many source redirects')


class Broker:
    def __init__(self):
        self.base = os.environ['BROKER_URL'].rstrip('/')
        parsed = urlparse(self.base)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/'):
            raise ValueError('Broker must be an HTTPS origin')
        self.run_id = os.environ.get('GITHUB_RUN_ID', 'local') + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
        self.client = requests.Session()
        self.client.headers['Authorization'] = 'Bearer ' + os.environ['BROKER_TOKEN']

    def call(self, path, **kwargs):
        response = self.client.post(self.base + '/runner/' + path, timeout=(15, 90), allow_redirects=False, **kwargs)
        if not response.ok:
            raise RuntimeError('Private delivery broker rejected the request')
        return response.json()

    def claim(self, job_id):
        return self.call('claim', json={'job_id': job_id, 'run_id': self.run_id})

    def deliver(self, job, data, item):
        result = self.call('deliver', data={'job_id': job['id'], 'run_id': self.run_id,
                                          'title': item['title'], 'source_url': item['url'],
                                          'publication_stamp': str(item['stamp'])},
                           files={'document': ('Rosstat.pdf', data, 'application/pdf')})
        if result.get('status') != 'completed':
            raise RuntimeError('Delivery has not been confirmed')

    def release(self, job_id):
        self.call('release', json={'job_id': job_id, 'run_id': self.run_id})

    def backoff(self, job_id, seconds):
        self.call('backoff', json={'job_id': job_id, 'run_id': self.run_id, 'seconds': seconds})

    def waiting(self, job_id):
        return self.call('waiting', json={'job_id': job_id, 'run_id': self.run_id})


def poll(job_id, broker, fetch, sleep=time.sleep, clock=time.monotonic, duration=295*60):
    deadline = clock() + duration
    while clock() < deadline:
        began = clock()
        delay = 60
        claimed = False
        try:
            claim = broker.claim(job_id)
            if claim['status'] in ('completed', 'cancelled', 'needs_review'):
                return claim['status']
            if claim['status'] == 'backoff':
                delay = max(1, claim.get('retry_after', 60))
                if delay > 60:
                    return 'deferred'
            if claim['status'] == 'ready':
                claimed = True
                if claim['job']['id'] != job_id:
                    raise ValueError('Unexpected job identifier')
                if check_job(claim['job'], fetch, broker.deliver) == 'delivered':
                    return 'completed'
                delay = broker.waiting(job_id)['interval_seconds']
                if delay > 60:
                    return 'deferred'
        except RetryLater as error:
            delay = error.seconds
            broker.backoff(job_id, delay)
            print('Source requested backoff:', delay, 'seconds', flush=True)
            return 'deferred'
        except Exception as error:
            # Do not print request exceptions, URLs from broker responses, or headers.
            print('Check will retry:', type(error).__name__, flush=True)
            if claimed:
                try:
                    delay = broker.waiting(job_id)['interval_seconds']
                    if delay > 60:
                        return 'deferred'
                except Exception:
                    pass
        sleep(max(0, min(delay - (clock() - began), deadline - clock())))
    return 'resume'


def main():
    job_id = os.environ['JOB_ID']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', job_id):
        raise ValueError('Invalid opaque job identifier')
    broker = Broker()
    try:
        print('Downloader finished:', poll(job_id, broker, Rosstat().fetch), flush=True)
    finally:
        try:
            broker.release(job_id)
        except Exception:
            print('Broker will recover the job after runner shutdown', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Downloader stopped:', type(error).__name__, flush=True)
        raise SystemExit(1)
