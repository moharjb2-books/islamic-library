// ============================================================================
// المكتبة الإسلامية الشاملة — Telegram book-search bot
// Cloudflare Worker: webhook + Mini App API + crawler ingest, D1 storage.
// Bindings: DB (D1). Secrets: BOT_TOKEN, INGEST_SECRET, WEBHOOK_SECRET,
// ADMIN_SETUP_CODE. Vars: MINIAPP_URL, BOT_USERNAME, MAIN_CHANNEL.
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
  for (const stmt of SCHEMA) await env.DB.prepare(stmt).run();
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0').run(); } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE files ADD COLUMN file_name TEXT DEFAULT ''").run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE channels ADD COLUMN backfill_cursor INTEGER DEFAULT 0').run(); } catch (e) {}
  try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS export_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, channel TEXT NOT NULL, status TEXT DEFAULT 'pending', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), done_at TEXT DEFAULT '')").run(); } catch (e) {}
  migrated = true;
  try { await reindexNormV2(env); } catch (e) { migrated = false; }
}

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
async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of rows.results || []) s[r.key] = r.value;
  return s;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, String(value)).run();
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
  const row = await env.DB.prepare('SELECT is_admin FROM users WHERE user_id = ?').bind(userId).first();
  if (row && row.is_admin) return true;
  const ids = (settings.admin_ids || '').split(',').map(x => x.trim()).filter(Boolean);
  return ids.includes(String(userId));
}

