// Outage simulation: D1 throws on EVERY operation (the daily-cap scenario).
// The bot must keep answering from the static snapshot, never go silent.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import worker from './worker.js';

const SNAP_DIR = new URL('../snapshot', import.meta.url).pathname;
const tgCalls = [];

// ---- mock Telegram API ----
const tgServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const method = req.url.split('/').pop();
    tgCalls.push({ method, body: JSON.parse(body || '{}') });
    let result = { ok: true, result: { status: 'member' } };
    if (method === 'getChatMember') {
      const uid = (JSON.parse(body || '{}') || {}).user_id;
      if (uid === 555001) result = { ok: false, error_code: 400, description: 'Bad Request: user not found' };
    }
    if (method === 'sendMessage' || method === 'copyMessage' || method === 'sendDocument') result = { ok: true, result: { message_id: 1 } };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  });
});
await new Promise(r => tgServer.listen(8791, r));

// ---- static snapshot server (stands in for GitHub Pages) ----
const snapServer = http.createServer(async (req, res) => {
  try {
    const p = path.join(SNAP_DIR, decodeURIComponent(req.url.split('?')[0]));
    const data = await readFile(p);
    res.setHeader('content-type', 'application/json');
    res.end(data);
  } catch (e) { res.statusCode = 404; res.end('nf'); }
});
await new Promise(r => snapServer.listen(8792, r));

// ---- mock Internet Archive advancedsearch + metadata ----
const iaServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/metadata/')) {
    const id = decodeURIComponent(u.pathname.slice('/metadata/'.length));
    if (id === 'tafsir-ibn-kathir-01') return res.end(JSON.stringify({ files: [{ name: 'tafsir_text.pdf', size: '12000000' }] }));
    return res.end(JSON.stringify({ files: [] }));
  }
  const q = u.searchParams.get('q') || '';
  const docs = [];
  if (q.includes('مقدمة')) docs.push({ identifier: 'tafsir-ibn-kathir-01', title: 'مقدمة ابن خلدون ط العلمية', creator: 'ابن خلدون' });
  if (q.includes('فقه')) docs.push({ identifier: 'tafsir-ibn-kathir-01', title: 'فقه السنة', creator: 'سيد سابق' });
  // Noise every query gets: bulk pack, non-Sunni, and an irrelevant hit.
  docs.push(
    { identifier: 'bulk-pack-99', title: 'كتب صيغة ورد وورد 6538 كتاب من المكتبة الشاملة', creator: null },
    { identifier: 'shia-book-98', title: 'بحار الأنوار', creator: 'المجلسي' },
    { identifier: 'another-book-02', title: 'كتاب آخر بعيد', creator: null },
  );
  res.end(JSON.stringify({ response: { numFound: docs.length, docs } }));
});
await new Promise(r => iaServer.listen(8793, r));

// ---- mock ketabonline API ----
const kbServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  const data = [];
  if (q.includes('مقدمة') || q.includes('فقه')) data.push(
    { id: 2422, lang: 'ar', is_free: 1, title: q.includes('مقدمة') ? 'مقدمة <em>ابن</em> خلدون' : 'فقه <em>المعاملات</em>', authors: [{ name: 'ابن خلدون' }],
      files: { data: { url: 'https://s2.ketabonline.com/books/2422/2422.data.zip', size: 636914 },
               pdf: { url: 'https://s2.ketabonline.com/books/2422/2422.pdf.zip', size: 4965008 } } });
  // Noise: no-file, paid, non-Sunni, non-Arabic, and an irrelevant free Arabic hit.
  data.push(
    { id: 6572, lang: 'ar', is_free: 1, title: 'كتاب بلا ملف', authors: [], files: { data: { url: 'x' }, pdf: null } },
    { id: 9999, lang: 'ar', is_free: 0, title: 'كتاب مدفوع يجب استبعاده', authors: [], files: { pdf: null } },
    { id: 7777, lang: 'ar', is_free: 1, title: 'غريب القرآن', authors: [{ name: 'زيد بن علي' }], files: { pdf: { url: 'https://s2.ketabonline.com/books/7777/7777.pdf.zip', size: 1000 } } },
    { id: 8888, lang: 'en', is_free: 1, title: 'English book must be excluded', authors: [], files: { pdf: null } },
    { id: 6300, lang: 'ar', is_free: 1, title: 'العمل الصالح', authors: [{ name: 'سامي محمد' }], files: { pdf: { url: 'https://s2.ketabonline.com/books/6300/6300.pdf.zip', size: 1000 } } },
  );
  res.end(JSON.stringify({ data }));
});
await new Promise(r => kbServer.listen(8794, r));

