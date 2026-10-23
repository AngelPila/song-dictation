'use strict';

const LRCLIB = 'https://lrclib.net/api';
const TAIL = 0.25; // segundos extra al final de cada verso para no cortar la última sílaba

// Inspirado en LyricsTraining: cuántas palabras del verso tenés que completar
const LEVELS = {
  easy: { label: 'Principiante', ratio: 0.25, note: 'Completás una palabra de cada cuatro.' },
  mid: { label: 'Intermedio', ratio: 0.5, note: 'Completás la mitad del verso.' },
  full: { label: 'Avanzado', ratio: 1, note: 'Escribís el verso entero.' },
};
const POINTS = { word: 10, comboBonus: 2, hint: 2, reveal: 5, skip: 3 };
const MAX_RECENTS = 4;

const $ = (id) => document.getElementById(id);

const state = {
  candidate: null, // resultado de LRCLIB elegido en el buscador
  level: 'full',
  song: null,      // { id, trackName, artistName, duration, lines: [{ start, end, text }] }
  videoId: null,
  offset: 0,
  idx: 0,
  best: [],        // mejor precisión (0..1) por verso
  revealed: [],    // versos donde se pidió la respuesta
  awarded: [],     // versos que ya sumaron puntos
  songPoints: 0,
  combo: 0,
  bestCombo: 0,
  hints: 0,
  solved: false,
  player: null,
  stopTimer: null,
  syncing: false,
  captionsOff: false,
};

// ---------- LRC y texto ----------

function parseLrc(lrc) {
  const entries = [];
  for (const raw of lrc.split('\n')) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) entries.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  entries.sort((a, b) => a.t - b.t);

  const lines = [];
  entries.forEach((e, i) => {
    if (!e.text || !tokenize(e.text).length) return;
    const next = entries[i + 1];
    lines.push({ start: e.t, end: next ? next.t : e.t + 6, text: e.text });
  });
  return lines;
}