async function trackUser(env, from) {
  if (!from || !from.id) return;
  await env.DB.prepare(
    `INSERT INTO users(user_id, first_name, username, last_seen) VALUES(?,?,?,unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=unixepoch()`
  ).bind(from.id, from.first_name || '', from.username || '').run();
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

async function searchFiles(env, q, ext, offset, limit, includeAudio) {
  const nq = norm(q);
  let where = '1=1';
  const binds = [];
  if (nq) {
    where += ' AND (title_norm LIKE ? OR author_norm LIKE ?)';
    binds.push(`%${nq}%`, `%${nq}%`);
  }
  if (ext && ext !== 'all') {
    if (ext === 'audio') { where += ` AND ext IN ${AUDIO_EXTS}`; }
    else { where += ' AND ext = ?'; binds.push(ext.toLowerCase()); }
  } else if (!includeAudio) {
    where += ` AND ext NOT IN ${AUDIO_EXTS}`;
  }
  binds.push(limit + 1, offset);
  const rows = await env.DB.prepare(
    `SELECT * FROM files WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...binds).all();
  const items = rows.results || [];
  const hasMore = items.length > limit;
  return { items: items.slice(0, limit), hasMore };
}

async function countExt(env, q) {
  const nq = norm(q);
  let where = '1=1';
  const binds = [];
  if (nq) { where += ' AND (title_norm LIKE ? OR author_norm LIKE ?)'; binds.push(`%${nq}%`, `%${nq}%`); }
  const rows = await env.DB.prepare(
    `SELECT CASE WHEN ext IN ${AUDIO_EXTS} THEN 'audio' ELSE ext END AS k, COUNT(*) AS c
     FROM files WHERE ${where} GROUP BY k`
  ).bind(...binds).all();
  const out = {};
  let total = 0;
  for (const r of rows.results || []) { out[r.k || 'other'] = r.c; total += r.c; }
  out.all = total - (out.audio || 0);
  return out;
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

async function suggestTitles(env, q, limit = 3) {
  const nq = norm(q);
  if (!nq || nq.length < 3 || nq.length > 80) return [];
  const rows = await env.DB.prepare(
    'SELECT id, title, title_norm, file_name FROM files ORDER BY id DESC LIMIT 2500'
  ).all();
  const qwords = [...new Set(nq.split(/\s+/).filter(x => x.length >= 2))].slice(0, 6);
  if (!qwords.length) return [];
  // prefilter on the longest (rarest) query word only, then cap scored candidates
  const mainW = qwords.slice().sort((a, b) => b.length - a.length)[0];
  const scored = [];
  for (const r of rows.results || []) {
    if (scored.length > 0 && scored.length >= 400) break;
    const hay = (r.title_norm || '') + ' ' + norm(r.file_name || '');
    const ctoks = hay.split(/[\s_\-–—.,()]+/).filter(t => t.length >= 2);
    const hit = ctoks.some(t => t.includes(mainW) || mainW.includes(t) || (mainW.length >= 4 && t.length >= 4 && t.slice(0, 4) === mainW.slice(0, 4)));
    if (!hit) continue;
    const sc = Math.min(tokenScore(nq, r.title_norm || r.title), tokenScore(nq, norm(r.file_name || '')));
    if (sc <= 1.0) scored.push({ id: r.id, title: r.title, sc });
  }
  scored.sort((a, b) => a.sc - b.sc);
  const seen = new Set();
  const out = [];
  for (const t of scored) {
    const k = norm(t.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: t.id, title: prettyTitle(t.title) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- Telegram Desktop export ingest (owner only) ----------
function exportText(t) {
  if (!t) return '';
  if (typeof t === 'string') return t.trim();
  if (Array.isArray(t)) return t.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join('').trim();
  return '';
}

function exportSize(m2) {
  let sz = Number(m2.file_size) || 0;
  if (!sz && typeof m2.file === 'string') {
    const sm = /\(([\d.,]+)\s*(B|KB|MB|GB)\)/i.exec(m2.file);
    if (sm) sz = Math.round(parseFloat(sm[1].replace(',', '.')) * ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824 })[sm[2].toUpperCase()]);
  }
  return sz || 0;
}

async function handleExportIngest(env, chatId, msg) {
  const caption = msg.caption || '';
  const mCap = /@([A-Za-z0-9_]{3,})/.exec(caption) || /t\.me\/([A-Za-z0-9_]{3,})/.exec(caption);
  const username = mCap ? mCap[1].toLowerCase() : '';
  if (!username) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: '📄 استلمت ملف التصدير، لكن أحتاج يوزر القناة.\nأعد إرسال الملف واكتب في التعليق يوزر القناة، مثل: @cr_wrr' });
    return;
  }
  const ch = await env.DB.prepare('SELECT username, bot_member FROM channels WHERE username = ?').bind(username).first();
  if (!ch) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ القناة @${username} غير مسجّلة في المكتبة.` });
    return;
  }
  const fsize = msg.document.file_size || 0;
  if (fsize > 19 * 1024 * 1024) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ الملف كبير (${fmtSize(fsize)}). الحد الأقصى للإرسال المباشر 19 MB.\n\nالبديل: ارفع الملف إلى Google Drive (مشاركة: أي شخص لديه الرابط) وأرسل الرابط هنا مع يوزر القناة، وسأفهرسه تلقائيًا.` });
    return;
  }
  const gf = await tg(env, 'getFile', { file_id: msg.document.file_id });
  if (!gf || !gf.file_path) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: '⚠️ تعذّر تنزيل الملف من تيليجرام. جرّب رفعه كرابط Drive بدلًا من ذلك.' });
    return;
  }
  const resp = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.file_path}`);
  const data = resp.ok ? await resp.json().catch(() => null) : null;
  if (!data || !Array.isArray(data.messages)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: '⚠️ هذا ليس ملف تصدير تيليجرام صالحًا (result.json).' });
    return;
  }
  const msgs = data.messages;
  let docs = 0;
  for (const m2 of msgs) {
    if (m2 && m2.type === 'message' && (m2.media_type === 'document' || m2.media_type === 'audio' || m2.media_type === 'voice' || m2.file_name)) docs++;
  }
  if (msgs.length > 60000) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ التصدير ضخم (${msgs.length.toLocaleString('en')} رسالة). الأفضل رفعه كرابط Drive وإرساله هنا مع يوزر القناة.` });
    return;
  }
  let added = 0;
  const batch = [];
  for (const m2 of msgs) {
    if (!m2 || m2.type !== 'message') continue;
    const fname = String(m2.file_name || '').slice(0, 500);
    const isDoc = m2.media_type === 'document' || m2.media_type === 'audio' || m2.media_type === 'voice' || fname;
    if (!isDoc) continue;
    const txt = exportText(m2.text);
    const title = (fname || txt || 'ملف').slice(0, 300);
    const ext0 = extOf(fname) || (m2.media_type === 'audio' || m2.media_type === 'voice' ? 'audio' : '');
    batch.push(env.DB.prepare(
      `INSERT INTO files(title, title_norm, file_name, author, author_norm, ext, size_bytes, channel, message_id, link, file_id, delivery)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(channel, message_id, title_norm) DO UPDATE SET
         file_name = CASE WHEN excluded.file_name != '' THEN excluded.file_name ELSE files.file_name END,
         size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE files.size_bytes END`
    ).bind(
      title, norm(title), fname, extractAuthor(txt, fname) || '', norm(extractAuthor(txt, fname) || ''), ext0,
      exportSize(m2), username, Number(m2.id) || 0, `https://t.me/${username}/${m2.id}`, '',
      ch.bot_member ? 'copy' : 'link'
    ));
    if (batch.length >= 90) {
      const res = await env.DB.batch(batch.splice(0));
      for (const r of res) if (r.meta && r.meta.changes > 0) added++;
    }
  }
  if (batch.length) {
    const res = await env.DB.batch(batch);
    for (const r of res) if (r.meta && r.meta.changes > 0) added++;
  }
  const maxId = msgs.reduce((a, m2) => Math.max(a, Number(m2 && m2.id) || 0), 0);
  if (maxId) await env.DB.prepare('UPDATE channels SET last_message_id = MAX(last_message_id, ?) WHERE username = ?').bind(maxId, username).run();
  const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM files WHERE channel = ?').bind(username).first();
  await env.DB.prepare('UPDATE channels SET file_count = ? WHERE username = ?').bind(c.c || 0, username).run();
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: `✅ تمت فهرسة ${added.toLocaleString('en')} ملفًا من @${username} (من أصل ${docs.toLocaleString('en')} مستند في التصدير).\n📦 التسليم: ${ch.bot_member ? 'إرسال مباشر (البوت مشرف)' : 'روابط'}.`,
  });
}

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

