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
  res.end(JSON.stringify({ response: { numFound: 2, docs: [
    { identifier: 'tafsir-ibn-kathir-01', title: 'تفسير ابن كثير ط العلمية', creator: 'ابن كثير' },
    { identifier: 'another-book-02', title: 'كتاب آخر', creator: null },
  ] } }));
});
await new Promise(r => iaServer.listen(8793, r));

// ---- mock ketabonline API ----
const kbServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [
    { id: 2422, lang: 'ar', is_free: 1, title: 'العمل <em>الصالح</em>', authors: [{ name: 'سامي محمد' }],
      files: { data: { url: 'https://s2.ketabonline.com/books/2422/2422.data.zip', size: 636914 },
               pdf: { url: 'https://s2.ketabonline.com/books/2422/2422.pdf.zip', size: 4965008 } } },
    { id: 6572, lang: 'ar', is_free: 1, title: 'كتاب بلا ملف', authors: [], files: { data: { url: 'x' }, pdf: null } },
    { id: 9999, lang: 'ar', is_free: 0, title: 'كتاب مدفوع يجب استبعاده', authors: [], files: { pdf: null } },
    { id: 8888, lang: 'en', is_free: 1, title: 'English book must be excluded', authors: [], files: { pdf: null } },
  ] }));
});
await new Promise(r => kbServer.listen(8794, r));

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
  check('not-found also offers archive.org direct-download links (federated fallback)', Boolean(m) && /archive.org/.test(m.body.text || '') && mk.includes('/download/tafsir-ibn-kathir-01/tafsir_text.pdf'), JSON.stringify(m && m.body).slice(0, 300));
  check('IA item without files falls back to its details page', mk.includes('/details/another-book-02'), mk.slice(0, 300));
  check('not-found offers Sunni external-library search links', mk.includes('shamela.ws/search?q=') && mk.includes('waqfeya.net/search?q=') && mk.includes('dorar.net/site/search?skeys=') && mk.includes('islamhouse.com/ar/search/'), mk.slice(0, 300));
  check('not-found offers ketabonline reader + direct PDF, free+Arabic only, tags stripped', mk.includes('ketabonline.com/ar/books/2422') && mk.includes('2422.pdf.zip') && mk.includes('ketabonline.com/ar/books/6572') && !mk.includes('9999') && !mk.includes('8888') && !mk.includes('<em>') && mk.includes('سامي محمد'), mk.slice(0, 400));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
