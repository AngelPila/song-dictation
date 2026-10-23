'use strict';
// Servicio mínimo para buscar el video de YouTube de una canción con la YouTube Data API v3.
// Sin dependencias: http y fetch de Node. La clave vive en YOUTUBE_API_KEY y nunca sale de acá.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const CACHE_FILE = process.env.CACHE_FILE || '/data/cache.json';
const SEARCH_TTL = 30 * 24 * 3600 * 1000; // una búsqueda cuesta 100 unidades: la guardamos un mes
const VIDEO_TTL = 90 * 24 * 3600 * 1000;
const YT = process.env.YT_BASE || 'https://www.googleapis.com/youtube/v3'; // YT_BASE solo para pruebas
const OEMBED = process.env.OEMBED_BASE || 'https://www.youtube.com/oembed';
const REGION = (process.env.YT_REGION || 'EC').toUpperCase(); // país desde el que se mira: para los bloqueos regionales
const PLAYABLE_TTL = 24 * 3600 * 1000; // el dueño puede cambiar el permiso de inserción: lo revisamos una vez por día

// ---------- Caché en memoria, persistida en un archivo ----------
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) { console.warn('no se pudo guardar la caché:', e.message); }
  }, 500);
}
function getCached(k) {
  const e = cache[k];
  if (!e) return null;
  if (Date.now() > e.exp) { delete cache[k]; return null; }
  return e.v;
}
function setCached(k, v, ttl) { cache[k] = { v, exp: Date.now() + ttl }; persist(); }

