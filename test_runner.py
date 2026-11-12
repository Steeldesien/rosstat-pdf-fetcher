import importlib
import unittest
from datetime import datetime, timezone


def rss(*items):
    return ('<rss><channel>' + ''.join(
        '<item><title>' + title + '</title><link>' + url + '</link><pubDate>' + date + '</pubDate></item>'
        for title, url, date in items) + '</channel></rss>').encode()


TITLE = 'Об оценке индекса потребительских цен с 3 по 9 ноября 2026 года'
SOURCE = 'https://rosstat.gov.ru/central-news/document/279592'


class DeliveryBehavior(unittest.TestCase):
    def setUp(self):
        try:
            self.module = importlib.import_module('runner')
        except ModuleNotFoundError:
            self.fail('The public downloader has not been implemented yet')

    def test_late_release_is_accepted_after_midnight(self):
        job = {'id': 'weekly-job', 'kind': 'inflation', 'mode': 'scheduled',
               'not_before': '2026-11-11T00:00:00+05:00'}
        body = rss((TITLE, SOURCE, 'Thu, 12 Nov 2026 01:00:00 +0500'))
        delivered = []
        result = self.module.check_job(job, lambda url: body if url == self.module.RSS else b'%PDF-real',
                                       lambda *args: delivered.append(args))
        self.assertEqual(result, 'delivered')
        self.assertEqual(delivered[0][1], b'%PDF-real')

    def test_previous_release_does_not_satisfy_new_target(self):
        job = {'id': 'new-week', 'kind': 'inflation', 'mode': 'scheduled',
               'not_before': '2026-11-18T00:00:00+05:00'}
        calls = []
        def fetch(url):
            calls.append(url)
            return rss((TITLE, SOURCE, 'Wed, 11 Nov 2026 19:00:00 +0300'))
        self.assertEqual(self.module.check_job(job, fetch, lambda *a: self.fail('Old PDF sent')), 'waiting')
        self.assertEqual(calls, [self.module.RSS])

    def test_manual_latest_chooses_freshest_matching_release(self):
        old = 'https://rosstat.gov.ru/central-news/document/1'
        body = rss((TITLE, SOURCE, 'Wed, 11 Nov 2026 19:00:00 +0300'),
                   (TITLE, old, 'Wed, 04 Nov 2026 19:00:00 +0300'))
        urls = []
        def fetch(url):
            urls.append(url)
            return body if url == self.module.RSS else b'%PDF-real'
        self.module.check_job({'id': 'manual', 'kind': 'inflation', 'mode': 'latest'}, fetch, lambda *a: None)
        self.assertEqual(urls[-1], SOURCE)

    def test_html_error_page_is_never_delivered_as_pdf(self):
        body = rss((TITLE, SOURCE, 'Wed, 11 Nov 2026 19:00:00 +0300'))
        with self.assertRaises(ValueError):
            self.module.check_job({'id': 'manual', 'kind': 'inflation', 'mode': 'latest'},
                                  lambda url: body if url == self.module.RSS else b'<html>Blocked</html>',
                                  lambda *a: self.fail('HTML sent'))

    def test_completed_cloud_job_stops_without_contacting_rosstat(self):
        class Broker:
            def claim(self, job_id): return {'status': 'completed'}
        self.assertEqual(self.module.poll('done', Broker(), lambda url: self.fail('Unexpected Rosstat request'),
                                         sleep=lambda t: self.fail('Unexpected wait')), 'completed')

    def test_post_delivery_lost_response_recovers_from_private_state_without_redownload(self):
        class Broker:
            claims = 0
            def claim(self, job_id):
                self.claims += 1
                return {'status': 'ready', 'job': {'id': job_id, 'kind': 'inflation', 'mode': 'latest'}} if self.claims == 1 else {'status': 'completed'}
            def deliver(self, *args): raise ConnectionError('Response lost after server accepted PDF')
        body = rss((TITLE, SOURCE, 'Wed, 11 Nov 2026 19:00:00 +0300'))
        calls = []
        def fetch(url):
            calls.append(url)
            return body if url == self.module.RSS else b'%PDF-real'
        self.assertEqual(self.module.poll('job', Broker(), fetch, sleep=lambda t: None), 'completed')
        self.assertEqual(calls, [self.module.RSS, SOURCE])

    def test_download_rejects_credentials_and_untrusted_hosts(self):
        for url in ['http://rosstat.gov.ru/a', 'https://rosstat.gov.ru.attacker.test/a',
                    'https://name:password@rosstat.gov.ru/a', 'https://example.org/a']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.module.validate_source(url)

    def test_backoff_prevents_next_rosstat_request_for_retry_period(self):
        class Broker:
            count = 0
            pauses = []
            def deliver(self, *args): raise AssertionError('No PDF should be delivered during backoff')
            def backoff(self, job_id, seconds): self.pauses.append((job_id,seconds))
            def claim(self, job_id):
                self.count += 1
                return {'status': 'ready', 'job': {'id': job_id, 'kind': 'inflation', 'mode': 'latest'}} if self.count == 1 else {'status': 'completed'}
        waits = []
        def fetch(url): raise self.module.RetryLater(900)
        self.assertEqual(self.module.poll('job', Broker(), fetch, sleep=waits.append), 'deferred')
        self.assertEqual(waits, [])
        self.assertEqual(Broker.pauses,[('job',900)])

    def test_hourly_wait_exits_runner_without_idle_sleep(self):
        class Broker:
            def claim(self, job_id):
                return {'status':'ready','job':{'id':job_id,'kind':'inflation','mode':'scheduled','not_before':'2026-11-18T00:00:00+05:00'}}
            def deliver(self, *args): raise AssertionError('No release available')
            def waiting(self, job_id): return {'interval_seconds':3600}
        body = rss((TITLE, SOURCE, 'Wed, 11 Nov 2026 19:00:00 +0300'))
        calls=[]
        def fetch(url): calls.append(url); return body
        self.assertEqual(self.module.poll('job',Broker(),fetch,sleep=lambda t:self.fail('Idle runner')), 'deferred')
        self.assertEqual(calls,[self.module.RSS])

    def test_report_period_distinguishes_two_releases_published_on_the_same_day(self):
        older='https://rosstat.gov.ru/central-news/document/old-delayed'
        newer='https://rosstat.gov.ru/central-news/document/new'
        body=rss((TITLE,older,'Wed, 18 Nov 2026 20:00:00 +0300'),
                 ('Об оценке индекса потребительских цен с 10 по 16 ноября 2026 года',newer,'Wed, 18 Nov 2026 19:00:00 +0300'))
        calls=[]
        def fetch(url): calls.append(url); return body if url==self.module.RSS else b'%PDF-test'
        job={'id':'week','kind':'inflation','mode':'scheduled','not_before':'2026-11-18T00:00:00+05:00','report_end':'2026-11-16'}
        self.module.check_job(job,fetch,lambda *a:None)
        self.assertEqual(calls[-1],newer)


if __name__ == '__main__': unittest.main()
