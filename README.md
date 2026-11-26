# المكتبة الإسلامية الشاملة

Telegram book-search bot: @ISLAMIC_BOOKS_LIBbot

- `worker/` — Cloudflare Worker: webhook, Mini App API, crawler ingest (D1 storage)
- `miniapp/` — Telegram Mini App (served via GitHub Pages at /miniapp/)
- `crawler/` — Python crawler of public channel pages, runs on GitHub Actions every 6h

Secrets live in Cloudflare (BOT_TOKEN, INGEST_SECRET, WEBHOOK_SECRET,
ADMIN_SETUP_CODE) and GitHub Actions secrets (INGEST_URL, INGEST_SECRET).
