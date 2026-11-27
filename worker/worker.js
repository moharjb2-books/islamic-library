// ============================================================================
// المكتبة الإسلامية الشاملة — Telegram book-search bot
// Cloudflare Worker: webhook + Mini App API + crawler ingest, D1 storage.
// Bindings: DB (D1). Secrets: BOT_TOKEN, INGEST_SECRET, WEBHOOK_SECRET,
// ADMIN_SETUP_CODE. Vars: MINIAPP_URL, BOT_USERNAME, MAIN_CHANNEL.
// Bump on every Mini App change: Telegram's WebView caches pages per URL,
// so the web_app links carry ?v= to force a fresh load after each deploy.
const APP_VERSION = '20261127e';
function miniUrl(env, extra) {
  return env.MINIAPP_URL + '?v=' + APP_VERSION + (extra ? '&' + extra : '');
}
// ============================================================================

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_norm TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    author TEXT DEFAULT '',
    author_norm TEXT DEFAULT '',
    ext TEXT DEFAULT '',
    size_bytes INTEGER DEFAULT 0,
    channel TEXT DEFAULT '',
    message_id INTEGER DEFAULT 0,
    link TEXT DEFAULT '',
    file_id TEXT DEFAULT '',
    delivery TEXT DEFAULT 'link',
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(channel, message_id, title_norm)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_title ON files(title_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(title_norm, author_norm, content='')`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_ai AFTER INSERT ON files BEGIN
     INSERT INTO files_fts(rowid, title_norm, author_norm) VALUES (new.id, new.title_norm, new.author_norm);
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_ad AFTER DELETE ON files BEGIN
     INSERT INTO files_fts(files_fts, rowid, title_norm, author_norm) VALUES('delete', old.id, old.title_norm, old.author_norm);
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_fts_au AFTER UPDATE OF title_norm, author_norm ON files BEGIN
     INSERT INTO files_fts(files_fts, rowid, title_norm, author_norm) VALUES('delete', old.id, old.title_norm, old.author_norm);
     INSERT INTO files_fts(rowid, title_norm, author_norm) VALUES (new.id, new.title_norm, new.author_norm);
   END`,
  `CREATE TABLE IF NOT EXISTS channels (
    username TEXT PRIMARY KEY,
    bot_member INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    added_at INTEGER DEFAULT (unixepoch()),
    last_message_id INTEGER DEFAULT 0,
    backfill_cursor INTEGER DEFAULT 0,
    file_count INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS forced_channels (
    username TEXT PRIMARY KEY,
    active INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    first_name TEXT DEFAULT '',
    username TEXT DEFAULT '',
    is_admin INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    first_seen INTEGER DEFAULT (unixepoch()),
    last_seen INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    kind TEXT DEFAULT 'text',
    text TEXT DEFAULT '',
    file_id TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    cursor INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 0,
    q TEXT DEFAULT '',
    results INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, file_id)
  )`,
];

let migrated = false;
let migrateFailAt = 0;
async function reindexNormV2(env) {
  const v = await env.DB.prepare("SELECT value FROM settings WHERE key = 'norm_v'").first();
  if (v && v.value === '2') return;
  const rows = await env.DB.prepare('SELECT id, channel, message_id, title, author, file_id, size_bytes FROM files').all();
  const all = rows.results || [];
  const groups = new Map();
  for (const r of all) {
    const k = r.channel + '|' + r.message_id + '|' + norm(r.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const drop = [], updates = [];
  for (const [, g] of groups) {
    g.sort((a, b) => ((b.file_id ? 1 : 0) - (a.file_id ? 1 : 0)) || (b.size_bytes - a.size_bytes) || (a.id - b.id));
    for (let i = 1; i < g.length; i++) drop.push(g[i].id);
    updates.push({ id: g[0].id, t: norm(g[0].title), a: norm(g[0].author || '') });
  }
  for (let i = 0; i < drop.length; i += 400) {
    await env.DB.batch(drop.slice(i, i + 400).map(id => env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id)));
  }
  for (let i = 0; i < updates.length; i += 400) {
    await env.DB.batch(updates.slice(i, i + 400).map(u =>
      env.DB.prepare('UPDATE files SET title_norm = ?, author_norm = ? WHERE id = ?').bind(u.t, u.a, u.id)));
  }
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES('norm_v', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
}

async function migrate(env) {
  if (migrated) return;
  // After a failed attempt (DB capped/slow), back off a minute instead of
  // paying a hanging DDL round-trip on every request.
  if (Date.now() - migrateFailAt < 60000) return;
  try {
    await withTimeout((async () => {
      for (const stmt of SCHEMA) await env.DB.prepare(stmt).run();
      try { await env.DB.prepare('ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0').run(); } catch (e) {}
      try { await env.DB.prepare("ALTER TABLE files ADD COLUMN file_name TEXT DEFAULT ''").run(); } catch (e) {}
      try { await env.DB.prepare('ALTER TABLE channels ADD COLUMN backfill_cursor INTEGER DEFAULT 0').run(); } catch (e) {}
      try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS export_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, channel TEXT NOT NULL, status TEXT DEFAULT 'pending', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), done_at TEXT DEFAULT '')").run(); } catch (e) {}
    })(), 4000);
  } catch (e) {
    migrateFailAt = Date.now();
    throw e;
  }
  migrated = true;
  try { await withTimeout(reindexNormV2(env), 4000); } catch (e) { migrated = false; migrateFailAt = Date.now(); }
  try { await withTimeout(backfillFts(env), 4000); } catch (e) {}
}

