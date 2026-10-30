'use strict';
const $ = id => document.getElementById(id);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = m => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const money = v => `$${v.toFixed(2)}`;
const STORE_KEY = 'gti-state';

let puzzle, products = [], state;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

async function init() {
  [puzzle, products] = await Promise.all([
    fetch('/api/puzzle').then(r => r.json()),
    fetch('/api/products').then(r => r.json()).then(r => r.products),
  ]);
  const saved = load();
  state = saved && saved.date === puzzle.date ? saved : { date: puzzle.date, guesses: [], done: false, won: false, reveal: null };

  $('sub').textContent = `#${puzzle.number} · ${new Date(puzzle.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
  const { start, end } = puzzle;
  const diff = end.price - start.price;
  const rate = (diff / start.price) * 100;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  $('startMon').textContent = fmtMonth(start.month);
  $('endMon').textContent = fmtMonth(end.month);
  $('startAmt').textContent = money(start.price);
  $('endAmt').textContent = money(end.price);
  $('diff').textContent = `${sign}${money(Math.abs(diff))}`;
  $('rate').textContent = `${sign}${Math.abs(rate).toFixed(1)}%`;
  $('diff').className = $('rate').className = cls;

  render();
  startCountdown(puzzle.resetsIn);
}

function render() {
  const slots = $('slots');
  slots.innerHTML = '';
  for (let i = 0; i < puzzle.maxGuesses; i++) {
    const g = state.guesses[i];
    const li = document.createElement('li');
    li.className = 'slot ' + (!g ? 'empty' : g.correct ? 'right' : 'wrong');
    if (g) {
      li.innerHTML = `<span class="g"></span>`;
      li.firstChild.textContent = (g.correct ? '✓ ' : '✗ ') + g.text;
      if (g.hint) {
        const h = document.createElement('span');
        h.className = 'h';
        h.textContent = g.hint;
        li.append(h);
      }
    } else {
      li.textContent = `Guess ${i + 1} of ${puzzle.maxGuesses}`;
    }
    slots.append(li);
  }

  $('form').hidden = state.done;
  if (state.done && state.reveal) showResult();
}

function showResult() {
  const r = state.reveal;
  $('result').hidden = false;
  $('resultTitle').textContent = state.won ? ['Genius!', 'Nice one!', 'Phew!'][state.guesses.length - 1] : 'Out of guesses';
  $('answer').textContent = r.product;
  $('chartTitle').textContent = `Average price in Canada, ${fmtMonth(r.series[0].month)} – ${fmtMonth(r.series.at(-1).month)}`;
  drawChart(r.series);
  $('msg').textContent = '';
}

// ---------- autocomplete ----------

const input = $('guess'), list = $('list');
let matches = [], active = -1;

function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function updateList() {
  const q = input.value.trim().toLowerCase();
  const guessed = new Set(state.guesses.map(g => g.text));
  matches = !q ? [] : products
    .filter(p => !guessed.has(p) && p.toLowerCase().includes(q))
    .sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q))
    .slice(0, 50);
  active = matches.length ? 0 : -1;
  list.innerHTML = matches.map((p, i) => {
    const at = p.toLowerCase().indexOf(q);
    const html = escapeHtml(p.slice(0, at)) + '<mark>' + escapeHtml(p.slice(at, at + q.length)) + '</mark>' + escapeHtml(p.slice(at + q.length));
    return `<li role="option" id="opt${i}" data-i="${i}" aria-selected="${i === active}">${html}</li>`;
  }).join('');
  list.hidden = !matches.length;
  input.setAttribute('aria-expanded', String(!list.hidden));
}

function setActive(i) {
  active = (i + matches.length) % matches.length;
  [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === active)));
  list.children[active]?.scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', `opt${active}`);
}

function pick(i) {
  input.value = matches[i];
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
}

input.addEventListener('input', updateList);
input.addEventListener('keydown', e => {
  if (list.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
  else if (e.key === 'Escape') { list.hidden = true; }
  else if (e.key === 'Enter' && active >= 0 && input.value !== matches[active]) { e.preventDefault(); pick(active); }
});
list.addEventListener('mousedown', e => {
  const li = e.target.closest('li');
  if (li) { e.preventDefault(); pick(+li.dataset.i); input.focus(); }
});
input.addEventListener('blur', () => { list.hidden = true; });

// ---------- guessing ----------

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (state.done) return;
  const text = products.find(p => p.toLowerCase() === input.value.trim().toLowerCase());
  if (!text) { $('msg').textContent = 'Pick a product from the list.'; return; }
  if (state.guesses.some(g => g.text === text)) { $('msg').textContent = 'You already guessed that.'; return; }

  $('submit').disabled = true;
  try {
    const res = await fetch('/api/guess', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: state.date, guess: text, attempt: state.guesses.length + 1 }),
    }).then(r => r.json());
    if (res.error) { $('msg').textContent = res.error; return; }
    state.guesses.push({ text, correct: res.correct, hint: res.hint || null });
    if (res.reveal) { state.done = true; state.won = res.correct; state.reveal = res.reveal; }
    $('msg').textContent = res.correct || res.reveal ? '' : 'Not quite. Here’s a hint.';
    input.value = '';
    save();
    render();
  } catch {
    $('msg').textContent = 'Network error, try again.';
  } finally {
    $('submit').disabled = false;
  }
});

$('share').addEventListener('click', async () => {
  const squares = state.guesses.map(g => (g.correct ? '🟩' : '🟥')).join('') + '⬜'.repeat(puzzle.maxGuesses - state.guesses.length);
  const text = `Guess the Inflation #${puzzle.number} ${state.won ? state.guesses.length : 'X'}/${puzzle.maxGuesses}\n${squares}\n` +
    `${fmtMonth(puzzle.start.month)} ${money(puzzle.start.price)} → ${fmtMonth(puzzle.end.month)} ${money(puzzle.end.price)}\n${location.origin}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); $('share').textContent = 'Copied!'; setTimeout(() => ($('share').textContent = 'Share'), 1500); }
  } catch {}
});

function startCountdown(secs) {
  const end = Date.now() + secs * 1000;
  const tick = () => {
    const s = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (s === 0) { location.reload(); return; }
    $('countdown').textContent = [s / 3600, (s % 3600) / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- chart ----------

function drawChart(series) {
  const W = 440, H = 220, L = 44, R = 12, T = 12, B = 26;
  const vals = series.map(d => d.price);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || hi * 0.05 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const x = i => L + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - L - R));
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4, yy = y(v).toFixed(1);
    grid += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>` +
      `<text class="axis" x="${L - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">$${v.toFixed(2)}</text>`;
  }
  // x labels: January of each year, thinned to at most ~6 labels
  const jan = series.map((d, i) => [d, i]).filter(([d]) => d.month.endsWith('-01'));
  const step = Math.ceil(jan.length / 6) || 1;
  let xl = '';
  jan.filter((_, k) => k % step === 0).forEach(([d, i]) => {
    xl += `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.month.slice(0, 4)}</text>`;
  });
  if (!jan.length) {
    xl = `<text class="axis" x="${L}" y="${H - 6}">${fmtMonth(series[0].month)}</text>` +
      `<text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmtMonth(series.at(-1).month)}</text>`;
  }

  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d.price).toFixed(1)}`).join(' ');
  const end = i => `<circle cx="${x(i)}" cy="${y(vals[i])}" r="4" fill="var(--line)" stroke="var(--surface)" stroke-width="2"/>`;

  $('chart').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of monthly prices from ${money(vals[0])} to ${money(vals.at(-1))}">` +
    grid + xl +
    `<polyline points="${pts}" fill="none" stroke="var(--line)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    end(0) + end(series.length - 1) +
    `<line id="xh" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>` +
    `<circle id="xd" r="4" fill="var(--line)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>` +
    `<rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" id="hit"/>` +
    `</svg><div class="tip" hidden></div>`;

  const svg = $('chart').querySelector('svg'), tip = $('chart').querySelector('.tip');
  const xh = svg.querySelector('#xh'), xd = svg.querySelector('#xd');
  const move = e => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((px - L) / (W - L - R)) * (series.length - 1))));
    const cx = x(i), cy = y(vals[i]);
    xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', cx); xd.setAttribute('cy', cy); xd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${fmtMonth(series[i].month)}: ${money(vals[i])}`;
    tip.style.left = `${(cx / W) * 100}%`;
    tip.style.top = `${(cy / H) * r.height}px`;
  };
  const leave = () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  const hit = svg.querySelector('#hit');
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

init().catch(err => { console.error(err); $('msg').textContent = 'Could not load today’s puzzle.'; });