// ---- mock aljam3 API ----
const ajServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/v1/books') {
    const q = u.searchParams.get('q') || '';
    const books = [];
    if (q.includes('مقدمة')) books.push(
      { id: 101, title: '<mark>مقدمة&nbsp;</mark>ابن خلدون', author: { id: 1, name: 'ابن خلدون' }, library: { id: 3, name: 'الوقفية' } },
      { id: 103, title: 'مقدمة ابن خلدون - طبعة أخرى', author: { id: 1, name: 'ابن خلدون' }, library: { id: 3, name: 'الوقفية' } });
    if (q.includes('فقه')) books.push(
      { id: 101, title: 'فقه المعاملات', author: { id: 2, name: 'ابن قدامة' }, library: { id: 3, name: 'الوقفية' } });
    // Noise: an irrelevant hit and a non-Sunni one.
    books.push(
      { id: 105, title: 'رياض الصالحين - النووي', author: { id: 1, name: 'النووي' }, library: { id: 3, name: 'الوقفية' } },
      { id: 104, title: 'الكافي', author: { id: 9, name: 'الكليني' }, library: { id: 3, name: 'الوقفية' } });
    return res.end(JSON.stringify({ books }));
  }
  if (u.pathname === '/api/v1/books/105') {
    return res.end(JSON.stringify({ files: [{ id: 5, urls: { pdf: 'https://hf.co/riyad105.pdf' } }] }));
  }
  if (u.pathname === '/api/v1/books/103') {
    return res.end(JSON.stringify({ files: [{ id: 2, urls: { pdf: 'https://hf.co/riyad.pdf' } }] }));
  }
  if (u.pathname === '/api/v1/books/104') {
    return res.end(JSON.stringify({ files: [{ id: 3, urls: { pdf: 'https://hf.co/kafi.pdf' } }] }));
  }
  if (u.pathname === '/api/v1/books/101') {
    return res.end(JSON.stringify({ files: [{ id: 1, urls: { pdf: 'https://hf.co/riyad.pdf', docx: 'https://hf.co/riyad.docx' } }] }));
  }
  return res.end(JSON.stringify({ files: [] }));
});
await new Promise(r => ajServer.listen(8795, r));

// ---- D1 that is down for everything ----
const deadStmt = {
  bind() { return this; },
  async run() { throw new Error("D1 daily row read limit exceeded"); },
  async first() { throw new Error("D1 daily row read limit exceeded"); },
  async all() { throw new Error("D1 daily row read limit exceeded"); },
};
const deadDB = {
  prepare() { return { ...deadStmt }; },
  async batch() { throw new Error("D1 daily row read limit exceeded"); },
};

const env = {
  DB: deadDB,
  BOT_TOKEN: 'TEST_TOKEN',
  INGEST_SECRET: 'ingest123',
  WEBHOOK_SECRET: 'wh123',
  ADMIN_SETUP_CODE: 'setup123',
  MINIAPP_URL: 'http://miniapp.local/',
  BOT_USERNAME: 'ISLAMIC_BOOKS_LIBbot',
  MAIN_CHANNEL: 'cr_wrr',
  OWNER_ID: '999999',
  TG_API_BASE: 'http://127.0.0.1:8791',
  SNAPSHOT_BASE: 'http://127.0.0.1:8792',
  IA_API_BASE: 'http://127.0.0.1:8793',
  KB_API_BASE: 'http://127.0.0.1:8794',
  AJ_API_BASE: 'http://127.0.0.1:8795',
};

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