let ftsOk = false;
async function backfillFts(env) {
  if (ftsOk) return;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fts_ready'").first();
  if (row && row.value === '1') { ftsOk = true; return; }
  await env.DB.prepare(
    'INSERT INTO files_fts(rowid, title_norm, author_norm) SELECT id, title_norm, author_norm FROM files'
  ).run();
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('fts_ready', '1')").run();
  ftsOk = true;
}
function ftsQuery(words) { return words.map(w => '"' + w.replace(/"/g, '') + '"').join(' AND '); }

// ---------- Arabic normalization ----------
function norm(s) {
  return (s || '').toString()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ؤئ]/g, 'ء')
    .toLowerCase()
    .replace(/[_.\-–—,،;:!?؟()[\]{}«»"'\/\\|~*+=]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtSize(b) {
  b = Number(b) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// ---------- settings ----------
const DEFAULTS = {
  welcome_on: '1',
  per_page: '20',
  protect_content: '0',
  notify_new: '0',
  admin_ids: '',
};
let settingsCache = { at: 0, s: null };
let overviewCache = { at: 0, s: null };
async function getSettings(env) {
  if (settingsCache.s && Date.now() - settingsCache.at < 300000) return settingsCache.s;
  if (snapOn && !snapMaybeProbe()) return settingsCache.s || { ...DEFAULTS };
  const s = { ...DEFAULTS };
  try {
    const rows = await withTimeout(env.DB.prepare('SELECT key, value FROM settings').all(), 2500);
    for (const r of rows.results || []) s[r.key] = r.value;
    snapRecovered();
    settingsCache = { at: Date.now(), s };
  } catch (e) { snapNote(); }
  return settingsCache.s || s;
}


// ---------- relevance scoring (shared by both suggesters) ----------
// Per query word, best match quality against a row's title/author tokens:
// exact 1.0, prefix 0.85, contained 0.7, typo(1) 0.6, typo(2) 0.4.
// Rows rank by token coverage first (every query word matched beats one
// strong match), then total quality; author matches add a small bonus.
function wordQuality(w, titleToks, authorToks) {
  let best = 0;
  for (const t of titleToks) {
    let q = 0;
    if (t === w) q = 1.0;
    else if (t.startsWith(w) || w.startsWith(t)) q = 0.85;
    else if (t.includes(w)) q = 0.7;
    else if (t[0] === w[0] && Math.abs(t.length - w.length) <= 3) {
      const d = editDist(w, t, 2);
      q = d === 1 ? 0.6 : d === 2 ? 0.4 : 0;
    }
    if (q > best) best = q;
    if (best === 1) break;
  }
  let abest = 0;
  for (const t of authorToks) {
    if (t === w) { abest = 1; break; }
    if (t.startsWith(w) || t.includes(w)) abest = Math.max(abest, 0.9);
  }
  return { title: best, author: abest };
}
function scoreRow(words, titleNorm, authorNorm) {
  const titleToks = (titleNorm || '').split(/\s+/).filter(Boolean).slice(0, 40);
  const authorToks = (authorNorm || '').split(/\s+/).filter(Boolean).slice(0, 12);
  let cover = 0, total = 0, authorHit = 0;
  for (const w of words) {
    const q = wordQuality(w, titleToks, authorToks);
    if (q.title > 0 || q.author > 0) cover++;
    total += Math.max(q.title, q.author * 0.95);
    if (q.author > 0) authorHit = 1;
  }
  return { cover, score: total + authorHit * 0.3 };
}
function rankScored(rows, limit, seenT) {
  rows.sort((a, b) => b.cover - a.cover || b.score - a.score);
  const out = [];
  for (const r of rows) {
    const pt = r.pretty;
    if (!pt) continue;
    const key = pt.replace(/[\d٠-٩]+/g, ' ').replace(/[^\p{L} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (seenT.has(key)) continue;
    seenT.add(key);
    out.push({ id: r.id, title: pt });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- snapshot fallback (static search while D1 is unavailable) ----------
// The Mini App repo (GitHub Pages) hosts a sharded snapshot built from a D1
// export: an inverted index (idx/), row chunks (rows/) and an id map (byid/).
// When a D1 read errors (e.g. the daily free read cap), snapOn flips and
// search/latest/stats/delivery keep working from the snapshot until D1
// recovers; every request retries D1 first whenever snapOn did not trip yet.
let snapOn = false;
function snapNote() { snapOn = true; }
function snapRecovered() { snapOn = false; }
// While snapOn, D1 is probed at most once a minute; every other caller goes
// straight to the snapshot instead of paying a failing round trip per call.
let snapProbeAt = 0;
function snapMaybeProbe() {
  if (!snapOn) return true;
  if (Date.now() - snapProbeAt < 60000) return false;
  snapProbeAt = Date.now();
  return true;
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), ms))]);
}
// Non-critical work off the reply path: tracking, logging.
function defer(ctx, p) {
  const q = p.catch(e => console.error('deferred failed:', (e && e.message) || e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(q);
}
let SNAP_BASE = 'https://moharjb2-books.github.io/islamic-library/snapshot';
let snapMetaCache = { at: 0, meta: null };

async function snapGet(path) {
  const r = await fetch(SNAP_BASE + path, { cf: { cacheEverything: true, cacheTtl: 300 } });
  if (!r.ok) throw new Error('snapshot ' + r.status + ' ' + path);
  return r.json();
}
async function snapMeta() {
  if (snapMetaCache.meta && Date.now() - snapMetaCache.at < 300000) return snapMetaCache.meta;
  const meta = await snapGet('/meta.json');
  snapMetaCache = { at: Date.now(), meta };
  return meta;
}
function snapRowFile(r) {
  return { id: r[0], title: r[1], file_name: r[2], author: r[3], ext: r[4], size_bytes: r[5],
           channel: r[6], message_id: r[7], link: r[8], file_id: r[9], delivery: r[10], created_at: r[11] };
}
function extFilterOk(e, ext, includeAudio) {
  e = String(e || '').toLowerCase();
  const aud = isAudioExt(e);
  if (ext && ext !== 'all') return ext === 'audio' ? aud : e === ext.toLowerCase();
  return includeAudio || !aud;
}
async function snapPostings(word) {
  let shard;
  try { shard = await snapGet('/idx/' + encodeURIComponent(word.slice(0, 2)) + '.json'); }
  catch (e) { return []; }  // no shard for this prefix = no matches
  if (!shard || typeof shard !== 'object') return [];
  if (shard[word]) return shard[word];
  const out = [];
  for (const k of Object.keys(shard)) {
    if (k.startsWith(word)) {
      for (const i of shard[k]) { out.push(i); if (out.length >= 20000) break; }
    }
    if (out.length >= 20000) break;
  }
  out.sort((a, b) => a - b);
  return out;
}
async function snapSearch(q, ext, offset, limit, includeAudio) {
  const nq = norm(q);
  const words = nq.split(/\s+/).filter(Boolean).slice(0, 8).map(x => x.slice(0, 20));
  if (!words.length) {
    const latest = await snapGet('/latest.json');
    const rows = (latest.items || []).map(snapRowFile).filter(f => extFilterOk(f.ext, ext, includeAudio));
    return { items: rows.slice(offset, offset + limit), hasMore: offset + limit < rows.length };
  }
  const lists = (await Promise.all(words.map(snapPostings))).filter(l => l.length);
  if (lists.length < words.length) return { items: [], hasMore: false };
  lists.sort((a, b) => a.length - b.length);
  let cand = lists[0];
  for (let i = 1; i < lists.length && cand.length; i++) {
    const s = new Set(lists[i]);
    cand = cand.filter(x => s.has(x));
  }
  const items = [];
  const chunks = {};
  let pos = cand.length - 1, matched = 0, scanned = 0;
  while (pos >= 0 && items.length < limit + 1 && scanned < 6000) {
    const g = cand[pos--]; scanned++;
    const ci = Math.floor(g / 500);
    if (!chunks[ci]) {
      if (Object.keys(chunks).length >= 8) break;
      chunks[ci] = await snapGet('/rows/c' + String(ci).padStart(3, '0') + '.json');
    }
    const r = chunks[ci][g % 500];
    if (!r) continue;
    if (!extFilterOk(r[4], ext, includeAudio)) continue;
    if (matched++ < offset) continue;
    items.push(snapRowFile(r));
  }
  const hasMore = items.length > limit;
  return { items: items.slice(0, limit), hasMore };
}
async function snapGetFileById(id) {
  const lst = await snapGet('/byid/b' + (id % 64) + '.json');
  let g = -1;
  for (const pair of lst) { if (pair[0] === id) { g = pair[1]; break; } }
  if (g < 0) return null;
  const chunk = await snapGet('/rows/c' + String(Math.floor(g / 500)).padStart(3, '0') + '.json');
  const r = chunk[g % 500];
  return r ? snapRowFile(r) : null;
}
async function snapSuggest(q, limit) {
  const words = norm(q).split(/\s+/).filter(x => x.length >= 2).slice(0, 6).map(x => x.slice(0, 20));
  if (!words.length) return [];
  // Per word: matched index tokens (exact/prefix/typo) with quality and size.
  const perWord = [];
  for (const w of words) {
    let shard;
    try { shard = await snapGet('/idx/' + encodeURIComponent(w.slice(0, 2)) + '.json'); }
    catch (e) { perWord.push({ w, tokens: [] }); continue; }
    const tokens = [];
    let budget = 1200;
    for (const k of Object.keys(shard)) {
      if (k.length < 2) continue;
      let q = 0;
      if (k === w) q = 1.0;
      else if (k.startsWith(w)) q = 0.85;
      else if (k.includes(w) && w.length >= 3) q = 0.7;
      else if (k[0] === w[0] && Math.abs(k.length - w.length) <= 3) {
        if (budget-- <= 0) break;
        const d = editDist(w, k, 2);
        q = d === 1 ? 0.6 : d === 2 ? 0.4 : 0;
      }
      if (q > 0) tokens.push({ t: k, q, n: shard[k].length });
    }
    tokens.sort((a, b) => b.q - a.q || b.n - a.n);
    perWord.push({ w, tokens: tokens.slice(0, 6) });
  }
  // Candidate rows come from the RAREST word's best tokens (bounded), then
  // every candidate is scored against ALL query words, coverage first.
  const ranked = perWord.filter(p => p.tokens.length)
    .map(p => ({ ...p, size: p.tokens.reduce((a, t) => a + Math.min(t.n, 50) * t.q, 0) }))
    .sort((a, b) => a.size - b.size);
  if (!ranked.length) return [];
  const rare = ranked[0];
  const candIdx = [];
  for (const t of rare.tokens) {
    const shard = await snapGet('/idx/' + encodeURIComponent(t.t.slice(0, 2)) + '.json').catch(() => null);
    const posts = shard ? shard[t.t] : null;
    if (!posts) continue;
    for (const g of posts.slice(-150)) candIdx.push(g);
    if (candIdx.length >= 400) break;
  }
  const chunks = {};
  let fetches = 0;
  const scoredRows = [];
  for (const g of candIdx.slice(0, 400)) {
    const ci = Math.floor(g / 500);
    if (!chunks[ci]) {
      if (fetches >= 8) break;
      try { chunks[ci] = await snapGet('/rows/c' + String(ci).padStart(3, '0') + '.json'); fetches++; }
      catch (e) { continue; }
    }
    const r = chunks[ci][g % 500];
    if (!r) continue;
    const title = String(r[1] || '').trim();
    if (!title) continue;
    const s = scoreRow(words, norm(title), norm(String(r[3] || '')));
    if (s.cover === 0 || s.score < 0.8) continue;
    scoredRows.push({ id: r[0], pretty: prettyTitle(title), ...s });
  }
  return rankScored(scoredRows, limit, new Set());
}
async function getFileById(env, id) {
  if (!snapOn) {
    try { return await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first(); }
    catch (e) { snapNote(); }
  }
  return snapGetFileById(id);
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, String(value)).run();
  settingsCache.at = 0;
}

// ---------- external sources: Internet Archive live fallback ----------
// Link-only federated search: when the local library has no match, offer a
// few archive.org links. No hosting, no D1 writes; results cached in-isolate.
const iaCache = new Map();
// Sunni-curated external libraries: link-only federated fallback (no API key needed).
const EXT_LIBS = [
  ['📚 الشاملة', e => 'https://shamela.ws/search?q=' + e],
  ['🕌 الوقفية', e => 'https://waqfeya.net/search?q=' + e],
  ['📿 الدرر السنية', e => 'https://dorar.net/site/search?skeys=' + e],
  ['🌐 إسلام هاوس', e => 'https://islamhouse.com/ar/search/?q=' + e],
];
function extLibRows(query) {
  const e = encodeURIComponent(query);
  const btns = EXT_LIBS.map(([label, f]) => ({ text: label, url: f(e), style: 'primary' }));
  return [btns.slice(0, 2), btns.slice(2)];
}

async function iaSearch(env, q, limit = 3) {
  const key = (q || '').toLowerCase().trim();
  if (!key) return [];
  const hit = iaCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.items;
  const base = env.IA_API_BASE || 'https://archive.org';
  const u = new URL(base + '/advancedsearch.php');
  u.searchParams.set('q', `(${q}) AND mediatype:texts`);
  for (const f of ['identifier', 'title', 'creator']) u.searchParams.append('fl[]', f);
  u.searchParams.set('sort[]', 'downloads desc');
  u.searchParams.set('rows', '10');
  u.searchParams.set('output', 'json');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(u.toString(), { signal: ctrl.signal, headers: { 'user-agent': 'IslamicLibraryBot/1.0 (+https://t.me/ISLAMIC_BOOKS_LIBbot)' } });
    const j = await r.json();
    const docs = ((j.response && j.response.docs) || [])
      .filter(d => d && d.identifier)
      .filter(d => sunniOk(d.title, d.creator) && !IA_BULK_RE.test(String(d.title || '')))
      // Skip hits with no real title: a bare identifier (WAQ59561) is not a book name.
      .filter(d => d.title && String(d.title).trim() && String(d.title).trim() !== d.identifier)
      // Only real title matches: archive.org ranks by downloads, not relevance.
      .map(d => ({ ...d, rel: relScore(d.title, d.creator, q) }))
      .filter(d => d.rel > 0)
      .sort((a, b) => b.rel - a.rel)
      .slice(0, limit);
    // Resolve a direct PDF/EPUB per item so the button downloads the book
    // itself, like a channel result, instead of opening a search page.
    const items = await Promise.all(docs.map(async (d) => {
      const title = String(d.title || d.identifier);
      const page = { title: title.slice(0, 45), url: base + '/details/' + d.identifier };
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 2000);
        try {
          const mres = await fetch(`${base}/metadata/${encodeURIComponent(d.identifier)}`, { signal: c2.signal, headers: { 'user-agent': 'IslamicLibraryBot/1.0 (+https://t.me/ISLAMIC_BOOKS_LIBbot)' } });
          const m = await mres.json();
          const files = (m.files || []).filter(f => /\.(pdf|epub)$/i.test(f.name || ''));
          const pick =
            files.find(f => String(f.name || '').toLowerCase() === (d.identifier + '.pdf').toLowerCase()) ||
            files.find(f => /_text\.pdf$/i.test(f.name || '')) ||
            files.find(f => /\.pdf$/i.test(f.name || '') && !/_bw\.pdf$/i.test(f.name || '')) ||
            files[0];
          if (!pick) return page;
          const mb = pick.size ? Math.round(Number(pick.size) / 1e6) : 0;
          return {
            title: title.slice(0, 36),
            url: `${base}/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(pick.name)}`,
            kind: /\.epub$/i.test(pick.name || '') ? 'EPUB' : 'PDF',
            sizeMb: mb,
          };
        } finally { clearTimeout(t2); }
      } catch (e) { return page; }
    }));
    iaCache.set(key, { at: Date.now(), items });
    if (iaCache.size > 500) iaCache.clear();
    return items;
  } catch (e) { return []; } finally { clearTimeout(t); }
}

// Non-Sunni markers: external corpora are broad; drop obvious off-manhaj hits.
const NON_SUNNI_RE = /(الشيع|الإمامية|الزيدية|الخميني|الكليني|المجلسي|الطوسي|الطباطبائي|زيد بن علي|الحر العاملي|الإسماعيلي|البهائية|القاديانية|الأحمدية|النصيرية|الدرزية|بابي)/;
function sunniOk(...fields) { return !NON_SUNNI_RE.test(fields.filter(Boolean).join(' ')); }
// IA bulk packs (whole-library zips) are noise for a single-book query.
const IA_BULK_RE = /(6538|صيغة و+رد|صيغة ويب|صيغة htm|كتاب إسلامي كل ألف|6 ألف|HTM WEB|shamelah|موسوعة الكتب|الموسوعة المقروءة)/i;

// aljam3.com (الجامع): free open API, ~63k Sunni-curated books. Search has no
// files; a bounded detail call per hit resolves direct PDF/DOCX/TXT links.
const ajCache = new Map();
async function ajSearch(env, q, limit = 3) {
  const key = (q || '').toLowerCase().trim();
  if (!key) return [];
  const hit = ajCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.items;
  const base = env.AJ_API_BASE || 'https://aljam3.com';
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const ua = { 'user-agent': 'IslamicLibraryBot/1.0 (+https://t.me/ISLAMIC_BOOKS_LIBbot)' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const u = new URL(base + '/api/v1/books');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    const r = await fetch(u.toString(), { signal: ctrl.signal, headers: ua });
    const j = await r.json();
    // Fetch a couple extra: same book in several editions ranks as separate hits.
    const books = ((j && j.books) || []).slice(0, limit + 2).filter(b => b && b.id);
    const items = await Promise.all(books.map(async (b) => {
      const author = strip(b.author && b.author.name);
      const rawTitle = strip(b.title);
      if (!sunniOk(rawTitle, author)) return null;
      const rel = relScore(rawTitle, author, q);
      if (!rel) return null;
      const title = rawTitle.slice(0, 30) + (author ? ' · ' + author.slice(0, 12) : '');
      let pdf = null, alt = null, altKind = '';
      try {
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 2000);
        try {
          const dres = await fetch(`${base}/api/v1/books/${b.id}?expand[]=files`, { signal: c2.signal, headers: ua });
          const d = await dres.json();
          const f0 = (d.files || [])[0];
          if (f0 && f0.urls) {
            pdf = f0.urls.pdf || null;
            if (f0.urls.docx) { alt = f0.urls.docx; altKind = 'DOCX'; }
            else if (f0.urls.txt) { alt = f0.urls.txt; altKind = 'TXT'; }
          }
        } finally { clearTimeout(t2); }
      } catch (e) {}
      if (!pdf && !alt) return null;
      return { title, url: pdf || alt, alt: pdf ? alt : null, altKind, kind: pdf ? 'PDF' : altKind, sizeMb: 0, rel, lib: strip(b.library && b.library.name) };
    }));
    // Dedupe editions: same direct file, or same author + same normalized title
    // (punctuation/edition markers ignored), keeps only its first hit.
    const seen = new Set();
    const out = items.filter(Boolean).sort((x, y) => y.rel - x.rel).filter(i => {
      const k1 = 'u:' + i.url;
      const k2 = 't:' + i.title.replace(/[\s\-–—:()«»]+/g, '').replace(/[أإآ]/g, 'ا').slice(0, 22);
      if (seen.has(k1) || seen.has(k2)) return false;
      seen.add(k1); seen.add(k2);
      return true;
    }).slice(0, limit);
    ajCache.set(key, { at: Date.now(), items: out });
    if (ajCache.size > 500) ajCache.clear();
    return out;
  } catch (e) { return []; } finally { clearTimeout(t); }
}

