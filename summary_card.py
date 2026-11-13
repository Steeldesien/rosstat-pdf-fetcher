"""Deterministic summary cards. Chart values come from PDF text, never image AI."""
from decimal import Decimal
import io
import re
from pathlib import Path

RED='#A50034'
INK='#28252C'
MUTED='#77727D'
PAPER='#FFFFFF'
PANEL='#F5F3F5'


def change(index):
    return float(Decimal(index.replace(',','.'))-100)


def chart_data(plan):
    result={'weekly':[],'kpis':[],'categories':[]}
    if plan['kind'] not in ('inflation','cpi'):return result
    current=None
    for doc in sorted(plan['documents'],key=lambda d:d['period_end']):
        text=' '.join(doc['pages'][0]['text'].split())
        found=re.search(r'индекс потребительских цен.{0,200}?составил\s+(\d{2,3},\d+)%.*?с начала месяца\s*[-–]?\s*(\d{2,3},\d+)%.*?с начала года\s*[-–]?\s*(\d{2,3},\d+)%',text,re.I)
        if not found:continue
        point={'date':doc['period_end'],'value':change(found[1]),'baseline':doc['role']=='baseline'}
        result['weekly'].append(point)
        if doc['role']=='selected':current=(doc,found)
    if not current:return result
    doc,found=current
    result['kpis']=[{'label':'За неделю' if plan['kind']=='inflation' else 'За месяц','value':change(found[1])},
                    {'label':'С начала месяца','value':change(found[2])},{'label':'С начала года','value':change(found[3])}]
    labels={'Огурцы':'Огурцы','Помидоры':'Помидоры','Капуста белокочанная':'Капуста','Яблоки':'Яблоки',
            'Сахар-песок':'Сахар','Бензин автомобильный':'Бензин','Дизельное топливо':'Дизель',
            'Яйца куриные':'Яйца','Картофель':'Картофель','Морковь':'Морковь'}
    all_text='\n'.join(p['text'] for p in doc['pages']).replace(' -','-').replace('- ','-')
    for label,short in labels.items():
        row=re.search(r'^\s*'+re.escape(label)+r'(?:\s+свеж[а-я]+)?\s+(\d{2,3},\d+)\s+(\d{2,3},\d+)\s+(\d{2,3},\d+)',all_text,re.M|re.I)
        if row:result['categories'].append((short,change(row[1])))
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
    else:
        draw.rounded_rectangle((70,305,1530,495),radius=18,fill=PANEL)
        metric_lines=[line[2:] for line in analysis_text.splitlines() if line.startswith('• ')][:3]
        wrap('  /  '.join(metric_lines) or 'Ключевые показатели — в текстовом разборе',100,345,1390,30,3)

    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':13,'axes.edgecolor':'#DCD8DE','axes.labelcolor':MUTED,'xtick.color':MUTED,'ytick.color':MUTED})
    def place_plot(fig,box):
        out=io.BytesIO();fig.savefig(out,format='png',dpi=140,facecolor='white');plt.close(fig)
        chart=Image.open(out).convert('RGB');chart.thumbnail((box[2]-box[0],box[3]-box[1]),Image.Resampling.LANCZOS)
        canvas.paste(chart,(box[0]+(box[2]-box[0]-chart.width)//2,box[1]))
    text(74,540,'ДИНАМИКА ЦЕН' if data['weekly'] else 'ПОКАЗАТЕЛИ ВЫПУСКА',28,INK,True)
    if data['weekly']:text(74,581,'Изменение к предыдущей дате регистрации, %'+('  /  первая точка — база сравнения' if data['weekly'][0]['baseline'] else ''),22,MUTED)
    if data['weekly']:
        rows=data['weekly'];values=[r['value'] for r in rows];xs=list(range(len(rows)))
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

    text(74,1040,'ЧТО ИЗМЕНИЛОСЬ ЗА НЕДЕЛЮ' if plan['kind']=='inflation' else 'КЛЮЧЕВЫЕ ИЗМЕНЕНИЯ',27,INK,True)
    categories=data['categories']
    if categories:
        positives=sorted((r for r in categories if r[1]>0),key=lambda r:r[1],reverse=True)[:3]
        negatives=sorted((r for r in categories if r[1]<0),key=lambda r:r[1])[:2]
        bars=positives+negatives
        if not bars:bars=categories[:5]
        fig,ax=plt.subplots(figsize=(6.3,2.75));fig.subplots_adjust(left=.24,right=.87,bottom=.15,top=.97)
        names,values=zip(*bars);ax.barh(names,values,color=[RED if v>=0 else '#8B858F' for v in values],height=.52)
        ax.invert_yaxis();ax.axvline(0,color='#C3BEC6',lw=1)
        span=max(abs(v) for v in values) or 1;ax.set_xlim(min(0,min(values))-.4*span,max(0,max(values))+.35*span)
        for i,v in enumerate(values):
            inside=v<0 and abs(v)>.12*span
            ax.text(v/2 if inside else v+.05*span,i,num(v),va='center',ha='center' if inside else 'left',fontsize=11,weight='bold',color='white' if inside else INK)
        ax.set_xticks([]);ax.tick_params(axis='y',length=0)
        for spine in ax.spines.values():spine.set_visible(False)
        place_plot(fig,(55,1100,950,1465))
    else:wrap('Сравнение показателей приведено в текстовом анализе.',90,1160,780,32,3,color=MUTED)
    draw.rounded_rectangle((980,1100,1530,1465),radius=16,fill=PANEL)
    text(1010,1130,'ГЛАВНОЕ',23,RED,True)
    blocks=analysis_text.split('\n\n');summary=blocks[1] if len(blocks)>1 else analysis_text
    if data['kpis']:
        last=data['weekly'][-1]['value'];year=data['kpis'][2]['value']
        summary=f"За последнюю неделю цены {'выросли' if last>=0 else 'снизились'} на {num(abs(last)).lstrip('+')}. С начала года изменение составило {num(year)}."
        if len(data['weekly'])>1:summary+=f" Недельный темп на графике: {num(data['weekly'][0]['value'])} → {num(last)}."
    wrap(summary,1010,1180,485,26,7)
    draw.line((70,1500,1530,1500),fill='#E0DCE2',width=2)
    text(74,1522,'Источник: Росстат  •  Графики: данные PDF',21,MUTED)
    text(74,1555,'Оперативная оценка. Недельные темпы не равны месячному ИПЦ.' if plan['kind']=='inflation' else 'Периоды и единицы измерения приведены в текстовом анализе.',18,MUTED)
    output=io.BytesIO();canvas.save(output,format='PNG',optimize=True)
    return output.getvalue()
