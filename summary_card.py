"""Deterministic summary cards. Chart values come from PDF text, never image AI."""
from decimal import Decimal
from datetime import date,timedelta
import io
import re
import textwrap
from pathlib import Path

RED='#A50034'
INK='#28252C'
MUTED='#77727D'
PAPER='#FFFFFF'
PANEL='#F5F3F5'


def change(index):
    return float(Decimal(index.replace(',','.'))-100)


def chart_data(plan):
    result={'weekly':[],'kpis':[],'categories':[],'cumulative':[],'range':plan['mode']!='release'}
    if plan.get('weekly_history'):
        history=plan['weekly_history'];goods=history['goods']
        result.update({'history':True,'series':[],'categories':[(g['name'].split(',')[0],g['change']) for g in goods]})
        up=max(goods,key=lambda g:g['change']);down=min(goods,key=lambda g:g['change'])
        result['kpis']=[{'label':'Макс. рост товаров¹','value':up['change'],'detail':up['name'].split(',')[0]},
                        {'label':'Макс. снижение¹','value':down['change'],'detail':down['name'].split(',')[0]}]
        if history['aggregate_cpi'] is not None:result['kpis'].insert(0,{'label':'За выбранный период¹','value':history['aggregate_cpi'],'detail':'По сопоставимым индексам PDF'})
        pdfs=[{**d,'role':'selected'} for d in plan['documents'] if d.get('format')!='table']
        if pdfs:
            latest=chart_data({**plan,'mode':'release','weekly_history':None,'documents':pdfs})
            if latest['kpis'] and history['aggregate_cpi'] is None:result['kpis'].append({'label':'Последняя неделя, ИПЦ','value':latest['kpis'][0]['value']})
        chosen=[]
        for prefix in ['Огурцы','Помидоры','Бензин']:
            found=next((g for g in goods if g['name'].startswith(prefix)),None)
            if found:chosen.append(found)
        if not chosen:chosen=[up,down] if up!=down else [up]
        for g in chosen:
            product=Decimal(1);points=[{'date':history['base_date'],'value':0}]
            for day,index in zip(history['dates'],g['indices']):
                product*=Decimal(str(index))/100
                points.append({'date':day,'value':float((product-1)*100)})
            result['series'].append({'name':g['name'].split(',')[0],'points':points})
        return result
    if plan['kind'] not in ('inflation','cpi'):return result
    current=None;selected=[]
    for doc in sorted(plan['documents'],key=lambda d:d['period_end']):
        text=' '.join(doc['pages'][0]['text'].split())
        found=re.search(r'индекс потребительских цен.{0,200}?составил\s+(\d{2,3},\d+)%.*?с начала месяца\s*[-–]?\s*(\d{2,3},\d+)%.*?с начала года\s*[-–]?\s*(\d{2,3},\d+)%',text,re.I)
        if not found:continue
        point={'date':doc['period_end'],'value':change(found[1]),'baseline':doc['role']=='baseline'}
        result['weekly'].append(point)
        if doc['role']=='selected':current=(doc,found);selected.append((doc,point))
    if not current:return result
    doc,found=current
    result['kpis']=[{'label':'За неделю' if plan['kind']=='inflation' else 'За месяц','value':change(found[1])},
                    {'label':'С начала месяца','value':change(found[2])},{'label':'С начала года','value':change(found[3])}]
    labels={'Огурцы':'Огурцы','Помидоры':'Помидоры','Капуста белокочанная':'Капуста','Яблоки':'Яблоки',
            'Сахар-песок':'Сахар','Бензин автомобильный':'Бензин','Дизельное топливо':'Дизель',
            'Яйца куриные':'Яйца','Картофель':'Картофель','Морковь':'Морковь'}
    def categories(document):
        values={};all_text='\n'.join(p['text'] for p in document['pages']).replace(' -','-').replace('- ','-')
        for label,short in labels.items():
            row=re.search(r'^\s*'+re.escape(label)+r'(?:\s+свеж[а-я]+)?\s+(\d{2,3},\d+)\s+(\d{2,3},\d+)\s+(\d{2,3},\d+)',all_text,re.M|re.I)
            if row:values[short]=Decimal(row[1].replace(',','.'))/100
        return values
    if result['range']:
        if len(selected)!=sum(d['role']=='selected' for d in plan['documents']):
            # Never silently replace a range with the newest successfully parsed issue.
            return {'weekly':[],'kpis':[],'categories':[],'cumulative':[],'range':True}
        cumulative=Decimal(1)
        start=selected[0][0].get('period_start',plan['start'])
        result['cumulative']=[{'date':(date.fromisoformat(start)-timedelta(days=1)).isoformat(),'value':0,'baseline':True}]
        for document,point in selected:
            cumulative*=1+Decimal(str(point['value']))/100
            result['cumulative'].append({'date':point['date'],'value':float((cumulative-1)*100),'baseline':False})
        mean=(cumulative**(Decimal(1)/Decimal(len(selected)))-1)*100
        result['kpis']=[{'label':'За выбранные недели¹','value':float((cumulative-1)*100)},
                       {'label':'В среднем за неделю¹','value':float(mean)},
                       {'label':'Последняя неделя','value':selected[-1][1]['value']}]
        tables=[categories(document) for document,_ in selected]
        common=set.intersection(*(set(t) for t in tables))
        for name in sorted(common):
            index=Decimal(1)
            for table in tables:index*=table[name]
            result['categories'].append((name,float((index-1)*100)))
    else:result['categories']=[(name,float((index-1)*100)) for name,index in categories(doc).items()]
    return result