function ctx() { return { promises: [], waitUntil(p) { this.promises.push(p); } }; }
async function fire(update) {
  const c = ctx();
  const r = await worker.fetch(new Request('http://local/tg/wh123', { method: 'POST', body: JSON.stringify(update) }), env, c);
  await Promise.allSettled(c.promises);
  return r;
}

// 1. /start while D1 is dead -> welcome message must still go out
tgCalls.length = 0;
await fire({ update_id: 1, message: { message_id: 1, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'Test' }, text: '/start' } });
check('bot answers /start with D1 dead', tgCalls.some(c => c.method === 'sendMessage' && c.body.chat_id === 12345), JSON.stringify(tgCalls).slice(0, 200));

// 2. text search while D1 is dead -> results from the snapshot
tgCalls.length = 0;
await fire({ update_id: 2, message: { message_id: 2, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'Test' }, text: 'مقدمة ابن خلدون' } });
const resMsg = tgCalls.find(c => c.method === 'sendMessage' && c.body.reply_markup);
check('bot search returns snapshot results with D1 dead', Boolean(resMsg && JSON.stringify(resMsg.body.reply_markup).length > 60), JSON.stringify(tgCalls).slice(0, 300));
{
  const mk = JSON.stringify((resMsg && resMsg.body.reply_markup) || {});
  const tx = (resMsg && resMsg.body.text) || '';
  check('has-results shows external sources inline (aljam3 + archive.org + ketabonline)', mk.includes('hf.co/riyad.pdf') && mk.includes('hf.co/riyad.docx') && mk.includes('/download/tafsir-ibn-kathir-01/tafsir_text.pdf') && mk.includes('ketabonline.com/ar/books/2422') && mk.includes('2422.pdf.zip'), mk.slice(0, 400));
  check('irrelevant + non-Sunni + bulk external hits are dropped', !mk.includes('رياض الصالحين') && !mk.includes('riyad105') && !mk.includes('الكافي') && !mk.includes('الكليني') && !mk.includes('kafi.pdf') && !mk.includes('bulk-pack-99') && !mk.includes('بحار') && !mk.includes('كتاب آخر') && !mk.includes('العمل الصالح') && !mk.includes('7777') && !mk.includes('9999') && !mk.includes('8888'), mk.slice(0, 500));
  check('aljam3 duplicate editions collapse (riyad.pdf appears once)', mk.split('hf.co/riyad.pdf').length === 2, mk.slice(0, 300));
  check('external titles are tag-stripped', !mk.includes('<mark>') && !mk.includes('<em>'), mk.slice(0, 200));
  const lbls = [...mk.matchAll(/"text":"([^"]+)"/g)].map(x => x[1]);
  check('has-results labels are clean (no underscores / raw extensions)', lbls.length > 0 && lbls.every(l => !/\.(pdf|epub|docx)/i.test(l) && !/\w_\w/.test(l)), JSON.stringify(lbls).slice(0, 300));
  check('has-results reply is cards only (no header text at all)', tx === '📚', tx.slice(0, 200));
  check('external rows look like channel rows (uniform 📕 labels)', lbls.filter(l => l.startsWith('📕')).length >= 4, JSON.stringify(lbls).slice(0, 300));
}
// local duplicate rows collapse to one (largest copy kept)
{
  tgCalls.length = 0;
  await fire({ update_id: 21, message: { message_id: 21, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'T' }, text: 'فقه' } });
  await new Promise(r => setTimeout(r, 400));
  const m2 = tgCalls.find(c => c.method === 'sendMessage' && c.body.reply_markup);
  const rows = m2 ? JSON.stringify(m2.body.reply_markup) : '';
  const dlIds = [...rows.matchAll(/"callback_data":"dl:(\d+)"/g)].map(x => x[1]);
  const labels = [...rows.matchAll(/"text":"📕 ([^"]+)"/g)].map(x => x[1]);
  const uniq = new Set(labels.map(l => l.replace(/\s*\((PDF|EPUB|DOCX|صوتي)[^)]*\)$/i, '').trim().toLowerCase()));
  check('local duplicate titles collapse to one row', dlIds.length > 0 && uniq.size === labels.length, `${labels.length} rows, ${uniq.size} unique`);
}