function normWord(w) {
  return w.toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Devuelve [{ shown, norm }] ignorando tokens que son solo puntuación
function tokenize(text) {
  return text.replace(/[()]/g, ' ').split(/\s+/)
    .map((shown) => ({ shown, norm: normWord(shown) }))
    .filter((t) => t.norm);
}

// Alinea lo esperado con lo escrito usando LCS palabra por palabra
function compare(expectedText, typedText) {
  const E = tokenize(expectedText);
  const T = tokenize(typedText);
  const dp = Array.from({ length: E.length + 1 }, () => new Array(T.length + 1).fill(0));
  for (let i = E.length - 1; i >= 0; i--) {
    for (let j = T.length - 1; j >= 0; j--) {
      dp[i][j] = E[i].norm === T[j].norm
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < E.length || j < T.length) {
    if (i < E.length && j < T.length && E[i].norm === T[j].norm) {
      ops.push({ type: 'ok', word: E[i].shown }); i++; j++;
    } else if (j < T.length && (i === E.length || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'extra', word: T[j].shown }); j++;
    } else {
      ops.push({ type: 'miss', word: E[i].shown }); i++;
    }
  }
  const matched = dp[0][0];
  return { ops, score: E.length ? matched / E.length : 1, perfect: matched === E.length, missing: E.length - matched, total: E.length };
}

function hintText(text, revealed) {
  return tokenize(text)
    .map((t, k) => (k < revealed ? t.shown : t.norm[0] + '_'.repeat(t.norm.length - 1)))
    .join(' ');
}

// Elige qué palabras ocultar en modo huecos; es determinístico para que el verso no cambie al volver
function pickGaps(text, ratio, seed) {
  const words = tokenize(text);
  let h = seed + 1;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rand = () => ((h = (h * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const order = words
    .map((w, k) => ({ k, w: (w.norm.length >= 3 ? 1 : 0) + rand() }))
    .sort((a, b) => b.w - a.w)
    .map((o) => o.k);
  const count = Math.max(1, Math.round(words.length * ratio));
  return new Set(order.slice(0, count));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtStamp = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const fmtNum = (n) => n.toLocaleString('es');
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function parseYouTubeId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---------- Almacenamiento local ----------

function readStore(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* sin almacenamiento: seguimos sin guardar */ }
}

const progressKey = () => `sd:${state.song.id}:${state.videoId}:${state.level}`;
const offsetKey = () => `sd:off:${state.song.id}:${state.videoId}`;
const solvedCount = () => state.best.filter((b) => b === 1).length;
const accuracy = () => Math.round((state.best.reduce((a, b) => a + b, 0) / state.song.lines.length) * 100);

function saveProgress() {
  writeStore(progressKey(), {
    idx: state.idx, best: state.best, revealed: state.revealed, awarded: state.awarded,
    songPoints: state.songPoints, bestCombo: state.bestCombo,
  });
  writeStore(offsetKey(), state.offset);
  // "Seguir practicando" en la pantalla de canciones
  const recents = readStore('sd:recents', []).filter((r) => !(r.lrc === state.song.id && r.v === state.videoId && r.level === state.level));
  recents.unshift({
    lrc: state.song.id, v: state.videoId, level: state.level,
    title: state.song.trackName, artist: state.song.artistName,
    total: state.song.lines.length, solved: solvedCount(), acc: accuracy(), at: Date.now(),
  });
  writeStore('sd:recents', recents.slice(0, 12));
}

function addPoints(n) {
  state.songPoints = Math.max(0, state.songPoints + n);
  writeStore('sd:points', Math.max(0, readStore('sd:points', 0) + n));
  renderPoints();
}

function renderPoints() {
  $('points-total').textContent = fmtNum(readStore('sd:points', 0));
  if (state.song) $('song-points').textContent = fmtNum(state.songPoints);
}

// ---------- Navegación entre las dos pantallas ----------

// Un solo h1 en la pantalla visible: el título de la otra pasa a h2
function retag(id, tag) {
  const el = $(id);
  if (el.tagName.toLowerCase() === tag) return;
  const copy = document.createElement(tag);
  for (const a of el.attributes) copy.setAttribute(a.name, a.value);
  copy.innerHTML = el.innerHTML;
  el.replaceWith(copy);
}

function showScreen(name) {
  const practice = name === 'practice';
  retag('home-title', practice ? 'h2' : 'h1');
  retag('song-title', practice ? 'h1' : 'h2');
  $('setup').classList.toggle('hidden', practice);
  $('practice').classList.toggle('hidden', !practice);
  $('nav-songs').toggleAttribute('aria-current', !practice);
  $('nav-practice').toggleAttribute('aria-current', practice);
  if ($('nav-songs').hasAttribute('aria-current')) $('nav-songs').setAttribute('aria-current', 'page');
  if ($('nav-practice').hasAttribute('aria-current')) $('nav-practice').setAttribute('aria-current', 'page');
  $('nav-practice').setAttribute('aria-disabled', String(!state.song));
  window.scrollTo(0, 0);
}

$('nav-songs').addEventListener('click', (e) => { e.preventDefault(); backToSetup(); });
$('nav-practice').addEventListener('click', (e) => { e.preventDefault(); if (state.song) showScreen('practice'); });

// ---------- Canciones ----------

function selectLevel(level) {
  state.level = LEVELS[level] ? level : 'full';
  document.querySelectorAll('.level').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === state.level)));
  $('level-note').textContent = LEVELS[state.level].note;
  // vista previa del nivel con una frase de muestra, con la misma regla que elige los huecos
  const sample = 'Every night I hum the same old song';
  const gaps = state.level === 'full' ? null : pickGaps(sample, LEVELS[state.level].ratio, 0);
  $('level-sample').innerHTML = gaps
    ? sample.split(' ').map((w, k) => (gaps.has(k) ? '<u></u>' : esc(w))).join(' ')
    : '<span class="ui-faint">Escribís todo lo que escuchás</span>';
  writeStore('sd:level', state.level);
}

document.querySelectorAll('.level').forEach((b) => b.addEventListener('click', () => selectLevel(b.dataset.level)));

function renderRecents() {
  const recents = readStore('sd:recents', []);
  $('recents-card').classList.toggle('hidden', !recents.length);
  if (!recents.length) {
    $('home-subline').textContent = 'Buscá una canción en inglés con la letra sincronizada y practicala verso por verso.';
    return;
  }
  const first = recents[0];
  $('home-subline').innerHTML = `Seguís con <b>${esc(first.title)}</b>: ${first.solved} de ${first.total} versos resueltos.`;
  $('recents-count').textContent = recents.length > MAX_RECENTS ? `${MAX_RECENTS} de ${recents.length}` : `${recents.length} ${recents.length === 1 ? 'canción' : 'canciones'}`;
  const list = $('recents');
  list.innerHTML = '';
  for (const r of recents.slice(0, MAX_RECENTS)) {
    const li = document.createElement('li');
    const pct = r.total ? (r.solved / r.total) * 100 : 0;
    li.innerHTML = `
      <img src="${thumb(r.v)}" alt="" width="64" height="36" loading="lazy">
      <span class="who"><b>${esc(r.title)}</b><span>${esc(r.artist)}</span></span>
      <span class="ui-meta lvl">${LEVELS[r.level]?.label || ''}</span>
      <span class="plan">
        <span class="track"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="ui-meta"><span><span class="num">${r.solved}</span> de <span class="num">${r.total}</span> versos</span></span>
      </span>
      <span class="acc"><span class="num">${r.acc}</span><span class="ui-faint">%</span></span>
      <button type="button" class="ui-btn">Seguir</button>`;
    li.querySelector('button').addEventListener('click', () => resume(r));
    list.appendChild(li);
  }
}

// Trae una letra por id; primero del navegador (las canciones ya abiertas), si no de LRCLIB con un reintento
async function fetchLyrics(id) {
  const cached = readStore(`sd:lrc:${id}`, null);
  if (cached?.syncedLyrics) return cached;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${LRCLIB}/get/${encodeURIComponent(id)}`);
    if (res.ok) {
      const item = await res.json();
      if (!item.syncedLyrics) throw new Error('Esa versión de la letra no tiene tiempos.');
      return item;
    }
    if (res.status === 404) throw new Error('LRCLIB ya no tiene esa letra. Buscala de nuevo.');
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    else throw new Error(`LRCLIB no responde ahora (error ${res.status}). Probá de nuevo en unos minutos.`);
  }
}

async function resume(r) {
  try {
    const item = await fetchLyrics(r.lrc);
    selectLevel(r.level);
    startPractice(item, r.v);
  } catch (err) {
    $('setup-msg').textContent = err.message || 'No se pudo cargar esa canción.';
  }
}

// Sugerencias para la primera vez: canciones conocidas con dicción clara
const STARTERS = [
  ['Yellow', 'Coldplay'],
  ['Someone Like You', 'Adele'],
  ['Let It Be', 'The Beatles'],
  ['Riptide', 'Vance Joy'],
  ['Perfect', 'Ed Sheeran'],
];

function renderStarters() {
  const list = $('starter-list');
  list.innerHTML = '';
  for (const [track, artist] of STARTERS) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `<span class="r-main"><span class="r-title">${esc(track)}</span><span class="r-meta">${esc(artist)}</span></span><span></span><span class="r-tag"><span class="ui-btn text">Buscar</span></span>`;
    const go = () => { $('q-track').value = track; $('q-artist').value = artist; $('search-form').requestSubmit(); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    list.appendChild(li);
  }
}

// ---------- Emparejar letra y video ----------
// La letra de LRCLIB trae su duración. El video con la duración más cercana suele ser el que coincide
// verso por verso; los videoclips con intro corren los tiempos, así que preferimos audio oficial o lyric video.

const DUR_OK = 3; // segundos de diferencia que todavía cuentan como "coincide"
const LRC_SEARCH_TTL = 7 * 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const looseIncludes = (a, b) => { const x = normName(a), y = normName(b); return Boolean(x && y) && (x.includes(y) || y.includes(x)); };

Object.assign(state, {
  results: [],       // resultados de LRCLIB de la última búsqueda
  lyricManual: false, // el usuario eligió la versión de letra a mano
  yt: null,          // null: sin saber; true: hay búsqueda automática; false: sin clave o sin servicio
  ytStatus: null,    // { kind: 'loading' | 'empty' | 'error', text }
  videos: [],        // propuestas ordenadas de mejor a peor
  autoVideo: null,   // la propuesta elegida (o la que el usuario tocó de las alternativas)
  manualVideo: null, // el pegado a mano: manda sobre la propuesta
  videoQuery: '',
  searching: false,
  searched: false,   // ya hubo al menos una búsqueda en esta visita
});

const currentVideo = () => state.manualVideo || state.autoVideo;

// Versiones con tiempos que son de la canción buscada (LRCLIB también trae homónimos de otros artistas)
function relevantLyrics(items, track, artist) {
  const synced = items.filter((i) => i.syncedLyrics);
  const strict = synced.filter((i) => (!artist || looseIncludes(i.artistName, artist)) && looseIncludes(i.trackName, track));
  if (strict.length) return strict;
  const byArtist = synced.filter((i) => !artist || looseIncludes(i.artistName, artist));
  return byArtist.length ? byArtist : synced;
}

// Sin video para comparar: la duración que más se repite entre las versiones suele ser la del disco
function pickLyricByConsensus(list) {
  let best = null, bestVotes = -1;
  for (const a of list) {
    const votes = list.filter((b) => Math.abs(a.duration - b.duration) <= 2).length;
    if (votes > bestVotes) { best = a; bestVotes = votes; }
  }
  return best;
}

function pickLyricFor(list, duration) {
  if (!duration) return pickLyricByConsensus(list);
  return list.reduce((best, i) => (Math.abs(i.duration - duration) < Math.abs(best.duration - duration) ? i : best), list[0]);
}

const BAD_WORDS = ['live', 'en vivo', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'nightcore', '8d', 'reverb',
  'acoustic', 'piano', 'tutorial', 'lesson', 'reaction', 'hour', 'loop', 'traducida', 'subtitulada', 'letra en espanol', 'concert', 'session'];

// Menor es mejor
function scoreVideo(v, index, lyrics, track, artist) {
  const title = normName(v.title);
  const channel = normName(v.channel);
  const trackN = normName(track);
  const diff = Math.min(...lyrics.map((l) => Math.abs(l.duration - v.duration)));
  let s = diff <= DUR_OK ? diff * 0.5 : DUR_OK * 0.5 + (Math.min(diff, 60) - DUR_OK) * 1.5;
  if (!title.includes(trackN)) s += 30;
  for (const w of BAD_WORDS) if (` ${title} `.includes(` ${w} `) && !` ${trackN} `.includes(` ${w} `)) s += 40;
  if (/\bofficial audio\b|\baudio\b/.test(title) || channel.endsWith(' topic')) s -= 8;
  else if (/\blyrics?\b/.test(title)) s -= 5;
  if (/\bofficial (music )?video\b|\bmusic video\b|\bvideoclip\b|\bofficial mv\b/.test(title)) s += 6;
  if (looseIncludes(channel.replace(/ topic$| vevo$|vevo$/, ''), artist) || /vevo$/.test(channel)) s -= 3;
  return s + index * 0.3;
}

function rankVideos(videos, lyrics, track, artist) {
  return videos
    .filter((v) => v.embeddable !== false && v.duration > 0)
    .map((v, k) => ({ ...v, score: scoreVideo(v, k, lyrics, track, artist) }))
    .sort((a, b) => a.score - b.score);
}

// ---------- LRCLIB: pocas llamadas, con caché en el navegador ----------

function cachedSearch(key) {
  const all = readStore('sd:lrcq', {});
  const hit = all[key];
  return hit && Date.now() - hit.at < LRC_SEARCH_TTL ? hit.items : null;
}

function storeSearch(key, items) {
  const all = readStore('sd:lrcq', {});
  all[key] = { at: Date.now(), items };
  // solo las 10 búsquedas más recientes, para no llenar el almacenamiento
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 10);
  writeStore('sd:lrcq', Object.fromEntries(keep));
}

async function searchLyrics(track, artist) {
  const key = `${normName(track)}|${normName(artist)}`;
  const hit = cachedSearch(key);
  if (hit) return hit;
  const params = new URLSearchParams({ track_name: track });
  if (artist) params.set('artist_name', artist);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${LRCLIB}/search?${params}`);
    if (res.ok) {
      const items = (await res.json())
        .map(({ id, trackName, artistName, albumName, duration, syncedLyrics }) => ({ id, trackName, artistName, albumName, duration, syncedLyrics }))
        .slice(0, 20);
      storeSearch(key, items);
      return items;
    }
    // ocupado: esperamos un poco y probamos una sola vez más
    if (attempt === 0 && (res.status === 503 || res.status === 429)) { await sleep(2500); continue; }
    throw Object.assign(new Error('lrclib'), { status: res.status });
  }
}