// ketabonline.com: free open API, Shamela-based Sunni library. One search
// call returns title/authors/files; some books carry a direct PDF zip.
const kbCache = new Map();
async function kbSearch(env, q, limit = 3) {
  const key = (q || '').toLowerCase().trim();
  if (!key) return [];
  const hit = kbCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.items;
  const base = env.KB_API_BASE || 'https://backend.ketabonline.com';
  const u = new URL(base + '/api/v2/books');
  u.searchParams.set('q', q);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(u.toString(), { signal: ctrl.signal, headers: { 'user-agent': 'IslamicLibraryBot/1.0 (+https://t.me/ISLAMIC_BOOKS_LIBbot)' } });
    const j = await r.json();
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
    const items = ((j && j.data) || [])
      .filter(b => b && b.id && b.lang === 'ar' && (b.is_free === 1 || b.is_free === true))
      .filter(b => sunniOk(strip(b.title), (b.authors || []).map(a => strip(a.name)).join(' '), (b.categories || []).map(c => strip(c.name)).join(' ')))
      .map(b => ({ b, rel: relScore(strip(b.title), (b.authors || []).map(a => strip(a.name)).join(' '), q) }))
      .filter(x => x.rel > 0)
      .sort((a2, b2) => b2.rel - a2.rel)
      .slice(0, limit)
      .map(x => x.b)
      .map(b => {
        const author = (b.authors || []).map(a => strip(a.name)).filter(Boolean).join('، ');
        const title = strip(b.title).slice(0, 28) + (author ? ` · ${author.slice(0, 14)}` : '');
        const pdf = b.files && b.files.pdf && b.files.pdf.url ? b.files.pdf : null;
        return {
          title,
          url: `https://ketabonline.com/ar/books/${b.id}`,
          pdf: pdf ? pdf.url : null,
          pdfSize: pdf && pdf.size ? Math.round(Number(pdf.size) / 1e6) : 0,
          kind: pdf ? 'PDF' : '',
        };
      });
    kbCache.set(key, { at: Date.now(), items });
    if (kbCache.size > 500) kbCache.clear();
    return items;
  } catch (e) { return []; } finally { clearTimeout(t); }
}

// ---------- Telegram API ----------
async function tg(env, method, body) {
  const base = env.TG_API_BASE || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// ---------- Mini App initData validation ----------
async function validateInitData(env, initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheck = pairs.join('\n');
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretBuf = await crypto.subtle.sign('HMAC', keyMaterial, enc.encode(env.BOT_TOKEN));
    const key = await crypto.subtle.importKey(
      'raw', secretBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(dataCheck));
    const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (sig !== hash) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user;
  } catch (e) { return null; }
}

function isOwner(env, userId) {
  return Boolean(env.OWNER_ID) && String(userId) === String(env.OWNER_ID);
}