def render_card(plan,analysis_text):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter
    from PIL import Image,ImageDraw,ImageFont
    from runner import REPORTS
    from analysis import LABELS
    font_dir=Path(matplotlib.get_data_path())/'fonts/ttf'
    def font(size,bold=False):return ImageFont.truetype(str(font_dir/('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')),size)
    canvas=Image.new('RGB',(1600,1600),PAPER);draw=ImageDraw.Draw(canvas)
    def text(x,y,value,size=30,color=INK,bold=False):draw.text((x,y),str(value),font=font(size,bold),fill=color)
    def wrap(value,x,y,width,size=27,max_lines=3,color=INK):
        words=value.split();lines=[];line=''
        for word in words:
            candidate=(line+' '+word).strip()
            if draw.textlength(candidate,font=font(size))>width and line:lines.append(line);line=word
            else:line=candidate
        if line:lines.append(line)
        for i,line in enumerate(lines[:max_lines]):text(x,y+i*(size+10),line+('…' if i==max_lines-1 and len(lines)>max_lines else ''),size,color)
    def num(value):return ('+' if value>0 else '')+f'{value:.2f}'.replace('.',',')+'%'
    data=chart_data(plan)
    # Burgundy and neutral edition; a new palette changes the card cache version.
    draw.rectangle((0,0,1600,14),fill=RED)
    text(70,55,'УБРиР',48,RED,True);text(315,72,'МАКРОЭКОНОМИКА',23,MUTED,True)
    text(1200,76,'РОССТАТ / ОБЗОР',20,MUTED)
    title=REPORTS[plan['kind']]['label'].replace(' — последний выпуск','')
    wrap(title.upper(),70,153,1460,54,2)
    date=lambda value:value.split('-')[2]+'.'+value.split('-')[1]+'.'+value.split('-')[0]
    text(74,240,f"{LABELS[plan['mode']]}  /  {date(plan['start'])} — {date(plan['end'])}",26,MUTED)
    if data['kpis']:
        for i,kpi in enumerate(data['kpis']):
            x=70+i*500;draw.rounded_rectangle((x,305,x+465,495),radius=18,fill=RED if i==0 else PANEL)
            text(x+28,330,kpi['label'],27,'white' if i==0 else MUTED)
            text(x+24,382,num(kpi['value']),63,'white' if i==0 else INK,True)
            if kpi.get('detail'):text(x+28,462,textwrap.shorten(kpi['detail'],width=30,placeholder='…'),21,'white' if i==0 else MUTED)
    else:
        draw.rounded_rectangle((70,305,1530,495),radius=18,fill=PANEL)
        metric_lines=[line[2:] for line in analysis_text.splitlines() if line.startswith('• ')][:3]
        wrap('  /  '.join(metric_lines) or 'Ключевые показатели — в текстовом разборе',100,345,1390,30,3)

    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':13,'axes.edgecolor':'#DCD8DE','axes.labelcolor':MUTED,'xtick.color':MUTED,'ytick.color':MUTED})
    def place_plot(fig,box):
        out=io.BytesIO();fig.savefig(out,format='png',dpi=140,facecolor='white');plt.close(fig)
        chart=Image.open(out).convert('RGB');chart.thumbnail((box[2]-box[0],box[3]-box[1]),Image.Resampling.LANCZOS)
        canvas.paste(chart,(box[0]+(box[2]-box[0]-chart.width)//2,box[1]))
    text(74,540,'ЦЕНЫ ОТДЕЛЬНЫХ ТОВАРОВ¹' if data.get('history') else ('НАКОПЛЕННОЕ ИЗМЕНЕНИЕ ЦЕН¹' if data['range'] else 'ДИНАМИКА ЦЕН') if data['weekly'] else 'ПОКАЗАТЕЛИ ВЫПУСКА',28,INK,True)
    if data.get('history'):text(74,581,'Накопленное изменение к началу выбранного периода, %',22,MUTED)
    if data['weekly']:text(74,581,'К началу выбранного периода, %' if data['range'] else 'Изменение к предыдущей дате регистрации, %',22,MUTED)
    if data.get('series'):
        fig,ax=plt.subplots(figsize=(10.4,2.6));fig.subplots_adjust(left=.08,right=.95,bottom=.24,top=.85)
        colors=[RED,'#504851','#9D929C'];rows=data['series'][0]['points'];xs=list(range(len(rows)))
        ax.axhline(0,color='#BFB9C2',lw=1);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
        for series,color in zip(data['series'],colors):
            values=[p['value'] for p in series['points']]
            ax.plot(xs,values,color=color,lw=2.5,marker='o',markersize=3,label=series['name'])
            ax.annotate(num(values[-1]),(xs[-1],values[-1]),xytext=(8,0),textcoords='offset points',color=color,fontsize=11)
        ticks=sorted(set(xs[::max(1,len(xs)//6)]+[xs[-1]]))
        ax.set_xticks(ticks,[rows[i]['date'][8:10]+'.'+rows[i]['date'][5:7] for i in ticks])
        ax.yaxis.set_major_formatter(FuncFormatter(lambda y,_:f'{y:.1f}'.replace('.',',')))
        ax.legend(loc='upper left',bbox_to_anchor=(0,1.23),ncol=3,frameon=False,fontsize=10)
        for side in ['top','right','left']:ax.spines[side].set_visible(False)
        place_plot(fig,(65,620,1535,1005))
    elif data['weekly']:
        rows=data['cumulative'] if data['range'] else data['weekly'];values=[r['value'] for r in rows];xs=list(range(len(rows)))
        fig,ax=plt.subplots(figsize=(10.4,2.6));fig.subplots_adjust(left=.07,right=.96,bottom=.24,top=.84)
        ax.axhline(0,color='#BFB9C2',lw=1);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
        if len(rows)>1:
            ax.plot(xs,values,color=RED,lw=3,marker='o',markersize=6)
            ax.fill_between(xs,values,0,color=RED,alpha=.05)
        else:ax.bar(xs,values,width=.32,color=RED);ax.set_xlim(-.7,.7)
        pad=max(.05,(max(values)-min(values))*.18)
        ax.set_ylim(min(0,min(values))-pad,max(0,max(values))+pad*2)
        step=max(1,len(rows)//7)
        ticks=sorted(set(xs[::step]+[xs[-1]]));ax.set_xticks(ticks,[rows[i]['date'][8:10]+'.'+rows[i]['date'][5:7] for i in ticks])
        ax.yaxis.set_major_formatter(FuncFormatter(lambda y,_:f'{y:.2f}'.replace('.',',')))
        for i in sorted(set([0,len(rows)-1])):ax.annotate(num(values[i]),(xs[i],values[i]),xytext=(0,13),textcoords='offset points',ha='center',weight='bold',color=RED,fontsize=13)
        for side in ['top','right','left']:ax.spines[side].set_visible(False)
        place_plot(fig,(65,620,1535,1005))
        if len(rows)==1:text(1050,975,'Временной ряд: один выпуск',20,MUTED)
    else:wrap('График для этого типа отчёта пока недоступен. Ключевые цифры и сравнение приведены в текстовом анализе.',100,690,1350,33,3,color=MUTED)

    text(74,1040,'ИЗМЕНЕНИЯ ЗА ВЫБРАННЫЙ ПЕРИОД¹' if data['range'] else 'ЧТО ИЗМЕНИЛОСЬ ЗА НЕДЕЛЮ' if plan['kind']=='inflation' else 'КЛЮЧЕВЫЕ ИЗМЕНЕНИЯ',27,INK,True)
    categories=data['categories']
    if categories:
        positives=sorted((r for r in categories if r[1]>0),key=lambda r:r[1],reverse=True)[:3]
        negatives=sorted((r for r in categories if r[1]<0),key=lambda r:r[1])[:2]
        bars=positives+negatives
        if not bars:bars=categories[:5]
        fig,ax=plt.subplots(figsize=(6.3,2.75));fig.subplots_adjust(left=.35,right=.87,bottom=.15,top=.97)
        names,values=zip(*bars);names=[textwrap.shorten(n,width=19,placeholder='…') for n in names];ax.barh(names,values,color=[RED if v>=0 else '#8B858F' for v in values],height=.52)
        ax.invert_yaxis();ax.axvline(0,color='#C3BEC6',lw=1)
        span=max(abs(v) for v in values) or 1;ax.set_xlim(min(0,min(values))-.65*span,max(0,max(values))+.35*span)
        for i,v in enumerate(values):
            ax.text(v+(.05*span if v>=0 else -.05*span),i,num(v),va='center',ha='left' if v>=0 else 'right',fontsize=11,weight='bold',color=INK)
        ax.set_xticks([]);ax.tick_params(axis='y',length=0)
        for spine in ax.spines.values():spine.set_visible(False)
        place_plot(fig,(55,1100,950,1465))
    else:wrap('Сравнение показателей приведено в текстовом анализе.',90,1160,780,32,3,color=MUTED)
    draw.rounded_rectangle((980,1100,1530,1465),radius=16,fill=PANEL)
    text(1010,1130,'ГЛАВНОЕ',23,RED,True)
    blocks=analysis_text.split('\n\n');summary=blocks[1] if len(blocks)>1 else analysis_text
    if data.get('history'):
        history=plan['weekly_history'];summary=f"В диапазоне {len(history['dates'])} недельных наблюдений по {len(history['goods'])} товарам и услугам. "+(f"Общая цепная оценка по сопоставимым индексам PDF — {num(history['aggregate_cpi'])}." if history['aggregate_cpi'] is not None else 'Общий ИПЦ за этот период в исходной таблице отсутствует.')
    elif data['kpis']:
        last=data['weekly'][-1]['value']
        if data['range']:summary=f"За {len(data['cumulative'])-1} недельных выпусков накопленная оценка изменения цен — {num(data['kpis'][0]['value'])}. В среднем за неделю — {num(data['kpis'][1]['value'])}. Последняя неделя — {num(last)}."
        else:summary=f"За последнюю неделю цены {'выросли' if last>=0 else 'снизились'} на {num(abs(last)).lstrip('+')}. С начала года изменение составило {num(data['kpis'][2]['value'])}."
    wrap(summary,1010,1180,485,26,7)
    draw.line((70,1500,1530,1500),fill='#E0DCE2',width=2)
    text(74,1522,'Источник: официальный XLSX Росстата + последний PDF' if data.get('history') else 'Источник: Росстат  •  Графики: данные PDF',21,MUTED)
    text(74,1555,('¹ Общий темп: отношение ИПЦ с начала года из двух PDF. Товары: цепные индексы XLSX.' if plan['weekly_history']['aggregate_cpi'] is not None else '¹ Цепные изменения товаров, не общий ИПЦ. Веса для общего индекса отсутствуют.') if data.get('history') else '¹ Цепная оценка по недельным индексам; не официальный месячный ИПЦ.' if data['range'] and data['weekly'] else 'Оперативная оценка. Недельные темпы не равны месячному ИПЦ.' if plan['kind']=='inflation' else 'Периоды и единицы измерения приведены в текстовом анализе.',18,MUTED)
    output=io.BytesIO();canvas.save(output,format='PNG',optimize=True)
    return output.getvalue()
