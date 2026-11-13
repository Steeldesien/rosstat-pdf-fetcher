import importlib
import unittest


def item(title, suffix):
    return {'title': title, 'url': 'https://rosstat.gov.ru/storage/mediabank/'+suffix+'.pdf', 'stamp': 1}


class AnalysisSelection(unittest.TestCase):
    def setUp(self):
        try: self.api = importlib.import_module('analysis')
        except ModuleNotFoundError: self.fail('Analysis selection is not implemented')

    def test_weekly_range_includes_cross_month_and_previous_release(self):
        rows = [item(f'Об оценке индекса потребительских цен с {a} по {b} 2026 года', str(i)) for i,(a,b) in enumerate([
            ('29 сентября','5 октября'),('6','12 октября'),('13','19 октября'),('20','26 октября'),
            ('27 октября','2 ноября'),('3','9 ноября')])]
        result = self.api.select_releases(rows, 'inflation', 'm1')
        self.assertEqual(result['end'], '2026-11-09')
        self.assertEqual(len(result['documents']), 6)
        self.assertEqual(result['documents'][0]['role'], 'baseline')
        self.assertEqual(result['start'], '2026-10-06')

    def test_single_release_has_no_need_for_archival_baseline(self):
        row = item('Об оценке индекса потребительских цен со 2 по 8 декабря 2025 года', 'a')
        plan = self.api.select_releases([row], 'inflation', 'release')
        self.assertEqual(plan['start'], '2025-12-02')
        self.assertEqual(len(plan['documents']), 1)

    def test_missing_week_is_rejected_instead_of_presented_as_complete_month(self):
        rows = [item('Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года','a'),
                item('Об оценке индекса потребительских цен с 20 по 26 октября 2026 года','b')]
        with self.assertRaises(self.api.IncompleteArchive):
            self.api.select_releases(rows,'inflation','m1')

    def test_monthly_cumulative_releases_count_as_months_not_overlapping_totals(self):
        rows=[item('О промышленном производстве в январе'+ending+' 2026 года',str(i))
              for i,ending in enumerate(['-мае','-июне','-июле','-августе','-сентябре'])]
        plan=self.api.select_releases(rows,'industry','m3')
        self.assertEqual(plan['start'],'2026-07-01')
        self.assertEqual(plan['end'],'2026-09-30')
        self.assertEqual(len(plan['documents']),4)
        self.assertEqual(plan['documents'][1]['period_start'],'2026-01-01')

    def test_gdp_does_not_mix_estimate_production_and_use_series(self):
        rows=[item(f'О производстве валового внутреннего продукта в {q} квартале 2026 года',q) for q in ['I','II','III']]
        rows.append(item('Об использовании валового внутреннего продукта во II квартале 2026 года','other'))
        plan=self.api.select_releases(rows,'gdp','m6')
        self.assertEqual(plan['start'],'2026-04-01')
        self.assertTrue(all('О производстве' in d['title'] for d in plan['documents']))

    def test_same_period_duplicate_prefers_news_timestamp(self):
        title='Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года'
        news=item(title,'news'); archive=item(title,'archive'); archive['stamp']=None
        self.assertEqual(self.api.select_releases([archive,news],'inflation','release')['documents'][0]['url'],news['url'])

    def test_modes_follow_frequency(self):
        self.assertEqual(self.api.allowed_modes('inflation'),['release','m1','m2','m3'])
        self.assertEqual(self.api.allowed_modes('industry'),['release','m3','m6','m12'])
        self.assertEqual(self.api.allowed_modes('gdp'),['release','m6','m12'])

    def test_wage_arrears_is_a_point_in_time_not_a_monthly_flow(self):
        first,last=self.api.period('О просроченной задолженности по заработной плате на конец сентября 2026 года','wages')
        self.assertEqual(first.isoformat(),'2026-09-30')
        self.assertEqual(first,last)

    def test_news_archive_parser_reads_public_pdf_titles_without_inventing_publication_time(self):
        html='<div class="news-card__title"><a href="/storage/mediabank/week.pdf">Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года</a></div>'
        self.assertEqual(self.api.news_entries(html,'inflation')[0]['url'],'https://rosstat.gov.ru/storage/mediabank/week.pdf')
        self.assertIsNone(self.api.news_entries(html,'inflation')[0]['stamp'])

    def test_archive_completion_stops_as_soon_as_requested_window_is_complete(self):
        latest=item('Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года','latest')
        titles=['с 29 сентября по 5 октября','с 6 по 12 октября','с 13 по 19 октября','с 20 по 26 октября','с 27 октября по 2 ноября']
        html=''.join(f'<div class="news-card__title"><a href="/storage/mediabank/{i}.pdf">Об оценке индекса потребительских цен {t} 2026 года</a></div>' for i,t in enumerate(titles))
        calls=[]
        def fetch(url):calls.append(url);return html.encode()
        plan=self.api.complete_archive([latest],'inflation','m1',fetch,sleep=lambda _:None)
        self.assertEqual(len(calls),1)
        self.assertEqual(len(plan['documents']),6)
        second=self.api.complete_archive(plan['documents'],'inflation','m1',lambda _:self.fail('Complete cached archive must not be crawled again'))
        self.assertEqual(second['end'],plan['end'])


if __name__ == '__main__': unittest.main()