$('search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (state.searching) return;
  const track = $('q-track').value.trim();
  const artist = $('q-artist').value.trim();
  if (!track) return;

  const list = $('results');
  $('starter').classList.add('hidden');
  list.innerHTML = '<li class="status">Buscando en LRCLIB…</li>';
  state.candidate = null;
  state.results = [];
  state.lyricManual = false;
  renderChosen();
  state.searching = true;
  state.searched = true;
  $('search-form').querySelector('button').disabled = true;
  try {
    state.results = await searchLyrics(track, artist);
  } catch (err) {
    list.innerHTML = err.status === 503 || err.status === 429
      ? '<li class="status">LRCLIB está saturado ahora mismo. Esperá un minuto y buscá de nuevo.</li>'
      : err.status
        ? `<li class="status">LRCLIB respondió con un error (<span class="num">${err.status}</span>). Probá de nuevo en unos minutos.</li>`
        : '<li class="status">No se pudo conectar con LRCLIB. Revisá la conexión y buscá de nuevo.</li>';
    return;
  } finally {
    state.searching = false;
    $('search-form').querySelector('button').disabled = false;
  }

  const lyrics = relevantLyrics(state.results, track, artist);
  if (!lyrics.length) {
    renderResults();
    return;
  }
  // primero una versión por consenso, y en cuanto llega el video, la más cercana a su duración
  state.candidate = state.manualVideo?.duration ? pickLyricFor(lyrics, state.manualVideo.duration) : pickLyricByConsensus(lyrics);
  renderResults();
  renderChosen();
  findVideo(state.candidate.trackName, state.candidate.artistName || artist);
});

