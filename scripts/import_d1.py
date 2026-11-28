#!/usr/bin/env python3
"""Direct D1 import of staged channel items via the Cloudflare D1 REST API.
Budget-aware: stops at 75% of the daily write cap so the worker keeps a reserve.

Mirrors worker /ingest semantics: INSERT OR IGNORE, delivery=copy (bot_member),
link=https://t.me/<ch>/<mid>. Cursor-paced, safe to re-run."""
import json, os, re, sys, time, urllib.request

ACCOUNT = 'edd657e56467c71d390fc92d27bad9c6'
DB = '6fe9db87-a8c7-4a20-9a42-70e3f59a0457'
ITEMS_PATH = '/tmp/cr_wrr_items.json'
CURSOR_PATH = '/tmp/cr_wrr_ingest_cursor'
BATCH = 150

def norm(s):
    s = re.sub(r'[ً-ْٰـ]', '', s or '')
    s = re.sub(r'[أإآٱ]', 'ا', s)
    s = s.replace('ة', 'ه').replace('ى', 'ي')
    s = re.sub(r'[ؤئ]', 'ء', s)
    s = s.lower()
    s = re.sub(r'[_.\-–—,،;:!?؟()\[\]{}«»"\'/\\|~*+=]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

secret = ''
tok = ''
for line in open(os.path.expanduser('~/islamic-library/deploy-secrets.env')):
    if line.startswith('CF_D1_TOKEN='): tok = line.strip().split('=', 1)[1]
assert tok

max_items = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 40000
WRITE_BUDGET = 75000  # keep 25% of the 100k/day D1 write cap for the worker


def d1(sql):
    body = json.dumps({'sql': sql}).encode()
    req = urllib.request.Request(url, data=body, headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))


def writes_used():
    r = d1("SELECT value FROM settings WHERE key = 'w:' || date('now')")
    try:
        res = r['result'][0].get('results') or []
        return int(res[0]['value']) if res else 0
    except Exception:
        return 0


def add_writes(n):
    try:
        d1("INSERT INTO settings(key, value) VALUES('w:' || date('now'), '%d') "
           "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + %d AS TEXT)" % (n, n))
    except Exception as e:
        print('budget counter failed:', str(e)[:120], flush=True)
data = json.load(open(ITEMS_PATH))
ch = data['channel']
bot_member = data.get('bot_member')
items = data['items']
done = int(open(CURSOR_PATH).read().strip() or 0) if os.path.exists(CURSOR_PATH) else 0
todo = items[done:done + max_items]
print(f'total={len(items)} done={done} sending={len(todo)}', flush=True)
if not todo:
    sys.exit(0)

def q(s):
    return "'" + s.replace("'", "''") + "'"

sent = 0
url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB}/query'
t0 = time.time()
used = writes_used()
print(f'daily writes used={used} budget={WRITE_BUDGET}', flush=True)
if used >= WRITE_BUDGET:
    print('write budget already spent today; not importing', flush=True)
    sys.exit(0)
for i in range(0, len(todo), BATCH):
    chunk = todo[i:i + BATCH]
    # Two rows written per item (files row + FTS index row): stop before the
    # daily budget line so the worker keeps a reserve for the control panel.
    if used + len(chunk) * 2 > WRITE_BUDGET:
        print(f'write budget reached (used={used}); stopping cleanly at {done + sent}', flush=True)
        break
    vals = []
    for it in chunk:
        title = str(it.get('title') or '')[:300]
        mid = int(it.get('message_id') or 0)
        if not title or not mid:
            continue
        ext = str(it.get('ext') or '').lower()
        size = int(it.get('size_bytes') or 0)
        fn = str(it.get('file_name') or '')[:500]
        link = f'https://t.me/{ch}/{mid}'
        delivery = 'copy' if bot_member else 'link'
        vals.append(f"({q(title)},{q(norm(title))},{q(fn)},'', '',{q(ext)},{size},{q(ch)},{mid},{q(link)},'',{q(delivery)})")
    if not vals:
        continue
    sql = ("INSERT OR IGNORE INTO files(title, title_norm, file_name, author, author_norm, ext, size_bytes, channel, message_id, link, file_id, delivery) VALUES "
           + ','.join(vals))
    body = json.dumps({'sql': sql}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=body, headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
            r = json.load(urllib.request.urlopen(req, timeout=60))
            if not r.get('success'):
                raise RuntimeError(str(r.get('errors'))[:200])
            break
        except Exception as e:
            if attempt == 2:
                print('FAILED batch at', done + i, str(e)[:200], flush=True)
                raise
            time.sleep(2 * (attempt + 1))
    sent += len(chunk)
    used += len(chunk) * 2
    add_writes(len(chunk) * 2)
    with open(CURSOR_PATH, 'w') as f:
        f.write(str(done + sent))
    if (i // BATCH) % 20 == 0:
        elapsed = time.time() - t0
        print(f'{done + sent}/{len(items)} elapsed={elapsed:.0f}s', flush=True)
    if time.time() - t0 > 95:
        print('time budget reached, stopping cleanly', flush=True)
        break

# last chunk of the whole file: bump channel watermark
if done + sent >= len(items) and data.get('last_message_id'):
    sql = f"UPDATE channels SET last_message_id = MAX(last_message_id, {int(data['last_message_id'])}) WHERE username = {q(ch)}"
    req = urllib.request.Request(url, data=json.dumps({'sql': sql}).encode(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    print('watermark:', json.load(urllib.request.urlopen(req, timeout=30)).get('success'), flush=True)
print(f'done_run sent={sent} cursor={done + sent}', flush=True)