// 3. delivery callback dl:<id> while D1 is dead -> file sent via snapshot lookup
const rows = JSON.parse(await readFile(path.join(SNAP_DIR, 'rows', 'c000.json'), 'utf8'));
const deliverable = rows.find(r => r[9] || r[10] === 'copy');
check('snapshot has a deliverable row to test', Boolean(deliverable));
if (deliverable) {
  tgCalls.length = 0;
  await fire({ update_id: 3, callback_query: { id: 'cb1', from: { id: 12345, first_name: 'Test' }, message: { chat: { id: 12345, type: 'private' } }, data: 'dl:' + deliverable[0] } });
  check('bot delivers a file with D1 dead', tgCalls.some(c => ['sendDocument', 'copyMessage', 'sendMessage'].includes(c.method) && c.method !== 'answerCallbackQuery'), JSON.stringify(tgCalls).slice(0, 300));
}

// 4. API search while D1 is dead
const apiR = await worker.fetch(new Request('http://local/api/search?q=' + encodeURIComponent('فقه')), env, ctx());
const apiJ = await apiR.json();
check('api/search works with D1 dead', Array.isArray(apiJ.items) && apiJ.items.length > 0, JSON.stringify(apiJ).slice(0, 200));
check('api/search has-results carries external sources too', Array.isArray(apiJ.external) && apiJ.external.length > 0 && apiJ.external.some(e2 => e2.src === 'aj'), JSON.stringify(apiJ.external || []).slice(0, 200));
check('external entries carry card metadata (kind + sizeMb + url)', apiJ.external.every(e2 => e2.url && 'kind' in e2 && 'sizeMb' in e2) && apiJ.external.some(e2 => e2.src === 'ia' && e2.kind === 'PDF'), JSON.stringify(apiJ.external || []).slice(0, 250));
check('api/search item titles are clean', apiJ.items.every(i2 => !/[_.](pdf|epub|docx)/i.test(i2.file_name || '')), (apiJ.items[0] || {}).file_name || '');

// 5. api/stats falls back to snapshot meta
const stR = await worker.fetch(new Request('http://local/api/stats'), env, ctx());
const stJ = await stR.json();
check('api/stats falls back to snapshot meta', stJ.files > 50000 && stJ.snapshot === true, JSON.stringify(stJ));

// 6. typo search while D1 is dead -> "هل تقصد" with suggestion buttons
tgCalls.length = 0;
await fire({ update_id: 6, message: { message_id: 6, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'T' }, text: 'مقمدة ابن خلدونن' } });
const sugMsg = tgCalls.find(c => c.method === 'sendMessage');
check('typo search gets did-you-mean with buttons (D1 dead)', Boolean(sugMsg && /هل تقصد/.test(sugMsg.body.text) && sugMsg.body.reply_markup && sugMsg.body.reply_markup.inline_keyboard.length > 0), JSON.stringify(tgCalls).slice(0, 300));

// 7. gibberish search while D1 is dead -> clear not-found, never silent
tgCalls.length = 0;
await fire({ update_id: 7, message: { message_id: 7, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'T' }, text: 'خخخخخخخقققق' } });
const nfMsg = tgCalls.find(c => c.method === 'sendMessage');
check('gibberish search still gets a reply (D1 dead)', Boolean(nfMsg && /لم أجد/.test(nfMsg.body.text)), JSON.stringify(tgCalls).slice(0, 300));