async function isAdmin(env, settings, userId) {
  if (!userId) return false;
  if (env.OWNER_ID && String(userId) === String(env.OWNER_ID)) return true;
  if (!snapOn) {
    try {
      const row = await withTimeout(env.DB.prepare('SELECT is_admin FROM users WHERE user_id = ?').bind(userId).first(), 2500);
      if (row && row.is_admin) return true;
    } catch (e) { snapNote(); }
  }
  const ids = (settings.admin_ids || '').split(',').map(x => x.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

async function trackUser(env, from) {
  if (!from || !from.id) return;
  if (snapOn) return;  // known-down DB: do not pay a failing call on the reply path
  try {
    await env.DB.prepare(
      `INSERT INTO users(user_id, first_name, username, last_seen) VALUES(?,?,?,unixepoch())
       ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=unixepoch()`
    ).bind(from.id, from.first_name || '', from.username || '').run();
  } catch (e) { snapNote(); }  // a capped DB must never kill the bot's reply path
}

async function logSearch(env, userId, q, results) {
  if (!q || !q.trim()) return;
  try {
    await env.DB.prepare('INSERT INTO searches(user_id, q, results) VALUES(?,?,?)')
      .bind(userId || 0, q.trim().slice(0, 200), results).run();
  } catch (e) {}
}

// ---------- search ----------
const AUDIO_EXT_LIST = ['mp3','m4a','ogg','oga','opus','wav','aac','flac','weba','audio'];
const AUDIO_EXTS = "('" + AUDIO_EXT_LIST.join("','") + "')";
function isAudioExt(e) { return AUDIO_EXT_LIST.includes(String(e || '').toLowerCase()); }

async function searchFilesDB(env, q, ext, offset, limit, includeAudio) {
  const nq = norm(q);
  const words = nq.split(/\s+/).filter(Boolean).slice(0, 8).map(x => x.slice(0, 20));
  let from = 'files f';
  let where = '1=1';
  const binds = [];
  if (words.length && ftsOk) {
    // FTS5 reads only matching rows; LIKE would scan the whole table per search
    // (D1 free tier caps daily rows read, so full scans do not scale).
    from += ' JOIN files_fts x ON x.rowid = f.id';
    where += ' AND files_fts MATCH ?';
    binds.push(ftsQuery(words));
  } else {
    // D1 limits LIKE patterns to 50 bytes; Arabic chars are 2 bytes, so match
    // word-by-word (each clamped) instead of one long phrase pattern.
    for (const w of words) {
      where += ' AND (f.title_norm LIKE ? OR f.author_norm LIKE ?)';
      binds.push(`%${w}%`, `%${w}%`);
    }
  }
  if (ext && ext !== 'all') {
    if (ext === 'audio') { where += ` AND f.ext IN ${AUDIO_EXTS}`; }
    else { where += ' AND f.ext = ?'; binds.push(ext.toLowerCase()); }
  } else if (!includeAudio) {
    where += ` AND f.ext NOT IN ${AUDIO_EXTS}`;
  }
  binds.push(limit + 1, offset);
  const rows = await env.DB.prepare(
    `SELECT f.* FROM ${from} WHERE ${where}
     ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();
  const items = rows.results || [];
  const hasMore = items.length > limit;
  return { items: items.slice(0, limit), hasMore };
}

async function countExtDB(env, q) {
  const nq = norm(q);
  const words = nq.split(/\s+/).filter(Boolean).slice(0, 8).map(x => x.slice(0, 20));
  let from = 'files f';
  let where = '1=1';
  const binds = [];
  if (words.length && ftsOk) {
    from += ' JOIN files_fts x ON x.rowid = f.id';
    where += ' AND files_fts MATCH ?';
    binds.push(ftsQuery(words));
  } else {
    for (const w of words) { where += ' AND (f.title_norm LIKE ? OR f.author_norm LIKE ?)'; binds.push(`%${w}%`, `%${w}%`); }
  }
  const rows = await env.DB.prepare(
    `SELECT CASE WHEN f.ext IN ${AUDIO_EXTS} THEN 'audio' ELSE f.ext END AS k, COUNT(*) AS c
     FROM ${from} WHERE ${where} GROUP BY k`
  ).bind(...binds).all();
  const out = {};
  let total = 0;
  for (const r of rows.results || []) { out[r.k || 'other'] = r.c; total += r.c; }
  out.all = total - (out.audio || 0);
  return out;
}


// Fallback-aware wrappers: try D1 first, flip to the static snapshot on error.
async function searchFiles(env, q, ext, offset, limit, includeAudio) {
  if (snapOn && !snapMaybeProbe()) return snapSearch(q, ext, offset, limit, includeAudio);
  try {
    const r = await withTimeout(searchFilesDB(env, q, ext, offset, limit, includeAudio), 3000);
    snapRecovered();
    return r;
  } catch (e) { snapNote(); return await snapSearch(q, ext, offset, limit, includeAudio); }
}
async function countExt(env, q) {
  if (snapOn) return null;
  try { return await countExtDB(env, q); } catch (e) { snapNote(); return null; }
}
async function suggestTitles(env, q, limit = 5) {
  if (!snapOn) { try { return await suggestTitlesDB(env, q, limit); } catch (e) { snapNote(); } }
  return snapSuggest(q, limit);
}

// ---------- local result polish: clean titles, dedupe, channel ranking ----------
function cleanTitle(name) {
  let s = String(name || '');
  s = s.replace(/\.(pdf|epub|docx?|txt|mp3|m4a|wav|ogg|zip|rar|7z|mobi|azw3?)$/i, '');
  s = s.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}
function titleKey(name) {
  return norm(cleanTitle(name)).replace(/\s+/g, ' ').trim();
}
// One row per book (largest copy wins), his channel first, clean display titles.
function polishLocal(items, mainChannel) {
  const seen = new Map();
  for (const f of items) {
    const cleanTitle_ = cleanTitle(f.file_name || f.title);
    const clean = { ...f, title: cleanTitle_, file_name: cleanTitle_ };
    const k = titleKey(f.file_name || f.title) || String(f.id);
    const prev = seen.get(k);
    if (!prev || (clean.size_bytes || 0) > (prev.size_bytes || 0)) seen.set(k, clean);
  }
  const own = [], other = [];
  for (const f of seen.values()) (f.channel === mainChannel ? own : other).push(f);
  return own.concat(other);
}
// External rows look like the channel rows: 📕 title (FORMAT · size), one tap downloads.
function fmtExtLabel(e) {
  const bits = [];
  if (e.kind) bits.push(e.kind);
  const mb = e.sizeMb || e.pdfSize || 0;
  if (mb) bits.push(mb + 'MB');
  return `📕 ${e.title}${bits.length ? ' (' + bits.join(' ') + ')' : ''}`;
}
function extRows(aj, ext, kbk) {
  const rows = [];
  for (const a of aj) {
    const row = [{ text: fmtExtLabel(a), url: a.url, style: 'success' }];
    if (a.alt) row.push({ text: `⬇️ ${a.altKind}`, url: a.alt, style: 'primary' });
    rows.push(row);
  }
  for (const e of ext) rows.push([{ text: fmtExtLabel(e), url: e.url, style: 'primary' }]);
  for (const k of kbk) {
    const row = [{ text: fmtExtLabel(k), url: k.url, style: 'primary' }];
    if (k.pdf) row.push({ text: `⬇️ PDF${k.pdfSize ? ' ' + k.pdfSize + 'MB' : ''}`, url: k.pdf, style: 'success' });
    rows.push(row);
  }
  return rows;
}
function extText(aj, ext, kbk) {
  return (aj.length ? '\n\n📘 من الجامع aljam3.com (تحميل مباشر):' : '')
    + (ext.length ? '\n\n🌐 من archive.org (تحميل مباشر):' : '')
    + (kbk.length ? '\n\n📗 من كتاب أونلاين:' : '');
}

// ---------- external relevance: only real title matches ----------
const QSTOP_RE = /^(كتاب|كتب|تحميل|برابط|مجانا|مجاناً|كامل|بجوده|عالية|pdf|من|في|علي|الي|عن|ان|إن)$/;
function qTerms(q) {
  return norm(q).split(/\s+/).filter(w => w.length > 2 && !QSTOP_RE.test(w));
}
// Every query word must match the title/author (substring, or one typo away
// from a title word). Returns 0 for weak/fuzzy hits; otherwise coverage plus
// a phrase bonus, so callers can rank exact matches first.
function relScore(title, author, q) {
  const words = qTerms(q);
  if (!words.length) return 0;
  const t = norm((title || '') + ' ' + (author || ''));
  const twords = t.split(/\s+/).filter(Boolean);
  let hit = 0;
  for (const w of words) {
    if (t.includes(w)) { hit++; continue; }
    if (twords.some(tw => Math.abs(tw.length - w.length) <= 1 && editDist(w, tw, 1) <= 1)) hit++;
  }
  if (hit < words.length) return 0;
  return hit + (t.includes(norm(q).replace(/\s+/g, ' ').trim()) ? 1 : 0);
}

// ---------- fuzzy suggestions ----------
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > max) return max + 1;
  }
  return dp[b.length];
}

function tokenScore(nq, cand) {
  const qw = nq.split(/\s+/).filter(Boolean).slice(0, 8);
  const cw = String(cand || '').split(/[\s_\-–—.,()]+/).filter(Boolean).slice(0, 40);
  if (!qw.length || !cw.length) return 99;
  let total = 0;
  for (const w of qw) {
    let best = 4;
    for (const c of cw) {
      const nc = norm(c);
      if (!nc || nc.length < 2) continue;
      if (nc.length >= 3 && w.length >= 3 && (nc.includes(w) || w.includes(nc))) { best = Math.min(best, Math.abs(nc.length - w.length) > 2 ? 0.5 : 0); continue; }
      if (nc[0] !== w[0]) continue; // cheap gate: edit distance only within same first letter
      best = Math.min(best, editDist(w, nc, 3));
    }
    total += best;
  }
  return total / qw.length;
}

function prettyTitle(t) {
  let x = String(t || '');
  x = x.replace(/\.[a-z0-9]{2,5}$/i, '');
  x = x.replace(/^[A-Za-z]{3,}\d{3,}[_\s-]+/, '');
  x = x.replace(/[_{}]+/g, ' ').replace(/\s+/g, ' ').trim();
  return x || String(t || '');
}

async function suggestTitlesDB(env, q, limit = 3) {
  const words = norm(q).split(/\s+/).filter(x => x.length >= 2).slice(0, 6).map(x => x.slice(0, 20));
  if (!words.length) return [];
  // Candidates: rows matching ANY word (prefix on each), scored against ALL
  // words in JS. FTS exact tokens do not cover typos; a trigram FTS table is
  // queued post-ingest to make D1-side matching fully typo-tolerant.
  let rows;
  const orQ = words.map(w => '"' + w.replace(/"/g, '') + '" OR "' + w.replace(/"/g, '') + '"*').join(' OR ');
  if (ftsOk) {
    rows = await env.DB.prepare(
      `SELECT f.id, f.title, f.title_norm, f.file_name, f.author_norm FROM files f
       JOIN files_fts x ON x.rowid = f.id
       WHERE files_fts MATCH ? ORDER BY f.id DESC LIMIT 250`
    ).bind(orQ).all();
  } else {
    const where = words.map(() => '(title_norm LIKE ? OR author_norm LIKE ?)').join(' OR ');
    const binds = [];
    for (const w of words) { binds.push(`%${w}%`, `%${w}%`); }
    rows = await env.DB.prepare(
      `SELECT id, title, title_norm, file_name, author_norm FROM files WHERE ${where}
       ORDER BY id DESC LIMIT 250`
    ).bind(...binds).all();
  }
  const scored = [];
  for (const r of rows.results || []) {
    const title = String(r.title || r.file_name || '').trim();
    if (!title) continue;
    const s = scoreRow(words, (r.title_norm || '') + ' ' + norm(r.file_name || ''), r.author_norm || '');
    if (s.cover === 0 || s.score < 0.8) continue;
    scored.push({ id: r.id, pretty: prettyTitle(title), ...s });
  }
  return rankScored(scored, limit, new Set());
}

// ---------- custom button icons (Telegram custom emoji pack owned by the bot) ----------
const ICON = {
  search: '5787597031270785832',
  book: '5785239901679132333',
  star: '5785259254801769652',
  mega: '5787383056000098329',
  info: '5787535952540868498',
  dl: '5787650005397413705',
};

// ---------- file delivery ----------
async function deliverFile(env, settings, chatId, file) {
  const protect = settings.protect_content === '1';
  if (file.file_id) {
    return tg(env, 'sendDocument', {
      chat_id: chatId, document: file.file_id,
      caption: `📕 ${file.title}\n\n📚 @${env.BOT_USERNAME}`,
      protect_content: protect,
    });
  }
  if (file.delivery === 'copy' && file.channel && file.message_id) {
    const r = await tg(env, 'copyMessage', {
      chat_id: chatId, from_chat_id: '@' + file.channel,
      message_id: file.message_id, protect_content: protect,
    });
    if (r && r.ok) return r;
    // fallback to link
  }
  if (file.link) {
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `📕 ${file.file_name || file.title}\n📎 ${file.ext ? file.ext.toUpperCase() + ' · ' : ''}${fmtSize(file.size_bytes)}`,
      reply_markup: { inline_keyboard: [[{ text: '⬇️ فتح الملف في القناة', url: file.link }]] },
    });
  }
  return tg(env, 'sendMessage', { chat_id: chatId, text: `تعذر تسليم: ${file.title}` });
}

let forcedCache = { at: 0, list: null };
async function forcedList(env) {
  if (forcedCache.list && (Date.now() - forcedCache.at) < 300000) return forcedCache.list;
  try {
    const rows = await env.DB.prepare('SELECT username FROM forced_channels WHERE active = 1').all();
    let list = (rows.results || []).map(r => r.username);
    if (!list.length && env.MAIN_CHANNEL) {
      // First run: seed the main channel so the gate is on by default; admins can remove it.
      const seeded = await env.DB.prepare("SELECT value FROM settings WHERE key = 'forced_seeded'").first();
      if (!seeded) {
        const mc = String(env.MAIN_CHANNEL).toLowerCase();
        await env.DB.prepare('INSERT OR IGNORE INTO forced_channels(username, active) VALUES(?, 1)').bind(mc).run();
        await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('forced_seeded', '1')").run();
        list = [mc];
      }
    }
    forcedCache = { at: Date.now(), list };
    return forcedCache.list;
  } catch (e) { snapNote(); }
  // D1 unavailable: fall back to the env list, then the snapshot's published
  // list, then the main-channel default. The gate must never silently turn
  // off — fail closed, not open. Fallback lists are deliberately NOT cached
  // in forcedCache so the live config takes over as soon as D1 recovers.
  if (env.FORCED_CHANNELS) {
    const l = String(env.FORCED_CHANNELS).split(',')
      .map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    if (l.length) return l;
  }
  try {
    const meta = await snapMeta();
    if (Array.isArray(meta.forced_channels) && meta.forced_channels.length) return meta.forced_channels;
  } catch (e) {}
  return env.MAIN_CHANNEL ? [String(env.MAIN_CHANNEL).toLowerCase()] : [];
}

const memberCache = new Map();  // userId -> {at, missing}; Telegram calls are the slowest hop
async function checkForced(env, userId, fresh) {
  const hit = !fresh && memberCache.get(userId);
  if (hit && Date.now() - hit.at < 600000) return hit.missing;
  const list = await forcedList(env);
  const missing = [];
  for (const u of list) {
    try {
      const m = await tg(env, 'getChatMember', { chat_id: '@' + u, user_id: userId });
      const st = m && m.ok && m.result ? m.result.status : 'left';
      if (['left', 'kicked'].includes(st)) missing.push(u);
    } catch (e) { missing.push(u); }
  }
  memberCache.set(userId, { at: Date.now(), missing });
  if (memberCache.size > 5000) memberCache.clear();
  return missing;
}

// ---------- webhook ----------
async function handleUpdate(env, update, ctx2) {
  const settings = await getSettings(env);

  if (update.message || update.channel_post) {
    const msg = update.message || update.channel_post;
    const chatId = msg.chat.id;

    // Channel post in a channel where the bot is admin: index with file_id
    if (update.channel_post) {
      const doc = msg.document || msg.audio || msg.video;
      if (doc) {
        const username = (msg.chat.username || '').toLowerCase();
        const title = doc.file_name || msg.caption || 'ملف';
        const ext0 = extOf(doc.file_name || '') || (!msg.document && msg.audio ? 'audio' : '');
        await upsertFile(env, {
          title, file_name: doc.file_name || '', author: extractAuthor(title, msg.caption),
          ext: ext0, size_bytes: doc.file_size || 0,
          channel: username, message_id: msg.message_id,
          link: username ? `https://t.me/${username}/${msg.message_id}` : '',
          file_id: doc.file_id, delivery: 'copy',
        });
        if (username) {
          await env.DB.prepare(
            'UPDATE channels SET last_message_id = MAX(last_message_id, ?), bot_member = 1 WHERE username = ?'
          ).bind(msg.message_id, username).run();
        }
      }
      return;
    }

    const from = msg.from || {};
    defer(ctx2, trackUser(env, from));

    // Owner export ingest: Telegram Desktop result.json
    if (msg.document && msg.chat.type === 'private' && isOwner(env, from.id) && /\.json$/i.test(msg.document.file_name || '')) {
      await handleExportIngest(env, chatId, msg);
      return;
    }

    // Owner link to a big export file (Drive/direct): queue for crawler pull
    if (msg.chat.type === 'private' && isOwner(env, from.id) && msg.text && /https?:\/\/\S+/.test(msg.text) && /@([A-Za-z0-9_]{3,})/.test(msg.text)) {
      const um = /@([A-Za-z0-9_]{3,})/.exec(msg.text);
      const lm = /https?:\/\/\S+/.exec(msg.text);
      const uname = um[1].toLowerCase();
      const exists = await env.DB.prepare('SELECT username FROM channels WHERE username = ?').bind(uname).first();
      if (exists && /(drive\.google|dropbox|docs\.google|\/result\.json|github\.com.*\/releases)/i.test(lm[0])) {
        await env.DB.prepare('INSERT INTO export_jobs(url, channel) VALUES(?, ?)').bind(lm[0], uname).run();
        await tg(env, 'sendMessage', { chat_id: chatId, text: `📥 سجّلت رابط التصدير لقناة @${uname}. سأفهرسه تلقائيًا في الجولة القادمة وأخبرك بالنتيجة.` });
        return;
      }
    }

    // Document forwarded/sent to the bot in private: cache file_id
    const doc = msg.document || msg.audio || msg.video;
    if (doc && msg.chat.type === 'private') {
      const fwd = msg.forward_from_chat && msg.forward_from_chat.username
        ? msg.forward_from_chat.username.toLowerCase() : '';
      const title = doc.file_name || msg.caption || 'ملف';
      const ext0 = extOf(doc.file_name || '') || (!msg.document && msg.audio ? 'audio' : '');
      await upsertFile(env, {
        title, file_name: doc.file_name || '', author: extractAuthor(title, msg.caption),
        ext: ext0, size_bytes: doc.file_size || 0,
        channel: fwd, message_id: msg.forward_from_message_id || 0,
        link: fwd && msg.forward_from_message_id ? `https://t.me/${fwd}/${msg.forward_from_message_id}` : '',
        file_id: doc.file_id, delivery: 'file_id',
      });
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ تمت إضافة «${title}» إلى المكتبة.\n📎 ${extOf(doc.file_name || '').toUpperCase()} · ${fmtSize(doc.file_size)}`,
      });
      return;
    }

    let text = (msg.text || '').trim();

    // Forced-subscription gate: everything below needs membership.
    // Owner/admins and the admin-claim deep link bypass. The channel list
    // falls back to env/snapshot/main-channel when D1 is down, so the gate
    // stays enforced during a database outage (fail closed).
    if (msg.chat.type === 'private' && !text.startsWith('/start admin_')
        && !isOwner(env, from.id) && !(await isAdmin(env, settings, from.id))) {
      const missing0 = await checkForced(env, from.id);
      if (missing0.length) return sendForced(env, chatId, missing0);
    }

    if (text.startsWith('/start')) {
      const param = text.split(' ')[1] || '';
      // Admin claim: /start admin_<code>
      if (param === 'admin_' + env.ADMIN_SETUP_CODE) {
        await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').bind(from.id).run();
        const ids = (settings.admin_ids || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!ids.includes(String(from.id))) {
          ids.push(String(from.id));
          await setSetting(env, 'admin_ids', ids.join(','));
        }
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: '👑 تم تفعيل صلاحية المشرف لحسابك. افتح لوحة التحكم من زر الإعدادات في التطبيق.',
        });
        return;
      }
      // Deep link delivery: /start dl_<id>
      if (param.startsWith('dl_')) {
        const id = parseInt(param.slice(3), 10);
        const file = await getFileById(env, id);
        if (file) return deliverFile(env, settings, chatId, file);
      }
      return sendWelcome(env, settings, chatId);
    }

    // ---- broadcast (admin): /broadcast <text> or caption on media ----
    const bsrc = text || (msg.caption || '');
    if (bsrc.startsWith('/broadcast') && msg.chat.type === 'private') {
      if (!(await isAdmin(env, settings, from.id))) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'هذه المنطقة للمشرف فقط.' });
        return;
      }
      const body = bsrc.replace(/^\/broadcast\s*/, '').trim();
      const media = msg.photo ? { kind: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id }
        : msg.document ? { kind: 'document', file_id: msg.document.file_id }
        : msg.audio ? { kind: 'audio', file_id: msg.audio.file_id }
        : msg.video ? { kind: 'video', file_id: msg.video.file_id } : null;
      if (!body && !media) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'اكتب: /broadcast متن الرسالة\nأو أرسل صورة/ملفًا بكابشن يبدأ بـ /broadcast' });
        return;
      }
      const kind = media ? media.kind : 'text';
      const fid = media ? media.file_id : '';
      const r = await env.DB.prepare(
        "INSERT INTO broadcasts(admin_id, kind, text, file_id, status) VALUES(?,?,?,?, 'draft')"
      ).bind(from.id, kind, body, fid).run();
      const bid = r.meta.last_row_id;
      const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE blocked = 0').first();
      // preview: show the content itself
      if (kind === 'text') {
        await tg(env, 'sendMessage', { chat_id: chatId, text: '👀 معاينة:\n\n' + body });
      } else {
        const m = { photo: 'sendPhoto', document: 'sendDocument', audio: 'sendAudio', video: 'sendVideo' }[kind];
        await tg(env, m, { chat_id: chatId, [kind]: fid, caption: '👀 معاينة:\n\n' + body });
      }
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `📣 سيتم إرسال هذه الرسالة إلى ${cnt.c} مستخدم.\nالتأكيد؟`,
        reply_markup: { inline_keyboard: [[
          { text: '✅ تأكيد الإرسال', callback_data: 'bc_go:' + bid },
          { text: '❌ إلغاء', callback_data: 'bc_no:' + bid },
        ]] },
      });
      return;
    }

    if (text === '/admin') {
      if (await isAdmin(env, settings, from.id)) {
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: '🛠 لوحة التحكم:',
          reply_markup: { inline_keyboard: [[{ text: '🛠 فتح لوحة التحكم', web_app: { url: miniUrl(env, 'admin=1') }, style: 'primary', icon_custom_emoji_id: ICON.info }]] },
        });
      } else {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'هذه المنطقة للمشرف فقط.' });
      }
      return;
    }

    if (text && !text.startsWith('/')) {
      // Plain search in chat
      if (text.length > 200) text = text.slice(0, 200);
      const perPage = parseInt(settings.per_page, 10) || 10;
      const audioAsked = /(صوتي|صوت|مسموع|تلاوه|تلاوة|استماع|استمع|mp3|audio)/i.test(text);
      // Local channels and external libraries searched together, in parallel.
      const [{ items, hasMore }, ajAll, iaAll, kbAll] = await Promise.all([
        searchFiles(env, text, 'all', 0, perPage, audioAsked),
        audioAsked ? [] : ajSearch(env, text, 3),
        audioAsked ? [] : iaSearch(env, text, 3),
        audioAsked ? [] : kbSearch(env, text, 3),
      ]);
      const local = polishLocal(items, env.MAIN_CHANNEL);
      defer(ctx2, logSearch(env, from.id, text, local.length));
      const extCap = local.length ? 2 : 3;
      const aj = (ajAll || []).slice(0, extCap);
      const ext = (iaAll || []).slice(0, extCap);
      const kbk = (kbAll || []).slice(0, extCap);
      if (!local.length) {
        const sug = await suggestTitles(env, text, 3).catch(() => []);
        const kb = (sug || []).filter(g => g && g.title && g.id).map(g => [{ text: `🔎 ${String(g.title).slice(0, 45)}`, callback_data: 'sq:' + g.id, style: 'primary', icon_custom_emoji_id: ICON.search }]);
        for (const row of extRows(aj, ext, kbk)) kb.push(row);
        for (const row of extLibRows(text)) kb.push(row);
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: `🔍 لم أجد نتائج مطابقة لـ«${text}».`
            + (sug.length ? '\n\nهل تقصد:' : '')
            + extText(aj, ext, kbk)
            + '\n\n🔗 أو ابحث في مكتبات سنّية موثوقة:'
            + (!sug.length && !aj.length && !ext.length && !kbk.length ? '\nجرّب اسمًا أقصر أو جزءًا من اسم الكتاب أو المؤلف.' : ''),
          reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
        });
        return;
      }
      const keyboard = local.map(f => {
        const label = `📕 ${String(f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') {
          return [{ text: label, callback_data: 'dl:' + f.id, style: 'primary', icon_custom_emoji_id: ICON.book }];
        }
        return [{ text: label, url: f.link, style: 'primary', icon_custom_emoji_id: ICON.book }];
      });
      if (hasMore) keyboard.push([{ text: '⬇️ عرض المزيد', callback_data: 'more:' + items.length, style: 'primary', icon_custom_emoji_id: ICON.dl }]);
      for (const row of extRows(aj, ext, kbk)) keyboard.push(row);
      keyboard.push([{ text: '🔍 تصفية النتائج في صفحة البحث', web_app: { url: miniUrl(env) }, style: 'success', icon_custom_emoji_id: ICON.search }]);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        // Cards only: no header line, no per-source headers. Telegram needs
        // non-empty text, so it is a single neutral emoji. The buttons are one
        // ordered list: his channel, other channels, aljam3, archive.org, ketabonline.
        text: '📚',
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const chatId = cb.message ? cb.message.chat.id : cb.from.id;
    const settings2 = await getSettings(env);
    if (data !== 'recheck' && cb.message && cb.message.chat && cb.message.chat.type === 'private'
        && !isOwner(env, cb.from.id) && !(await isAdmin(env, settings2, cb.from.id))) {
      const missingCb = await checkForced(env, cb.from.id);
      if (missingCb.length) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'اشترك في القنوات المطلوبة أولًا', show_alert: true });
        return sendForced(env, chatId, missingCb);
      }
    }
    if (data === 'help') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'ℹ️ طريقة الاستخدام:\n\n1. أرسل اسم الكتاب أو المؤلف في المحادثة مباشرة.\n2. اختر النتيجة المناسبة ليصلك الملف فورًا.\n3. أو افتح صفحة البحث لتصفية النتائج حسب النوع (PDF، EPUB، Word، صوتي) والحجم.\n4. يمكنك أيضًا إعادة توجيه أي ملف إلى البوت ليُضاف إلى المكتبة.',
      });
      return;
    }
    if (data === 'latest') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      const { items } = await searchFiles(env, '', 'all', 0, parseInt(settings2.per_page, 10) || 10);
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'لا توجد إضافات بعد. المكتبة قيد الفهرسة.' });
        return;
      }
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id, style: 'primary', icon_custom_emoji_id: ICON.book }];
        return [{ text: label, url: f.link, style: 'primary', icon_custom_emoji_id: ICON.book }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: '📚 أحدث الإضافات:', reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (data === 'favs') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      let items = [];
      try {
        const rows = await env.DB.prepare(
          'SELECT f.* FROM favorites v JOIN files f ON f.id = v.file_id WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 10'
        ).bind(cb.from.id).all();
        items = rows.results || [];
      } catch (e) { snapNote(); }
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'مفضلتك فارغة. أضف كتبًا إليها من صفحة البحث بالضغط على ☆.' });
        return;
      }
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id, style: 'primary', icon_custom_emoji_id: ICON.book }];
        return [{ text: label, url: f.link, style: 'primary', icon_custom_emoji_id: ICON.book }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: '⭐ المفضلة:', reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (data.startsWith('bc_go:') || data.startsWith('bc_no:')) {
      const bid = parseInt(data.split(':')[1], 10);
      if (!(await isAdmin(env, settings2, cb.from.id))) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'للمشرف فقط', show_alert: true });
        return;
      }
      if (data.startsWith('bc_no:')) {
        await env.DB.prepare("UPDATE broadcasts SET status = 'canceled' WHERE id = ?").bind(bid).run();
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'أُلغي الإرسال' });
        return;
      }
      await env.DB.prepare("UPDATE broadcasts SET status = 'pending', cursor = 0 WHERE id = ? AND status = 'draft'").bind(bid).run();
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '📣 بدأ الإرسال... ستصلك النتيجة هنا' });
      await runBroadcastChunk(env, bid);
      return;
    }
    if (data === 'recheck') {
      const missing = await checkForced(env, cb.from.id, true);
      if (missing.length) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'ما زلت غير مشترك في كل القنوات', show_alert: true });
      } else {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '✅ تم التحقق، يمكنك الاستخدام الآن' });
        await sendWelcome(env, settings2, chatId);
      }
      return;
    }
    if (data.startsWith('more:')) {
      const off = parseInt(data.slice(5), 10) || 0;
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      let last = null;
      try {
        last = await env.DB.prepare(
          'SELECT q FROM searches WHERE user_id = ? AND results > 0 ORDER BY id DESC LIMIT 1'
        ).bind(cb.from.id).first();
      } catch (e) { snapNote(); }
      if (!last || !last.q) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'أرسل كلمة البحث من جديد لمتابعة النتائج.' });
        return;
      }
      const perPage3 = 20;
      const audioAsked3 = /(صوتي|صوت|مسموع|تلاوه|تلاوة|استماع|استمع|mp3|audio)/i.test(last.q);
      const { items, hasMore } = await searchFiles(env, last.q, 'all', off, perPage3, audioAsked3);
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'انتهت النتائج ✅' });
        return;
      }
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id, style: 'primary', icon_custom_emoji_id: ICON.book }];
        return [{ text: label, url: f.link, style: 'primary', icon_custom_emoji_id: ICON.book }];
      });
      if (hasMore) keyboard.push([{ text: '⬇️ عرض المزيد', callback_data: 'more:' + (off + items.length), style: 'primary', icon_custom_emoji_id: ICON.dl }]);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `🔍 «${last.q}» — نتائج ${off + 1} إلى ${off + items.length}:`,
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }
    if (data.startsWith('sq:')) {
      const id = parseInt(data.slice(3), 10);
      const f = await getFileById(env, id);
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      if (!f) return;
      const q2 = f.title.split(/\s+/).slice(0, 5).join(' ');
      const perPage2 = parseInt(settings2.per_page, 10) || 10;
      const { items } = await searchFiles(env, q2, 'all', 0, perPage2);
      defer(ctx2, logSearch(env, cb.from.id, q2, items.length));
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: `🔍 لم أجد نتائج مطابقة لـ«${q2}».\nجرّب اسمًا أقصر أو جزءًا من اسم الكتاب أو المؤلف.` });
        return;
      }
      const keyboard = items.map(f2 => {
        const label = `📕 ${(f2.file_name || f2.title).slice(0, 40)} (${isAudioExt(f2.ext) ? 'صوتي' : (f2.ext || '').toUpperCase()} ${fmtSize(f2.size_bytes)})`;
        if (f2.file_id || f2.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f2.id }];
        return [{ text: label, url: f2.link }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: `🔍 نتائج «${q2}»:`, reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (data.startsWith('dl:')) {
      const id = parseInt(data.slice(3), 10);
      const file = await getFileById(env, id);
      if (!file) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'الملف لم يعد متاحًا', show_alert: true });
        return;
      }
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '📤 جارٍ إرسال الملف...' });
      return deliverFile(env, settings, chatId, file);
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  }
}