async function checkForced(env, userId) {
  const rows = await env.DB.prepare('SELECT username FROM forced_channels WHERE active = 1').all();
  const missing = [];
  for (const r of rows.results || []) {
    try {
      const m = await tg(env, 'getChatMember', { chat_id: '@' + r.username, user_id: userId });
      const st = m && m.ok && m.result ? m.result.status : 'left';
      if (['left', 'kicked'].includes(st)) missing.push(r.username);
    } catch (e) { missing.push(r.username); }
  }
  return missing;
}

// ---------- webhook ----------
async function handleUpdate(env, update) {
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
    await trackUser(env, from);

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

    const text = (msg.text || '').trim();

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
        const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
        if (file) {
          const missing = await checkForced(env, from.id);
          if (missing.length) return sendForced(env, chatId, missing);
          return deliverFile(env, settings, chatId, file);
        }
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
          reply_markup: { inline_keyboard: [[{ text: 'فتح لوحة التحكم', web_app: { url: env.MINIAPP_URL + '?admin=1' } }]] },
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
      const { items, hasMore } = await searchFiles(env, text, 'all', 0, perPage, audioAsked);
      await logSearch(env, from.id, text, items.length);
      if (!items.length) {
        let sug = [];
        try { sug = await suggestTitles(env, text, 3); } catch (e) {}
        const kb = sug.map(g => [{ text: `🔎 ${g.title.slice(0, 45)}`, callback_data: 'sq:' + g.id }]);
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: `🔍 لم أجد نتائج مطابقة لـ«${text}».` + (sug.length ? '\n\nهل تقصد:' : '\nجرّب اسمًا أقصر أو جزءًا من اسم الكتاب أو المؤلف.'),
          reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
        });
        return;
      }
      const missing = await checkForced(env, from.id);
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') {
          return [{ text: label, callback_data: 'dl:' + f.id }];
        }
        return [{ text: label, url: f.link }];
      });
      if (hasMore) keyboard.push([{ text: 'عرض المزيد ⬇', callback_data: 'more:' + items.length }]);
      keyboard.push([{ text: '🔍 تصفية النتائج في صفحة البحث', web_app: { url: env.MINIAPP_URL } }]);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `🔍 نتائج البحث عن «${text}»${hasMore ? ' — الصفحة الأولى من ' + items.length : ' — ' + items.length}:`,
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
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id }];
        return [{ text: label, url: f.link }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: '📚 أحدث الإضافات:', reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (data === 'favs') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      const rows = await env.DB.prepare(
        'SELECT f.* FROM favorites v JOIN files f ON f.id = v.file_id WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 10'
      ).bind(cb.from.id).all();
      const items = rows.results || [];
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'مفضلتك فارغة. أضف كتبًا إليها من صفحة البحث بالضغط على ☆.' });
        return;
      }
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id }];
        return [{ text: label, url: f.link }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: '☆ المفضلة:', reply_markup: { inline_keyboard: keyboard } });
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
      const missing = await checkForced(env, cb.from.id);
      if (missing.length) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'ما زلت غير مشترك في كل القنوات', show_alert: true });
      } else {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '✅ تم التحقق، يمكنك الاستخدام الآن' });
        await tg(env, 'sendMessage', { chat_id: chatId, text: '✅ تم التحقق من اشتراكك. أرسل اسم الكتاب للبحث.' });
      }
      return;
    }
    if (data.startsWith('more:')) {
      const off = parseInt(data.slice(5), 10) || 0;
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      const last = await env.DB.prepare(
        'SELECT q FROM searches WHERE user_id = ? AND results > 0 ORDER BY id DESC LIMIT 1'
      ).bind(cb.from.id).first();
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
      const missing = await checkForced(env, cb.from.id);
      if (missing.length) return sendForced(env, chatId, missing);
      const keyboard = items.map(f => {
        const label = `📕 ${(f.file_name || f.title).slice(0, 40)} (${isAudioExt(f.ext) ? 'صوتي' : (f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id }];
        return [{ text: label, url: f.link }];
      });
      if (hasMore) keyboard.push([{ text: 'عرض المزيد ⬇', callback_data: 'more:' + (off + items.length) }]);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `🔍 «${last.q}» — نتائج ${off + 1} إلى ${off + items.length}:`,
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }
    if (data.startsWith('sq:')) {
      const id = parseInt(data.slice(3), 10);
      const f = await env.DB.prepare('SELECT title FROM files WHERE id = ?').bind(id).first();
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      if (!f) return;
      const q2 = f.title.split(/\s+/).slice(0, 5).join(' ');
      const perPage2 = parseInt(settings2.per_page, 10) || 10;
      const { items } = await searchFiles(env, q2, 'all', 0, perPage2);
      await logSearch(env, cb.from.id, q2, items.length);
      if (!items.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: `🔍 لم أجد نتائج مطابقة لـ«${q2}».` });
        return;
      }
      const missing = await checkForced(env, cb.from.id);
      const keyboard = items.map(f2 => {
        const label = `📕 ${(f2.file_name || f2.title).slice(0, 40)} (${isAudioExt(f2.ext) ? 'صوتي' : (f2.ext || '').toUpperCase()} ${fmtSize(f2.size_bytes)})`;
        if (f2.file_id || f2.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f2.id }];
        return [{ text: label, url: f2.link }];
      });
      if (missing.length) return sendForced(env, chatId, missing);
      await tg(env, 'sendMessage', { chat_id: chatId, text: `🔍 نتائج «${q2}»:`, reply_markup: { inline_keyboard: keyboard } });
      return;
    }
    if (data.startsWith('dl:')) {
      const id = parseInt(data.slice(3), 10);
      const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
      if (!file) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'الملف لم يعد متاحًا', show_alert: true });
        return;
      }
      const missing = await checkForced(env, cb.from.id);
      if (missing.length) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'اشترك في القنوات المطلوبة أولًا', show_alert: true });
        return sendForced(env, chatId, missing);
      }
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '📤 جارٍ إرسال الملف...' });
      return deliverFile(env, settings, chatId, file);
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  }
}

async function sendForced(env, chatId, missing) {
  const buttons = missing.map(u => [{ text: `📢 اشترك: @${u}`, url: `https://t.me/${u}` }]);
  buttons.push([{ text: '✅ اشتركت، تحقق', callback_data: 'recheck' }]);
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
  if (env.MAIN_CHANNEL) lastRow.push({ text: '📢 القناة الرئيسية', url: 'https://t.me/' + env.MAIN_CHANNEL });
  lastRow.push({ text: 'ℹ️ طريقة الاستخدام', callback_data: 'help' });
  const keyboard = [
    [{ text: '🔍 فتح صفحة البحث', web_app: { url: env.MINIAPP_URL } }],
    [
      { text: '📚 أحدث الإضافات', callback_data: 'latest' },
      { text: '☆ المفضلة', callback_data: 'favs' },
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

async function handleApi(env, request, path) {
  const url = new URL(request.url);
  const settings = await getSettings(env);

  if (path === '/api/stats') {
    const files = await env.DB.prepare('SELECT COUNT(*) AS c FROM files').first();
    const channels = await env.DB.prepare('SELECT COUNT(*) AS c FROM channels WHERE active = 1').first();
    return json({ files: files.c || 0, channels: channels.c || 0 });
  }

  if (path === '/api/search' || path === '/api/latest') {
    const q = (url.searchParams.get('q') || '').slice(0, 120);
    const ext = url.searchParams.get('ext') || 'all';
    const off = parseInt(url.searchParams.get('off') || '0', 10) || 0;
    const perPage = parseInt(settings.per_page, 10) || 10;
    const { items, hasMore } = await searchFiles(env, q, ext, off, perPage);
    if (q) {
      const u = await apiUser(env, request).catch(() => null);
      await logSearch(env, u && u.id ? u.id : 0, q, items.length);
    }
    const counts = q ? await countExt(env, q) : null;
    let suggestions = null;
    if (q && !items.length) { try { suggestions = await suggestTitles(env, q, 3); } catch (e) {} }
    return json({ items: items.map(publicFile), hasMore, counts, suggestions });
  }

  if (path === '/api/me') {
    const user = await apiUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    await trackUser(env, user);
    const admin = await isAdmin(env, settings, user.id);
    return json({ user_id: user.id, is_admin: admin, is_owner: isOwner(env, user.id) });
  }

  if (path === '/api/fav' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const user = await apiUser(env, request, body);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const fid = parseInt(body.file_id, 10);
    if (!fid) return json({ error: 'bad file_id' }, 400);
    if (body.on) {
      await env.DB.prepare('INSERT OR IGNORE INTO favorites(user_id, file_id) VALUES(?,?)').bind(user.id, fid).run();
    } else {
      await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND file_id = ?').bind(user.id, fid).run();
    }
    return json({ ok: true });
  }

  if (path === '/api/favs') {
    const user = await apiUser(env, request);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const rows = await env.DB.prepare(
      `SELECT f.* FROM favorites v JOIN files f ON f.id = v.file_id
       WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 50`
    ).bind(user.id).all();
    return json({ items: (rows.results || []).map(publicFile) });
  }

  // ---- admin ----
  if (path.startsWith('/api/admin/')) {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const user = await apiUser(env, request, body);
    if (!user) return json({ error: 'unauthorized' }, 401);
    if (!(await isAdmin(env, settings, user.id))) return json({ error: 'forbidden' }, 403);

    if (path === '/api/admin/overview') {
      const files = await env.DB.prepare('SELECT COUNT(*) AS c FROM files').first();
      const users = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
      const usersToday = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM users WHERE first_seen >= unixepoch('now','start of day')").first();
      const activeToday = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM users WHERE last_seen >= unixepoch('now','start of day')").first();
      const searchesTotal = await env.DB.prepare('SELECT COUNT(*) AS c FROM searches').first();
      const searchesToday = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM searches WHERE created_at >= unixepoch('now','start of day')").first();
      const noResult = await env.DB.prepare('SELECT COUNT(*) AS c FROM searches WHERE results = 0').first();
      const chans = await env.DB.prepare('SELECT * FROM channels ORDER BY added_at DESC').all();
      const forced = await env.DB.prepare('SELECT * FROM forced_channels ORDER BY username').all();
      return json({
        files: files.c || 0, users: users.c || 0,
        users_today: usersToday.c || 0, active_today: activeToday.c || 0,
        searches_total: searchesTotal.c || 0, searches_today: searchesToday.c || 0,
        searches_no_result: noResult.c || 0,
        channels: chans.results || [], forced: forced.results || [], settings,
      });
    }

    if (path === '/api/admin/searches') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 300);
      const rows = await env.DB.prepare(
        'SELECT user_id, q, results, created_at FROM searches ORDER BY id DESC LIMIT ?'
      ).bind(limit).all();
      return json({ searches: rows.results || [] });
    }

    if (path === '/api/admin/channel' && request.method === 'POST') {
      const uname = String(body.username || '').replace(/^@/, '').replace(/^https:\/\/t\.me\//, '').split('/')[0].toLowerCase().trim();
      if (!/^[a-z0-9_]{3,32}$/.test(uname)) return json({ error: 'bad username' }, 400);
      if (body.action === 'remove') {
        await env.DB.prepare('DELETE FROM channels WHERE username = ?').bind(uname).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO channels(username, bot_member) VALUES(?, ?)
           ON CONFLICT(username) DO UPDATE SET active = 1, bot_member = MAX(channels.bot_member, excluded.bot_member)`
        ).bind(uname, body.bot_member ? 1 : 0).run();
      }
      return json({ ok: true });
    }

    if (path === '/api/admin/channel-toggle' && request.method === 'POST') {
      await env.DB.prepare('UPDATE channels SET active = ? WHERE username = ?')
        .bind(body.active ? 1 : 0, String(body.username || '').toLowerCase()).run();
      return json({ ok: true });
    }

    if (path === '/api/admin/forced' && request.method === 'POST') {
      const uname = String(body.username || '').replace(/^@/, '').toLowerCase().trim();
      if (!uname) return json({ error: 'bad username' }, 400);
      if (body.action === 'remove') {
        await env.DB.prepare('DELETE FROM forced_channels WHERE username = ?').bind(uname).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO forced_channels(username, active) VALUES(?, 1) ON CONFLICT(username) DO UPDATE SET active = 1'
        ).bind(uname).run();
      }
      return json({ ok: true });
    }

    if (path === '/api/admin/forced-toggle' && request.method === 'POST') {
      await env.DB.prepare('UPDATE forced_channels SET active = ? WHERE username = ?')
        .bind(body.active ? 1 : 0, String(body.username || '').toLowerCase()).run();
      return json({ ok: true });
    }

    // ---- owner only: manage admins ----
    if (path === '/api/admin/admins') {
      if (!isOwner(env, user.id)) return json({ error: 'owner only' }, 403);
      const rows = await env.DB.prepare(
        "SELECT user_id, first_name, username, first_seen FROM users WHERE is_admin = 1 ORDER BY first_seen"
      ).all();
      return json({ admins: rows.results || [], owner_id: env.OWNER_ID || '' });
    }

    if (path === '/api/admin/admin' && request.method === 'POST') {
      if (!isOwner(env, user.id)) return json({ error: 'owner only' }, 403);
      const who = String(body.user || '').trim();
      if (!who) return json({ error: 'missing user' }, 400);
      let target = null;
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
      if (!target) return json({ error: 'user_not_found', message: 'لم يبدأ هذا المستخدم البوت بعد. اطلب منه فتح البوت وإرسال /start أولًا.' }, 404);
      if (String(target.user_id) === String(env.OWNER_ID)) return json({ error: 'cannot_change_owner' }, 400);
      await env.DB.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?')
        .bind(body.action === 'remove' ? 0 : 1, target.user_id).run();
      return json({ ok: true, user_id: target.user_id });
    }

    if (path === '/api/admin/settings' && request.method === 'POST') {
      const allowed = ['welcome_on', 'per_page', 'protect_content', 'notify_new'];
      for (const k of allowed) {
        if (body[k] !== undefined) await setSetting(env, k, String(body[k]));
      }
      return json({ ok: true });
    }

    if (path === '/api/admin/broadcast' && request.method === 'POST') {
      if (body.action === 'preview') {
        const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE blocked = 0').first();
        return json({ ok: true, users: c.c || 0 });
      }
      const txt = String(body.text || '').trim();
      if (!txt) return json({ error: 'empty text' }, 400);
      if (body.test) {
        const tr = await tg(env, 'sendMessage', { chat_id: Number(env.OWNER_ID), text: txt });
        return json({ ok: true, test: true, delivered: Boolean(tr && tr.ok !== false && (tr.message_id || (tr.result && tr.result.message_id))) });
      }
      const r = await env.DB.prepare(
        "INSERT INTO broadcasts(admin_id, kind, text, status) VALUES(?, 'text', ?, 'pending')"
      ).bind(user.id, txt).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }

    if (path === '/api/admin/broadcasts') {
      const rows = await env.DB.prepare(
        'SELECT id, kind, text, status, sent, failed, blocked, created_at FROM broadcasts ORDER BY id DESC LIMIT 10'
      ).all();
      return json({ broadcasts: rows.results || [] });
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
  if (channel) {
    const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM files WHERE channel = ?').bind(channel).first();
    await env.DB.prepare('UPDATE channels SET file_count = ? WHERE username = ?').bind(c.c || 0, channel).run();
  }
  return json({ ok: true, added }, 200, false);
}

// ---------- router ----------
export default {
  async scheduled(event, env, ctx) {
    await migrate(env);
    const rows = await env.DB.prepare(
      "SELECT id FROM broadcasts WHERE status IN ('pending','sending') ORDER BY id LIMIT 3"
    ).all();
    for (const r of rows.results || []) ctx.waitUntil(runBroadcastChunk(env, r.id));
    if (new Date().getUTCMinutes() % 30 === 0) ctx.waitUntil(recheckMemberships(env));
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
    await migrate(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return json({ ok: true }, 200);

    if (path === '/health') return json({ ok: true, service: 'islamic-library' }, 200, false);

    if (path === `/tg/${env.WEBHOOK_SECRET}` && request.method === 'POST') {
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update));
      return json({ ok: true }, 200, false);
    }

    if (path.startsWith('/ingest')) return handleIngest(env, request);

    if (path.startsWith('/api/')) return handleApi(env, request, path);

    return json({ error: 'not found' }, 404, false);
}