// 8. sq: suggestion-pick callback while D1 is dead -> results via snapshot
const typoSug = sugMsg && sugMsg.body.reply_markup.inline_keyboard[0][0].callback_data;
if (typoSug) {
  tgCalls.length = 0;
  await fire({ update_id: 8, callback_query: { id: 'cb8', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' } }, data: typoSug } });
  const sqRes = tgCalls.find(c => c.method === 'sendMessage' && c.body.reply_markup);
  check('sq: suggestion pick returns results (D1 dead)', Boolean(sqRes), JSON.stringify(tgCalls).slice(0, 300));
}

// 8b. Groups: silent unless the message starts with بحث
{
  tgCalls.length = 0;
  await fire({ update_id: 31, message: { message_id: 31, chat: { id: -100999, type: 'supergroup' }, from: { id: 777001, first_name: 'G' }, text: 'مقدمة ابن خلدون' } });
  await new Promise(r => setTimeout(r, 300));
  check('group: plain message without بحث gets total silence', !tgCalls.some(c => c.method === 'sendMessage'), JSON.stringify(tgCalls).slice(0, 200));

  tgCalls.length = 0;
  await fire({ update_id: 32, message: { message_id: 32, chat: { id: -100999, type: 'supergroup' }, from: { id: 777001, first_name: 'G' }, text: 'السلام عليكم' } });
  await new Promise(r => setTimeout(r, 300));
  check('group: greeting gets total silence', !tgCalls.some(c => c.method === 'sendMessage'), JSON.stringify(tgCalls).slice(0, 200));

  tgCalls.length = 0;
  await fire({ update_id: 33, message: { message_id: 33, chat: { id: -100999, type: 'supergroup' }, from: { id: 777001, first_name: 'G' }, text: 'بحث مقدمة ابن خلدون' } });
  await new Promise(r => setTimeout(r, 400));
  const gm = tgCalls.find(c => c.method === 'sendMessage' && c.body.chat_id === -100999);
  check('group: بحث + query returns results cards', Boolean(gm && JSON.stringify(gm.body.reply_markup || {}).includes('dl:')), JSON.stringify(gm && gm.body).slice(0, 200));

  tgCalls.length = 0;
  await fire({ update_id: 34, message: { message_id: 34, chat: { id: -100999, type: 'group' }, from: { id: 777001, first_name: 'G' }, text: 'بحث' } });
  await new Promise(r => setTimeout(r, 300));
  const gh = tgCalls.find(c => c.method === 'sendMessage');
  check('group: bare بحث gets a usage hint', Boolean(gh && /بحث اسم الكتاب/.test(gh.body.text || '')), JSON.stringify(gh && gh.body).slice(0, 200));

  tgCalls.length = 0;
  await fire({ update_id: 35, message: { message_id: 35, chat: { id: -100999, type: 'supergroup' }, from: { id: 777001, first_name: 'G' }, text: '/start' } });
  await new Promise(r => setTimeout(r, 300));
  check('group: /start gets total silence', !tgCalls.some(c => c.method === 'sendMessage'), JSON.stringify(tgCalls).slice(0, 200));
}

// 9. API typo search -> suggestions carry {id, title}
const sR = await worker.fetch(new Request('http://local/api/search?q=' + encodeURIComponent('مقمدة ابن خلدونن')), env, ctx());
const sJ = await sR.json();
check('api suggestions are {id,title} rows', Array.isArray(sJ.suggestions) && sJ.suggestions.length > 0 && Boolean(sJ.suggestions[0].id && sJ.suggestions[0].title), JSON.stringify(sJ.suggestions).slice(0, 200));

// ---- the user's typo-test set (snapshot suggester quality) ----
async function apiSearch(q) {
  const r = await worker.fetch(new Request('http://local/api/search?q=' + encodeURIComponent(q)), env, ctx());
  return r.json();
}
let j = await apiSearch('ابن كثيرر');
check("'ابن كثيرر' suggests ابن كثير books first", Boolean(j.suggestions && j.suggestions[0] && j.suggestions[0].title.includes('ابن كثير')), JSON.stringify(j.suggestions || j.items && j.items.slice(0,2)));
j = await apiSearch('تفسير ابن كثيرر');
check("'تفسير ابن كثيرر' top suggestion is تفسير ابن كثير", Boolean(j.suggestions && j.suggestions[0] && /تفسير ابن كثير/.test(j.suggestions[0].title)), JSON.stringify(j.suggestions));
j = await apiSearch('صحيح البخارى');
check("'صحيح البخارى' (ى typo) finds results directly", Boolean(j.items && j.items.length > 0 && /البخاري/.test(j.items[0].title + j.items[0].file_name)), JSON.stringify((j.items||[]).slice(0,1)));
j = await apiSearch('رياض الصالحين');
check("'رياض الصالحين' finds results directly", Boolean(j.items && j.items.length > 0), JSON.stringify((j.items||[]).slice(0,1)));
j = await apiSearch('رياض الصالحيين');
check("'رياض الصالحيين' suggests رياض الصالحين", Boolean(j.suggestions && j.suggestions[0] && j.suggestions[0].title.includes('رياض الصالحين')), JSON.stringify(j.suggestions));
j = await apiSearch('مقمدة ابن خلدونن');
check("'مقمدة ابن خلدونن' suggests خلدون books", Boolean(j.suggestions && j.suggestions[0] && /خلدون/.test(j.suggestions[0].title)), JSON.stringify(j.suggestions));
j = await apiSearch('صحيح مسلمم');
check("'صحيح مسلمم' suggests صحيح مسلم", Boolean(j.suggestions && j.suggestions[0] && /مسلم/.test(j.suggestions[0].title)), JSON.stringify(j.suggestions));

// ---- forced-subscription gate stays ENFORCED while D1 is dead ----
async function fireMsg(uid, text) {
  tgCalls.length = 0;
  await worker.fetch(new Request('http://local/tg/wh123', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: Date.now() % 100000, message: { message_id: 1, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: 'N' }, text } }),
  }), env, ctx());
  await new Promise(r => setTimeout(r, 300));
}
await fireMsg(555001, 'ابن خلدون');
{
  const gate = tgCalls.find(c => c.method === 'sendMessage' && c.body.chat_id === 555001 && /اشترك في القنوات/.test(c.body.text || ''));
  const mk = gate ? JSON.stringify(gate.body.reply_markup || {}) : '';
  check('D1 dead: non-member search is gated', Boolean(gate) && mk.includes('recheck') && mk.includes('t.me/cr_wrr'), JSON.stringify(tgCalls).slice(0, 300));
  check('D1 dead: gate leaks no results', !tgCalls.some(c => JSON.stringify(c.body).includes('dl:') || c.method === 'copyMessage' || c.method === 'sendDocument'), '');
}
await fireMsg(555001, '/start');
check('D1 dead: non-member /start is gated', tgCalls.some(c => c.method === 'sendMessage' && c.body.chat_id === 555001 && /اشترك في القنوات/.test(c.body.text || '')), JSON.stringify(tgCalls).slice(0, 200));
await fireMsg(555002, 'ابن خلدون');
check('D1 dead: member search still returns results', tgCalls.some(c => (c.method === 'sendMessage' || c.method === 'copyMessage') && /dl:|copyMessage/.test(JSON.stringify(c.body) + c.method)), JSON.stringify(tgCalls).slice(0, 200));
{
  tgCalls.length = 0;
  await worker.fetch(new Request('http://local/tg/wh123', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: Date.now() % 100000, callback_query: { id: 'cb1', from: { id: 555001, first_name: 'N' }, message: { message_id: 2, chat: { id: 555001, type: 'private' } }, data: 'recheck' } }),
  }), env, ctx());
  await new Promise(r => setTimeout(r, 300));
  check('D1 dead: recheck while non-member alerts and does not pass', tgCalls.some(c => c.method === 'answerCallbackQuery' && /غير مشترك/.test(c.body.text || '')) && !tgCalls.some(c => /تم التحقق من اشتراكك/.test((c.body && c.body.text) || '')), JSON.stringify(tgCalls).slice(0, 300));
}