async function sendForced(env, chatId, missing) {
  const buttons = missing.map(u => [{ text: `📢 اشترك: @${u}`, url: `https://t.me/${u}`, style: 'primary', icon_custom_emoji_id: ICON.mega }]);
  buttons.push([{ text: '✅ اشتركت، تحقق', callback_data: 'recheck', style: 'success' }]);
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: '⚠️ لاستخدام المكتبة، اشترك في القنوات التالية ثم اضغط «اشتركت، تحقق»:',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendWelcome(env, settings, chatId) {
  const text =
    `بسم الله الرحمن الرحيم\n\n` +
    `أهلًا بك في المكتبة الإسلامية الشاملة 📚\n\n` +
    `ابحث عن أي كتاب أو ملف باسمه، وسأحضره لك فورًا من المكتبة.\n\n` +
    `أرسل اسم الكتاب مباشرة في المحادثة، أو افتح صفحة البحث لتصفية النتائج حسب النوع والحجم.`;
  const lastRow = [];
  if (env.MAIN_CHANNEL) lastRow.push({ text: '📢 القناة الرئيسية', url: 'https://t.me/' + env.MAIN_CHANNEL, style: 'primary', icon_custom_emoji_id: ICON.mega });
  lastRow.push({ text: 'ℹ️ طريقة الاستخدام', callback_data: 'help', style: 'primary', icon_custom_emoji_id: ICON.info });
  const keyboard = [
    [{ text: '🔍 فتح صفحة البحث', web_app: { url: miniUrl(env) }, style: 'success', icon_custom_emoji_id: ICON.search }],
    [
      { text: '🆕 أحدث الإضافات', callback_data: 'latest', style: 'primary', icon_custom_emoji_id: ICON.book },
      { text: '⭐ المفضلة', callback_data: 'favs', style: 'primary', icon_custom_emoji_id: ICON.star },
    ],
    lastRow,
  ];
  await tg(env, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } });
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function extractAuthor(title, caption) {
  const src = caption || title || '';
  const m = /(?:تأليف|للإمام|للشيخ|لـ)\s*[:\-]?\s*([^\n\-–—]{2,60})/.exec(src);
  return m ? m[1].trim() : '';
}

