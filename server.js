'use strict';
/*
  Matchday scoreboard server.
  - Serves the control app at /control and the OBS overlay at /overlay.
  - Keeps the match in memory (and in data/state.json) and pushes every change to every open page
    with Server-Sent Events, so the overlay in OBS follows the control app on any device.
  - In live mode it follows a real match from API-Football (see feed.js).
  - Changes need the CONTROL_KEY when one is set. No npm packages needed.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Match = require('./public/match.js');
const createFeed = require('./feed.js');

const PORT = Number(process.env.PORT) || 8080;
const CONTROL_KEY = String(process.env.CONTROL_KEY || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGES = { '/control': 'control.html', '/overlay': 'overlay.html' };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// What the control app may change. The feed details, crest versions and competition link are the server's.
const PATCHABLE = ['mode', 'onAir', 'scale', 'clockOffset', 'comp', 'kickoff', 'kickoffAt', 'home', 'away', 'period', 'note', 'clock',
  'added', 'score', 'pens', 'stats', 'statsShown', 'goals', 'reds', 'anims', 'show', 'bug', 'card', 'writer', 'rev'];

let state = Match.defaults();
const crests = { home: null, away: null }; // { type, base64 }
const clients = new Set();

/* ---------- Live updates ---------- */
function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function broadcast() {
  const msg = frame('state', { state, now: Date.now() });
  for (const res of clients) res.write(msg);
}
function changed() {
  state.ts = Date.now();
  broadcast();
  saveSoon();
}
function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(frame('state', { state, now: Date.now() }));
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
// A ping every 15 seconds keeps connections open through proxies and keeps every clock in sync.
setInterval(() => {
  const msg = frame('ping', { now: Date.now() });
  for (const res of clients) res.write(msg);
}, 15000).unref();

/* ---------- Live feed ---------- */
const feed = createFeed({
  get: () => state,
  changed,
  setCrest(side, crest) {
    crests[side] = crest;
    state[side].crestV = Date.now();
  },
});

/* ---------- Saving to disk, so a restart keeps the match ---------- */
function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = Match.normalize(saved.state);
    ['home', 'away'].forEach((side) => {
      const c = saved.crests && saved.crests[side];
      crests[side] = c && /^image\/(png|jpeg|webp)$/.test(c.type) && typeof c.base64 === 'string' ? c : null;
      if (!crests[side]) state[side].crestV = 0;
    });
    // A clock left running for hours (an old session) comes back paused instead of showing 400 minutes.
    if (state.clock.running && Date.now() - state.clock.at > 6 * 3600 * 1000 && state.mode !== 'live') state.clock.running = false;
    console.log(`Loaded the saved match from ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read the saved match, starting fresh: ${err.message}`);
  }
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state, crests }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.warn(`Could not save the match: ${err.message}`);
  }
}

