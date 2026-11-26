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
import urllib.request
import urllib.error

INGEST_URL = os.environ["INGEST_URL"].rstrip("/")
INGEST_SECRET = os.environ["INGEST_SECRET"]
MAX_PAGES = int(os.environ.get("MAX_PAGES", "25"))
DELAY = float(os.environ.get("DELAY", "1.5"))

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


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        INGEST_URL + path, data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + INGEST_SECRET,
            "User-Agent": "islamic-library-crawler/1.0",
        }, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get_sources():
    req = urllib.request.Request(
        INGEST_URL + "/sources",
        headers={"Authorization": "Bearer " + INGEST_SECRET})
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


def crawl_channel(ch):
    username = ch["username"]
    last_seen = int(ch.get("last_message_id") or 0)
    bot_member = bool(ch.get("bot_member"))
    print(f"== @{username} (last={last_seen}, member={bot_member})", flush=True)
    before = None
    total_new = 0
    max_id = last_seen
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
    return total_new


def main():
    channels = get_sources()
    if not channels:
        print("no sources configured", flush=True)
        return
    total = 0
    for ch in channels:
        try:
            total += crawl_channel(ch)
        except Exception as e:
            print(f"channel {ch.get('username')} failed: {e}", flush=True)
        time.sleep(DELAY)
    print(f"DONE: {total} new files", flush=True)


if __name__ == "__main__":
    main()
