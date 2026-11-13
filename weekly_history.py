"""Official Rosstat weekly goods indices as a transparent archive fallback."""
from datetime import date,timedelta
from decimal import Decimal
import hashlib
import io
import json
from pathlib import Path
import re
from analysis import IncompleteArchive,shift_month,prepare_plan
from runner import MONTHS,entry_key

HISTORY_URL='https://rosstat.gov.ru/storage/mediabank/nedel_Ipc.xlsx'


def period_cpi(current,baseline,start,end):
    if start[:4]!=end[:4]:return None
    pattern=r'с начала года\s*[-–]?\s*(\d{2,3},\d+)%'
    last=re.search(pattern,' '.join(current.split()),re.I)
    first=re.search(pattern,' '.join(baseline.split()),re.I)
    if not last or not first:return None
    return float((Decimal(last[1].replace(',','.'))/Decimal(first[1].replace(',','.'))-1)*100)


def read_history(data,end,start_after):
    from openpyxl import load_workbook
    end=date.fromisoformat(end);cutoff=date.fromisoformat(start_after)
    workbook=load_workbook(io.BytesIO(data),read_only=True,data_only=True)
    columns={};goods={}
    months={forms[0]:i+1 for i,forms in enumerate(MONTHS)}
    for year in range(cutoff.year,end.year+1):
        if str(year) not in workbook:raise IncompleteArchive('В таблице нет нужного года.')
        rows=list(workbook[str(year)].values);header=None
        for i,row in enumerate(rows[:15]):
            if str(row[0] or '').strip().lower()=='наименование':header=i;break
        if header is None:raise IncompleteArchive('Не распознан заголовок недельной таблицы.')
        dates=[]
        for column,value in enumerate(rows[header][1:],1):
            match=re.search(r'на\s+(\d{1,2})\s+('+'|'.join(months)+r')',str(value or '').lower())
            if not match:continue
            day=date(year,months[match[2]],int(match[1]));dates.append((column,day))
        for position,(column,day) in enumerate(dates):
            previous=dates[position-1][1] if position else date(year,1,1)-timedelta(days=1)
            if cutoff<day<=end:columns[day]=previous
        for row in rows[header+1:]:
            name=str(row[0] or '').strip()
            if not name or name.startswith(('*','…')):continue
            for column,day in dates:
                if day not in columns:continue
                value=row[column] if column<len(row) else None
                if isinstance(value,(int,float)) and not isinstance(value,bool) and 0<float(value)<1000:
                    goods.setdefault(name,{})[day]=Decimal(str(value))
    ordered=sorted(columns)
    if not ordered or ordered[-1]!=end:raise IncompleteArchive('В таблице нет последней недели.')
    first_previous=columns[ordered[0]]
    if first_previous>cutoff:raise IncompleteArchive('В таблице нет начала диапазона.')
    if any(columns[right]!=left for left,right in zip(ordered,ordered[1:])):raise IncompleteArchive('В таблице есть пропуск недель.')
    result=[]
    for name,values in goods.items():
        if not all(day in values for day in ordered):continue
        product=Decimal(1)
        for day in ordered:product*=values[day]/100
        result.append({'name':name,'indices':[float(values[day]) for day in ordered],'change':float((product-1)*100)})
    if not result:raise IncompleteArchive('Нет непрерывных рядов товаров за диапазон.')
    return {'start':(first_previous+timedelta(days=1)).isoformat(),'end':end.isoformat(),'base_date':first_previous.isoformat(),
            'dates':[day.isoformat() for day in ordered],'goods':result,'aggregate_cpi':None,'source_url':HISTORY_URL}


def history_plan(rows,mode,fetch,known_bytes=None):
    from analysis import period
    rows=list(rows)+json.loads((Path(__file__).parent/'archive_supplement.json').read_text(encoding='utf-8'))
    latest=max(rows,key=entry_key);end=period(latest['title'],'inflation')[1]
    data=fetch(HISTORY_URL)
    history=read_history(data,end.isoformat(),shift_month(end,-int(mode[1:])).isoformat())
    current=prepare_plan({'kind':'inflation','mode':mode,'start':history['start'],'end':history['end'],
                          'documents':[{**latest,'period_start':period(latest['title'],'inflation')[0].isoformat(),'period_end':end.isoformat(),'role':'reference'}]},fetch,known_bytes)
    baselines=[]
    for row in rows:
        try:
            first,last=period(row['title'],'inflation')
            if last.isoformat()==history['base_date']:baselines.append({**row,'period_start':first.isoformat(),'period_end':last.isoformat(),'role':'baseline'})
        except ValueError:pass
    if baselines:
        try:
            base=prepare_plan({'kind':'inflation','mode':mode,'start':history['start'],'end':history['end'],
                               'documents':[max(baselines,key=entry_key)]},fetch,known_bytes)['documents'][0]
            history['aggregate_cpi']=period_cpi(current['documents'][0]['pages'][0]['text'],base['pages'][0]['text'],history['base_date'],history['end'])
            current['documents'].insert(0,base)
        except Exception:
            # Historical aggregate CPI is optional; never replace it with an average of goods.
            pass
    fmt=lambda value:f'{value:.2f}'.replace('.',',')
    calculated='\n'.join(f"{g['name']} | изменение за {history['start']} — {history['end']} (цепная оценка): {fmt(g['change'])}%." for g in history['goods'])
    matrix='Товар | '+' | '.join(history['dates'])+'\n'+'\n'.join(g['name']+' | '+' | '.join(fmt(v)+'%' for v in g['indices']) for g in history['goods'])
    aggregate=('Общего ИПЦ в XLSX нет. Цепная оценка общего изменения цен за весь диапазон по двум PDF с общей базой с начала года: '+fmt(history['aggregate_cpi'])+'%.\n') if history['aggregate_cpi'] is not None else 'Общий ИПЦ за весь диапазон неизвестен.\n'
    table={'title':'Еженедельные индексы потребительских цен на отдельные товары и услуги — официальный XLSX Росстата',
           'url':HISTORY_URL,'period_start':history['start'],'period_end':history['end'],'role':'selected','format':'table',
           'sha256':hashlib.sha256(data).hexdigest(),'sheet':str(end.year),'pages':[
               {'page':1,'text':f"Источник: лист {end.year} официального XLSX Росстата. Недельных наблюдений: {len(history['dates'])}. Товаров с полным рядом: {len(history['goods'])}.\n"
                 +aggregate+'Товары нельзя усреднять без весов. Показатели товаров ниже рассчитаны кодом: 100*(произведение недельных индексов/100 - 1). Общий темп, если доступен, рассчитан как 100*(ИПЦ с начала года на конец / ИПЦ с начала года на базовую дату - 1). Не официальный месячный ИПЦ.\n'+calculated},
               {'page':2,'text':'Исходные индексы в процентах к предыдущей дате регистрации:\n'+matrix}]}
    current['documents'].append(table);current['weekly_history']=history
    return current
