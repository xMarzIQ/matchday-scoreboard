'use strict';
/*
  Live match feed from API-Football (api-sports.io).
  - Lists fixtures for the Premier League, Championship, League One, Champions League and Europa League.
  - Follows one linked match: score and scorers, red cards, stats, period and clock, kit colours and crests.
  - Works alongside the operator: a goal or red card pressed by hand stays on screen while the feed
    catches up, then the feed fills in who it was. Manual mode stops all of this.
*/
const Match = require('./public/match.js');

const KEY = String(process.env.API_FOOTBALL_KEY || '').trim();
const RAPID_KEY = String(process.env.RAPIDAPI_KEY || '').trim();
const RAPID_HOST = 'api-football-v1.p.rapidapi.com';
const BASE = String(process.env.API_FOOTBALL_BASE || (KEY || !RAPID_KEY ? 'https://v3.football.api-sports.io' : `https://${RAPID_HOST}/v3`)).replace(/\/+$/, '');
const TIMEZONE = process.env.MATCH_TIMEZONE || 'Europe/London';
const GRACE_MS = 5 * 60 * 1000; // how long something pressed by hand waits for the feed to agree
const NO_KEY = 'Live data needs an API-Football key. Add API_FOOTBALL_KEY to the server’s environment variables.';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const localTime = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(String(iso || '')); return m ? `${m[1]}:${m[2]}` : ''; };
const minuteOf = (time) => {
  const el = num(time && time.elapsed);
  const ex = num(time && time.extra);
  return el ? `${el}${ex ? `+${ex}` : ''}’` : '';
};
const timeValue = (e) => num(e.time && e.time.elapsed) * 100 + num(e.time && e.time.extra);
const eventKey = (e) => [e.type, e.detail, e.time && e.time.elapsed, (e.time && e.time.extra) || 0, e.team && e.team.id, (e.player && (e.player.id || e.player.name)) || ''].join('|');
function scorerName(e) {
  const name = String((e.player && e.player.name) || '').trim();
  if (!name) return '';
  if (/own goal/i.test(e.detail || '')) return `${name} (og)`;
  if (/penalty/i.test(e.detail || '')) return `${name} (pen)`;
  return name;
}

