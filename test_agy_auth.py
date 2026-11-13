import base64
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
try:
    import agy_cloud_auth as a
except ImportError:
    a = None


class AuthTests(unittest.TestCase):
    def test_encryption_and_safe_restore(self):
        self.assertIsNotNone(a)
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
            home = Path(src)
            (home / '.gemini').mkdir()
            (home / '.gemini/oauth_creds.json').write_text('private-session')
            (home / '.gemini/antigravity-cli/log').mkdir(parents=True)
            (home / '.gemini/antigravity-cli/log/secret.log').write_text('not-for-transfer')
            profile, count = a.seal(home, 'broker-secret')
            self.assertEqual(count, 1)
            self.assertNotIn('private-session', str(profile))
            a.restore(Path(dst), 'broker-secret', profile)
            self.assertEqual((Path(dst)/'.gemini/oauth_creds.json').read_text(), 'private-session')
            self.assertFalse((Path(dst)/'.gemini/antigravity-cli/log').exists())
            with self.assertRaises(Exception):
                a.restore(Path(dst), 'wrong-secret', profile)

    def test_hostile_archive_is_rejected(self):
        self.assertIsNotNone(a)
        for filename in ['../escape', '/tmp/escape', '.ssh/id_rsa', '.gemini/../escape']:
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz') as archive:
                member = tarfile.TarInfo(filename)
                member.size = 1
                archive.addfile(member, io.BytesIO(b'x'))
            profile = a.encrypt(buf.getvalue(), 'secret')
            with tempfile.TemporaryDirectory() as dst, self.assertRaises(ValueError):
                a.restore(Path(dst), 'secret', profile)

    def test_login_url_only_official(self):
        self.assertIsNotNone(a)
        self.assertEqual(a.login_url('Open https://accounts.google.com/o/oauth2/auth?state=x\r\n'), 'https://accounts.google.com/o/oauth2/auth?state=x')
        self.assertIsNone(a.login_url('https://accounts.google.com.attacker.test/token'))

    def test_diagnostics_do_not_echo_credentials(self):
        self.assertIsNotNone(a)
        result=a.diagnostic('login','invalid_grant https://accounts.google.com/?code=PRIVATE_CODE token=PRIVATE_TOKEN',1)
        self.assertEqual(result['flags'],['invalid_code'])
        self.assertNotIn('PRIVATE',str(result))
