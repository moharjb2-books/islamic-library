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
    first_seen INTEGER DEFAULT (unixepoch()),
    last_seen INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, file_id)
  )`,
];

let migrated = false;
async function migrate(env) {
  if (migrated) return;
  for (const stmt of SCHEMA) await env.DB.prepare(stmt).run();
  migrated = true;
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
  per_page: '10',
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

// ---------- search ----------
async function searchFiles(env, q, ext, offset, limit) {
  const nq = norm(q);
  let where = '1=1';
  const binds = [];
  if (nq) {
    where += ' AND (title_norm LIKE ? OR author_norm LIKE ?)';
    binds.push(`%${nq}%`, `%${nq}%`);
  }
  if (ext && ext !== 'all') {
    if (ext === 'audio') { where += " AND ext IN ('mp3','m4a','ogg','opus','wav')"; }
    else { where += ' AND ext = ?'; binds.push(ext.toLowerCase()); }
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
    `SELECT CASE WHEN ext IN ('mp3','m4a','ogg','opus','wav') THEN 'audio' ELSE ext END AS k, COUNT(*) AS c
     FROM files WHERE ${where} GROUP BY k`
  ).bind(...binds).all();
  const out = {};
  let total = 0;
  for (const r of rows.results || []) { out[r.k || 'other'] = r.c; total += r.c; }
  out.all = total;
  return out;
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
      text: `📕 ${file.title}\n📎 ${file.ext ? file.ext.toUpperCase() + ' · ' : ''}${fmtSize(file.size_bytes)}`,
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
        await upsertFile(env, {
          title, author: extractAuthor(title, msg.caption),
          ext: extOf(doc.file_name || ''), size_bytes: doc.file_size || 0,
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

    // Document forwarded/sent to the bot in private: cache file_id
    const doc = msg.document || msg.audio || msg.video;
    if (doc && msg.chat.type === 'private') {
      const fwd = msg.forward_from_chat && msg.forward_from_chat.username
        ? msg.forward_from_chat.username.toLowerCase() : '';
      const title = doc.file_name || msg.caption || 'ملف';
      await upsertFile(env, {
        title, author: extractAuthor(title, msg.caption),
        ext: extOf(doc.file_name || ''), size_bytes: doc.file_size || 0,
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
      const perPage = parseInt(settings.per_page, 10) || 10;
      const { items } = await searchFiles(env, text, 'all', 0, perPage);
      if (!items.length) {
        await tg(env, 'sendMessage', {
          chat_id: chatId,
          text: `🔍 لم أجد نتائج مطابقة لـ«${text}».\nجرّب اسمًا أقصر أو جزءًا من اسم الكتاب أو المؤلف.`,
        });
        return;
      }
      const missing = await checkForced(env, from.id);
      const keyboard = items.map(f => {
        const label = `📕 ${f.title.slice(0, 40)} (${(f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') {
          return [{ text: label, callback_data: 'dl:' + f.id }];
        }
        return [{ text: label, url: f.link }];
      });
      keyboard.push([{ text: '🔍 تصفية النتائج في صفحة البحث', web_app: { url: env.MINIAPP_URL } }]);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `🔍 نتائج البحث عن «${text}» — ${items.length}${items.length === perPage ? '+' : ''} نتيجة:`,
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
        const label = `📕 ${f.title.slice(0, 40)} (${(f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
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
        const label = `📕 ${f.title.slice(0, 40)} (${(f.ext || '').toUpperCase()} ${fmtSize(f.size_bytes)})`;
        if (f.file_id || f.delivery === 'copy') return [{ text: label, callback_data: 'dl:' + f.id }];
        return [{ text: label, url: f.link }];
      });
      await tg(env, 'sendMessage', { chat_id: chatId, text: '☆ المفضلة:', reply_markup: { inline_keyboard: keyboard } });
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
    `INSERT INTO files(title, title_norm, author, author_norm, ext, size_bytes, channel, message_id, link, file_id, delivery)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(channel, message_id, title_norm) DO UPDATE SET
       file_id = CASE WHEN excluded.file_id != '' THEN excluded.file_id ELSE files.file_id END,
       delivery = CASE WHEN excluded.delivery = 'link' THEN files.delivery ELSE excluded.delivery END`
  ).bind(
    f.title, norm(f.title), f.author || '', norm(f.author || ''), f.ext || '',
    f.size_bytes || 0, f.channel || '', f.message_id || 0, f.link || '', f.file_id || '',
    f.delivery || 'link'
  ).run();
  return r;
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
    const q = url.searchParams.get('q') || '';
    const ext = url.searchParams.get('ext') || 'all';
    const off = parseInt(url.searchParams.get('off') || '0', 10) || 0;
    const perPage = parseInt(settings.per_page, 10) || 10;
    const { items, hasMore } = await searchFiles(env, q, ext, off, perPage);
    const counts = q ? await countExt(env, q) : null;
    return json({ items: items.map(publicFile), hasMore, counts });
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
      const chans = await env.DB.prepare('SELECT * FROM channels ORDER BY added_at DESC').all();
      const forced = await env.DB.prepare('SELECT * FROM forced_channels ORDER BY username').all();
      return json({
        files: files.c || 0, users: users.c || 0,
        channels: chans.results || [], forced: forced.results || [], settings,
      });
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

    return json({ error: 'not found' }, 404);
  }

  return json({ error: 'not found' }, 404);
}

function publicFile(f) {
  return {
    id: f.id, title: f.title, author: f.author, ext: f.ext,
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

  if (request.method === 'GET' && url.pathname === '/ingest/sources') {
    const rows = await env.DB.prepare(
      'SELECT username, last_message_id, bot_member FROM channels WHERE active = 1 ORDER BY username'
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
      title, author: String(it.author || '').slice(0, 200),
      ext: String(it.ext || '').toLowerCase(), size_bytes: Number(it.size_bytes) || 0,
      channel, message_id: Number(it.message_id),
      link: `https://t.me/${channel}/${it.message_id}`,
      file_id: String(it.file_id || ''), delivery,
    });
    if (r && r.meta && r.meta.changes > 0) added++;
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
  async fetch(request, env, ctx) {
    await migrate(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return json({}, 204);

    if (path === '/health') return json({ ok: true, service: 'islamic-library' }, 200, false);

    if (path === `/tg/${env.WEBHOOK_SECRET}` && request.method === 'POST') {
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(env, update));
      return json({ ok: true }, 200, false);
    }

    if (path === '/ingest' || path === '/ingest/sources') return handleIngest(env, request);

    if (path.startsWith('/api/')) return handleApi(env, request, path);

    return json({ error: 'not found' }, 404, false);
  },
};
