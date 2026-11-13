import importlib
import unittest
import io


class SummaryCard(unittest.TestCase):
    def setUp(self):
        try:self.api=importlib.import_module('summary_card')
        except ModuleNotFoundError:self.fail('Summary card is not implemented')

    def plan(self):
        return {'kind':'inflation','mode':'release','start':'2026-11-03','end':'2026-11-09','documents':[
            {'title':'Недельный ИПЦ','role':'selected','period_end':'2026-11-09','pages':[{'page':1,'text':
             'индекс потребительских цен составил 100,12%, с начала месяца – 100,11%, с начала года – 106,33%.\n'
             'Огурцы 109,40 109,43 67,29\nБензин автомобильный 99,20 98,63 115,24'}]}]}

    def test_chart_numbers_are_extracted_from_source_and_indices_converted_to_growth(self):
        data=self.api.chart_data(self.plan())
        self.assertEqual(data['weekly'][0]['value'],0.12)
        self.assertEqual(data['kpis'][2]['value'],6.33)
        self.assertEqual(dict(data['categories'])['Огурцы'],9.4)
        self.assertEqual(dict(data['categories'])['Бензин'],-0.8)

    def test_single_issue_does_not_invent_historical_points(self):
        self.assertEqual(len(self.api.chart_data(self.plan())['weekly']),1)

    def test_range_kpis_and_commodity_changes_compound_all_selected_weeks(self):
        p=self.plan();p['mode']='m1';p['start']='2026-10-27'
        first={'title':'Предыдущая неделя','role':'selected','period_start':'2026-10-27','period_end':'2026-11-02',
               'pages':[{'page':1,'text':'индекс потребительских цен составил 100,10%, с начала месяца – 100,11%, с начала года – 106,20%.\nОгурцы 102,00 102,00 65,00\nБензин автомобильный 98,00 98,00 116,00'}]}
        p['documents'][0]['period_start']='2026-11-03'
        p['documents'].insert(0,first)
        data=self.api.chart_data(p)
        self.assertAlmostEqual(data['kpis'][0]['value'],0.22012,places=5)
        self.assertNotEqual(data['kpis'][0]['label'],'За неделю')
        self.assertAlmostEqual(dict(data['categories'])['Огурцы'],11.588,places=4)
        self.assertAlmostEqual(dict(data['categories'])['Бензин'],-2.784,places=4)
        self.assertAlmostEqual(data['cumulative'][-1]['value'],0.22012,places=5)

    def test_range_does_not_compound_baseline_week_or_partial_commodity_history(self):
        p=self.plan();p['mode']='m1';p['documents'][0]['period_start']='2026-11-03'
        baseline={**p['documents'][0],'role':'baseline','period_end':'2026-11-02'}
        p['documents'].insert(0,baseline)
        data=self.api.chart_data(p)
        self.assertAlmostEqual(data['kpis'][0]['value'],0.12,places=5)
        self.assertEqual(data['cumulative'][0]['value'],0)

    def test_png_is_readable_telegram_size_and_has_no_private_metadata(self):
        from PIL import Image
        data=self.api.render_card(self.plan(),'Короткий вывод на русском языке.')
        image=Image.open(io.BytesIO(data))
        self.assertEqual(image.format,'PNG')
        self.assertEqual(image.size,(1600,1600))
        self.assertLess(len(data),2*1024*1024)
        self.assertFalse(image.info)

    def test_unknown_report_does_not_receive_an_inflation_graph(self):
        p=self.plan();p['kind']='gdp'
        self.assertEqual(self.api.chart_data(p)['weekly'],[])
