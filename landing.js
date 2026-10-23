'use strict';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Probalo: el mismo flujo que la app, con frases originales ----------
// Cada frase tiene una trampa típica para hispanohablantes. Los estados iniciales son de muestra.

const LINES = [
  { pair: 'ship / sheep', text: "There's a sheep on the ship tonight", best: 1 },
  { pair: 'live / leave', text: "I can't live here, so I leave at nine", best: 1 },
  { pair: 'very / berry', text: 'A very small berry fell on my shoe', best: 0.625 },
  { pair: 'can / can’t', text: "I can dance, but I can't sing", best: 0 },
  { pair: 'thirty / thirteen', text: 'She was thirteen, not thirty', best: 0, revealed: true },
  { pair: 'walk / work', text: 'I walk to work when it rains', best: 0 },
  { pair: 'full / fool', text: "My heart is full, don't call me a fool", best: 0 },
  { pair: 'year / ear', text: 'Every year my ear gets a little better', best: 0 },
  { pair: 'heat / hit', text: 'The heat will hit us after noon', best: 0 },
];
let idx = 3;

// mismas reglas que la app: sin mayúsculas, sin puntuación, apóstrofos unificados
const norm = (w) => w.toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^\p{L}\p{N}]/gu, '');
const tokens = (t) => t.split(/\s+/).map((shown) => ({ shown, n: norm(shown) })).filter((x) => x.n);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function compare(expected, typed) {
  const E = tokens(expected);
  const T = tokens(typed);
  const dp = Array.from({ length: E.length + 1 }, () => new Array(T.length + 1).fill(0));
  for (let i = E.length - 1; i >= 0; i--) {
    for (let j = T.length - 1; j >= 0; j--) {
      dp[i][j] = E[i].n === T[j].n ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < E.length || j < T.length) {
    if (i < E.length && j < T.length && E[i].n === T[j].n) { ops.push(['ok', E[i].shown]); i++; j++; }
    else if (j < T.length && (i === E.length || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['extra', T[j].shown]); j++; }
    else { ops.push(['miss', '_'.repeat(Math.max(2, E[i].n.length))]); i++; }
  }
  return { ops, score: dp[0][0] / E.length, missing: E.length - dp[0][0], total: E.length };
}

const $ = (id) => document.getElementById(id);
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

function englishVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /^en-US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
}

function speak(rate, btn) {
  if (!canSpeak) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(LINES[idx].text);
  u.lang = 'en-US';
  u.rate = rate;
  const v = englishVoice();
  if (v) u.voice = v;
  btn.classList.add('playing');
  u.onend = u.onerror = () => btn.classList.remove('playing');
  speechSynthesis.speak(u);
  $('frag-input').focus({ preventScroll: true });
}

const stateOf = (l) => (l.best === 1 ? 'done' : l.revealed ? 'revealed' : l.best > 0 ? 'partial' : 'todo');

const STATUS = { done: 'Resuelta', partial: 'A medias', revealed: 'Revelada', todo: 'Nueva' };

function renderFrag() {
  // tira de la app (dentro del recorte)
  const strip = $('frag-strip');
  strip.innerHTML = '';
  LINES.forEach((l, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = [stateOf(l), i === idx && 'current'].filter(Boolean).join(' ');
    b.setAttribute('aria-label', `Frase ${i + 1}`);
    b.addEventListener('click', () => open(i));
    strip.appendChild(b);
  });
  const solved = LINES.filter((l) => l.best === 1).length;
  const revealed = LINES.filter((l) => l.revealed && l.best !== 1).length;
  $('frag-summary').innerHTML = `<span class="num">${solved}</span> de <span class="num">${LINES.length}</span> resueltas${revealed ? ` · <span class="num">${revealed}</span> revelada${revealed === 1 ? '' : 's'}` : ''}`;

  // tablero de frases (a escala de página): la trampa, la frase si ya está resuelta, y su estado
  const board = $('board');
  board.innerHTML = '';
  LINES.forEach((l, i) => {
    const st = stateOf(l);
    const li = document.createElement('li');
    li.style.setProperty('--i', i);
    const shown = st === 'done' || st === 'revealed';
    const label = st === 'partial' ? `${Math.round(l.best * 100)}%` : STATUS[st];
    li.innerHTML = `<button type="button" class="brow" ${i === idx ? 'aria-current="true"' : ''}>
      <span class="b-pair">${esc(l.pair)}</span>
      <span class="b-text">${shown ? esc(l.text) : ''}</span>
      <span class="b-words">${tokens(l.text).length} palabras</span>
      <span class="b-st b-${st}">${label}</span>
    </button>`;
    li.querySelector('button').addEventListener('click', () => {
      open(i);
      document.getElementById('frame').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    });
    board.appendChild(li);
  });

  const l = LINES[idx];
  $('frag-num').textContent = idx + 1;
  $('frag-pair').textContent = l.pair;
  $('frag-finding').innerHTML = !canSpeak
    ? 'Tu navegador no puede leer en voz alta. En la app practicás con el video real.'
    : l.best === 1 ? 'Ya la resolviste. Elegí otra frase del tablero.'
    : `Esta frase tiene <b>${tokens(l.text).length} palabras</b>. Tu navegador la lee en voz alta; en la app, la canta la canción.`;
  $('frag-listen').disabled = !canSpeak;
  $('frag-slow').disabled = !canSpeak;
}

