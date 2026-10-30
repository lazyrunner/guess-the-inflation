'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || 'America/Toronto';
const CSV_PATH = process.env.CSV_PATH || path.join(__dirname, 'prices.csv');
const HINTS_PATH = process.env.HINTS_PATH || path.join(__dirname, 'hints.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'game.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_GUESSES = 3;
const MIN_MONTH_GAP = 12;     // start and end month are at least a year apart
const NO_REPEAT_DAYS = 90;    // don't reuse a product within this many days

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------- database ----------

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS prices (
    product_id INTEGER NOT NULL REFERENCES products(id),
    month      TEXT NOT NULL,           -- YYYY-MM
    price      REAL NOT NULL,
    PRIMARY KEY (product_id, month)
  );
  CREATE TABLE IF NOT EXISTS hints (
    product_id INTEGER NOT NULL REFERENCES products(id),
    ord        INTEGER NOT NULL,        -- 1 = shown after first wrong guess, etc.
    text       TEXT NOT NULL,
    PRIMARY KEY (product_id, ord)
  );
  CREATE TABLE IF NOT EXISTS daily_puzzles (
    date        TEXT PRIMARY KEY,       -- YYYY-MM-DD in server TZ
    product_id  INTEGER NOT NULL REFERENCES products(id),
    start_month TEXT NOT NULL,
    end_month   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------- CSV import ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "January 2017" -> "2017-01"
function toMonthKey(label) {
  const [name, year] = label.trim().split(/\s+/);
  const m = MONTHS.indexOf(name);
  return m < 0 || !/^\d{4}$/.test(year) ? null : `${year}-${String(m + 1).padStart(2, '0')}`;
}

// "Oranges, 1.36 kilograms 5 6" -> "Oranges, 1.36 kilograms" (strip StatCan footnote refs)
function cleanName(raw) {
  return raw.replace(/(\s+\d)+\s*$/, '').replace(/\s+/g, ' ').trim();
}

function importCsv() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, ''));
  const headerIdx = rows.findIndex(r => r[0] === 'Products');
  if (headerIdx < 0) throw new Error('Could not find "Products" header row in CSV');
  const months = rows[headerIdx].map((h, i) => (i === 0 ? null : toMonthKey(h)));

  const insProduct = db.prepare('INSERT OR IGNORE INTO products (name) VALUES (?)');
  const getProduct = db.prepare('SELECT id FROM products WHERE name = ?');
  const upsertPrice = db.prepare('INSERT OR REPLACE INTO prices (product_id, month, price) VALUES (?, ?, ?)');

  let products = 0, prices = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows.slice(headerIdx + 1)) {
      if (!r[0] || r.length < 3) { if (products) break; else continue; }
      const name = cleanName(r[0]);
      insProduct.run(name);
      const { id } = getProduct.get(name);
      products++;
      for (let i = 1; i < r.length; i++) {
        const v = parseFloat(r[i]);
        if (months[i] && Number.isFinite(v)) { upsertPrice.run(id, months[i], v); prices++; }
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(`Imported ${products} products, ${prices} prices from ${CSV_PATH}`);
}

// Seeds hints only where none exist, so edits made directly in the DB are kept.
function seedHints() {
  if (!fs.existsSync(HINTS_PATH)) return;
  const hints = JSON.parse(fs.readFileSync(HINTS_PATH, 'utf8'));
  const ins = db.prepare('INSERT OR IGNORE INTO hints (product_id, ord, text) VALUES (?, ?, ?)');
  let added = 0;
  db.exec('BEGIN');
  for (const p of db.prepare('SELECT id, name FROM products').all()) {
    const h = hints[p.name];
    if (!h) { console.warn(`No hints for "${p.name}"`); continue; }
    const size = p.name.includes(',') ? p.name.split(',').slice(1).join(',').trim() : p.name.match(/\((.*)\)/)?.[1];
    const sold = size === 'unit' ? 'each' : size;
    const texts = [`Aisle: ${h[0]}${sold ? ` · Sold as: ${sold}` : ''}`, h[1]];
    texts.forEach((t, i) => { added += Number(ins.run(p.id, i + 1, t).changes); });
  }
  db.exec('COMMIT');
  if (added) console.log(`Seeded ${added} hints`);
}

importCsv();
seedHints();

// ---------- puzzle logic ----------

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function secondsUntilMidnight() {
  const [h, m, s] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date()).split(':').map(Number);
  return 86400 - ((h % 24) * 3600 + m * 60 + s);
}

