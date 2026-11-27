#!/usr/bin/env python3
"""Crawler for المكتبة الإسلامية الشاملة.

Fetches public t.me/s/<channel> pages, extracts document messages, and POSTs
new items to the Cloudflare Worker ingest endpoint. Stdlib only.

Env: INGEST_URL (https://<worker>/ingest), INGEST_SECRET.
Optional: MAX_PAGES (default 25), DELAY (default 1.5).
"""
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import urllib.error

INGEST_URL = os.environ["INGEST_URL"].rstrip("/")
INGEST_SECRET = os.environ["INGEST_SECRET"]
MAX_PAGES = int(os.environ.get("MAX_PAGES", "25"))
DELAY = float(os.environ.get("DELAY", "1.5"))
EMBED_BACKFILL = int(os.environ.get("EMBED_BACKFILL", "150"))
EMBED_MAX_SCAN = int(os.environ.get("EMBED_MAX_SCAN", "150"))
CHANNEL_ONLY = (os.environ.get("CHANNEL_ONLY") or "").strip().lower()
BACKFILL = os.environ.get("BACKFILL") == "1"
EMBED_FROM = int(os.environ.get("EMBED_FROM", "0"))
EMBED_TO = int(os.environ.get("EMBED_TO", "0"))
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", "30000"))
EMBED_WORKERS = int(os.environ.get("EMBED_WORKERS", "4"))

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

