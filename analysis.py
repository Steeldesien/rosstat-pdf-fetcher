"""Select comparable release windows and prepare public PDFs for analysis."""
import base64
import calendar
from datetime import date, timedelta
import hashlib
import io
from html.parser import HTMLParser
import re
import time
from urllib.parse import urljoin,urlparse
from runner import MONTHS, REPORTS, entry_key, quarter_period, report_end, validate_source

WEEKLY = {'inflation', 'fuel'}
LABELS = {'release':'Последний выпуск', 'm1':'Последний месяц', 'm2':'Последние 2 месяца',
          'm3':'Последние 3 месяца', 'm6':'Последние 6 месяцев', 'm12':'Последние 12 месяцев'}


class IncompleteArchive(ValueError):
    pass


def allowed_modes(kind):
    if kind not in REPORTS: raise ValueError('Unsupported report')
    return ['release','m1','m2','m3'] if kind in WEEKLY else ['release','m6','m12'] if kind == 'gdp' else ['release','m3','m6','m12']


def shift_month(value, months):
    number=value.year*12+value.month-1+months
    year,month=divmod(number,12);month+=1
    return date(year,month,min(value.day,calendar.monthrange(year,month)[1]))


def period(title, kind):
    text=' '.join(title.lower().split())
    end=report_end(text)
    if end:
        end=date.fromisoformat(end)
        names=[forms[0] for forms in MONTHS]
        match=re.search(r'\bсо?\s+(\d{1,2})(?:\s+('+'|'.join(names)+r'))?(?:\s+(\d{4})(?:\s+года?)?)?\s+по\s',text)
        if not match: raise IncompleteArchive('Не удалось определить начало периода выпуска.')
        month=names.index(match[2])+1 if match[2] else end.month
        year=int(match[3]) if match[3] else end.year-(month>end.month)
        return date(year,month,int(match[1])),end
    quarter=quarter_period(text)
    if quarter:
        year=int(quarter[:4]);month=int(quarter[-1])*3
        start_month=month-2
        return date(year,start_month,1),date(year,month,calendar.monthrange(year,month)[1])
    half=re.search(r'\bi\s+полугодии?\s+(\d{4})',text)
    if half: return date(int(half[1]),1,1),date(int(half[1]),6,30)
    forms={form:i+1 for i,group in enumerate(MONTHS) for form in group}
    names='|'.join(forms)
    match=re.search(r'(?:\bв|\bза|на\s+конец)\s+('+names+r')(?:\s*[-–]\s*('+names+r'))?\s+(\d{4})',text)
    if match:
        first=forms[match[1]];last=forms[match[2]] if match[2] else first;year=int(match[3])
        end=date(year,last,calendar.monthrange(year,last)[1])
        return (end if 'на конец' in text else date(year-(first>last),first,1)),end
    annual=re.search(r'(?:\bв|\bза)\s+(20\d{2})\s+год',text)
    if annual: return date(int(annual[1]),1,1),date(int(annual[1]),12,31)
    raise IncompleteArchive('Не удалось определить отчётный период выпуска.')


def series(title,kind):
    if kind!='gdp': return kind
    text=title.lower()
    if 'использовании' in text: return 'gdp-use'
    if 'производстве' in text: return 'gdp-production'
    return 'gdp-estimate'