function createPuzzle(date) {
  const recent = db.prepare(`SELECT product_id FROM daily_puzzles WHERE date >= date(?, ?)`)
    .all(date, `-${NO_REPEAT_DAYS} days`).map(r => r.product_id);
  const all = db.prepare(`SELECT p.id FROM products p
    WHERE (SELECT COUNT(*) FROM prices WHERE product_id = p.id) > ?`).all(MIN_MONTH_GAP).map(r => r.id);
  const pool = all.filter(id => !recent.includes(id));
  const productId = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];

  const months = db.prepare('SELECT month FROM prices WHERE product_id = ? ORDER BY month')
    .all(productId).map(r => r.month);
  const s = Math.floor(Math.random() * (months.length - MIN_MONTH_GAP));
  const e = s + MIN_MONTH_GAP + Math.floor(Math.random() * (months.length - s - MIN_MONTH_GAP));

  // OR IGNORE: if two requests race at midnight, the first insert wins for everyone.
  db.prepare('INSERT OR IGNORE INTO daily_puzzles (date, product_id, start_month, end_month) VALUES (?, ?, ?, ?)')
    .run(date, productId, months[s], months[e]);
}

function getPuzzle(date) {
  const q = db.prepare(`SELECT d.*, p.name FROM daily_puzzles d JOIN products p ON p.id = d.product_id WHERE d.date = ?`);
  let row = q.get(date);
  if (!row && date === todayStr()) { createPuzzle(date); row = q.get(date); }
  return row;
}

const priceAt = (pid, month) =>
  db.prepare('SELECT price FROM prices WHERE product_id = ? AND month = ?').get(pid, month).price;

function puzzleNumber(date) {
  return db.prepare('SELECT COUNT(*) AS n FROM daily_puzzles WHERE date <= ?').get(date).n;
}

function reveal(p) {
  return {
    product: p.name,
    hints: db.prepare('SELECT text FROM hints WHERE product_id = ? ORDER BY ord').all(p.product_id).map(r => r.text),
    series: db.prepare('SELECT month, price FROM prices WHERE product_id = ? AND month BETWEEN ? AND ? ORDER BY month')
      .all(p.product_id, p.start_month, p.end_month),
  };
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

const routes = {
  'GET /api/puzzle': () => {
    const date = todayStr();
    const p = getPuzzle(date);
    return {
      date, number: puzzleNumber(date), maxGuesses: MAX_GUESSES, resetsIn: secondsUntilMidnight(),
      start: { month: p.start_month, price: priceAt(p.product_id, p.start_month) },
      end: { month: p.end_month, price: priceAt(p.product_id, p.end_month) },
    };
  },
  'GET /api/products': () => ({ products: db.prepare('SELECT name FROM products ORDER BY name').all().map(r => r.name) }),
  'POST /api/guess': async req => {
    const { date, guess, attempt } = await readJson(req);
    const p = getPuzzle(String(date));
    if (!p) return [404, { error: 'No puzzle for that date' }];
    const n = Math.max(1, Math.min(MAX_GUESSES, Number(attempt) || 1));
    const correct = String(guess || '').trim().toLowerCase() === p.name.toLowerCase();
    const out = { correct };
    if (correct || n >= MAX_GUESSES) out.reveal = reveal(p);
    else out.hint = db.prepare('SELECT text FROM hints WHERE product_id = ? AND ord = ?').get(p.product_id, n)?.text || null;
    return out;
  },
  'GET /healthz': () => ({ ok: true }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) {
      const r = await route(req);
      return Array.isArray(r) ? send(res, r[0], r[1]) : send(res, 200, r);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`Listening on :${PORT} (TZ ${TZ})`));
