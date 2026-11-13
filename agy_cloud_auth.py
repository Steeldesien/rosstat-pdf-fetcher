"""One-time cloud login probe. Never writes raw CLI output to public logs."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

import requests

ROOTS = ('.gemini', '.config/antigravity')
EXCLUDE = {'log', 'logs', 'history', 'tmp', 'cache', 'bin', 'node_modules', 'conversations', 'sessions', 'telemetry'}


def encrypt(blob, secret):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    key = hashlib.sha256(('rosstat-agy-profile-v1:' + secret).encode()).digest()
    cipher = AESGCM(key).encrypt(nonce, blob, b'rosstat-agy-profile-v1')
    if len(cipher) > 88000:
        raise ValueError('Profile exceeds private storage bound')
    return {'nonce': base64.b64encode(nonce).decode(), 'ciphertext': base64.b64encode(cipher).decode()}


def seal(home, secret):
    buf = io.BytesIO()
    count = total = 0
    with tarfile.open(fileobj=buf, mode='w:gz') as archive:
        for root in ROOTS:
            for p in sorted((home/root).rglob('*')):
                rel = p.relative_to(home)
                if not p.is_file() or p.is_symlink() or EXCLUDE.intersection(rel.parts) or '.git' in rel.parts:
                    continue
                if p.suffix not in {'.json', '.jsonc', '.toml', '.yaml', '.yml', '.txt', '.db', '.key', '.enc', ''}:
                    continue
                total += p.stat().st_size
                if total > 2*1024*1024:
                    raise ValueError('Profile exceeds archive bound')
                archive.add(p, arcname=rel.as_posix(), recursive=False)
                count += 1
    if not count:
        raise ValueError('No transferable profile files found')
    return encrypt(buf.getvalue(), secret), count


def restore(home, secret, profile):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.sha256(('rosstat-agy-profile-v1:' + secret).encode()).digest()
    raw = AESGCM(key).decrypt(base64.b64decode(profile['nonce']), base64.b64decode(profile['ciphertext']), b'rosstat-agy-profile-v1')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        members = archive.getmembers()
        if sum(m.size for m in members) > 2*1024*1024 or len(members) > 200:
            raise ValueError('Archive too large')
        for m in members:
            p = PurePosixPath(m.name)
            if not m.isfile() or p.is_absolute() or '..' in p.parts or not any(m.name.startswith(r+'/') for r in ROOTS):
                raise ValueError('Unsafe profile archive')
        for m in members:
            target = home/m.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(m).read())
            target.chmod(0o600)


def login_url(raw):
    raw = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', raw)
    for candidate in re.findall(r'https://[^\s<>"\x1b]+', raw):
        u = urlsplit(candidate)
        if u.hostname in {'accounts.google.com', 'antigravity.google', 'antigravity.google.com'} and not u.username and not u.password and not u.port:
            return candidate
    return None


def diagnostic(stage, raw='', returncode=None):
    lower=raw.lower()
    # Fixed flags only: never return arbitrary provider output, URLs or codes.
    return {'stage':stage,'returncode':returncode,'flags':[name for name,words in {
        'expired':['expired','timed out','timeout'],
        'invalid_code':['invalid_grant','invalid code','invalid authorization'],
        'auth_required':['authentication required','not authenticated'],
        'quota':['quota','rate limit','resource_exhausted'],
        'network':['enotfound','econnreset','fetch failed','network error'],
        'keyring':['keyring','secret service','dbus'],
        'permission':['permission denied','eacces'],
        'success_text':['successfully','authenticated','signed in'],
    }.items() if any(word in lower for word in words)]}


def settings(home):
    path = home/'.gemini/antigravity-cli/settings.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(path.read_text()) if path.exists() else {}
    data['useG1Credits'] = False
    path.write_text(json.dumps(data))


def main():
    import pty
    import fcntl
    import struct
    import termios
    sid, run_id = os.environ['AUTH_SESSION_ID'], os.environ['GITHUB_RUN_ID']
    secret = os.environ['BROKER_TOKEN']
    endpoint = os.environ['BROKER_URL'].rstrip('/')+'/runner/agy-auth'
    client = requests.Session()
    client.headers['Authorization'] = 'Bearer '+secret

    def call(op, **data):
        r = client.post(endpoint, json={'session_id': sid, 'run_id': run_id, 'op': op, **data}, timeout=30)
        if not r.ok:
            raise RuntimeError('Private auth bridge rejected operation')
        return r.json()

    stage, raw, exit_code = 'claim', '', None
    try:
        claim = call('claim')
        home = Path.home()
        binary = str(Path(os.environ['RUNNER_TEMP'])/'agy-bin/agy')
        if claim['action'] == 'verify':
            stage='restore'
            restore(home, secret, claim['profile'])
        settings(home)
        if claim['action'] == 'login':
            stage='login'
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 10000, 0, 0))
            # Keyring fallback in a genuinely headless runner; do not borrow PC credentials.
            env = dict(os.environ)
            env.pop('DBUS_SESSION_BUS_ADDRESS', None)
            proc = subprocess.Popen([binary, 'acp', '--login', '--disable-telemetry'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
            os.close(slave)
            raw, published, sent = '', False, False
            deadline, next_poll = time.monotonic()+900, 0
            try:
                while proc.poll() is None and time.monotonic()<deadline:
                    if select.select([master], [], [], 1)[0]:
                        try:
                            raw = (raw + os.read(master, 65536).decode(errors='replace'))[-100000:]
                        except OSError:
                            break
                    url = login_url(raw)
                    if url and not published:
                        call('url', url=url)
                        published = True
                    if published and not sent and time.monotonic()>=next_poll:
                        next_poll = time.monotonic()+3
                        try:
                            code = call('code').get('code')
                        except (requests.Timeout,requests.ConnectionError):
                            # A temporary private-bridge interruption must not abort login.
                            continue
                        if code:
                            os.write(master, code.encode()+b'\n')
                            sent = True
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=10)
                exit_code=proc.returncode
                if proc.returncode != 0:
                    raise RuntimeError('Cloud CLI login did not complete')
            finally:
                if proc.poll() is None:
                    proc.kill()
                os.close(master)
        settings(home)
        if claim['action']=='login':
            stage='checkpoint_seal'
            profile,files=seal(home,secret)
            stage='checkpoint_upload'
            call('checkpoint',profile=profile,files=files)
        stage='provider_probe'
        with tempfile.TemporaryDirectory() as workspace:
            result = subprocess.run([binary, '-p', 'Reply exactly CLOUD_SESSION_VERIFIED. Do not use tools or read files.', '--output-format', 'json', '--print-timeout', '90s'], cwd=workspace, capture_output=True, text=True, timeout=110)
        ok = result.returncode == 0 and 'CLOUD_SESSION_VERIFIED' in result.stdout
        raw=result.stdout+'\n'+result.stderr
        exit_code=result.returncode
        if not ok:
            raise RuntimeError('Cloud provider verification failed')
        if claim['action'] == 'login':
            stage='seal_profile'
            profile, files = seal(home, secret)
            call('complete', ok=True, profile=profile, files=files)
        else:
            call('complete', ok=True)
        print(json.dumps({'action':claim['action'], 'ok':True, 'raw_output_logged':False, 'extra_credits_enabled':False}))
    except Exception as error:
        print(json.dumps(diagnostic(stage, raw, exit_code)))
        private_detail=json.dumps({'stage':stage,'exception_type':type(error).__name__,'exception':str(error),'cli_output':raw[-30000:]})
        try:call('diagnostic',profile=encrypt(private_detail.encode(),secret))
        except Exception:pass
        try:
            call('complete', ok=False)
        except Exception:
            pass
        print('Cloud authentication test failed; no credential output was logged.')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