// Orden de la lista: las versiones de esta canción con tiempos, después el resto
function sortedResults() {
  const track = $('q-track').value.trim();
  const artist = $('q-artist').value.trim();
  const rel = new Set(relevantLyrics(state.results, track, artist));
  const rank = (i) => (rel.has(i) ? 0 : i.syncedLyrics ? 1 : 2);
  const sorted = [...state.results].sort((a, b) => rank(a) - rank(b));
  const shown = sorted.slice(0, 8);
  if (state.candidate && !shown.includes(state.candidate)) shown[shown.length - 1] = state.candidate;
  return shown;
}

function renderResults() {
  const list = $('results');
  if (!state.searched || state.searching) return;
  list.innerHTML = '';
  if (!state.results.length) {
    list.innerHTML = '<li class="status">Sin resultados. Probá con otro nombre, o sin el artista.</li>';
    return;
  }
  if (!state.results.some((i) => i.syncedLyrics)) {
    list.innerHTML = '<li class="status">LRCLIB tiene esta letra, pero ninguna versión con tiempos. Probá con otra canción.</li>';
    return;
  }
  const video = currentVideo();
  for (const item of sortedResults()) {
    const li = document.createElement('li');
    const diff = video?.duration ? Math.round(Math.abs(item.duration - video.duration)) : null;
    li.innerHTML = `
      <span class="r-main">
        <span class="r-title">${esc(item.trackName)}</span>
        <span class="r-meta">${esc(item.artistName)}${item.albumName ? ' · ' + esc(item.albumName) : ''}</span>
      </span>
      <span class="r-dur num">${fmtTime(item.duration)}</span>
      <span class="r-tag">${!item.syncedLyrics ? '<span class="ui-pill">Sin tiempos</span>'
        : diff !== null ? durationPill(diff) : '<span class="ui-pill pos">Con tiempos</span>'}</span>`;
    if (!item.syncedLyrics) {
      li.classList.add('disabled');
    } else {
      li.tabIndex = 0;
      if (item === state.candidate) li.classList.add('selected');
      li.setAttribute('aria-selected', String(item === state.candidate));
      const pick = () => {
        state.candidate = item;
        state.lyricManual = true;
        renderResults();
        renderChosen();
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    }
    list.appendChild(li);
  }
}

function durationPill(diff) {
  if (diff <= DUR_OK) return `<span class="ui-pill pos">Coincide&nbsp;<span class="num">±${diff}</span>&nbsp;s</span>`;
  return `<span class="ui-pill${diff > 10 ? ' neg' : ''}">Difiere&nbsp;<span class="num">${diff}</span>&nbsp;s</span>`;
}

function renderChosen() {
  const c = state.candidate;
  const video = currentVideo();
  const why = c && !state.lyricManual
    ? `<span class="ui-meta chosen-why">${video?.duration ? 'Versión elegida por la duración del video' : 'Versión elegida sola; cambiala en la lista si querés'}</span>`
    : '';
  $('chosen').innerHTML = c
    ? `<b>${esc(c.trackName)}</b><span class="ui-meta">${esc(c.artistName)} · <span class="num">${fmtTime(c.duration)}</span> · <span class="num">${parseLrc(c.syncedLyrics).length}</span> versos</span>${why}`
    : '<span class="ui-meta">Elegí una canción de la lista.</span>';
  renderVideo();
}

// ---------- YouTube: propuesta automática, alternativas y link a mano ----------

async function apiGet(path) {
  const res = await fetch(path, { signal: AbortSignal.timeout(12000) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function checkYouTube() {
  try {
    const r = await apiGet('/api/status');
    state.yt = r.ok && r.body.youtube === true;
  } catch {
    state.yt = false;
  }
  renderVideo();
}

function ytErrorText(body, status) {
  const reason = body?.reason || '';
  if (/quota/i.test(reason)) return 'YouTube no respondió: se agotó la cuota diaria de búsquedas (se renueva a medianoche, hora del Pacífico).';
  if (/keyInvalid|API_KEY|forbidden|accessNotConfigured/i.test(reason) || body?.status === 400 || body?.status === 403) return 'YouTube rechazó la clave configurada. Revisala en el archivo .env.';
  if (reason === 'timeout') return 'YouTube tardó demasiado en responder.';
  return `No se pudo buscar el video (error ${body?.status || status}).`;
}

async function findVideo(track, artist) {
  const query = `${normName(track)}|${normName(artist)}`;
  if (state.yt === false) return;
  if (state.videoQuery === query && state.videos.length) return pickBestPair();
  state.videoQuery = query;
  state.videos = [];
  state.autoVideo = null;
  state.ytStatus = { kind: 'loading', text: 'Buscando el video en YouTube…' };
  renderVideo();
  let r;
  try {
    r = await apiGet(`/api/youtube/search?${new URLSearchParams({ track, artist })}`);
  } catch {
    r = { ok: false, status: 0, body: { reason: 'timeout' } };
  }
  if (state.videoQuery !== query) return; // llegó tarde: ya se buscó otra canción
  if (!r.ok) {
    if (r.body?.error === 'no_key') { state.yt = false; state.ytStatus = null; }
    else state.ytStatus = { kind: 'error', text: `${ytErrorText(r.body, r.status)} Pegá un link abajo.` };
    return renderVideo();
  }
  const lyrics = relevantLyrics(state.results, track, artist);
  state.videos = rankVideos(r.body.videos || [], lyrics.length ? lyrics : [state.candidate], track, artist);
  state.ytStatus = state.videos.length ? null
    : { kind: 'empty', text: 'YouTube no devolvió videos que se puedan ver acá. Pegá un link abajo.' };
  pickBestPair();
}

// El mejor video y, si el usuario no eligió la letra a mano, la versión más cercana a su duración
function pickBestPair(video = state.videos[0]) {
  state.autoVideo = video || null;
  const lyrics = relevantLyrics(state.results, $('q-track').value.trim(), $('q-artist').value.trim());
  const ref = currentVideo();
  if (!state.lyricManual && ref?.duration && lyrics.length) state.candidate = pickLyricFor(lyrics, ref.duration);
  renderResults();
  renderChosen();
}

function renderVideo() {
  const video = currentVideo();
  const c = state.candidate;
  const pick = $('yt-pick');
  pick.classList.toggle('hidden', !video);
  if (video) {
    $('yt-thumb').src = thumb(video.id);
    $('yt-title').textContent = video.title || 'Video pegado a mano';
    const parts = [];
    if (video.channel) parts.push(esc(video.channel));
    if (video.duration) parts.push(`<span class="num">${fmtTime(video.duration)}</span>`);
    const diff = video.duration && c ? Math.round(Math.abs(video.duration - c.duration)) : null;
    $('yt-meta').innerHTML = `${parts.join(' · ')}${diff !== null ? ` ${durationPill(diff)}` : ''}`;
  }
  $('yt-source').textContent = !video ? '' : state.manualVideo ? 'Pegado a mano' : 'Propuesto';

  const st = $('yt-status');
  let text = '', kind = '';
  if (state.yt === false) {
    text = 'Búsqueda automática apagada: falta la clave de YouTube. Pegá el link abajo.';
    kind = 'off';
  } else if (state.ytStatus && !state.manualVideo) {
    ({ text, kind } = state.ytStatus);
  } else if (!video && !c) {
    text = 'Elegí una canción y te proponemos el video.';
    kind = 'idle';
  }
  st.textContent = text;
  st.className = `yt-status ${kind}`;

  // alternativas: las 3 siguientes de la lista, sin repetir la elegida
  const alts = state.manualVideo ? [] : state.videos.filter((v) => v !== state.autoVideo).slice(0, 3);
  $('yt-alts-wrap').classList.toggle('hidden', !alts.length);
  const ul = $('yt-alts');
  ul.innerHTML = '';
  for (const v of alts) {
    const li = document.createElement('li');
    const diff = c ? Math.round(Math.abs(v.duration - c.duration)) : null;
    li.innerHTML = `
      <button type="button" class="alt" aria-label="Usar este video: ${esc(v.title)}">
        <img src="${thumb(v.id)}" alt="" width="64" height="36" loading="lazy">
        <span class="alt-text"><span class="alt-title">${esc(v.title)}</span><span class="ui-meta">${esc(v.channel)} · <span class="num">${fmtTime(v.duration)}</span>${diff !== null ? ` · ${diff <= DUR_OK ? 'coincide' : `<span class="num">${diff}</span> s de diferencia`}` : ''}</span></span>
      </button>`;
    li.querySelector('button').addEventListener('click', () => pickBestPair(v));
    ul.appendChild(li);
  }
  updateStartButton();
}

let pasteTimer = null;
$('yt-url').addEventListener('input', () => {
  const id = parseYouTubeId($('yt-url').value);
  clearTimeout(pasteTimer);
  state.manualVideo = id ? { id, title: '', channel: '', duration: 0 } : null;
  renderResults();
  renderChosen();
  // con clave, pedimos título y duración del video pegado (1 unidad de cuota) para elegir la letra que coincide
  if (id && state.yt) {
    pasteTimer = setTimeout(async () => {
      try {
        const r = await apiGet(`/api/youtube/video?id=${id}`);
        if (!r.ok || state.manualVideo?.id !== id) return;
        state.manualVideo = r.body.video;
        pickBestPair(state.autoVideo);
      } catch { /* sin detalles: el video pegado sirve igual */ }
    }, 400);
  }
});

function updateStartButton() {
  $('start-btn').disabled = !(state.candidate && currentVideo());
  $('setup-msg').textContent = '';
}

$('start-btn').addEventListener('click', () => {
  startPractice(state.candidate, currentVideo().id);
});

// ---------- Práctica ----------

const ytReady = new Promise((resolve) => {
  if (window.YT && window.YT.Player) resolve();
  else window.onYouTubeIframeAPIReady = resolve;
});

async function startPractice(lrcItem, videoId) {
  const lines = parseLrc(lrcItem.syncedLyrics);
  if (!lines.length) {
    $('setup-msg').textContent = 'Esta letra no tiene versos con tiempo. Elegí otra versión de la lista.';
    return;
  }
  state.song = { id: lrcItem.id, trackName: lrcItem.trackName, artistName: lrcItem.artistName, duration: lrcItem.duration, lines };
  writeStore(`sd:lrc:${lrcItem.id}`, { id: lrcItem.id, trackName: lrcItem.trackName, artistName: lrcItem.artistName, duration: lrcItem.duration, syncedLyrics: lrcItem.syncedLyrics });
  state.videoId = videoId;

  const n = lines.length;
  const saved = readStore(progressKey(), null);
  state.idx = saved ? Math.min(saved.idx, n - 1) : 0;
  state.best = saved?.best?.length === n ? saved.best : new Array(n).fill(0);
  state.revealed = saved?.revealed?.length === n ? saved.revealed : new Array(n).fill(false);
  state.awarded = saved?.awarded?.length === n ? saved.awarded : new Array(n).fill(false);
  state.songPoints = saved?.songPoints || 0;
  state.bestCombo = saved?.bestCombo || 0;
  state.combo = 0;
  setOffset(readStore(offsetKey(), 0));

  history.replaceState(null, '', `?lrc=${lrcItem.id}&v=${videoId}&lvl=${state.level}`);

  showScreen('practice');
  document.title = `${state.song.trackName} — Song Dictation`;
  $('song-title').textContent = state.song.trackName;
  $('song-meta').innerHTML = `${esc(state.song.artistName)} · <span class="num">${fmtTime(state.song.duration)}</span> · <span class="num">${n}</span> versos · ${LEVELS[state.level].label}`;
  $('song-cover').src = thumb(videoId);
  $('line-total').textContent = n;
  $('line-total-2').textContent = n;
  renderPoints();
  saveProgress();

  await ytReady;
  if (state.player) {
    state.captionsOff = false;
    state.player.cueVideoById(videoId);
  } else {
    state.player = new YT.Player('player', {
      videoId,
      playerVars: { rel: 0, playsinline: 1, cc_load_policy: 0 },
      events: { onReady: checkDuration, onError: onPlayerError, onStateChange: onPlayerState },
    });
  }
  showLine();
}

function onPlayerState(e) {
  // Los subtítulos regalan la respuesta: los apagamos al empezar, el botón CC sigue disponible
  if (e.data === YT.PlayerState.PLAYING && !state.captionsOff) {
    state.captionsOff = true;
    state.player.unloadModule('captions');
  }
  $('play-btn').classList.toggle('playing', e.data === YT.PlayerState.PLAYING);
}

function showSyncMsg(text) {
  $('sync-msg').textContent = text;
  $('sync-msg').classList.toggle('hidden', !text);
}

function checkDuration() {
  const d = state.player.getDuration();
  showSyncMsg(d && Math.abs(d - state.song.duration) > 3 && state.offset === 0
    ? `El video dura ${fmtTime(d)} y la letra ${fmtTime(state.song.duration)}: puede que tenga intro. Si los versos no coinciden, usá Sincronización, acá abajo.`
    : '');
}

function onPlayerError(e) {
  const msgs = {
    2: 'El link de YouTube no es válido. Volvé a Canciones y pegalo de nuevo.',
    100: 'El video no existe o es privado. Probá con otro video de la canción.',
    101: 'El dueño del video no permite reproducirlo fuera de YouTube. Probá con otro video de la canción.',
    150: 'El dueño del video no permite reproducirlo fuera de YouTube. Probá con otro video de la canción.',
  };
  showSyncMsg(msgs[e.data] || `El reproductor falló (error ${e.data}). Recargá la página.`);
}

function setOffset(v) {
  state.offset = Math.round(v * 10) / 10;
  $('offset').value = state.offset;
  const label = `${state.offset > 0 ? '+' : state.offset < 0 ? '−' : ''}${Math.abs(state.offset).toFixed(1)} s`;
  $('offset-val').textContent = label;
}

$('offset').addEventListener('input', (e) => { setOffset(Number(e.target.value)); saveProgress(); });

$('sync-btn').addEventListener('click', () => {
  const p = state.player;
  if (!p) return;
  if (!state.syncing) {
    clearInterval(state.stopTimer);
    state.syncing = true;
    p.setPlaybackRate(1);
    p.seekTo(0, true);
    p.playVideo();
    $('sync-btn').textContent = 'Ahora: cuando empieza a cantar';
  } else {
    state.syncing = false;
    setOffset(p.getCurrentTime() - state.song.lines[0].start);
    p.pauseVideo();
    $('sync-btn').textContent = 'Marcar el primer verso';
    showSyncMsg('');
    saveProgress();
  }
});

function playLine(rate = 1) {
  const p = state.player;
  if (!p || !p.seekTo) return;
  const line = state.song.lines[state.idx];
  const stopAt = line.end + state.offset + TAIL;
  clearInterval(state.stopTimer);
  p.setPlaybackRate(rate);
  p.seekTo(Math.max(0, line.start + state.offset - 0.15), true);
  p.playVideo();
  state.stopTimer = setInterval(() => {
    if (p.getCurrentTime() >= stopAt) {
      p.pauseVideo();
      clearInterval(state.stopTimer);
    }
  }, 50);
  focusInput();
}

const isGapMode = () => state.level !== 'full';

function focusInput() {
  if (!isGapMode()) return $('answer').focus({ preventScroll: true });
  const open = [...$('gap-area').querySelectorAll('input')].find((i) => !i.readOnly);
  if (open) open.focus({ preventScroll: true });
}

function setFinding(html) {
  $('finding').innerHTML = html;
}

function showLine() {
  const line = state.song.lines[state.idx];
  state.hints = 0;
  state.solved = false;
  $('work').classList.remove('hidden');
  $('done').classList.add('hidden');
  $('line-num').textContent = state.idx + 1;
  $('line-time').textContent = `${fmtStamp(line.start)} – ${fmtStamp(line.end)}`;
  $('feedback').innerHTML = '';
  $('answer').value = '';
  $('answer').classList.toggle('hidden', isGapMode());
  $('gap-area').classList.toggle('hidden', !isGapMode());
  if (isGapMode()) renderGaps(line);
  if (state.best[state.idx] === 1) setFinding('Ya lo resolviste. Escribilo otra vez para repasar, o seguí al siguiente.');
  else if (state.revealed[state.idx]) setFinding('Lo revelaste antes: este verso ya no suma puntos.');
  else setFinding(isGapMode()
    ? `Completá <b>${pickGaps(line.text, LEVELS[state.level].ratio, state.idx).size} ${pickGaps(line.text, LEVELS[state.level].ratio, state.idx).size === 1 ? 'palabra' : 'palabras'}</b> de este verso.`
    : `Este verso tiene <b>${tokenize(line.text).length} palabras</b>. Escuchalo y escribilo entero.`);
  renderProgress();
  focusInput();
}

function renderGaps(line) {
  const gaps = pickGaps(line.text, LEVELS[state.level].ratio, state.idx);
  const area = $('gap-area');
  area.innerHTML = '';
  let k = 0; // índice entre palabras reales (sin puntuación suelta)
  for (const shown of line.text.split(/\s+/)) {
    const norm = normWord(shown);
    if (norm && gaps.has(k)) {
      const input = document.createElement('input');
      input.dataset.answer = norm;
      input.style.width = `${Math.max(norm.length, 2) + 1.5}ch`;
      input.setAttribute('aria-label', `Palabra de ${norm.length} letras`);
      input.autocomplete = 'off';
      input.spellcheck = false;
      area.appendChild(input);
    } else {
      const span = document.createElement('span');
      span.textContent = shown;
      area.appendChild(span);
    }
    if (norm) k++;
  }
}

function lineState(i) {
  if (state.best[i] === 1) return 'done';
  if (state.revealed[i]) return 'revealed';
  if (state.best[i] > 0) return 'partial';
  return 'todo';
}

function renderProgress() {
  const lines = state.song.lines;
  // tira de versos
  const strip = $('strip');
  strip.innerHTML = '';
  lines.forEach((line, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = [lineState(i), i === state.idx && 'current'].filter(Boolean).join(' ');
    b.setAttribute('aria-label', `Verso ${i + 1}`);
    b.title = `Verso ${i + 1} · ${fmtStamp(line.start)}`;
    b.addEventListener('click', () => goTo(i));
    strip.appendChild(b);
  });
  const done = solvedCount();
  const revealed = state.revealed.filter((r, i) => r && state.best[i] !== 1).length;
  $('strip-summary').innerHTML = `<span class="num">${done}</span> de <span class="num">${lines.length}</span> versos resueltos${revealed ? ` · <span class="num">${revealed}</span> revelados` : ''}`;

  // hoja de letra
  const sheet = $('sheet');
  sheet.innerHTML = '';
  lines.forEach((line, i) => {
    const li = document.createElement('li');
    const st = lineState(i);
    const shown = st === 'done' || st === 'revealed';
    if (i === state.idx) li.className = 'current';
    const words = tokenize(line.text);
    const body = shown
      ? `<span class="txt">${esc(line.text)}</span>`
      : `<span class="bars" aria-label="${words.length} palabras">${words.map((t) => `<i style="width:${Math.min(t.norm.length, 10) * 6 + 6}px"></i>`).join('')}</span>`;
    const pill = st === 'done' ? '<span class="ui-pill pos">Resuelto</span>'
      : st === 'revealed' ? '<span class="ui-pill">Revelado</span>'
      : st === 'partial' ? `<span class="ui-pill"><span class="num">${Math.round(state.best[i] * 100)}</span>%</span>`
      : '<span class="dash" aria-label="Sin hacer">—</span>';
    li.innerHTML = `<span class="n">${i + 1}</span>${body}<span class="t num">${fmtStamp(line.start)}</span><span class="s">${pill}</span>`;
    li.addEventListener('click', () => goTo(i));
    sheet.appendChild(li);
  });
  const current = sheet.children[state.idx];
  if (current) current.scrollIntoView({ block: 'nearest' });
  $('solved-count').textContent = done;

  $('score').textContent = accuracy();
  $('combo').textContent = state.combo;
  renderPoints();
}

function lineSolved(wordCount) {
  state.solved = true;
  if (!state.awarded[state.idx] && !state.revealed[state.idx]) {
    state.awarded[state.idx] = true;
    state.combo++;
    state.bestCombo = Math.max(state.bestCombo, state.combo);
    const pts = wordCount * POINTS.word + (state.combo - 1) * POINTS.comboBonus;
    addPoints(pts);
    return pts;
  }
  return 0;
}

function verdict(perfect, score, earned) {
  if (perfect) {
    const parts = [earned ? `+${earned} pts` : '', state.combo > 1 ? `racha de ${state.combo}` : ''].filter(Boolean).join(' · ');
    return `<p class="ui-verdict good">Perfecto${parts ? ` · ${parts}` : ''}. Enter para el siguiente.</p>`;
  }
  return `<p class="ui-verdict"><span class="num">${Math.round(score * 100)}</span>% bien. Escuchalo otra vez y corregí lo marcado.</p>`;
}

function check() {
  if (state.solved) return next();
  const line = state.song.lines[state.idx];

  if (isGapMode()) {
    const inputs = [...$('gap-area').querySelectorAll('input')];
    if (!inputs.some((i) => i.value.trim())) return;
    let ok = 0;
    for (const input of inputs) {
      const good = normWord(input.value) === input.dataset.answer;
      input.classList.toggle('ok', good);
      input.classList.toggle('bad', !good && Boolean(input.value.trim()));
      input.readOnly = good;
      if (good) ok++;
    }
    const score = ok / inputs.length;
    state.best[state.idx] = Math.max(state.best[state.idx], score);
    const earned = score === 1 ? lineSolved(inputs.length) : (state.combo = 0);
    $('feedback').innerHTML = verdict(score === 1, score, earned);
    setFinding(score === 1 ? 'Resuelto.' : `Te ${inputs.length - ok === 1 ? 'falta' : 'faltan'} <b>${inputs.length - ok} de ${inputs.length}</b> ${inputs.length === 1 ? 'palabra' : 'palabras'}.`);
    focusInput();
  } else {
    const typed = $('answer').value;
    if (!typed.trim()) return;
    const r = compare(line.text, typed);
    state.best[state.idx] = Math.max(state.best[state.idx], r.score);
    const earned = r.perfect ? lineSolved(r.total) : (state.combo = 0);
    const words = r.ops.map((o) => `<span class="ui-mark ${o.type}">${o.type === 'miss' ? '_'.repeat(Math.max(2, normWord(o.word).length)) : esc(o.word)}</span>`);
    $('feedback').innerHTML = `<div class="ui-marks">${words.join('')}</div>${verdict(r.perfect, r.score, earned)}`;
    setFinding(r.perfect ? 'Resuelto.' : `Te ${r.missing === 1 ? 'falta' : 'faltan'} <b>${r.missing} de ${r.total}</b> ${r.total === 1 ? 'palabra' : 'palabras'}.`);
  }
  renderProgress();
  saveProgress();
}

function hint() {
  if (state.solved) return;
  addPoints(-POINTS.hint);
  const line = state.song.lines[state.idx];
  if (isGapMode()) {
    // completa una letra más del primer hueco sin resolver
    const input = [...$('gap-area').querySelectorAll('input')].find((i) => !i.readOnly);
    if (!input) return;
    const answer = input.dataset.answer;
    let n = 0;
    while (n < answer.length && normWord(input.value)[n] === answer[n]) n++;
    input.value = answer.slice(0, n + 1);
    input.classList.remove('bad');
    input.focus();
  } else {
    state.hints = Math.min(state.hints + 1, tokenize(line.text).length);
    $('feedback').innerHTML = `<div class="ui-marks"><span class="ui-mark hint">${esc(hintText(line.text, state.hints))}</span></div>`;
    $('answer').focus();
  }
}

function reveal() {
  if (state.solved) return;
  const line = state.song.lines[state.idx];
  if (!state.revealed[state.idx]) addPoints(-POINTS.reveal);
  state.revealed[state.idx] = true;
  state.combo = 0;
  if (isGapMode()) {
    $('gap-area').querySelectorAll('input:not([readonly])').forEach((i) => { i.value = i.dataset.answer; i.classList.remove('bad'); });
  }
  $('feedback').innerHTML = `<div class="ui-marks"><span class="ui-mark">${esc(line.text)}</span></div>`;
  setFinding('Revelado: escribilo igual para fijarlo. Este verso ya no suma puntos.');
  renderProgress();
  saveProgress();
  focusInput();
}

function goTo(i, autoplay = true) {
  state.idx = Math.max(0, Math.min(i, state.song.lines.length - 1));
  saveProgress();
  showLine();
  if (autoplay) playLine();
}

function next() {
  if (state.idx < state.song.lines.length - 1) goTo(state.idx + 1);
  else finish();
}

function skip() {
  if (!state.solved && !state.awarded[state.idx]) {
    addPoints(-POINTS.skip);
    state.combo = 0;
  }
  next();
}

function finish() {
  clearInterval(state.stopTimer);
  if (state.player && state.player.pauseVideo) state.player.pauseVideo();
  $('work').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('done-title').textContent = state.song.trackName;
  $('done-acc').innerHTML = `${accuracy()}<small>%</small>`;
  $('done-pts').textContent = fmtNum(state.songPoints);
  $('done-best').innerHTML = `${state.bestCombo}<small>${state.bestCombo === 1 ? 'verso' : 'versos'}</small>`;
}

function backToSetup() {
  clearInterval(state.stopTimer);
  if (state.player && state.player.pauseVideo) state.player.pauseVideo();
  history.replaceState(null, '', location.pathname);
  document.title = 'Song Dictation — práctica';
  renderRecents();
  showScreen('setup');
}

$('play-btn').addEventListener('click', () => playLine(1));
$('slow-btn').addEventListener('click', () => playLine(0.75));
$('check-btn').addEventListener('click', check);
$('hint-btn').addEventListener('click', hint);
$('reveal-btn').addEventListener('click', reveal);
$('skip-btn').addEventListener('click', skip);
$('prev-btn').addEventListener('click', () => goTo(state.idx - 1));
$('back-btn').addEventListener('click', backToSetup);
$('other-btn').addEventListener('click', backToSetup);
$('restart-btn').addEventListener('click', () => {
  const n = state.song.lines.length;
  state.best = new Array(n).fill(0);
  state.revealed = new Array(n).fill(false);
  state.awarded = new Array(n).fill(false);
  state.songPoints = 0;
  state.combo = 0;
  state.bestCombo = 0;
  renderPoints();
  goTo(0);
});

$('answer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    check();
  }
});

$('gap-area').addEventListener('keydown', (e) => {
  if (e.target.tagName !== 'INPUT') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    check();
  } else if (e.key === ' ') {
    // espacio salta al siguiente hueco, como si escribieras de corrido
    e.preventDefault();
    const inputs = [...$('gap-area').querySelectorAll('input')];
    const nextOpen = inputs.slice(inputs.indexOf(e.target) + 1).find((i) => !i.readOnly);
    if (nextOpen) nextOpen.focus();
  }
});

$('gap-area').addEventListener('input', (e) => e.target.classList.remove('bad'));

document.addEventListener('keydown', (e) => {
  if ($('practice').classList.contains('hidden') || !e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); playLine(1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); skip(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(state.idx - 1); }
});

// ---------- Inicio y link compartible: ?lrc=ID&v=VIDEO&lvl=NIVEL ----------

(async function init() {
  const params = new URLSearchParams(location.search);
  selectLevel(params.get('lvl') || readStore('sd:level', 'full'));
  renderPoints();
  renderRecents();
  renderStarters();
  checkYouTube();

  const lrcId = params.get('lrc');
  const videoId = params.get('v');
  if (!lrcId || !videoId) return;
  try {
    startPractice(await fetchLyrics(lrcId), videoId);
  } catch (err) {
    $('setup-msg').textContent = err instanceof TypeError
      ? 'No hay conexión con LRCLIB. Revisá internet y recargá.'
      : err.message;
  }
})();
