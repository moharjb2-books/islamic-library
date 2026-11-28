#!/usr/bin/env python3
"""Build a static search snapshot from a D1 dump: inverted index + row chunks.

Output under ~/islamic-library/snapshot/:
  meta.json            {v, generated_at, files, channels, chunks, idx_shards}
  latest.json          {items: [row, ...]}  newest 100 rows
  rows/cNNN.json       [[row], ...] 500 per chunk, ordered by id ASC
  idx/<2chars>.json    {token: [gidx, ...]}  inverted index, sharded by token[:2]
  byid/bN.json         [[id, gidx], ...] sorted by id; N = id % 64

Row layout: [id, title, file_name, author, ext, size_bytes, channel,
             message_id, link, file_id, delivery, created_at]
Only public file metadata is exported (no users/searches tables).
"""
import json, re, sqlite3, sys, time, unicodedata, os

DB = '/tmp/d1.db'
OUT = os.path.expanduser('~/islamic-library/snapshot')
CHUNK = 500

def norm(s):
    s = (s or '')
    s = re.sub('[ً-ْٰـ]', '', s)
    s = re.sub('[أإآٱ]', 'ا', s)
    s = s.replace('ة', 'ه').replace('ى', 'ي')
    s = re.sub('[ؤئ]', 'ء', s)
    s = s.lower()
    s = re.sub(r'[_.\-–—,،;:!?؟()\[\]{}«»"\'/\\|~*+=]+', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


# User-facing lists show real books only: archives and scraped code names stay
# in the row data (delivery by id still works) but are never indexed or listed.
BOOK_EXTS = {'pdf','epub','doc','docx','txt','rtf','mobi','azw3','azw','djvu','chm','ppt','pptx','xls','xlsx'}
AUDIO_EXTS = {'mp3','m4a','ogg','oga','opus','wav','aac','flac','weba','audio'}
def junk_title(t):
    s = (t or '').strip()
    if not s:
        return True
    if not re.search('[\u0621-\u064A]', s):
        if re.search(r'\d', s) or '_' in s or len(s) < 4:
            return True
        return False
    return len([c for c in s if c.isalpha()]) < 3
def visible_row(ext, title, fname):
    e = (ext or '').lower()
    if e not in BOOK_EXTS and e not in AUDIO_EXTS:
        return False
    return not junk_title(fname or title)

db = sqlite3.connect(DB)
rows = db.execute(
    'SELECT id, title, file_name, author, ext, size_bytes, channel, message_id, link, file_id, delivery, created_at FROM files ORDER BY id ASC'
).fetchall()
channels = db.execute('SELECT COUNT(*) FROM channels WHERE active = 1').fetchone()[0]

# Optional: merge a staged channel export straight into the snapshot,
# bypassing D1 entirely (search serves these rows immediately; D1 ingest
# can proceed later at its own pace for admin/consistency).
import os as _os
STAGED = _os.environ.get('STAGED_ITEMS', '')
for STAGED_ONE in [s for s in STAGED.split(',') if s and _os.path.exists(s)]:
    st = json.load(open(STAGED_ONE))
    ch = st['channel']
    bot_member = st.get('bot_member')
    next_id = max(r[0] for r in rows) + 1
    for it in st['items']:
        mid = it['message_id']
        rows.append((next_id, it['title'], it.get('file_name') or it['title'], it.get('author') or '',
                     (it.get('ext') or '').lower(), it.get('size_bytes') or 0, ch, mid,
                     f'https://t.me/{ch}/{mid}', '', 'copy' if bot_member else 'link', 0))
        next_id += 1
    print('staged merged:', len(st['items']), 'from', ch)

os.makedirs(OUT + '/rows', exist_ok=True)
os.makedirs(OUT + '/idx', exist_ok=True)
os.makedirs(OUT + '/byid', exist_ok=True)

# row chunks + byid + index
idx = {}
byid = {}
compact = []
for g, r in enumerate(rows):
    rid, title, fname, author, ext, size, ch, mid, link, fid, delivery, created = r
    compact.append([rid, title, fname or '', author or '', (ext or '').lower(), size or 0,
                    ch, mid or 0, link or '', fid or '', delivery or 'link', created or 0])
    byid.setdefault(rid % 64, []).append([rid, g])
    if not visible_row(ext, title, fname):
        continue  # junk row: keep for delivery, never index it
    toks = set((norm(title) + ' ' + norm(author)).split())
    for t in toks:
        if not t: continue
        idx.setdefault(t[:2], {}).setdefault(t, []).append(g)

nchunks = 0
for i in range(0, len(compact), CHUNK):
    with open(f'{OUT}/rows/c{i//CHUNK:03d}.json', 'w') as f:
        json.dump(compact[i:i+CHUNK], f, ensure_ascii=False, separators=(',', ':'))
    nchunks += 1

for k, shard in idx.items():
    with open(f'{OUT}/idx/{k}.json', 'w') as f:
        json.dump(shard, f, ensure_ascii=False, separators=(',', ':'))

for k, lst in byid.items():
    lst.sort()
    with open(f'{OUT}/byid/b{k}.json', 'w') as f:
        json.dump(lst, f, separators=(',', ':'))

latest = sorted([r for r in compact if visible_row(r[4], r[1], r[2])],
                key=lambda r: (r[11], r[0]), reverse=True)[:300]
with open(f'{OUT}/latest.json', 'w') as f:
    json.dump({'items': latest}, f, ensure_ascii=False, separators=(',', ':'))

forced = set(r[0] for r in db.execute('SELECT username FROM forced_channels WHERE active = 1'))
fg = [g for g, r in enumerate(rows) if (r[6] or '') in forced]
meta = {'v': 1, 'generated_at': int(time.time()), 'files': len(compact),
        'channels': channels, 'chunks': nchunks, 'idx_shards': len(idx),
        'forced_channels': sorted(forced),
        'forced_lo': min(fg) if fg else None, 'forced_hi': max(fg) if fg else None}
with open(f'{OUT}/meta.json', 'w') as f:
    json.dump(meta, f, separators=(',', ':'))

print('rows:', len(compact), 'chunks:', nchunks, 'idx shards:', len(idx),
      'tokens:', sum(len(s) for s in idx.values()))