SIZE_RE = re.compile(r"([\d.,]+)\s*(B|KB|MB|GB)", re.I)
MSG_RE = re.compile(
    r'<div class="tgme_widget_message[^"]*"\s+data-post="([^"]+)"[^>]*>(.*?)</time>\s*</a>\s*</div>\s*</div>',
    re.S,
)
DOC_TITLE_RE = re.compile(r'tgme_widget_message_document_title[^>]*>(.*?)</', re.S)
DOC_EXTRA_RE = re.compile(r'tgme_widget_message_document_extra[^>]*>(.*?)</', re.S)
CAPTION_RE = re.compile(r'tgme_widget_message_caption[^>]*>(.*?)</div>', re.S)
TAG_RE = re.compile(r"<[^>]+>")


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(min(2 ** i, 8) + 0.2)
    raise last


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        INGEST_URL + path, data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + INGEST_SECRET,
            "User-Agent": UA,
        }, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def direct_url(url):
    m = re.search(r"drive\.google\.com/file/d/([-\w]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    m = re.search(r"drive\.google\.com/open\?id=([-\w]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    m = re.search(r"docs\.google\.com/uc\?.*id=([-\w]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    return url


def get_export_jobs():
    req = urllib.request.Request(
        INGEST_URL + "/export-jobs",
        headers={"Authorization": "Bearer " + INGEST_SECRET, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["jobs"]


def export_text(t):
    if not t:
        return ""
    if isinstance(t, str):
        return t.strip()
    if isinstance(t, list):
        return "".join(p if isinstance(p, str) else (p.get("text", "") if isinstance(p, dict) else "") for p in t).strip()
    return ""


def export_size(m2):
    sz = m2.get("file_size") or 0
    if not sz and isinstance(m2.get("file"), str):
        sm = re.search(r"\(([\d.,]+)\s*(B|KB|MB|GB)\)", m2["file"], re.I)
        if sm:
            mult = {"B": 1, "KB": 1024, "MB": 1048576, "GB": 1073741824}[sm.group(2).upper()]
            sz = int(float(sm.group(1).replace(",", ".")) * mult)
    return sz or 0


def run_export_job(job):
    url = direct_url(job["url"])
    channel = job["channel"].lower()
    bot_member = any(ch.get("username", "").lower() == channel and ch.get("bot_member") for ch in get_sources())
    print(f"export job {job['id']}: downloading {url[:80]} for @{channel}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    data = json.loads(raw.decode("utf-8", "replace"))
    msgs = data.get("messages") or []
    print(f"export job {job['id']}: {len(msgs)} messages", flush=True)
    items = []
    for m2 in msgs:
        if not isinstance(m2, dict) or m2.get("type") != "message":
            continue
        fname = str(m2.get("file_name") or "")[:500]
        is_doc = m2.get("media_type") in ("document", "audio", "voice") or fname
        if not is_doc:
            continue
        txt = export_text(m2.get("text"))
        title = (fname or txt or "ملف")[:300]
        ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
        if not ext and m2.get("media_type") in ("audio", "voice"):
            ext = "audio"
        items.append({
            "title": title, "file_name": fname, "author": author_from(txt),
            "ext": ext, "size_bytes": export_size(m2), "message_id": m2.get("id"),
        })
    added = 0
    for i in range(0, len(items), 450):
        res = post("/ingest", {"channel": channel, "items": items[i:i + 450], "bot_member": bool(bot_member)})
        added += res.get("added", 0)
        time.sleep(0.3)
    post("/ingest/export-jobs/done", {"id": job["id"], "status": "done", "note": f"indexed {added} of {len(items)} documents"})
    print(f"export job {job['id']}: indexed {added}/{len(items)}", flush=True)


def get_sources():
    req = urllib.request.Request(
        INGEST_URL + "/sources",
        headers={"Authorization": "Bearer " + INGEST_SECRET, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["channels"]


def clean(html):
    return TAG_RE.sub("", html or "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'").replace("&quot;", '"').strip()


def parse_size(text):
    m = SIZE_RE.search(text or "")
    if not m:
        return 0
    v = float(m.group(1).replace(",", "."))
    unit = m.group(2).upper()
    return int(v * {"B": 1, "KB": 1024, "MB": 1048576, "GB": 1073741824}[unit])


def author_from(text):
    m = re.search(r"(?:تأليف|للإمام|للشيخ|لـ)\s*[:\-]?\s*([^\n\-–—]{2,60})", text or "")
    return m.group(1).strip() if m else ""



EMBED_ERR_RE = re.compile(r"tgme_widget_message_error|Post not found")


def embed_get(username, mid):
    return get(f"https://t.me/{username}/{mid}?embed=1&mode=tme")


def embed_valid(html):
    return "tgme_widget_message " in html and not EMBED_ERR_RE.search(html)


def probe_max_id(username, hint=0):
    lo = max(int(hint or 0), 1)
    hi = lo
    step = 500
    while True:
        try:
            html = embed_get(username, hi)
        except Exception:
            return 0
        if embed_valid(html):
            lo = hi
            hi += step
            step = min(step * 2, 8000)
            if hi > 3000000:
                return lo
        else:
            break
        time.sleep(0.15)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        try:
            html = embed_get(username, mid)
        except Exception:
            break
        if embed_valid(html):
            lo = mid
        else:
            hi = mid
        time.sleep(0.15)
    return lo



def safe_embed(username, mid):
    try:
        return mid, embed_get(username, mid)
    except Exception:
        return mid, ""


def parse_embed_doc(html, mid):
    if not html or not embed_valid(html):
        return None
    title_m = DOC_TITLE_RE.search(html)
    if not title_m:
        return None
    title = clean(title_m.group(1))
    file_name = title[:500]
    extra_m = DOC_EXTRA_RE.search(html)
    extra = clean(extra_m.group(1)) if extra_m else ""
    caption_m = CAPTION_RE.search(html)
    caption = clean(caption_m.group(1)) if caption_m else ""
    ext = ""
    em = re.search(r"\.([A-Za-z0-9]{1,5})$", title)
    if em:
        ext = em.group(1).lower()
        title = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", title).strip()
    if caption and len(title) < 100:
        title = title + " — " + caption[:80]
    return {"message_id": mid, "title": title[:300], "file_name": file_name,
            "author": author_from(caption or title), "ext": ext,
            "size_bytes": parse_size(extra)}


def backfill_range(username, bot_member, scan_from, scan_to):
    print(f"== @{username} BACKFILL {scan_from}-{scan_to} ({scan_to - scan_from + 1} posts, {EMBED_WORKERS} workers)", flush=True)
    total_new = 0
    scanned_to = scan_to
    items = []
    with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as ex:
        for mid, html in ex.map(lambda m: safe_embed(username, m),
                                range(scan_from, scan_to + 1), chunksize=8):
            it = parse_embed_doc(html, mid)
            if it:
                items.append(it)
            if len(items) >= 400:
                items.sort(key=lambda x: x["message_id"])
                try:
                    r = post("", {"channel": username, "items": items, "bot_member": bot_member})
                    total_new += r.get("added", 0)
                except Exception as e:
                    print(f"  ingest failed: {e}", flush=True)
                items = []
                print(f"  ...at {mid}, +{total_new} files", flush=True)
    if items:
        items.sort(key=lambda x: x["message_id"])
        try:
            r = post("", {"channel": username, "items": items, "bot_member": bot_member})
            total_new += r.get("added", 0)
        except Exception as e:
            print(f"  ingest failed: {e}", flush=True)
    new_cursor = scan_from
    try:
        post("", {"channel": username, "items": [], "bot_member": bot_member,
                  "backfill_cursor": new_cursor})
    except Exception as e:
        print(f"  cursor save failed: {e}", flush=True)
    print(f"== @{username}: {total_new} files from {scan_from}-{scanned_to}", flush=True)
    if new_cursor > 1:
        print(f"BACKFILL_INCOMPLETE remaining={new_cursor - 1}", flush=True)
    else:
        print("BACKFILL_DONE", flush=True)
    return total_new


def crawl_channel_embed(ch):
    username = ch["username"]
    last_seen = int(ch.get("last_message_id") or 0)
    bot_member = bool(ch.get("bot_member"))
    print(f"== @{username} EMBED mode (last={last_seen})", flush=True)
    max_id = probe_max_id(username, last_seen)
    if not max_id:
        print(f"== @{username}: embed probe failed", flush=True)
        return 0
    if BACKFILL:
        cursor = int(ch.get("backfill_cursor") or 0)
        if cursor <= 0:
            cursor = max_id + 1
        scan_from = max(1, EMBED_FROM or (cursor - EMBED_BATCH))
        scan_to = min(EMBED_TO or (cursor - 1), max_id)
        if scan_to < scan_from:
            print(f"== @{username}: BACKFILL_DONE", flush=True)
            print("BACKFILL_DONE", flush=True)
            return 0
        return backfill_range(username, bot_member, scan_from, scan_to)
    elif last_seen <= 0:
        scan_from = max(1, max_id - EMBED_BACKFILL + 1)
    else:
        scan_from = last_seen + 1
    scan_to = min(max_id, scan_from + (EMBED_MAX_SCAN - 1 if not BACKFILL else max(0, scan_to - scan_from))) if not BACKFILL else scan_to
    last_marker = None if BACKFILL else scan_to
    total_new = 0
    items = []
    for mid in range(scan_from, scan_to + 1):
        try:
            html = embed_get(username, mid)
        except Exception:
            continue
        if not embed_valid(html):
            continue
        title_m = DOC_TITLE_RE.search(html)
        if not title_m:
            continue
        title = clean(title_m.group(1))
        file_name = title[:500]
        extra_m = DOC_EXTRA_RE.search(html)
        extra = clean(extra_m.group(1)) if extra_m else ""
        caption_m = CAPTION_RE.search(html)
        caption = clean(caption_m.group(1)) if caption_m else ""
        ext = ""
        em = re.search(r"\.([A-Za-z0-9]{1,5})$", title)
        if em:
            ext = em.group(1).lower()
            title = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", title).strip()
        if caption and len(title) < 100:
            title = title + " — " + caption[:80]
        items.append({"message_id": mid, "title": title[:300], "file_name": file_name,
                      "author": author_from(caption or title), "ext": ext,
                      "size_bytes": parse_size(extra)})
        if len(items) >= 100:
            try:
                payload = {"channel": username, "items": items, "bot_member": bot_member}
                if last_marker: payload["last_message_id"] = last_marker
                r = post("", payload)
                total_new += r.get("added", 0)
            except Exception as e:
                print(f"  ingest failed: {e}", flush=True)
            items = []
        time.sleep(0.15)
    if items:
        try:
            payload = {"channel": username, "items": items, "bot_member": bot_member}
            if last_marker: payload["last_message_id"] = last_marker
            r = post("", payload)
            total_new += r.get("added", 0)
        except Exception as e:
            print(f"  ingest failed: {e}", flush=True)
    print(f"== @{username}: {total_new} new files (scanned {scan_from}-{scan_to}, max {max_id})", flush=True)
    return total_new


def crawl_channel(ch):
    username = ch["username"]
    last_seen = int(ch.get("last_message_id") or 0)
    bot_member = bool(ch.get("bot_member"))
    print(f"== @{username} (last={last_seen}, member={bot_member})", flush=True)
    if BACKFILL:
        return crawl_channel_embed(ch)
    before = None
    total_new = 0
    max_id = last_seen
    saw_posts = False
    for page in range(MAX_PAGES):
        url = f"https://t.me/s/{username}" + (f"?before={before}" if before else "")
        try:
            html = get(url)
        except Exception as e:
            print(f"  page fetch failed: {e}", flush=True)
            break
        posts = re.findall(
            r'data-post="' + re.escape(username) + r'/(\d+)"(.*?)(?=data-post="' + re.escape(username) + r'/|$)',
            html, re.S)
        if not posts:
            break
        saw_posts = True
        items = []
        oldest = None
        for mid_s, block in posts:
            mid = int(mid_s)
            oldest = mid if oldest is None else min(oldest, mid)
            if mid <= last_seen:
                continue
            title_m = DOC_TITLE_RE.search(block)
            if not title_m:
                continue
            title = clean(title_m.group(1))
            file_name = title[:500]
            extra = clean((DOC_EXTRA_RE.search(block) or [None, ""])[1] if DOC_EXTRA_RE.search(block) else "")
            caption_m = CAPTION_RE.search(block)
            caption = clean(caption_m.group(1)) if caption_m else ""
            ext = ""
            em = re.search(r"\.([A-Za-z0-9]{1,5})$", title)
            if em:
                ext = em.group(1).lower()
                title = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", title).strip()
            if caption:
                title = (title + " — " + caption[:80]) if len(title) < 100 else title
            items.append({
                "message_id": mid,
                "title": title[:300],
                "file_name": file_name,
                "author": author_from(caption or title),
                "ext": ext,
                "size_bytes": parse_size(extra),
            })
            max_id = max(max_id, mid)
        if items:
            try:
                r = post("", {"channel": username, "items": items,
                              "bot_member": bot_member,
                              "last_message_id": max_id})
                total_new += r.get("added", 0)
                print(f"  page {page+1}: sent {len(items)}, added {r.get('added')}", flush=True)
            except Exception as e:
                print(f"  ingest failed: {e}", flush=True)
                break
        if oldest is None or oldest <= last_seen + 1:
            break
        before = oldest
        time.sleep(DELAY)
    print(f"== @{username}: {total_new} new files, last -> {max_id}", flush=True)
    if not saw_posts and not bot_member:
        return crawl_channel_embed(ch)
    return total_new


def main():
    for job in get_export_jobs():
        try:
            run_export_job(job)
        except Exception as e:
            print(f"export job {job.get('id')} failed: {e}", flush=True)
            try:
                post("/ingest/export-jobs/done", {"id": job["id"], "status": "failed", "note": str(e)[:280]})
            except Exception:
                pass
    channels = get_sources()
    if not channels:
        print("no sources configured", flush=True)
        return
    total = 0
    for ch in channels:
        if CHANNEL_ONLY and ch["username"].lower() != CHANNEL_ONLY:
            continue
        try:
            total += crawl_channel(ch)
        except Exception as e:
            print(f"channel {ch.get('username')} failed: {e}", flush=True)
        time.sleep(DELAY)
    print(f"DONE: {total} new files", flush=True)


if __name__ == "__main__":
    main()
