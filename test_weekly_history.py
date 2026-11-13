import importlib
import io
import unittest


def workbook():
    from openpyxl import Workbook
    w=Workbook();s=w.active;s.title='2026'
    s.append(['Индексы на отдельные товары и услуги'])
    s.append(['в % к предыдущей дате регистрации'])
    s.append(['Наименование','на 26 октября','на 2 ноября','на 9 ноября'])
    s.append(['Огурцы свежие, кг',100,102,109.4])
    s.append(['Бензин автомобильный, л',100,98,99.2])
    b=io.BytesIO();w.save(b);return b.getvalue()


class WeeklyHistory(unittest.TestCase):
    def setUp(self):
        try:self.api=importlib.import_module('weekly_history')
        except ModuleNotFoundError:self.fail('Official weekly history support is missing')

    def test_dates_and_compounded_goods_changes_are_read_from_official_style_table(self):
        result=self.api.read_history(workbook(),'2026-11-09',start_after='2026-10-26')
        self.assertEqual(result['start'],'2026-10-27')
        self.assertEqual(len(result['dates']),2)
        self.assertAlmostEqual(result['goods'][0]['change'],11.588)
        self.assertAlmostEqual(result['goods'][1]['change'],-2.784)
        self.assertIsNone(result['aggregate_cpi'])

    def test_missing_current_week_is_rejected(self):
        with self.assertRaises(ValueError):self.api.read_history(workbook(),'2026-11-16',start_after='2026-10-26')

    def test_period_cpi_uses_common_year_base_not_sum_of_rates(self):
        result=self.api.period_cpi('с начала года – 106,33%','с начала года – 104,84%','2026-08-03','2026-11-09')
        self.assertAlmostEqual(result,1.421213277,places=7)
        self.assertIsNone(self.api.period_cpi('с начала года – 106,33%','с начала года – 104,84%','2025-12-29','2026-11-09'))

    def test_range_chart_uses_all_observations_and_never_labels_goods_as_total_cpi(self):
        from summary_card import chart_data
        history=self.api.read_history(workbook(),'2026-11-09',start_after='2026-10-26')
        plan={'kind':'inflation','mode':'m3','start':'2026-10-27','end':'2026-11-09','documents':[],'weekly_history':history}
        result=chart_data(plan)
        self.assertEqual(len(result['series'][0]['points']),3)
        self.assertEqual(result['series'][0]['points'][0]['value'],0)
        self.assertAlmostEqual(result['series'][0]['points'][-1]['value'],11.588)
        self.assertEqual(result['weekly'],[])