/* ---------- Helpers ---------- */
function authorised(req) {
  if (!CONTROL_KEY) return true;
  const given = Buffer.from(String(req.headers['x-control-key'] || ''));
  const want = Buffer.from(CONTROL_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
const httpError = (status, message) => Object.assign(new Error(message), { status });
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) { reject(httpError(413, 'That was too big to accept.')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(httpError(400, 'That wasn’t valid JSON.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function serveFile(res, relative) {
  const full = path.join(PUBLIC_DIR, relative);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(buf);
  });
  return undefined;
}

/* ---------- Routes ---------- */
async function handle(req, res) {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    return sendJson(res, 400, { error: 'Bad address' });
  }
  const method = req.method;

  if (method === 'GET' && pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (method === 'GET' && pathname === '/api/events') return openStream(req, res);
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, { state, now: Date.now() });
  if (method === 'GET' && pathname === '/api/session') return sendJson(res, 200, { locked: !!CONTROL_KEY, ok: authorised(req) });

  // A change from the control app, as a list of [path, value] patches.
  if (method === 'POST' && pathname === '/api/state') {
    if (!authorised(req)) return sendJson(res, 401, { error: 'Wrong or missing control key.' });
    const body = await readJson(req, 96 * 1024);
    const prev = state;
    const draft = Match.copy(prev);
    Match.applyPatch(draft, body && body.patch, PATCHABLE);
    const next = Match.normalize(draft);
    next.home.crestV = prev.home.crestV; // crests only change through /api/crest
    next.away.crestV = prev.away.crestV;
    next.compKey = prev.compKey;
    next.feed = prev.feed;
    state = next;
    if (body && Array.isArray(body.ignore)) feed.ignore(body.ignore);
    if (next.mode === 'live' && prev.mode === 'live' && next.period !== prev.period) feed.holdPeriod(next.period);
    if (next.mode !== prev.mode) feed.onModeChange();
    else if (next.clockOffset !== prev.clockOffset) feed.resync();
    changed();
    return sendJson(res, 200, { ok: true, ts: state.ts });
  }

  // The live feed
  if (pathname.startsWith('/api/feed/')) {
    if (!authorised(req)) return sendJson(res, 401, { error: 'Wrong or missing control key.' });
    const route = `${method} ${pathname}`;
    if (route === 'GET /api/feed/fixtures') {
      const fixtures = await feed.listFixtures(url.searchParams.get('comp'), url.searchParams.get('date'));
      return sendJson(res, 200, { fixtures });
    }
    if (route === 'GET /api/feed/account') return sendJson(res, 200, await feed.account());
    if (route === 'POST /api/feed/link') {
      const body = await readJson(req, 4096);
      const id = Number(body && body.fixtureId);
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'Pick a match first.' });
      await feed.link(id, String((body && body.comp) || ''));
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/feed/unlink') { feed.unlink(); return sendJson(res, 200, { ok: true }); }
    if (route === 'POST /api/feed/refresh') { feed.poll(); return sendJson(res, 200, { ok: true }); }
    if (route === 'POST /api/feed/settings') {
      const body = await readJson(req, 4096) || {};
      if ([15, 30, 60, 90, 120].includes(Number(body.pollSeconds))) state.feed.pollSeconds = Number(body.pollSeconds);
      if (typeof body.kitColours === 'boolean') state.feed.kitColours = body.kitColours;
      if (typeof body.crests === 'boolean') state.feed.crests = body.crests;
      feed.schedule();
      changed();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  const crest = /^\/api\/crest\/(home|away)$/.exec(pathname);
  if (crest) {
    const side = crest[1];
    if (method === 'GET' || method === 'HEAD') {
      const c = crests[side];
      if (!c) return sendJson(res, 404, { error: 'No crest' });
      res.writeHead(200, {
        'Content-Type': c.type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      });
      return res.end(Buffer.from(c.base64, 'base64'));
    }
    if (!authorised(req)) return sendJson(res, 401, { error: 'Wrong or missing control key.' });
    if (method === 'POST') {
      const body = await readJson(req, 1024 * 1024);
      const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String((body && body.dataUrl) || ''));
      if (!m) return sendJson(res, 400, { error: 'Send a PNG, JPEG or WebP image.' });
      crests[side] = { type: m[1], base64: m[2] };
      state[side].crestV = Date.now(); // new number every upload, so browsers never show an old crest
      state.feed.crests = false;       // a crest chosen by hand stays, even in live mode
    } else if (method === 'DELETE') {
      crests[side] = null;
      state[side].crestV = 0;
    } else {
      return sendJson(res, 405, { error: 'Not allowed' });
    }
    changed();
    return sendJson(res, 200, { ok: true, crestV: state[side].crestV });
  }

  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/') { res.writeHead(302, { Location: '/control' }); return res.end(); }
    if (PAGES[pathname]) return serveFile(res, PAGES[pathname]);
    return serveFile(res, pathname.replace(/^\/+/, ''));
  }
  return sendJson(res, 405, { error: 'Not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) { res.end(); return; }
    const status = err.status || (err.message && /live feed|API key|request limit/i.test(err.message) ? 502 : 500);
    sendJson(res, status, { error: err.status || status === 502 ? err.message : 'Something went wrong on the server.' });
    if (status === 500) console.error(err);
  });
});

function shutdown() {
  clearTimeout(saveTimer);
  saveNow();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

load();
feed.start();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Scoreboard running on port ${PORT}`);
  console.log(`  Control app: http://localhost:${PORT}/control`);
  console.log(`  Overlay:     http://localhost:${PORT}/overlay`);
  if (!CONTROL_KEY) console.warn('CONTROL_KEY is not set, so anyone with the control link can change the scoreboard.');
  if (!feed.available) console.warn('No API_FOOTBALL_KEY, so live data is off. Manual control still works.');
});