async function upsertFile(env, f) {
  const r = await env.DB.prepare(
    `INSERT INTO files(title, title_norm, file_name, author, author_norm, ext, size_bytes, channel, message_id, link, file_id, delivery)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(channel, message_id, title_norm) DO UPDATE SET
       file_id = CASE WHEN excluded.file_id != '' THEN excluded.file_id ELSE files.file_id END,
       file_name = CASE WHEN excluded.file_name != '' THEN excluded.file_name ELSE files.file_name END,
       size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE files.size_bytes END,
       delivery = CASE WHEN excluded.delivery = 'link' THEN files.delivery ELSE excluded.delivery END`
  ).bind(
    f.title, norm(f.title), String(f.file_name || '').slice(0, 500), f.author || '', norm(f.author || ''), f.ext || '',
    f.size_bytes || 0, f.channel || '', f.message_id || 0, f.link || '', f.file_id || '',
    f.delivery || 'link'
  ).run();
  return r;
}

// ---------- bot membership re-check ----------
async function recheckMemberships(env) {
  const botId = (env.BOT_TOKEN || '').split(':')[0];
  if (!botId) return;
  const rows = await env.DB.prepare('SELECT username, bot_member FROM channels WHERE active = 1').all();
  for (const ch of rows.results || []) {
    try {
      const r = await tg(env, 'getChatMember', { chat_id: '@' + ch.username, user_id: Number(botId) });
      const st = r && r.ok && r.result && r.result.status;
      const member = (st === 'administrator' || st === 'creator' || st === 'member') ? 1 : 0;
      await env.DB.prepare('UPDATE channels SET bot_member = ? WHERE username = ?').bind(member, ch.username).run();
      // repair delivery rows every sweep (new ingests may carry a stale flag)
      if (member) {
        await env.DB.prepare("UPDATE files SET delivery = 'copy' WHERE channel = ? AND delivery = 'link' AND file_id = ''").bind(ch.username).run();
      } else {
        await env.DB.prepare("UPDATE files SET delivery = 'link' WHERE channel = ? AND delivery = 'copy' AND file_id = ''").bind(ch.username).run();
      }
    } catch (e) {}
  }
}