// Pedidos iguales en vuelo comparten la misma promesa: no se paga dos veces la cuota
const inflight = new Map();
function once(k, fn) {
  if (inflight.has(k)) return inflight.get(k);
  const p = fn().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

// ---------- YouTube ----------
class YtError extends Error {
  constructor(status, reason) { super(reason || `YouTube respondió ${status}`); this.status = status; this.reason = reason; }
}

async function yt(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(`${YT}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new YtError(res.status, body?.error?.errors?.[0]?.reason || body?.error?.message);
  return body;
}

// PT1H2M3S → segundos
function isoSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// videos.list: 1 unidad por cada 50 ids
async function videoDetails(ids) {
  const out = {};
  const missing = [];
  for (const id of ids) {
    const c = getCached(`v:${id}`);
    if (c) out[id] = c; else missing.push(id);
  }
  if (missing.length) {
    const body = await yt('videos', {
      part: 'snippet,contentDetails,status',
      id: missing.join(','),
      fields: 'items(id,snippet(title,channelTitle),contentDetails(duration,regionRestriction,contentRating/ytRating),status(embeddable,privacyStatus))',
    });
    for (const it of body.items || []) {
      const region = it.contentDetails?.regionRestriction || {};
      const v = {
        id: it.id,
        title: it.snippet?.title || '',
        channel: it.snippet?.channelTitle || '',
        duration: isoSeconds(it.contentDetails?.duration),
        embeddable: it.status?.embeddable !== false,
        private: it.status?.privacyStatus === 'private',
        ageRestricted: it.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
        regionBlocked: Boolean((region.blocked || []).includes(REGION) || (region.allowed && !region.allowed.includes(REGION))),
      };
      out[it.id] = v;
      setCached(`v:${it.id}`, v, VIDEO_TTL);
    }
  }
  return ids.map((id) => out[id]).filter(Boolean);
}

// search.list: 100 unidades; devuelve hasta 10 videos insertables con su duración
async function searchSong(track, artist) {
  const q = `${artist} ${track} audio`.trim().replace(/\s+/g, ' ');
  const k = `s:${q.toLowerCase()}`;
  const hit = getCached(k);
  if (hit) return { videos: await videoDetails(hit), cached: true };
  return once(k, async () => {
    const body = await yt('search', {
      part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '10', q,
      fields: 'items(id(videoId))',
    });
    const ids = (body.items || []).map((i) => i.id?.videoId).filter(Boolean);
    setCached(k, ids, SEARCH_TTL);
    return { videos: await videoDetails(ids), cached: false };
  });
}

// ¿Se puede reproducir insertado en otra página?
// oEmbed no pide clave: 401 = el dueño desactivó la inserción, 404/400 = privado, borrado o inexistente.
// Con clave sumamos lo que oEmbed no dice: restricción por edad y bloqueo en el país (los dos impiden verlo insertado).
const VERDICT_TEXT = {
  ok: 'Se puede reproducir acá',
  embed_disabled: 'El dueño no permite reproducirlo fuera de YouTube',
  not_found: 'El video no existe, es privado o fue borrado',
  age_restricted: 'Tiene restricción de edad: YouTube no lo deja ver fuera de su sitio',
  region_blocked: `No se puede ver desde este país (${REGION})`,
};

async function oembed(id) {
  const target = `https://www.youtube.com/watch?v=${id}`;
  const res = await fetch(`${OEMBED}?${new URLSearchParams({ url: target, format: 'json' })}`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 401 || res.status === 403) return { verdict: 'embed_disabled' };
  if (res.status === 404 || res.status === 400) return { verdict: 'not_found' };
  if (!res.ok) throw new YtError(res.status, 'oembed');
  const body = await res.json().catch(() => ({}));
  return { verdict: 'ok', title: body.title || '', channel: body.author_name || '' };
}

async function playable(id) {
  const k = `p:${id}`;
  const hit = getCached(k);
  if (hit) return hit;
  return once(k, async () => {
    const o = await oembed(id);
    let verdict = o.verdict;
    let info = { title: o.title || '', channel: o.channel || '', duration: 0 };
    if (KEY && verdict === 'ok') {
      const [v] = await videoDetails([id]).catch(() => []);
      if (v) {
        info = { title: v.title || info.title, channel: v.channel || info.channel, duration: v.duration };
        if (!v.embeddable) verdict = 'embed_disabled';
        else if (v.private) verdict = 'not_found';
        else if (v.ageRestricted) verdict = 'age_restricted';
        else if (v.regionBlocked) verdict = 'region_blocked';
      }
    }
    const out = { id, playable: verdict === 'ok', verdict, text: VERDICT_TEXT[verdict], checkedWithKey: Boolean(KEY), ...info };
    setCached(k, out, PLAYABLE_TTL);
    return out;
  });
}

// ---------- HTTP ----------
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const clean = (s, max = 120) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  try {
    if (url.pathname === '/api/status') {
      return send(res, 200, { youtube: Boolean(KEY) });
    }
    if (url.pathname === '/api/youtube/search') {
      if (!KEY) return send(res, 503, { error: 'no_key' });
      const track = clean(url.searchParams.get('track'));
      const artist = clean(url.searchParams.get('artist'));
      if (!track) return send(res, 400, { error: 'track' });
      return send(res, 200, await searchSong(track, artist));
    }
    if (url.pathname === '/api/youtube/playable') {
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]{11}$/.test(id)) return send(res, 400, { error: 'id' });
      return send(res, 200, await playable(id));
    }
    if (url.pathname === '/api/youtube/video') {
      if (!KEY) return send(res, 503, { error: 'no_key' });
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]{11}$/.test(id)) return send(res, 400, { error: 'id' });
      const [video] = await videoDetails([id]);
      return video ? send(res, 200, { video }) : send(res, 404, { error: 'not_found' });
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof YtError) {
      console.warn('YouTube:', e.status, e.reason);
      return send(res, 502, { error: 'youtube', status: e.status, reason: e.reason || '' });
    }
    console.error(e);
    return send(res, 502, { error: 'upstream', reason: e.name === 'TimeoutError' ? 'timeout' : 'network' });
  }
});

server.listen(PORT, () => console.log(`api en :${PORT} · clave de YouTube ${KEY ? 'configurada' : 'ausente'}`));