{
  tgCalls.length = 0;
  await worker.fetch(new Request('http://local/tg/wh123', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: Date.now() % 100000, callback_query: { id: 'cb2', from: { id: 555002, first_name: 'M' }, message: { message_id: 3, chat: { id: 555002, type: 'private' } }, data: 'recheck' } }),
  }), env, ctx());
  await new Promise(r => setTimeout(r, 300));
  const welcome = tgCalls.find(c => c.method === 'sendMessage' && c.body.chat_id === 555002 && /أهلًا بك في المكتبة الإسلامية الشاملة/.test(c.body.text || ''));
  check('D1 dead: passing recheck sends the full welcome with buttons', Boolean(welcome) && JSON.stringify((welcome && welcome.body.reply_markup) || {}).includes('web_app'), JSON.stringify(tgCalls).slice(0, 300));
}

// ---- every Mini App / admin endpoint degrades gracefully with D1 dead (no 'internal', no 500) ----
import nodeCrypto from 'node:crypto';
function makeInit(user) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'q1');
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = nodeCrypto.createHmac('sha256', 'WebAppData').update('TEST_TOKEN').digest();
  params.set('hash', nodeCrypto.createHmac('sha256', secret).update(pairs).digest('hex'));
  return params.toString();
}
const ownerInit = encodeURIComponent(makeInit({ id: 999999, first_name: 'Owner' }));
async function apiGet(p) { const r = await worker.fetch(new Request('http://local' + p), env, ctx()); return { status: r.status, j: await r.json() }; }
async function apiPost(p, b) { const r = await worker.fetch(new Request('http://local' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), env, ctx()); return { status: r.status, j: await r.json() }; }

