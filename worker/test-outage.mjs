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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
