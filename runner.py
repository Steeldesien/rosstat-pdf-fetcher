"""Public Rosstat downloader. Telegram credentials and delivery state stay in the broker."""
from datetime import datetime, date
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import calendar
import json
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
CATALOGUE = 'https://rosstat.gov.ru/compendium/document/50798'
REPORTS = {item['kind']: item for item in json.loads((ROOT/'reports.json').read_text(encoding='utf-8'))}
MONTHS = [('января','январе','январь'),('февраля','феврале','февраль'),('марта','марте','март'),
          ('апреля','апреле','апрель'),('мая','мае','май'),('июня','июне','июнь'),('июля','июле','июль'),
          ('августа','августе','август'),('сентября','сентябре','сентябрь'),('октября','октябре','октябрь'),
          ('ноября','ноябре','ноябрь'),('декабря','декабре','декабрь')]


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
    if kind not in REPORTS:raise ValueError('Unsupported publication kind')
    return any(text.startswith(prefix) for prefix in REPORTS[kind]['prefixes'])


def quarter_period(title):
    match=re.search(r'\b(iv|iii|ii|i)\s+квартал[а-я]*\s+(\d{4})',title.lower())
    return f"{match[2]}-Q{['i','ii','iii','iv'].index(match[1])+1}" if match else None


def entry_key(item):
    title=item['title'].lower(); years=re.findall(r'\b20\d{2}\b',title)
    year=max(map(int,years)) if years else 0
    end=report_end(title)
    if end:period=int(end.replace('-',''))
    else:
        quarter=quarter_period(title)
        if quarter:month=int(quarter[-1])*3
        else:
            found=[(m.start(),i+1) for i,forms in enumerate(MONTHS) for form in forms for m in re.finditer(r'\b'+form+r'\b',title)]
            month=max(found)[1] if found else 0
            if not month and re.search(r'(?:\bв|\bза)\s+20\d{2}\s+год',title):month=12
        period=year*10000+month*100+(calendar.monthrange(year,month)[1] if year and month else 0)
    # For the same period prefer the official news publication timestamp over a catalogue modification date.
    return period,bool(item.get('stamp')),item.get('stamp') or item.get('sort_stamp') or 0


class CatalogueParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.depth=0;self.record=None;self.root=None;self.field=None;self.field_depth=None;self.items=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='div':
            self.depth+=1;classes=attrs.get('class','').split()
            if 'document-list__item' in classes and 'document-list__item--list-tree' not in classes:
                self.record={'title':[],'info':[],'pdfs':[]};self.root=self.depth
            if self.record is not None:
                for field in ['title','info']:
                    if 'document-list__item-'+field in classes:self.field=field;self.field_depth=self.depth
        if tag=='a' and self.record is not None and urlparse(attrs.get('href','')).path.lower().endswith('.pdf'):
            self.record['pdfs'].append(urljoin(CATALOGUE,attrs['href']))
    def handle_data(self,data):
        if self.record is not None and self.field:self.record[self.field].append(data)
    def handle_endtag(self,tag):
        if tag!='div':return
        if self.depth==self.field_depth:self.field=None;self.field_depth=None
        if self.record is not None and self.depth==self.root:
            title=' '.join(''.join(self.record['title']).split());info=' '.join(self.record['info'])
            if title and self.record['pdfs']:
                try:
                    url=validate_source(self.record['pdfs'][0]);match=re.search(r'\b(\d{2})\.(\d{2})\.(\d{4})\b',info)
                    publication_date=date(int(match[3]),int(match[2]),int(match[1])).isoformat() if match else None
                    self.items.append({'title':title,'url':url,'stamp':None,'catalogue_date':publication_date,
                                       'sort_stamp':datetime.fromisoformat(publication_date+'T00:00:00+03:00').timestamp() if publication_date else 0})
                except (ValueError,TypeError):pass
            self.record=None;self.root=None
        self.depth-=1


def catalogue_entries(html,kind):
    parser=CatalogueParser();parser.feed(html.decode('utf-8') if isinstance(html,bytes) else html)
    return [item for item in parser.items if matches(item['title'],kind)]


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