function createFeed(ctx) {
  const available = !!(KEY || RAPID_KEY);
  const mem = {
    animated: new Set(), // goals and cards already shown with an animation
    ignored: new Set(),  // feed goals the operator took off by hand
    lastFixture: null,   // used to re-line-up the clock without spending a request
    finalPolls: 0,
    hold: null,          // a period set by hand that the feed hasn't reached yet
    timer: null,
    busy: false,
    lists: new Map(),
    codes: new Map(),
    remaining: null,
    limit: null,
    account: null,
    accountAt: 0,
  };

  function headers() {
    if (KEY) return { 'x-apisports-key': KEY };
    return { 'x-rapidapi-key': RAPID_KEY, 'x-rapidapi-host': RAPID_HOST };
  }

  async function api(pathname, params) {
    if (!available) throw httpError(503, NO_KEY);
    const url = new URL(BASE + pathname);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(url, { headers: headers(), signal: ctrl.signal });
    } catch (e) {
      throw new Error('Couldn’t reach the live feed. Check the server’s internet connection.');
    } finally {
      clearTimeout(timer);
    }
    const left = res.headers.get('x-ratelimit-requests-remaining');
    const limit = res.headers.get('x-ratelimit-requests-limit');
    if (left !== null && left !== '' && Number.isFinite(Number(left))) mem.remaining = Number(left);
    if (limit !== null && limit !== '' && Number.isFinite(Number(limit))) mem.limit = Number(limit);
    if (res.status === 429) throw new Error('The live feed’s request limit was reached. Slow the updates down or move to a bigger plan.');
    if (res.status === 401 || res.status === 403) throw new Error('The live feed didn’t accept the API key. Check API_FOOTBALL_KEY.');
    if (!res.ok) throw new Error(`The live feed answered with an error (${res.status}).`);
    let body;
    try { body = await res.json(); } catch (e) { throw new Error('The live feed sent something unreadable.'); }
    const errs = body && body.errors ? (Array.isArray(body.errors) ? body.errors : Object.values(body.errors)) : [];
    if (errs.length) throw new Error(`Live feed: ${String(errs[0]).slice(0, 180)}`);
    return body ? body.response : null;
  }

  function publishQuota() {
    const s = ctx.get();
    s.feed.available = available;
    if (mem.remaining !== null) s.feed.remaining = mem.remaining;
    if (mem.limit !== null) s.feed.limit = mem.limit;
  }

  /* ---------- Choosing a match ---------- */
  const seasonFor = (date) => { const [y, m] = date.split('-').map(Number); return m >= 7 ? y : y - 1; };

  async function listFixtures(compKey, date) {
    const comp = Match.COMPETITIONS.find((c) => c.key === compKey);
    if (!comp) throw httpError(400, 'Pick a competition first.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw httpError(400, 'Pick a day.');
    const cacheKey = `${compKey}|${date}`;
    const hit = mem.lists.get(cacheKey);
    if (hit && Date.now() - hit.at < 90 * 1000) return hit.list;
    const rows = await api('/fixtures', { league: comp.id, season: seasonFor(date), date, timezone: TIMEZONE });
    const list = (Array.isArray(rows) ? rows : []).map((r) => {
      const f = r.fixture || {};
      const st = f.status || {};
      return {
        id: f.id,
        ts: num(f.timestamp) * 1000,
        kickoff: localTime(f.date),
        status: st.short || '',
        statusLong: st.long || '',
        elapsed: st.elapsed == null ? null : num(st.elapsed),
        home: (r.teams && r.teams.home && r.teams.home.name) || 'Home',
        away: (r.teams && r.teams.away && r.teams.away.name) || 'Away',
        goals: r.goals && r.goals.home != null ? [num(r.goals.home), num(r.goals.away)] : null,
        round: (r.league && r.league.round) || '',
      };
    }).sort((a, b) => a.ts - b.ts);
    mem.lists.set(cacheKey, { at: Date.now(), list });
    publishQuota();
    return list;
  }

  async function teamCode(team) {
    const id = team && team.id;
    if (mem.codes.has(id)) return mem.codes.get(id);
    let code = '';
    try {
      const rows = await api('/teams', { id });
      code = String((rows && rows[0] && rows[0].team && rows[0].team.code) || '').toUpperCase();
    } catch (e) { code = ''; }
    if (!/^[A-Z0-9]{2,4}$/.test(code)) code = String((team && team.name) || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    mem.codes.set(id, code);
    return code;
  }

  async function fetchCrest(url) {
    if (!/^https?:\/\//.test(String(url || ''))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(png|jpeg|webp)$/.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length && buf.length < 600000 ? { type, base64: buf.toString('base64') } : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function applyCrests(fx) {
    const teams = fx.teams || {};
    const [h, a] = await Promise.all([fetchCrest(teams.home && teams.home.logo), fetchCrest(teams.away && teams.away.logo)]);
    if (h) ctx.setCrest('home', h);
    if (a) ctx.setCrest('away', a);
  }

  async function link(fixtureId, compKey) {
    const rows = await api('/fixtures', { id: fixtureId, timezone: TIMEZONE });
    const fx = Array.isArray(rows) ? rows[0] : null;
    if (!fx || !fx.fixture) throw httpError(404, 'That match isn’t in the live feed.');
    const teams = fx.teams || {};
    const [hc, ac] = await Promise.all([teamCode(teams.home), teamCode(teams.away)]);
    const s = ctx.get();
    const comp = Match.COMPETITIONS.find((c) => c.key === compKey) || Match.COMPETITIONS.find((c) => fx.league && c.id === fx.league.id);
    mem.animated.clear();
    mem.ignored.clear();
    mem.finalPolls = 0;
    mem.hold = null;
    // A new match: clear the old one, keep the look and the layout.
    s.score = [0, 0];
    s.goals = [];
    s.reds = [];
    s.anims = [];
    s.pens = null;
    s.note = '';
    s.added = 0;
    s.clockOffset = 0;
    s.stats = Match.zeroStats();
    s.period = 'pre';
    Match.setClock(s, 0, false);
    s.comp = comp ? comp.name : String((fx.league && fx.league.name) || s.comp).slice(0, 40);
    s.compKey = comp ? comp.key : '';
    s.home.name = String((teams.home && teams.home.name) || 'Home').slice(0, 40);
    s.away.name = String((teams.away && teams.away.name) || 'Away').slice(0, 40);
    s.home.code = hc;
    s.away.code = ac;
    s.kickoff = localTime(fx.fixture.date) || s.kickoff;
    s.kickoffAt = num(fx.fixture.timestamp) * 1000;
    Object.assign(s.feed, { fixtureId: fx.fixture.id, compKey: s.compKey, title: `${s.home.name} v ${s.away.name}`, error: '', done: false, statsKeys: [] });
    s.mode = 'live';
    if (s.feed.crests) await applyCrests(fx);
    applyFixture(s, fx, true); // the match so far goes in without replaying animations
    s.feed.updatedAt = Date.now();
    publishQuota();
    schedule();
    ctx.changed();
  }

  function unlink() {
    clearTimeout(mem.timer);
    mem.timer = null;
    mem.lastFixture = null;
    const s = ctx.get();
    Object.assign(s.feed, { fixtureId: 0, compKey: '', title: '', status: '', statusShort: '', error: '', done: false, nextAt: 0, statsKeys: [] });
    s.mode = 'manual';
    ctx.changed();
  }

  /* ---------- Following the match ---------- */
  async function poll() {
    clearTimeout(mem.timer);
    mem.timer = null;
    const s = ctx.get();
    if (!available || s.mode !== 'live' || !s.feed.fixtureId || mem.busy) return;
    mem.busy = true;
    const id = s.feed.fixtureId;
    try {
      const rows = await api('/fixtures', { id, timezone: TIMEZONE });
      const fx = Array.isArray(rows) ? rows[0] : null;
      if (!fx || !fx.fixture) throw new Error('The live feed no longer has this match.');
      const cur = ctx.get(); // the operator may have changed things while we waited
      if (cur.mode === 'live' && cur.feed.fixtureId === id) {
        applyFixture(cur, fx, false);
        cur.feed.error = '';
        cur.feed.updatedAt = Date.now();
      }
    } catch (err) {
      ctx.get().feed.error = err.message;
    }
    mem.busy = false;
    publishQuota();
    schedule();
    ctx.changed();
  }

  function schedule() {
    clearTimeout(mem.timer);
    mem.timer = null;
    const s = ctx.get();
    if (!available || s.mode !== 'live' || !s.feed.fixtureId || s.feed.done) { s.feed.nextAt = 0; return; }
    const st = s.feed.statusShort;
    let wait;
    if (s.feed.error) wait = 60;
    else if (['NS', 'TBD', ''].includes(st)) {
      const toKickoff = s.kickoffAt - Date.now();
      wait = toKickoff > 90 * 60 * 1000 ? 15 * 60 : toKickoff > 0 ? 120 : 60; // lineups and kit colours land 20 to 40 minutes before kick-off
    } else if (['HT', 'BT'].includes(st)) wait = Math.max(60, s.feed.pollSeconds);
    else if (['FT', 'AET', 'PEN'].includes(st)) wait = 120; // a few last looks for late corrections, then stop
    else if (['PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(st)) wait = 15 * 60;
    else wait = s.feed.pollSeconds;
    s.feed.nextAt = Date.now() + wait * 1000;
    mem.timer = setTimeout(poll, wait * 1000);
  }

  function applyFixture(s, fx, quiet) {
    mem.lastFixture = fx;
    const teams = fx.teams || {};
    const homeId = teams.home && teams.home.id;
    const awayId = teams.away && teams.away.id;
    const sideOf = (team) => { const id = team && team.id; return id === homeId ? 0 : id === awayId ? 1 : -1; };
    const st = (fx.fixture && fx.fixture.status) || {};
    s.feed.status = String(st.long || '').slice(0, 60);
    s.feed.statusShort = String(st.short || '').slice(0, 8);

    applyPeriod(s, fx);

    const events = (Array.isArray(fx.events) ? fx.events : []).slice().sort((a, b) => timeValue(a) - timeValue(b));
    const official = [num(fx.goals && fx.goals.home), num(fx.goals && fx.goals.away)];
    const feedGoals = goalsFromEvents(events, sideOf, official).filter((g) => !mem.ignored.has(g.key));
    reconcile(s, 'goals', feedGoals, quiet);
    s.score = [0, 1].map((t) => s.goals.filter((g) => g.team === t).length);

    const feedReds = events
      .filter((e) => e.type === 'Card' && /red|second yellow/i.test(e.detail || '') && sideOf(e.team) >= 0)
      .map((e) => ({ team: sideOf(e.team), player: String((e.player && e.player.name) || '').trim(), minute: minuteOf(e.time), key: eventKey(e) }))
      .filter((r) => !mem.ignored.has(r.key));
    reconcile(s, 'reds', feedReds, quiet);

    applyStats(s, Array.isArray(fx.statistics) ? fx.statistics : [], sideOf);
    if (s.feed.kitColours) applyKits(s, Array.isArray(fx.lineups) ? fx.lineups : [], sideOf);

    const pen = fx.score && fx.score.penalty;
    s.pens = pen && pen.home != null && pen.away != null ? [num(pen.home), num(pen.away)] : null;

    if (['FT', 'AET', 'PEN'].includes(s.feed.statusShort)) {
      mem.finalPolls += 1;
      if (mem.finalPolls >= 4) s.feed.done = true;
    } else {
      mem.finalPolls = 0;
    }
  }

  // Period and clock. Uses the kick-off times of each half when the feed has them (accurate to the second),
  // otherwise the minute it reports, and leaves a running clock alone unless it has drifted.
  function applyPeriod(s, fx) {
    const f = fx.fixture || {};
    const st = f.status || {};
    const short = st.short || '';
    const el = num(st.elapsed);
    const ex = num(st.extra);
    const halves = f.periods || {};
    let period = s.period;
    if (['TBD', 'NS', 'PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(short)) period = 'pre';
    else if (short === '1H') period = '1h';
    else if (short === 'HT') period = 'ht';
    else if (short === '2H') period = '2h';
    else if (short === 'ET') period = el >= 106 ? 'et2' : 'et1';
    else if (short === 'BT') period = 'brk';
    else if (short === 'P') period = 'pens';
    else if (['FT', 'AET', 'PEN'].includes(short)) period = 'ft';
    s.note = short === 'AET' ? 'aet' : short === 'PEN' ? 'pens' : '';
    if (mem.hold) {
      if (period === mem.hold.period || Date.now() > mem.hold.until) mem.hold = null; // the feed caught up, or gave it long enough
      else return;                                                                 // the operator is ahead of the feed
    }
    const changed = period !== s.period;
    s.period = period;

    if (Match.PLAY.includes(period)) {
      if (short === 'SUSP' || short === 'INT') { Match.setClock(s, Match.elapsed(s), false); return; }
      const nowMs = Date.now();
      let target = null;
      if (period === '1h' && halves.first) target = (nowMs - num(halves.first) * 1000) / 1000;
      else if (period === '2h' && halves.second) target = 45 * 60 + (nowMs - num(halves.second) * 1000) / 1000;
      if (target !== null && Number.isFinite(target) && target >= 0 && target < 3 * 3600) {
        target = Math.max(Match.START[period], target) + s.clockOffset;
        if (changed || !s.clock.running || Math.abs(Match.elapsed(s) - target) > 3) Match.setClock(s, Math.max(0, target), true);
        return;
      }
      const reported = (el + ex) * 60;
      const cur = Match.elapsed(s);
      if (changed || !s.clock.running || cur < reported - 30 + s.clockOffset || cur > reported + 90 + s.clockOffset) {
        Match.setClock(s, Math.max(Match.START[period], reported - 30) + s.clockOffset, true);
      }
    } else if (changed || s.clock.running) {
      Match.setClock(s, Match.elapsed(s), false);
    }
  }

  // Goals from the events, with own goals and VAR decisions sorted out, kept to the official score.
  function goalsFromEvents(events, sideOf, official) {
    const build = (ownGoalToOtherSide) => {
      const out = [];
      events.forEach((e) => {
        const side = sideOf(e.team);
        if (e.type === 'Goal' && !/missed/i.test(e.detail || '') && side >= 0) {
          const og = /own goal/i.test(e.detail || '');
          out.push({ team: og && ownGoalToOtherSide ? 1 - side : side, scorer: scorerName(e), minute: minuteOf(e.time), key: eventKey(e), value: timeValue(e) });
        } else if (e.type === 'Var' && /goal (cancelled|disallowed)/i.test(e.detail || '') && side >= 0) {
          for (let i = out.length - 1; i >= 0; i -= 1) {
            if (out[i].team === side && Math.abs(out[i].value - timeValue(e)) <= 300) { out.splice(i, 1); break; }
          }
        }
      });
      return out;
    };
    const count = (list) => [0, 1].map((t) => list.filter((g) => g.team === t).length);
    let goals = build(true);
    const c = count(goals);
    if (c[0] !== official[0] || c[1] !== official[1]) {
      const alt = build(false);
      const c2 = count(alt);
      if (c2[0] === official[0] && c2[1] === official[1]) goals = alt;
    }
    const result = [];
    [0, 1].forEach((t) => {
      const mine = goals.filter((g) => g.team === t).slice(0, official[t]);
      for (let i = mine.length; i < official[t]; i += 1) mine.push({ team: t, scorer: '', minute: '', key: `pending|${t}|${i}` });
      mine.forEach((g) => result.push({ team: g.team, scorer: g.scorer, minute: g.minute, key: g.key }));
    });
    return result;
  }

  // Lines up what is on screen with what the feed says, team by team, in order.
  function reconcile(s, field, feedList, quiet) {
    const kind = field === 'goals' ? 'goal' : 'red';
    const nameField = field === 'goals' ? 'scorer' : 'player';
    const nowMs = Date.now();
    const next = [];
    [0, 1].forEach((t) => {
      const local = s[field].filter((x) => x.team === t);
      const fed = feedList.filter((x) => x.team === t);
      const n = Math.max(local.length, fed.length);
      for (let i = 0; i < n; i += 1) {
        const L = local[i];
        const F = fed[i];
        if (L && F) {
          const name = F[nameField];
          const nameless = !L[nameField] || (L.src === 'manual' && !L.typed);
          next.push(Object.assign({}, L, { src: 'feed', key: F.key, minute: F.minute || L.minute, [nameField]: name || L[nameField] }));
          // The feed has just said who scored a goal that was already on screen.
          if (kind === 'goal' && name && nameless && !quiet && !mem.animated.has(`scorer|${F.key}`)) {
            Match.pushAnim(s, { kind: 'scorer', team: t, name, minute: F.minute });
          }
          mem.animated.add(`${kind}|${F.key}`);
          if (name) mem.animated.add(`scorer|${F.key}`);
        } else if (F) {
          next.push({ team: t, [nameField]: F[nameField], minute: F.minute, src: 'feed', key: F.key, at: nowMs, typed: false });
          if (!quiet && !mem.animated.has(`${kind}|${F.key}`)) Match.pushAnim(s, { kind, team: t, name: F[nameField], minute: F.minute });
          mem.animated.add(`${kind}|${F.key}`);
          if (F[nameField]) mem.animated.add(`scorer|${F.key}`);
        } else if (L && L.src === 'manual' && nowMs - (L.at || 0) < GRACE_MS) {
          next.push(L); // pressed by hand and not in the feed yet, so it stays for now
        }
      }
    });
    s[field] = next;
  }

  function applyStats(s, blocks, sideOf) {
    const provided = new Set();
    blocks.forEach((block) => {
      const side = sideOf(block.team);
      if (side < 0) return;
      (Array.isArray(block.statistics) ? block.statistics : []).forEach((item) => {
        const def = Match.STATS.find((d) => d.api === item.type);
        if (!def || item.value === null || item.value === undefined || item.value === '') return;
        const v = parseFloat(String(item.value).replace('%', ''));
        if (!Number.isFinite(v)) return;
        s.stats[def.key][side] = Match.statClean(def, v);
        provided.add(def.key);
      });
    });
    if (provided.has('poss')) s.stats.poss[1] = 100 - s.stats.poss[0];
    s.feed.statsKeys = Array.from(provided);
  }

  function applyKits(s, lineups, sideOf) {
    lineups.forEach((l) => {
      const side = sideOf(l.team);
      const hex = String((l.team && l.team.colors && l.team.colors.player && l.team.colors.player.primary) || '').replace('#', '');
      if (side >= 0 && /^[0-9a-f]{6}$/i.test(hex)) s[side === 0 ? 'home' : 'away'].color = `#${hex.toLowerCase()}`;
    });
  }

  /* ---------- Things the server calls ---------- */
  function onModeChange() {
    const s = ctx.get();
    if (s.mode === 'live' && s.feed.fixtureId) {
      s.feed.done = false;
      mem.finalPolls = 0;
      setTimeout(poll, 0);
    } else {
      clearTimeout(mem.timer);
      mem.timer = null;
      s.feed.nextAt = 0;
    }
  }
  // After the clock offset changes, line the clock up again from the last feed answer (no request needed).
  function resync() {
    const s = ctx.get();
    if (s.mode === 'live' && mem.lastFixture) applyPeriod(s, mem.lastFixture);
  }
  function holdPeriod(period) {
    mem.hold = { period, until: Date.now() + 3 * 60 * 1000 };
  }
  function ignore(keys) {
    (Array.isArray(keys) ? keys : []).forEach((k) => { if (typeof k === 'string' && k) mem.ignored.add(k.slice(0, 120)); });
  }
  async function account() {
    if (mem.account && Date.now() - mem.accountAt < 60 * 1000) return mem.account;
    const r = await api('/status', {});
    const req = (r && r.requests) || {};
    const sub = (r && r.subscription) || {};
    mem.account = { plan: String(sub.plan || ''), active: sub.active !== false, used: num(req.current), limit: num(req.limit_day) };
    if (mem.account.limit) {
      mem.limit = mem.account.limit;
      mem.remaining = Math.max(0, mem.account.limit - mem.account.used);
      publishQuota();
    }
    mem.accountAt = Date.now();
    return mem.account;
  }
  function start() {
    publishQuota();
    const s = ctx.get();
    if (s.mode === 'live' && s.feed.fixtureId) setTimeout(poll, 500);
  }

  return { available, listFixtures, link, unlink, poll, schedule, onModeChange, resync, ignore, holdPeriod, account, start };
}

module.exports = createFeed;