def select_releases(rows,kind,mode):
    if mode not in allowed_modes(kind): raise ValueError('Unsupported analysis mode')
    parsed=[]
    for row in rows:
        try: first,last=period(row['title'],kind)
        except (IncompleteArchive,ValueError): continue
        parsed.append({**row,'period_start':first.isoformat(),'period_end':last.isoformat()})
    if not parsed: raise IncompleteArchive('В архиве не найден выпуск с распознаваемым периодом.')
    latest=max(parsed,key=entry_key)
    parsed=[r for r in parsed if series(r['title'],kind)==series(latest['title'],kind)]
    unique={}
    for row in sorted(parsed,key=entry_key): unique[row['period_end']]=row
    rows=sorted(unique.values(),key=lambda r:r['period_end'])
    end=date.fromisoformat(latest['period_end'])
    if mode=='release': selected=[latest]; start=date.fromisoformat(latest['period_start']); baseline=[]
    else:
        count=int(mode[1:]);cutoff=shift_month(end,-count) if kind in WEEKLY else shift_month(end.replace(day=1),1-count)-timedelta(days=1)
        selected=[r for r in rows if r['period_end']>cutoff.isoformat()]
        baseline=[r for r in rows if r['period_end']<=cutoff.isoformat()][-1:]
        if kind in WEEKLY:
            start=date.fromisoformat(selected[0]['period_start'])
            if start>cutoff+timedelta(days=1): raise IncompleteArchive('В архиве нет начала выбранного периода.')
            for left,right in zip(selected,selected[1:]):
                if date.fromisoformat(right['period_start'])!=date.fromisoformat(left['period_end'])+timedelta(days=1):
                    raise IncompleteArchive('В архиве отсутствует один или несколько недельных выпусков.')
        else:
            step=3 if kind=='gdp' else 1
            expected=count//step
            if len(selected)!=expected: raise IncompleteArchive('В архиве недостаточно выпусков за выбранный период.')
            for left,right in zip(selected,selected[1:]):
                if shift_month(date.fromisoformat(left['period_end']).replace(day=1),step)!=date.fromisoformat(right['period_end']).replace(day=1):
                    raise IncompleteArchive('В архиве есть пропуски между выпусками.')
            start=date.fromisoformat(selected[0]['period_end']).replace(day=1)
            if kind=='gdp': start=shift_month(start,-2)
    documents=[{**r,'role':'baseline'} for r in baseline]+[{**r,'role':'selected'} for r in selected]
    return {'kind':kind,'mode':mode,'start':start.isoformat(),'end':end.isoformat(),'documents':documents}


class NewsParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.title_depth=0;self.href=None;self.text=[];self.items=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='div':
            if self.title_depth:self.title_depth+=1
            elif 'news-card__title' in attrs.get('class','').split():self.title_depth=1
        if tag=='a' and self.title_depth:
            self.href=attrs.get('href');self.text=[]
    def handle_data(self,text):
        if self.href:self.text.append(text)
    def handle_endtag(self,tag):
        if tag=='a' and self.href:
            url=urljoin('https://rosstat.gov.ru/central-news',self.href)
            try:
                if urlparse(validate_source(url)).path.lower().endswith('.pdf'):
                    self.items.append({'title':' '.join(''.join(self.text).split()),'url':url,'stamp':None})
            except ValueError:pass
            self.href=None
        if tag=='div' and self.title_depth:self.title_depth-=1


def news_entries(html,kind):
    from runner import matches
    parser=NewsParser();parser.feed(html.decode('utf-8') if isinstance(html,bytes) else html)
    return [row for row in parser.items if matches(row['title'],kind)]


def complete_archive(rows,kind,mode,fetch,sleep=time.sleep):
    rows=list(rows);previous=set()
    for page in range(1,87):
        try:return select_releases(rows,kind,mode)
        except IncompleteArchive:pass
        html=fetch(f'https://rosstat.gov.ru/central-news?print=1&page={page}')
        digest=hashlib.sha256(html).hexdigest()
        if digest in previous:break
        previous.add(digest)
        rows.extend(news_entries(html,kind))
        # Do not burst requests when backfilling an archive.
        sleep(0.5)
    return select_releases(rows,kind,mode)


def prepare_plan(plan,fetch,known_bytes=None):
    from pypdf import PdfReader
    total=0;documents=[]
    known_bytes=known_bytes or {}
    for item in plan['documents']:
        validate_source(item['url'])
        data=known_bytes[item['url']] if item['url'] in known_bytes else fetch(item['url'])
        total+=len(data)
        if not data.startswith(b'%PDF-') or total>8*1024*1024: raise IncompleteArchive('Набор PDF превышает допустимый размер анализа.')
        reader=PdfReader(io.BytesIO(data))
        if len(reader.pages)>100: raise IncompleteArchive('Слишком много страниц в одном выпуске.')
        pages=[{'page':i+1,'text':p.extract_text(extraction_mode='layout')} for i,p in enumerate(reader.pages)]
        if sum(len(p['text']) for p in pages)>150000: raise IncompleteArchive('Слишком большой выпуск для текущего режима анализа.')
        documents.append({k:item[k] for k in ['title','url','period_start','period_end','role']} | {
            'sha256':hashlib.sha256(data).hexdigest(),'pages':pages,'pdf':base64.b64encode(data).decode('ascii')})
    return {**plan,'documents':documents}