// ---------- broadcast sender ----------
async function sendBroadcastTo(env, b, userId) {
  if (b.kind === 'text') return tg(env, 'sendMessage', { chat_id: userId, text: b.text });
  const m = { photo: 'sendPhoto', document: 'sendDocument', audio: 'sendAudio', video: 'sendVideo' }[b.kind];
  return tg(env, m, { chat_id: userId, [b.kind]: b.file_id, caption: b.text || undefined });
}

async function runBroadcastChunk(env, bid, maxPerRun = 700) {
  const b = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(bid).first();
  if (!b || !['pending', 'sending'].includes(b.status)) return;
  await env.DB.prepare("UPDATE broadcasts SET status = 'sending' WHERE id = ?").bind(bid).run();
  const rows = await env.DB.prepare(
    'SELECT user_id FROM users WHERE blocked = 0 AND user_id > ? ORDER BY user_id LIMIT ?'
  ).bind(b.cursor || 0, maxPerRun).all();
  const users = rows.results || [];
  let sent = 0, failed = 0, blocked = 0, lastId = b.cursor || 0;
  for (const u of users) {
    lastId = u.user_id;
    try {
      const r = await sendBroadcastTo(env, b, u.user_id);
      if (r && r.ok) sent++;
      else if (r && r.error_code === 403) {
        blocked++;
        await env.DB.prepare('UPDATE users SET blocked = 1 WHERE user_id = ?').bind(u.user_id).run();
      } else failed++;
    } catch (e) { failed++; }
    await new Promise(res => setTimeout(res, 45)); // ~22 msg/s, under Telegram limits
  }
  const done = users.length < maxPerRun;
  await env.DB.prepare(
    'UPDATE broadcasts SET cursor = ?, sent = sent + ?, failed = failed + ?, blocked = blocked + ?, status = ? WHERE id = ?'
  ).bind(lastId, sent, failed, blocked, done ? 'done' : 'sending', bid).run();
  if (done) {
    const b2 = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(bid).first();
    await tg(env, 'sendMessage', {
      chat_id: b.admin_id,
      text: `📣 اكتمل الإرسال:\n✅ أُرسل: ${b2.sent}\n❌ فشل: ${b2.failed}\n🚫 حظر البوت: ${b2.blocked}`,
    });
  }
}

// ---------- API ----------
function json(data, status = 200, cors = true) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(cors ? {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      } : {}),
    },
  });
}

async function apiUser(env, request, body) {
  let initData = '';
  if (request.method === 'GET') {
    initData = new URL(request.url).searchParams.get('init') || '';
  } else {
    initData = (body && body.init) || '';
  }
  return validateInitData(env, initData);
}

const ADMIN_DB_NOTICE = '⚠️ البيانات الحية غير متاحة مؤقتًا (الحد اليومي لقاعدة البيانات) — تُستأنف تلقائيًا. البحث وتحميل الكتب يعملان طبيعي.';
function dbDown() {
  return json({ error: 'db_unavailable', message: ADMIN_DB_NOTICE }, 503);
}