function open(i) {
  idx = i;
  $('frag-input').value = '';
  $('frag-feedback').innerHTML = '';
  renderFrag();
}

$('frag-listen').addEventListener('click', (e) => speak(0.9, e.currentTarget));
$('frag-slow').addEventListener('click', (e) => speak(0.6, e.currentTarget));
$('frag-next').addEventListener('click', () => open((idx + 1) % LINES.length));
$('frag-reveal').addEventListener('click', () => {
  const l = LINES[idx];
  l.revealed = true;
  $('frag-feedback').innerHTML = `<div class="ui-marks"><span class="ui-mark">${esc(l.text)}</span></div>`;
  renderFrag();
});
$('frag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('frag-form').requestSubmit(); }
});
$('frag-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const l = LINES[idx];
  const typed = $('frag-input').value;
  if (!typed.trim()) return;
  const r = compare(l.text, typed);
  l.best = Math.max(l.best, r.score);
  const marks = r.ops.map(([t, w]) => `<span class="ui-mark ${t}">${esc(w)}</span>`).join('');
  const verdict = r.score === 1
    ? '<p class="ui-verdict good">Perfecto. Elegí otra frase del tablero.</p>'
    : `<p class="ui-verdict"><span class="num">${Math.round(r.score * 100)}</span>% bien: te ${r.missing === 1 ? 'falta' : 'faltan'} ${r.missing} de ${r.total}. Escuchala otra vez y corregí lo marcado.</p>`;
  $('frag-feedback').innerHTML = `<div class="ui-marks">${marks}</div>${verdict}`;
  renderFrag();
});

renderFrag();


// ---------- Entradas ----------

requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-loaded')));

document.querySelectorAll('[data-reveal]').forEach((group) => {
  [...group.children].forEach((child, i) => child.style.setProperty('--i', i));
});

// bloques del nombre en el footer
const blocks = document.querySelector('.blocks');
const COLORS = ['c-red', 'c-yellow', 'c-blue', 'c-teal', 'c-white'];
const HEIGHTS = [100, 72, 88, 64, 94, 80, 68, 100, 76, 90, 62, 84, 96];
let k = 0;
for (const ch of 'song dictation') {
  const b = document.createElement('span');
  if (ch === ' ') { b.className = 'block space'; blocks.appendChild(b); continue; }
  b.className = `block ${COLORS[k % COLORS.length]}`;
  b.style.height = `${HEIGHTS[k % HEIGHTS.length]}%`;
  b.style.setProperty('--h-phone', `${Math.round(HEIGHTS[k % HEIGHTS.length] * 0.9)}px`);
  b.style.setProperty('--i', k);
  b.innerHTML = `<span>${ch}</span>`;
  blocks.appendChild(b);
  k++;
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  }
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('[data-reveal], .app-crop, .board, .blocks').forEach((el) => io.observe(el));

// ---------- La foto de la banda se acerca con el scroll ----------

const bandImg = document.querySelector('.band-photo img');
if (!reduceMotion && bandImg) {
  let ticking = false;
  const update = () => {
    ticking = false;
    const r = bandImg.parentElement.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight + r.height)));
    bandImg.style.setProperty('--band-scale', (1.14 - p * 0.14).toFixed(4));
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}