{
  const { status, j } = await apiGet('/api/admin/overview?init=' + ownerInit);
  check('admin overview with D1 dead: degraded snapshot answer', status === 200 && j.db_down === true && j.files > 50000 && j.notice && j.forced.some(f => f.username === 'cr_wrr'), JSON.stringify(j).slice(0, 200));
}
for (const p of ['/api/admin/users', '/api/admin/searches', '/api/admin/admins', '/api/admin/broadcasts']) {
  const { status, j } = await apiGet(p + '?init=' + ownerInit);
  check(p + ' with D1 dead: graceful, no internal/500', status === 200 && j.db_down === true && j.error !== 'internal', JSON.stringify(j).slice(0, 120));
}
{
  const { status, j } = await apiPost('/api/fav', { init: makeInit({ id: 12345, first_name: 'U' }), file_id: 1, on: true });
  check('fav write with D1 dead: clear message, no 500', status === 503 && j.error === 'db_unavailable' && /غير متاحة مؤقت/.test(j.message || ''), JSON.stringify(j));
}
for (const [p, b] of [
  ['/api/admin/channel-toggle', { username: 'cr_wrr', active: true }],
  ['/api/admin/forced-toggle', { username: 'cr_wrr', active: true }],
  ['/api/admin/settings', { per_page: 10 }],
  ['/api/admin/broadcast', { action: 'preview' }],
]) {
  b.init = makeInit({ id: 999999, first_name: 'Owner' });
  const { status, j } = await apiPost(p, b);
  check(p + ' mutation with D1 dead: clear 503 message', status === 503 && j.error === 'db_unavailable' && /غير متاحة مؤقت/.test(j.message || ''), JSON.stringify(j).slice(0, 150));
}
{
  const { status, j } = await apiGet('/api/me?init=' + ownerInit);
  check('/api/me with D1 dead still answers', status === 200 && j.is_owner === true, JSON.stringify(j));
}

{
  tgCalls.length = 0;
  await fire({ update_id: Date.now() % 100000, message: { message_id: 9, chat: { id: 12345, type: 'private' }, from: { id: 12345, first_name: 'M' }, text: 'كتاب غير موجود محليا ٩٩' } });
  await new Promise(r => setTimeout(r, 400));
  const m = tgCalls.find(c => c.method === 'sendMessage' && c.body.chat_id === 12345);
  const mk = m ? JSON.stringify(m.body.reply_markup || {}) : '';
  check('not-found still answers: suggestions + Sunni library search links', Boolean(m) && (m.body.text || '').includes('لم أجد') && mk.includes('shamela.ws/search?q=') && mk.includes('waqfeya.net/search?q=') && mk.includes('dorar.net/site/search?skeys=') && mk.includes('islamhouse.com/ar/search/'), JSON.stringify(m && m.body).slice(0, 300));
  check('not-found drops weak/irrelevant external hits entirely', !mk.includes('hf.co/') && !mk.includes('/download/') && !mk.includes('ketabonline.com/ar/books') && !mk.includes('/details/'), mk.slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