async function handleApi(env, request, path, ctx2) {
  const url = new URL(request.url);
  const settings = await getSettings(env);

  if (path === '/api/stats') {
    if (!snapOn) {
      try {
        const files = await env.DB.prepare('SELECT COUNT(*) AS c FROM files').first();
        const channels = await env.DB.prepare('SELECT COUNT(*) AS c FROM channels WHERE active = 1').first();
        return json({ files: files.c || 0, channels: channels.c || 0 });
      } catch (e) { snapNote(); }
    }
    const meta = await snapMeta();
    return json({ files: meta.files || 0, channels: meta.channels || 0, snapshot: true });
  }

  if (path === '/api/search' || path === '/api/latest') {
    const q = (url.searchParams.get('q') || '').slice(0, 120);
    const ext = url.searchParams.get('ext') || 'all';
    const off = parseInt(url.searchParams.get('off') || '0', 10) || 0;
    const perPage = parseInt(settings.per_page, 10) || 10;
    // Local channels and external libraries searched together, in parallel.
    const audioOnly = ext === 'audio';
    const [sr, aj2, ext2, kb2] = await Promise.all([
      searchFiles(env, q, ext, off, perPage),
      q && !audioOnly ? ajSearch(env, q, 3).catch(() => []) : Promise.resolve([]),
      q && !audioOnly ? iaSearch(env, q, 3).catch(() => []) : Promise.resolve([]),
      q && !audioOnly ? kbSearch(env, q, 3).catch(() => []) : Promise.resolve([]),
    ]);
    const { items, hasMore } = sr;
    const local = polishLocal(items, env.MAIN_CHANNEL);
    if (q) {
      const u = await apiUser(env, request).catch(() => null);
      defer(ctx2, logSearch(env, u && u.id ? u.id : 0, q, local.length));
    }
    const counts = q ? await countExt(env, q) : null;
    let suggestions = null;
    if (q && !local.length) { try { suggestions = await suggestTitles(env, q, 3); } catch (e) {} }
    const cap = local.length ? 2 : 3;
    const external = (aj2 || []).slice(0, cap).map(a2 => ({ title: a2.title, url: a2.url, src: 'aj', kind: a2.kind || '', sizeMb: a2.sizeMb || 0 }))
      .concat((ext2 || []).slice(0, cap).map(e2 => ({ title: e2.title, url: e2.url, src: 'ia', kind: e2.kind || '', sizeMb: e2.sizeMb || 0 })))
      .concat((kb2 || []).slice(0, cap).map(k2 => ({ title: k2.title, url: k2.pdf || k2.url, src: 'kb', kind: k2.kind || '', sizeMb: k2.pdfSize || 0 })));
    return json({ items: local.map(publicFile), hasMore, counts, suggestions, external });
  }

  if (path === '/api/me') {
    const user = await apiUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    try { await trackUser(env, user); } catch (e) { snapNote(); }
    let admin = false;
    try { admin = await isAdmin(env, settings, user.id); } catch (e) { snapNote(); }
    return json({ user_id: user.id, is_admin: admin, is_owner: isOwner(env, user.id) });
  }

  if (path === '/api/fav' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const user = await apiUser(env, request, body);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const fid = parseInt(body.file_id, 10);
    if (!fid) return json({ error: 'bad file_id' }, 400);
    try {
      if (body.on) {
        await env.DB.prepare('INSERT OR IGNORE INTO favorites(user_id, file_id) VALUES(?,?)').bind(user.id, fid).run();
      } else {
        await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND file_id = ?').bind(user.id, fid).run();
      }
      return json({ ok: true });
    } catch (e) { snapNote(); return dbDown(); }
  }

  if (path === '/api/favs') {
    const user = await apiUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    try {
      const rows = await env.DB.prepare(
        `SELECT f.* FROM favorites v JOIN files f ON f.id = v.file_id
         WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 50`
      ).bind(user.id).all();
      return json({ items: (rows.results || []).map(publicFile) });
    } catch (e) { snapNote(); return json({ items: [] }); }
  }

  // ---- admin ----
  if (path.startsWith('/api/admin/')) {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const user = await apiUser(env, request, body);
    if (!user) return json({ error: 'unauthorized' }, 401);
    if (!(await isAdmin(env, settings, user.id))) return json({ error: 'forbidden' }, 403);

    if (path === '/api/admin/overview') {
      const now = Date.now();
      if (overviewCache.s && now - overviewCache.at < 60000) return json(overviewCache.s);
      const overviewFallback = async () => {
        // D1 down: answer from the snapshot + gate fallback chain, flag it.
        let meta = {};
        try { meta = await snapMeta(); } catch (e2) {}
        let forcedNames = [];
        try { forcedNames = await forcedList(env); } catch (e2) {}
        return {
          files: meta.files || 0, users: 0, users_today: 0, active_today: 0,
          searches_total: 0, searches_today: 0, searches_no_result: 0,
          channels: [], forced: forcedNames.map(u => ({ username: u, active: 1 })),
          settings, db_down: true, notice: ADMIN_DB_NOTICE,
        };
      };
      if (snapOn && !snapMaybeProbe()) {
        const p = await overviewFallback();
        overviewCache = { at: now, s: p };
        return json(p);
      }
      try {
        // One parallel bounded batch: 9 sequential unbounded COUNTs used to
        // take seconds each on a slow or capped DB.
        const one = (sql) => withTimeout(env.DB.prepare(sql).first(), 1500);
        const [files, users, usersToday, activeToday, searchesTotal, searchesToday, noResult, chans, forced] = await Promise.all([
          one('SELECT COUNT(*) AS c FROM files'),
          one('SELECT COUNT(*) AS c FROM users'),
          one("SELECT COUNT(*) AS c FROM users WHERE first_seen >= unixepoch('now','start of day')"),
          one("SELECT COUNT(*) AS c FROM users WHERE last_seen >= unixepoch('now','start of day')"),
          one('SELECT COUNT(*) AS c FROM searches'),
          one("SELECT COUNT(*) AS c FROM searches WHERE created_at >= unixepoch('now','start of day')"),
          one('SELECT COUNT(*) AS c FROM searches WHERE results = 0'),
          withTimeout(env.DB.prepare('SELECT * FROM channels ORDER BY added_at DESC').all(), 1500),
          withTimeout(env.DB.prepare('SELECT * FROM forced_channels ORDER BY username').all(), 1500),
        ]);
        const p = {
          files: files.c || 0, users: users.c || 0,
          users_today: usersToday.c || 0, active_today: activeToday.c || 0,
          searches_total: searchesTotal.c || 0, searches_today: searchesToday.c || 0,
          searches_no_result: noResult.c || 0,
          channels: chans.results || [], forced: forced.results || [], settings,
        };
        snapRecovered();
        overviewCache = { at: now, s: p };
        return json(p);
      } catch (e) {
        snapNote();
        const p = await overviewFallback();
        overviewCache = { at: now, s: p };
        return json(p);
      }
    }

    if (path === '/api/admin/users') {
      if (snapOn && !snapMaybeProbe()) return json({ users: [], db_down: true, notice: ADMIN_DB_NOTICE });
      try {
        const rows = await env.DB.prepare(
          'SELECT user_id, first_name, username, is_admin, blocked, first_seen, last_seen FROM users ORDER BY last_seen DESC LIMIT 100'
        ).all();
        return json({ users: rows.results || [] });
      } catch (e) { snapNote(); return json({ users: [], db_down: true, notice: ADMIN_DB_NOTICE }); }
    }

    if (path === '/api/admin/searches') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 300);
      if (snapOn && !snapMaybeProbe()) return json({ searches: [], db_down: true, notice: ADMIN_DB_NOTICE });
      try {
        const rows = await env.DB.prepare(
          'SELECT user_id, q, results, created_at FROM searches ORDER BY id DESC LIMIT ?'
        ).bind(limit).all();
        return json({ searches: rows.results || [] });
      } catch (e) { snapNote(); return json({ searches: [], db_down: true, notice: ADMIN_DB_NOTICE }); }
    }

    if (path === '/api/admin/channel' && request.method === 'POST') {
      const uname = String(body.username || '').replace(/^@/, '').replace(/^https:\/\/t\.me\//, '').split('/')[0].toLowerCase().trim();
      if (!/^[a-z0-9_]{3,32}$/.test(uname)) return json({ error: 'bad username' }, 400);
      try {
        if (body.action === 'remove') {
          await env.DB.prepare('DELETE FROM channels WHERE username = ?').bind(uname).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO channels(username, bot_member) VALUES(?, ?)
             ON CONFLICT(username) DO UPDATE SET active = 1, bot_member = MAX(channels.bot_member, excluded.bot_member)`
          ).bind(uname, body.bot_member ? 1 : 0).run();
        }
        return json({ ok: true });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/channel-toggle' && request.method === 'POST') {
      try {
        await env.DB.prepare('UPDATE channels SET active = ? WHERE username = ?')
          .bind(body.active ? 1 : 0, String(body.username || '').toLowerCase()).run();
        return json({ ok: true });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/forced' && request.method === 'POST') {
      forcedCache.at = 0;
      const uname = String(body.username || '').replace(/^@/, '').toLowerCase().trim();
      if (!uname) return json({ error: 'bad username' }, 400);
      try {
        if (body.action === 'remove') {
          await env.DB.prepare('DELETE FROM forced_channels WHERE username = ?').bind(uname).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO forced_channels(username, active) VALUES(?, 1) ON CONFLICT(username) DO UPDATE SET active = 1'
          ).bind(uname).run();
        }
        return json({ ok: true });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/forced-toggle' && request.method === 'POST') {
      forcedCache.at = 0;
      try {
        await env.DB.prepare('UPDATE forced_channels SET active = ? WHERE username = ?')
          .bind(body.active ? 1 : 0, String(body.username || '').toLowerCase()).run();
        return json({ ok: true });
      } catch (e) { snapNote(); return dbDown(); }
    }

    // ---- owner only: manage admins ----
    if (path === '/api/admin/admins') {
      if (!isOwner(env, user.id)) return json({ error: 'owner only' }, 403);
      if (snapOn && !snapMaybeProbe()) return json({ admins: [], owner_id: env.OWNER_ID || '', db_down: true, notice: ADMIN_DB_NOTICE });
      try {
        const rows = await env.DB.prepare(
          "SELECT user_id, first_name, username, first_seen FROM users WHERE is_admin = 1 ORDER BY first_seen"
        ).all();
        return json({ admins: rows.results || [], owner_id: env.OWNER_ID || '' });
      } catch (e) { snapNote(); return json({ admins: [], owner_id: env.OWNER_ID || '', db_down: true, notice: ADMIN_DB_NOTICE }); }
    }

    if (path === '/api/admin/admin' && request.method === 'POST') {
      if (!isOwner(env, user.id)) return json({ error: 'owner only' }, 403);
      const who = String(body.user || '').trim();
      if (!who) return json({ error: 'missing user' }, 400);
      let target = null;
      try {
      if (/^\d{5,15}$/.test(who)) {
        target = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(parseInt(who, 10)).first();
        if (!target && body.action === 'add') {
          await env.DB.prepare('INSERT OR IGNORE INTO users(user_id) VALUES(?)').bind(parseInt(who, 10)).run();
          target = { user_id: parseInt(who, 10) };
        }
      } else {
        const uname = who.replace(/^@/, '').toLowerCase();
        target = await env.DB.prepare('SELECT * FROM users WHERE lower(username) = ?').bind(uname).first();
      }
      } catch (e) { snapNote(); return dbDown(); }
      if (!target) return json({ error: 'user_not_found', message: 'لم يبدأ هذا المستخدم البوت بعد. اطلب منه فتح البوت وإرسال /start أولًا.' }, 404);
      if (String(target.user_id) === String(env.OWNER_ID)) return json({ error: 'cannot_change_owner' }, 400);
      try {
        await env.DB.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?')
          .bind(body.action === 'remove' ? 0 : 1, target.user_id).run();
        return json({ ok: true, user_id: target.user_id });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/settings' && request.method === 'POST') {
      const allowed = ['welcome_on', 'per_page', 'protect_content', 'notify_new'];
      try {
        for (const k of allowed) {
          if (body[k] !== undefined) await setSetting(env, k, String(body[k]));
        }
        return json({ ok: true });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/broadcast' && request.method === 'POST') {
      if (body.action === 'preview') {
        try {
          const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE blocked = 0').first();
          return json({ ok: true, users: c.c || 0 });
        } catch (e) { snapNote(); return dbDown(); }
      }
      const txt = String(body.text || '').trim();
      if (!txt) return json({ error: 'empty text' }, 400);
      if (body.test) {
        const tr = await tg(env, 'sendMessage', { chat_id: Number(env.OWNER_ID), text: txt });
        return json({ ok: true, test: true, delivered: Boolean(tr && tr.ok !== false && (tr.message_id || (tr.result && tr.result.message_id))) });
      }
      try {
        const r = await env.DB.prepare(
          "INSERT INTO broadcasts(admin_id, kind, text, status) VALUES(?, 'text', ?, 'pending')"
        ).bind(user.id, txt).run();
        return json({ ok: true, id: r.meta.last_row_id });
      } catch (e) { snapNote(); return dbDown(); }
    }

    if (path === '/api/admin/broadcasts') {
      if (snapOn && !snapMaybeProbe()) return json({ broadcasts: [], db_down: true, notice: ADMIN_DB_NOTICE });
      try {
        const rows = await env.DB.prepare(
          'SELECT id, kind, text, status, sent, failed, blocked, created_at FROM broadcasts ORDER BY id DESC LIMIT 10'
        ).all();
        return json({ broadcasts: rows.results || [] });
      } catch (e) { snapNote(); return json({ broadcasts: [], db_down: true, notice: ADMIN_DB_NOTICE }); }
    }

    return json({ error: 'not found' }, 404);
  }

  return json({ error: 'not found' }, 404);
}

function publicFile(f) {
  return {
    id: f.id, title: f.title, file_name: f.file_name || f.title, author: f.author, ext: f.ext, is_audio: isAudioExt(f.ext),
    size_bytes: f.size_bytes, size: fmtSize(f.size_bytes),
    channel: f.channel, link: f.link,
    deliverable: Boolean(f.file_id) || f.delivery === 'copy',
    bot: null,
  };
}

// ---------- crawler ingest ----------
async function handleIngest(env, request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== 'Bearer ' + env.INGEST_SECRET) return json({ error: 'unauthorized' }, 401, false);
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/ingest/export-jobs') {
    const rows = await env.DB.prepare("SELECT id, url, channel FROM export_jobs WHERE status = 'pending' ORDER BY id LIMIT 5").all();
    return json({ jobs: rows.results || [] }, 200, false);
  }
  if (request.method === 'POST' && url.pathname === '/ingest/export-jobs/done') {
    const b2 = await request.json().catch(() => ({}));
    await env.DB.prepare('UPDATE export_jobs SET status = ?, note = ?, done_at = datetime(\'now\') WHERE id = ?')
      .bind(String(b2.status || 'done'), String(b2.note || '').slice(0, 300), Number(b2.id) || 0).run();
    return json({ ok: true }, 200, false);
  }

  if (request.method === 'GET' && url.pathname === '/ingest/sources') {
    const rows = await env.DB.prepare(
      'SELECT username, last_message_id, bot_member, backfill_cursor FROM channels WHERE active = 1 ORDER BY username'
    ).all();
    return json({ channels: rows.results || [] }, 200, false);
  }

  if (request.method !== 'POST') return json({ error: 'method' }, 405, false);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'bad body' }, 400, false);
  const channel = String(body.channel || '').toLowerCase();
  let added = 0;
  for (const it of body.items.slice(0, 500)) {
    const title = String(it.title || '').slice(0, 300);
    if (!title || !it.message_id) continue;
    const delivery = it.file_id ? 'copy' : (body.bot_member ? 'copy' : 'link');
    const r = await upsertFile(env, {
      title, file_name: String(it.file_name || '').slice(0, 500), author: String(it.author || '').slice(0, 200),
      ext: String(it.ext || '').toLowerCase(), size_bytes: Number(it.size_bytes) || 0,
      channel, message_id: Number(it.message_id),
      link: `https://t.me/${channel}/${it.message_id}`,
      file_id: String(it.file_id || ''), delivery,
    });
    if (r && r.meta && r.meta.changes > 0) added++;
  }
  if (channel && body.backfill_cursor) {
    await env.DB.prepare('UPDATE channels SET backfill_cursor = CASE WHEN backfill_cursor = 0 THEN ? ELSE MIN(backfill_cursor, ?) END WHERE username = ?')
      .bind(Number(body.backfill_cursor), Number(body.backfill_cursor), channel).run();
  }
  if (channel && body.last_message_id) {
    await env.DB.prepare(
      'UPDATE channels SET last_message_id = MAX(last_message_id, ?) WHERE username = ?'
    ).bind(Number(body.last_message_id), channel).run();
  }
  if (channel && added > 0) {
    await env.DB.prepare('UPDATE channels SET file_count = file_count + ? WHERE username = ?').bind(added, channel).run();
  }
  return json({ ok: true, added }, 200, false);
}

// ---------- router ----------
export default {
  async scheduled(event, env, ctx) {
    try {
      await migrate(env);
      if (!snapOn) {
        const rows = await withTimeout(env.DB.prepare(
          "SELECT id FROM broadcasts WHERE status IN ('pending','sending') ORDER BY id LIMIT 3"
        ).all(), 3000);
        for (const r of rows.results || []) ctx.waitUntil(runBroadcastChunk(env, r.id));
        if (new Date().getUTCMinutes() % 30 === 0) ctx.waitUntil(recheckMemberships(env));
      }
    } catch (e) { snapNote(); console.error('scheduled failed:', (e && e.stack) || e); }
  },

  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      return json({ error: 'internal', detail: String((e && e.stack) || e).slice(0, 400) }, 500);
    }
  },
};

async function handleFetch(request, env, ctx) {
    if (env.SNAPSHOT_BASE) SNAP_BASE = env.SNAPSHOT_BASE;
    // Migrate off the reply path: never block a webhook ack or an API answer on DDL.
    defer(ctx, migrate(env).then(() => {}, (e) => { snapNote(); }));
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return json({ ok: true }, 200);

    if (path === '/health') return json({ ok: true, service: 'islamic-library' }, 200, false);

    if (path === `/tg/${env.WEBHOOK_SECRET}` && request.method === 'POST') {
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update, ctx).catch(e => console.error('handleUpdate failed:', (e && e.stack) || e)));
      return json({ ok: true }, 200, false);
    }

    if (path.startsWith('/ingest')) return handleIngest(env, request);

    if (path.startsWith('/api/')) return handleApi(env, request, path, ctx);

    return json({ error: 'not found' }, 404, false);
}