def check_job(job, fetch, deliver, analyze=None, progress=None):
    if job.get('resume_source'):
        item=job['resume_source'];validate_source(item['url'])
        if not matches(item['title'],job['kind']):raise ValueError('Wrong report repair source')
        found=[item]
    else:found = entries(fetch(RSS), job['kind'])
    if job.get('resume_source'):pass
    elif job['mode'] == 'latest':
        # The catalogue complements the short RSS feed. Prefer the newest actual reporting period.
        found += catalogue_entries(fetch(CATALOGUE),job['kind'])
    else:
        if job.get('gdp_period'):
            found=[item for item in found if quarter_period(item['title'])==job['gdp_period']]
        if job.get('report_end'):
            found = [item for item in found if item['report_end'] == job['report_end']]
        else:
            cutoff = datetime.fromisoformat(job['not_before']).timestamp()
            found = [item for item in found if item['stamp'] >= cutoff]
    if not found:
        return 'waiting'
    item = max(found,key=entry_key)
    if progress:progress(job,'downloading')
    data = fetch(item['url'])
    if not data.startswith(b'%PDF-') or len(data) > MAX_BYTES:
        raise ValueError('Source response is not an acceptable PDF')
    item['received_stamp'] = time.time()
    deliver(job, data, item)
    if job.get('analysis_mode') and analyze:
        analyze(job, found, {item['url']:data})
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
        timeout=240 if path in ('analyze','forecast-finish') else 120
        response = self.client.post(self.base + '/runner/' + path, timeout=(15,timeout), allow_redirects=False, **kwargs)
        if not response.ok:
            raise RuntimeError('Private delivery broker rejected the request')
        return response.json()

    def claim(self, job_id):
        return self.call('claim', json={'job_id': job_id, 'run_id': self.run_id})

    def progress(self, job, stage, key=None):
        if job.get('mode')!='scheduled':return
        try:self.call('progress',json={'job_id':job['id'],'run_id':self.run_id,'stage':stage,**({'key':key} if key else {})})
        except Exception:print('Status update unavailable',flush=True)

    def deliver(self, job, data, item):
        result = self.call('deliver', data={'job_id': job['id'], 'run_id': self.run_id,
                                          'title': item['title'], 'source_url': item['url'],
                                          'publication_stamp': str(item.get('stamp','')),
                                          'catalogue_date': item.get('catalogue_date') or '',
                                          'received_stamp': str(item['received_stamp'])},
                           files={'document': ('Rosstat.pdf', data, 'application/pdf')})
        if result.get('status') != 'completed':
            raise RuntimeError('Delivery has not been confirmed')

    def analyze(self, job, found, known, fetch):
        from analysis import IncompleteArchive, prepare_plan, complete_archive
        try:
            history=self.call('archive',json={'job_id':job['id'],'run_id':self.run_id}).get('documents',[])
            if job.get('resume_source') and job['analysis_mode']=='release':
                found=[r for r in found if r['url']==job['resume_source']['url']]
            else:found += history
            if job['mode']!='latest' and job['analysis_mode']!='release':
                found += catalogue_entries(fetch(CATALOGUE),job['kind'])
            try:
                plan=prepare_plan(complete_archive(found,job['kind'],job['analysis_mode'],fetch,
                                  max_pages=3 if job['kind']=='inflation' else 86),fetch,known)
            except IncompleteArchive:
                if job['kind']!='inflation' or job['analysis_mode']=='release':raise
                from weekly_history import history_plan
                plan=history_plan(found,job['analysis_mode'],fetch,known)
            self.call('archive-save',json={'job_id':job['id'],'run_id':self.run_id,
                'documents':[{k:d[k] for k in ['title','url','period_start','period_end']} for d in plan['documents'] if d.get('format')!='table']})
        except (IncompleteArchive,ValueError):
            return self.call('analysis-failure',json={'job_id':job['id'],'run_id':self.run_id,'reason':'incomplete_archive'})
        if job['kind']=='inflation':
            from engine_client import analyze as analyze_engine
            selected_url=next((d['url'] for d in plan['documents'] if d['role']=='selected'),None)
            publication=next((r.get('stamp') for r in found if r.get('url')==selected_url and r.get('stamp')),None)
            if publication:plan={**plan,'publication_stamp':float(publication)}
            else:
                publication_date=next((r.get('catalogue_date') for r in found if r.get('url')==selected_url and r.get('catalogue_date')),None)
                if publication_date:plan={**plan,'publication_date':publication_date}
            result=analyze_engine(self,job,plan,known)
            if result is not None:return result
        result=self.call('analyze',json={'job_id':job['id'],'run_id':self.run_id,'plan':plan})
        if result.get('card'):
            try:
                card=result['card']
                status=self.call('card',json={'job_id':job['id'],'run_id':self.run_id,'key':card['key']})
                if status.get('status')=='needs_image':
                    from summary_card import render_card
                    image=render_card(plan,card['text'])
                    uploaded=self.call('card-upload',data={'job_id':job['id'],'run_id':self.run_id,'key':card['key']},
                              files={'image':('Rosstat_summary.png',image,'image/png')})
                    if uploaded.get('status')!='completed':raise RuntimeError('Image delivery unconfirmed')
                elif status.get('status')!='completed':raise RuntimeError('Image delivery unconfirmed')
            except Exception:
                self.progress(job,'card_error',result['card'].get('key'))
                print('Summary image unavailable; PDF and text retained',flush=True)
        return result

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
                analysis=(lambda job,found,known:broker.analyze(job,found,known,fetch)) if hasattr(broker,'analyze') else None
                progress=getattr(broker,'progress',None)
                if check_job(claim['job'], fetch, broker.deliver,analyze=analysis,progress=progress) == 'delivered':
                    return 'completed'
                delay = broker.waiting(job_id)['interval_seconds']
                if delay > 60:
                    return 'deferred'
        except RetryLater as error:
            if claimed and hasattr(broker,'progress'):broker.progress(claim['job'],'error')
            delay = error.seconds
            broker.backoff(job_id, delay)
            print('Source requested backoff:', delay, 'seconds', flush=True)
            return 'deferred'
        except Exception as error:
            if getattr(broker,'reports_expected',False):raise
            # Do not print request exceptions, URLs from broker responses, or headers.
            print('Check will retry:', type(error).__name__, flush=True)
            if claimed and hasattr(broker,'progress'):broker.progress(claim['job'],'error')
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
