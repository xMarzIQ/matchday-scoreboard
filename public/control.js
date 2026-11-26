/*
  Control app. Every change goes to the server as a small patch, and the server passes it straight on
  to every open overlay. In live mode the server also follows the chosen match from the live feed.
*/
(() => {
  'use strict';
  const M = window.Match;
  const SB = window.Scoreboard;
  const $ = (id) => document.getElementById(id);
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  const KEY_STORE = 'scoreboard-control-key';
  const ACTIONS = {
    pre: 'Kick off', '1h': 'End 1st half', ht: 'Start 2nd half', '2h': 'End match',
    brk: 'Start extra time', et1: 'End ET 1st half', et2: 'End match', pens: 'End match', ft: 'New match',
  };
  const CONN_TEXT = {
    connecting: 'Connecting…',
    live: 'Connected',
    reconnecting: 'Reconnecting…',
    offline: 'Can’t reach the server, retrying',
    error: 'Last change wasn’t saved',
  };
  const PATCHABLE = ['mode', 'onAir', 'scale', 'clockOffset', 'comp', 'kickoff', 'kickoffAt', 'home', 'away', 'period', 'note', 'clock',
    'added', 'score', 'pens', 'stats', 'statsShown', 'goals', 'reds', 'anims', 'show', 'bug', 'card', 'writer', 'rev'];

  const el = {};
  [
    'viewport', 'previewFlag', 'previewText', 'chips', 'overlayUrl', 'copyBtn', 'conn', 'connText', 'openNotice',
    'unlock', 'keyInput', 'keyError', 'controls', 'resetBtn', 'sourceLine', 'sourceText',
    'tally', 'readTime', 'readState', 'advanceBtn', 'clockBtn', 'clockBtnText', 'inClock', 'clockHint', 'addedOut', 'offsetNote', 'periodMore',
    'deckHomeBadge', 'deckAwayBadge', 'scHomeCode', 'scAwayCode', 'scHomeName', 'scAwayName', 'scHome', 'scAway', 'sideRedsHome', 'sideRedsAway',
    'goalHome', 'goalAway', 'inScorer', 'replayBtn',
    'feedNoKey', 'compChips', 'daySeg', 'dayInput', 'fixtures', 'linkedBox', 'linkedTitle', 'linkedStatus', 'linkedMeta', 'refreshBtn', 'unlinkBtn',
    'pollSeg', 'pollNote', 'kitToggle', 'crestToggle', 'quotaNote', 'feedError',
    'statChips', 'statsHeadNote', 'possBox', 'possHome', 'possAway', 'inPoss', 'statCtl', 'statsFeedNote',
    'inScale', 'scaleOut', 'inBugSize', 'bugSizeOut', 'inCardSize', 'cardSizeOut',
    'teamsNote', 'inHomeName', 'inHomeCode', 'inHomeColor', 'inHomeCrest', 'prevHome', 'clearHome', 'crestErrHome',
    'inAwayName', 'inAwayCode', 'inAwayColor', 'inAwayCrest', 'prevAway', 'clearAway', 'crestErrAway',
    'inComp', 'inKickoff',
  ].forEach((id) => { el[id] = $(id); });

  const clientId = Math.random().toString(36).slice(2, 10);
  let myRev = 0;
  let live = null;          // the match as this page shows it
  let base = null;          // the last state the server sent, to work out what this page changed
  let previewKey = null;    // a sample state shown only in this preview
  let previewState = null;
  let locked = false;       // the server has a CONTROL_KEY
  let authed = true;        // this device has the right key
  let sseLive = false;
  let pendingIgnore = [];   // feed goals and cards taken off by hand, so the feed doesn't put them back
  let controlKey = '';
  try { controlKey = localStorage.getItem(KEY_STORE) || ''; } catch (e) { controlKey = ''; }

  const board = SB.mount(el.viewport, { preview: true, onDrag });
  el.overlayUrl.value = `${location.origin}/overlay`;

  const following = () => !!(live && live.mode === 'live' && live.feed.fixtureId);
  const blocked = () => locked && !authed;

  /* ---------- Showing state ---------- */
  function show() {
    if (!live) return;
    if (previewKey) {
      const keep = previewState ? previewState.clock : null;
      previewState = M.withSample(live, previewKey);
      if (keep) previewState.clock = keep;
    }
    board.render(previewKey ? previewState : live);
    syncControls();
  }
  function receive(s) {
    const local = live && base ? M.diff(base, live).filter(([p]) => PATCHABLE.includes(p[0])) : [];
    base = s;
    if (live && s.writer === clientId && s.rev < myRev && local.length) {
      // The server hasn't seen this page's newest change yet: take its news and keep that change on top.
      live = M.normalize(M.applyPatch(M.copy(s), local));
    } else {
      live = M.copy(s);
    }
    show();
  }
  function commit(opts) {
    if (!live) return;
    myRev += 1;
    live.writer = clientId;
    live.rev = myRev;
    if (previewKey && !(opts && opts.keepPreview)) stopPreview();
    show();
    push();
  }

  /* ---------- Sending to the server (one request at a time, the newest state wins) ---------- */
  let inFlight = false;
  let dirty = false;
  let retryTimer = 0;
  function push() {
    dirty = true;
    if (!inFlight) flush();
  }
  async function flush() {
    clearTimeout(retryTimer);
    if (!dirty || !live || !base) return;
    dirty = false;
    inFlight = true;
    let failed = false;
    const patch = M.diff(base, live).filter(([p]) => PATCHABLE.includes(p[0]));
    const ignore = pendingIgnore.slice();
    try {
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Control-Key': controlKey },
        body: JSON.stringify({ patch, ignore }),
      });
      if (res.status === 401) handleUnauthorised();
      else if (!res.ok) setConn('error');
      else {
        pendingIgnore = pendingIgnore.filter((k) => !ignore.includes(k));
        if (sseLive) setConn('live');
      }
    } catch (e) {
      failed = true;
      dirty = true;
      setConn('offline');
    }
    inFlight = false;
    if (dirty) {
      if (failed) retryTimer = setTimeout(flush, 2000);
      else flush();
    }
  }
  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Control-Key': controlKey },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) { handleUnauthorised(); throw new Error('Unlock the controls first.'); }
    if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
    return data;
  }

  // The tag on the preview says what viewers see: on stream, off screen, a local preview, or a connection problem.
  let connKind = 'connecting';
  const TAG = {
    live: ['On stream', 'live'],
    connecting: ['Connecting…', 'wait'],
    reconnecting: ['Reconnecting…', 'wait'],
    offline: ['Can’t reach the server', 'bad'],
    error: ['Last change wasn’t saved', 'bad'],
  };
  function paintTag() {
    if (previewKey) {
      setText(el.previewText, `Preview only: ${M.SAMPLES[previewKey].label}`);
      el.previewFlag.dataset.mode = 'preview';
      return;
    }
    if (connKind === 'live' && live && !live.onAir) {
      setText(el.previewText, 'Off screen');
      el.previewFlag.dataset.mode = 'off';
      return;
    }
    const [text, mode] = TAG[connKind] || TAG.connecting;
    setText(el.previewText, text);
    el.previewFlag.dataset.mode = mode;
  }
  function setConn(kind) {
    connKind = kind;
    el.conn.dataset.state = kind;
    setText(el.connText, CONN_TEXT[kind] || '');
    paintTag();
  }
  function onStatus(kind) {
    sseLive = kind === 'live';
    if (kind !== 'live' || el.conn.dataset.state !== 'error') setConn(kind);
  }

  /* ---------- Control key ---------- */
  async function checkSession(key) {
    const res = await fetch('/api/session', { headers: { 'X-Control-Key': key }, cache: 'no-store' });
    if (!res.ok) throw new Error('session');
    return res.json();
  }
  function applyLock() {
    el.openNotice.hidden = locked;
    el.unlock.hidden = !blocked();
    el.controls.inert = blocked();
    el.controls.classList.toggle('is-locked', blocked());
    el.resetBtn.disabled = blocked();
    document.querySelectorAll('.source button').forEach((b) => { b.disabled = blocked() || b.dataset.off === 'true'; });
    if (!blocked()) loadFixtures(false);
  }
  async function initAuth() {
    try {
      const s = await checkSession(controlKey);
      locked = !!s.locked;
      authed = !!s.ok;
    } catch (e) { /* the connection pill already says the server can't be reached */ }
    applyLock();
  }
  async function unlock() {
    const key = el.keyInput.value.trim();
    if (!key) { setText(el.keyError, 'Enter the control key first.'); return; }
    try {
      const s = await checkSession(key);
      if (!s.ok) { setText(el.keyError, 'That key doesn’t match the one set on the server.'); return; }
      controlKey = key;
      try { localStorage.setItem(KEY_STORE, key); } catch (e) { /* remembered for this visit only */ }
      locked = !!s.locked;
      authed = true;
      el.keyInput.value = '';
      setText(el.keyError, '');
      applyLock();
    } catch (e) {
      setText(el.keyError, 'Can’t reach the server. Check the connection and try again.');
    }
  }
  function handleUnauthorised() {
    authed = false;
    locked = true;
    controlKey = '';
    try { localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ }
    setText(el.keyError, 'The control key has changed. Enter the new one to keep making changes.');
    applyLock();
  }

  /* ---------- Preview states (this page only) ---------- */
  function startPreview(key) {
    if (!live || !M.SAMPLES[key]) return;
    previewKey = key;
    previewState = null;
    paintTag();
    show();
  }
  function stopPreview() {
    previewKey = null;
    previewState = null;
    paintTag();
  }

  /* ---------- Big clock in the deck ---------- */
  let shownTime = '';
  function paintDigits(node, text) {
    if (text === shownTime) return;
    shownTime = text;
    const frag = document.createDocumentFragment();
    for (const ch of text) {
      const span = document.createElement('span');
      span.className = /\d/.test(ch) ? 'ch' : ch === ':' ? 'ch ch-colon' : ch === '+' ? 'ch ch-plus' : 'ch ch-alpha';
      span.textContent = ch;
      frag.appendChild(span);
    }
    node.replaceChildren(frag);
    node.setAttribute('aria-label', text);
  }
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.round(s / 3600)} h`;
  };
  function tickReadout() {
    if (!live) return;
    const v = M.clockView(live);
    paintDigits(el.readTime, v.text);
    setText(el.readState, v.label);
    const play = M.inPlay(live);
    el.tally.hidden = !play && live.period !== 'pens';
    if (!el.tally.hidden) {
      const tone = live.clock.running || live.period === 'pens' ? 'live' : 'paused';
      el.tally.dataset.tone = tone;
      setText(el.tally, tone === 'live' ? 'Live' : 'Paused');
    }
    paintSource();
    paintLinked();
  }

  /* ---------- Where the match data comes from ---------- */
  function paintSource() {
    const f = live.feed;
    let text;
    let tone;
    if (live.mode === 'manual') {
      text = 'Manual: the scoreboard only changes when you change it.';
      tone = 'idle';
    } else if (!f.available) {
      text = 'Live feed is off because the server has no API-Football key yet. Manual control still works.';
      tone = 'wait';
    } else if (!f.fixtureId) {
      text = 'Live feed is on. Pick a match in Live match feed and the scoreboard follows it.';
      tone = 'wait';
    } else if (f.error) {
      text = `Following ${f.title}, but the last update failed: ${f.error}`;
      tone = 'bad';
    } else {
      const when = f.updatedAt ? `updated ${ago(M.now() - f.updatedAt)} ago` : 'waiting for the first update';
      text = `Following ${f.title}, ${when}.`;
      tone = 'live';
    }
    setText(el.sourceText, text);
    el.sourceLine.dataset.tone = tone;
  }
  function statusText(f) {
    if (!f.statusShort) return '';
    const map = { NS: 'Not started', TBD: 'Time to be confirmed', '1H': '1st half', HT: 'Half-time', '2H': '2nd half', ET: 'Extra time', BT: 'Break', P: 'Penalties', FT: 'Full-time', AET: 'After extra time', PEN: 'After penalties', SUSP: 'Suspended', INT: 'Interrupted', PST: 'Postponed', CANC: 'Cancelled', ABD: 'Abandoned', AWD: 'Awarded', WO: 'Walkover', LIVE: 'In play' };
    return map[f.statusShort] || f.status;
  }
  function paintLinked() {
    const f = live.feed;
    const linked = !!f.fixtureId;
    el.linkedBox.classList.toggle('is-linked', linked);
    setText(el.linkedTitle, linked ? f.title : 'No match yet');
    setText(el.linkedStatus, linked ? statusText(f) : '');
    let meta = 'Pick one from the list.';
    if (linked) {
      const parts = [];
      if (live.mode !== 'live') parts.push('Paused while you’re in Manual.');
      else if (f.done) parts.push('Match over, updates have stopped.');
      else {
        if (f.updatedAt) parts.push(`Updated ${ago(M.now() - f.updatedAt)} ago.`);
        if (f.nextAt && f.nextAt > M.now()) parts.push(`Next update in ${ago(f.nextAt - M.now())}.`);
      }
      meta = parts.join(' ');
    }
    setText(el.linkedMeta, meta);
    el.refreshBtn.disabled = !linked || live.mode !== 'live';
    el.unlinkBtn.disabled = !linked;
  }

  /* ---------- Controls reflect the live match ---------- */
  function setValue(input, v) {
    if (document.activeElement !== input && input.value !== v) input.value = v;
  }
  function rangePct(input) {
    const min = +input.min || 0;
    const max = +input.max || 100;
    return `${(((+input.value - min) / (max - min)) * 100).toFixed(1)}%`;
  }
  function paintSideReds(node, team) {
    const list = live.reds.map((r, i) => ({ r, i })).filter((x) => x.r.team === team);
    const key = list.map((x) => `${x.i}:${x.r.player}:${x.r.minute}`).join('|');
    if (node._key === key) return;
    node._key = key;
    node.replaceChildren();
    list.forEach(({ r, i }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'red-chip';
      b.dataset.act = 'red-remove';
      b.dataset.index = String(i);
      const who = [r.player, r.minute].filter(Boolean).join(' ');
      b.title = `Take off this red card${who ? ` (${who})` : ''}`;
      b.setAttribute('aria-label', b.title);
      node.appendChild(b);
    });
  }
  function syncControls() {
    if (!live) return;
    const f = live.feed;
    el.chips.querySelectorAll('[data-sample]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sample === previewKey)));
    document.querySelectorAll('[data-act="air"]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.val === '1') === live.onAir)));
    document.querySelectorAll('[data-act="mode"]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.val === live.mode));
      if (b.dataset.val === 'live') {
        b.dataset.off = String(!f.available);
        b.disabled = blocked() || !f.available;
        b.title = f.available ? '' : 'Add API_FOOTBALL_KEY on the server to use live data';
      }
    });
    document.querySelectorAll('[data-act="period"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === live.period)));
    el.periodMore.value = '';
    el.periodMore.classList.toggle('is-active', ['brk', 'et1', 'et2', 'pens'].includes(live.period));
    if (pending !== el.advanceBtn) setText(el.advanceBtn, ACTIONS[live.period]);
    const play = M.inPlay(live);
    const running = play && live.clock.running;
    el.clockBtn.disabled = !play;
    el.clockBtn.dataset.running = String(running);
    setText(el.clockBtnText, running ? 'Pause' : 'Start');
    el.clockBtn.setAttribute('aria-label', running ? 'Pause the clock' : 'Start the clock');
    document.querySelectorAll('[data-act="nudge"], [data-act="set-clock"], [data-act="added"]').forEach((b) => { b.disabled = !play; });
    el.inClock.disabled = !play;
    setText(el.addedOut, `+${live.added}`);
    el.offsetNote.hidden = !following() || !live.clockOffset;
    setText(el.offsetNote, `Live clock moved ${live.clockOffset > 0 ? '+' : '−'}${Math.abs(live.clockOffset)} s to match the TV. The nudge buttons change this.`);
    tickReadout();

    setText(el.scHomeName, M.nameOf(live.home));
    setText(el.scAwayName, M.nameOf(live.away));
    setText(el.scHomeCode, M.codeOf(live.home));
    setText(el.scAwayCode, M.codeOf(live.away));
    setText(el.scHome, String(live.score[0]));
    setText(el.scAway, String(live.score[1]));
    el.goalHome.setAttribute('aria-label', `Goal for ${M.nameOf(live.home)}`);
    el.goalAway.setAttribute('aria-label', `Goal for ${M.nameOf(live.away)}`);
    document.querySelectorAll('[data-act="score"]').forEach((b) => {
      const team = +b.dataset.team === 0 ? live.home : live.away;
      b.setAttribute('aria-label', `${+b.dataset.d > 0 ? 'Add a goal to' : 'Take a goal off'} ${M.nameOf(team)} without the animation`);
    });
    document.querySelectorAll('[data-act="red"]').forEach((b) => {
      b.setAttribute('aria-label', `Red card for ${M.nameOf(+b.dataset.team === 0 ? live.home : live.away)}`);
    });
    paintSideReds(el.sideRedsHome, 0);
    paintSideReds(el.sideRedsAway, 1);
    el.replayBtn.disabled = !live.goals.length;
    SB.paintBadge(el.deckHomeBadge, live.home, 'home');
    SB.paintBadge(el.deckAwayBadge, live.away, 'away');

    syncFeed();
    syncStats();

    setValue(el.inScale, String(Math.round(live.scale * 100)));
    el.inScale.style.setProperty('--p', rangePct(el.inScale));
    setText(el.scaleOut, `${Math.round(live.scale * 100)}%`);
    document.querySelectorAll('[data-act="show"]').forEach((b) => {
      const key = b.dataset.key;
      const val = key === 'card' ? b.dataset.val : b.dataset.val === '1';
      b.setAttribute('aria-pressed', String(live.show[key] === val));
    });
    setValue(el.inBugSize, String(Math.round(live.bug.s * 100)));
    el.inBugSize.style.setProperty('--p', rangePct(el.inBugSize));
    setText(el.bugSizeOut, `${Math.round(live.bug.s * 100)}%`);
    setValue(el.inCardSize, String(Math.round(live.card.s * 100)));
    el.inCardSize.style.setProperty('--p', rangePct(el.inCardSize));
    setText(el.cardSizeOut, `${Math.round(live.card.s * 100)}%`);

    setValue(el.inHomeName, live.home.name);
    setValue(el.inHomeCode, live.home.code);
    setValue(el.inHomeColor, live.home.color);
    setValue(el.inAwayName, live.away.name);
    setValue(el.inAwayCode, live.away.code);
    setValue(el.inAwayColor, live.away.color);
    setValue(el.inComp, live.comp);
    setValue(el.inKickoff, live.kickoff);
    SB.paintBadge(el.prevHome, live.home, 'home');
    SB.paintBadge(el.prevAway, live.away, 'away');
    el.clearHome.disabled = !live.home.crestV;
    el.clearAway.disabled = !live.away.crestV;
  }

  /* ---------- Live match feed panel ---------- */
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shiftDay = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
  let feedComp = '';
  let feedDay = shiftDay(0);
  let fixtures = null;
  let fixturesError = '';
  let fixturesKey = '';
  let loading = false;

  function buildCompChips() {
    M.COMPETITIONS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.act = 'comp';
      b.dataset.comp = c.key;
      b.textContent = c.name;
      el.compChips.appendChild(b);
    });
  }
  function syncFeed() {
    const f = live.feed;
    if (!feedComp) feedComp = f.compKey || live.compKey || 'pl';
    el.feedNoKey.hidden = f.available;
    el.compChips.querySelectorAll('[data-comp]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.comp === feedComp));
      b.disabled = !f.available;
    });
    el.daySeg.querySelectorAll('[data-shift]').forEach((b) => {
      b.setAttribute('aria-pressed', String(shiftDay(+b.dataset.shift) === feedDay));
      b.disabled = !f.available;
    });
    setValue(el.dayInput, feedDay);
    el.dayInput.disabled = !f.available;
    el.pollSeg.querySelectorAll('[data-secs]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.secs === f.pollSeconds)));
    const perMatch = Math.round((130 * 60) / f.pollSeconds) + 25;
    setText(el.pollNote, `About ${perMatch} requests for a full match. The free plan allows 100 a day, Pro allows 7,500.`);
    el.kitToggle.checked = f.kitColours;
    el.crestToggle.checked = f.crests;
    setText(el.quotaNote, f.limit ? `Requests left today: ${(f.remaining || 0).toLocaleString('en-GB')} of ${f.limit.toLocaleString('en-GB')}` : '');
    setText(el.feedError, following() && f.error ? f.error : '');
    setText(el.teamsNote, f.fixtureId ? 'Filled in from the live feed. Your changes here stay.' : 'The live feed fills these in when you pick a match');
    paintFixtures();
  }
  async function loadFixtures(force) {
    if (!live || !live.feed.available || blocked()) return;
    const key = `${feedComp || 'pl'}|${feedDay}`;
    if (!force && key === fixturesKey && (fixtures || fixturesError || loading)) return;
    fixturesKey = key;
    fixtures = null;
    fixturesError = '';
    loading = true;
    paintFixtures();
    try {
      const data = await call('GET', `/api/feed/fixtures?comp=${encodeURIComponent(feedComp || 'pl')}&date=${encodeURIComponent(feedDay)}`);
      if (fixturesKey === key) fixtures = data.fixtures || [];
    } catch (e) {
      if (fixturesKey === key) fixturesError = e.message;
    }
    loading = false;
    paintFixtures();
  }
  const LIVE_CODES = ['1H', '2H', 'ET', 'P', 'LIVE'];
  function fixtureStatus(fx) {
    if (LIVE_CODES.includes(fx.status)) return { text: fx.elapsed ? `${fx.elapsed}’` : 'Live', tone: 'live' };
    if (fx.status === 'HT') return { text: 'HT', tone: 'live' };
    if (fx.status === 'BT') return { text: 'Break', tone: 'live' };
    if (['FT', 'AET', 'PEN'].includes(fx.status)) return { text: fx.status === 'FT' ? 'FT' : fx.status, tone: 'done' };
    if (['PST', 'CANC', 'ABD', 'SUSP', 'INT'].includes(fx.status)) return { text: fx.statusLong || fx.status, tone: 'off' };
    return { text: fx.kickoff || 'TBC', tone: 'soon' };
  }
  function paintFixtures() {
    const box = el.fixtures;
    const linkedId = live ? live.feed.fixtureId : 0;
    const compName = (M.COMPETITIONS.find((c) => c.key === (feedComp || 'pl')) || {}).name || '';
    const sig = JSON.stringify([fixtures, fixturesError, loading, linkedId, live && live.feed.available]);
    if (box._sig === sig) return;
    box._sig = sig;
    box.replaceChildren();
    const note = (text, cls) => { const p = document.createElement('p'); p.className = cls || 'fx-empty'; p.textContent = text; box.appendChild(p); };
    if (!live || !live.feed.available) { note('Matches show here once the server has an API-Football key.'); return; }
    if (loading) { note('Loading matches…'); return; }
    if (fixturesError) { note(fixturesError, 'fx-empty is-error'); return; }
    if (!fixtures) return;
    if (!fixtures.length) { note(`No ${compName} matches on this day. Try another day.`); return; }
    fixtures.forEach((fx) => {
      const row = document.createElement('div');
      row.className = 'fx';
      if (fx.id === linkedId) row.classList.add('is-linked');
      const st = fixtureStatus(fx);
      const time = document.createElement('span');
      time.className = `fx-time is-${st.tone}`;
      time.textContent = st.text;
      const teams = document.createElement('span');
      teams.className = 'fx-teams';
      const score = fx.goals && !['NS', 'TBD', 'PST', 'CANC'].includes(fx.status) ? `${fx.goals[0]}–${fx.goals[1]}` : 'v';
      teams.innerHTML = '<b></b><span class="fx-score"></span><b></b>';
      teams.children[0].textContent = fx.home;
      teams.children[1].textContent = score;
      teams.children[2].textContent = fx.away;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.dataset.act = 'feed-link';
      btn.dataset.id = String(fx.id);
      btn.textContent = fx.id === linkedId ? 'Following' : 'Follow';
      btn.disabled = fx.id === linkedId;
      btn.setAttribute('aria-label', `Follow ${fx.home} v ${fx.away}`);
      row.append(time, teams, btn);
      box.appendChild(row);
    });
  }
  async function linkFixture(id, btn) {
    setText(el.feedError, '');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      await call('POST', '/api/feed/link', { fixtureId: id, comp: feedComp || 'pl' });
      fixturesKey = '';
      loadFixtures(true);
    } catch (e) {
      setText(el.feedError, e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Follow'; }
    }
  }
  async function feedSettings(body) {
    try { await call('POST', '/api/feed/settings', body); } catch (e) { setText(el.feedError, e.message); }
  }

  /* ---------- Stats panel ---------- */
  function buildStatChips() {
    M.STATS.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.act = 'stat-toggle';
      b.dataset.key = s.key;
      b.textContent = s.label;
      el.statChips.appendChild(b);
    });
  }
  let stripsKey = '';
  function syncStats() {
    const shown = live.statsShown;
    el.statChips.querySelectorAll('[data-key]').forEach((b) => {
      const on = shown.includes(b.dataset.key);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !on && shown.length >= M.MAX_SHOWN;
    });
    setText(el.statsHeadNote, shown.length ? `${shown.length} of ${M.MAX_SHOWN} showing under the scoreboard and on the big card` : 'None showing. Pick some to show under the scoreboard and on the big card.');
    const fedKeys = following() ? live.feed.statsKeys : [];
    el.possBox.hidden = !shown.includes('poss');
    const ph = M.clamp(live.stats.poss[0], 0, 100);
    setValue(el.inPoss, String(ph));
    el.inPoss.style.setProperty('--p', `${ph}%`);
    el.inPoss.disabled = fedKeys.includes('poss');
    setText(el.possHome, `${ph}%`);
    setText(el.possAway, `${100 - ph}%`);
    const keys = shown.filter((k) => k !== 'poss');
    const sig = keys.join(',');
    if (sig !== stripsKey) {
      stripsKey = sig;
      el.statCtl.replaceChildren();
      keys.forEach((key) => {
        const def = M.STAT[key];
        const row = document.createElement('div');
        row.className = 'strip';
        row.dataset.strip = key;
        const side = (t, who) => `<div class="stepper ${t === 0 ? 'h' : 'a'}"><button class="btn btn-sq" type="button" data-act="stat" data-key="${key}" data-team="${t}" data-d="-1" aria-label="${def.label}, ${who} team: less">−</button><output data-out="${key}-${t}"></output><button class="btn btn-sq" type="button" data-act="stat" data-key="${key}" data-team="${t}" data-d="1" aria-label="${def.label}, ${who} team: more">+</button></div>`;
        row.innerHTML = `<div class="strip-name"></div>${side(0, 'home')}${side(1, 'away')}<div class="mini" aria-hidden="true"><i class="mh"></i><i class="ma"></i></div>`;
        row.querySelector('.strip-name').textContent = def.label;
        el.statCtl.appendChild(row);
      });
    }
    el.statCtl.querySelectorAll('[data-strip]').forEach((strip) => {
      const key = strip.dataset.strip;
      const def = M.STAT[key];
      const [h, a] = live.stats[key];
      strip.querySelectorAll('output').forEach((o) => setText(o, M.formatStat(def, +o.dataset.out.split('-')[1] === 0 ? h : a)));
      const p = h + a ? (h / (h + a)) * 100 : 50;
      strip.querySelector('.mh').style.width = `calc(${p.toFixed(1)}% - 1.5px)`;
      strip.querySelector('.ma').style.width = `calc(${(100 - p).toFixed(1)}% - 1.5px)`;
      const fed = fedKeys.includes(key);
      strip.classList.toggle('is-fed', fed);
      strip.querySelectorAll('button').forEach((b) => { b.disabled = fed; });
    });
    el.statsFeedNote.hidden = !fedKeys.length;
  }

  /* Destructive buttons ask for a second tap instead of a pop-up */
  let pending = null;
  let pendingTimer = 0;
  function clearPending() {
    if (!pending) return;
    const b = pending;
    pending = null;
    clearTimeout(pendingTimer);
    b.classList.remove('is-confirming');
    setText(b, b.dataset.label || '');
    syncControls();
  }
  function confirmTwice(btn, fn) {
    if (pending === btn) { clearPending(); fn(); return; }
    clearPending();
    pending = btn;
    btn.dataset.label = btn.textContent;
    btn.classList.add('is-confirming');
    setText(btn, 'Tap again to reset');
    pendingTimer = setTimeout(clearPending, 3200);
  }

  /* ---------- Match actions ---------- */
  function newMatch() {
    M.setClock(live, 0, false);
    live.period = 'pre';
    live.note = '';
    live.added = 0;
    live.score = [0, 0];
    live.pens = null;
    live.stats = M.zeroStats();
    live.goals = [];
    live.reds = [];
    live.anims = [];
    live.clockOffset = 0;
    commit();
  }
  function advance() {
    const p = live.period;
    if (p === 'ft') { confirmTwice(el.advanceBtn, newMatch); return; }
    if (p === 'pre') { live.period = '1h'; M.setClock(live, 0, true); }
    else if (p === '1h') { live.period = 'ht'; M.setClock(live, M.elapsed(live), false); }
    else if (p === 'ht') { live.period = '2h'; M.setClock(live, M.START['2h'], true); }
    else if (p === 'brk') {
      const second = M.elapsed(live) >= M.END.et1;
      live.period = second ? 'et2' : 'et1';
      M.setClock(live, second ? M.START.et2 : M.START.et1, true);
    } else if (p === 'et1') { live.period = 'brk'; M.setClock(live, Math.max(M.elapsed(live), M.END.et1), false); }
    else { live.period = 'ft'; M.setClock(live, M.elapsed(live), false); }
    live.added = 0;
    commit();
  }
  function jumpPeriod(p) {
    if (!p || p === live.period) return;
    const start = { pre: 0, '1h': 0, '2h': M.START['2h'], et1: M.START.et1, et2: M.START.et2 }[p];
    live.period = p;
    live.added = 0;
    if (p !== 'ft') live.note = '';
    M.setClock(live, start !== undefined ? start : M.elapsed(live), false);
    commit();
  }
  function setClockFromInput() {
    const v = M.parseClock(el.inClock.value);
    if (v == null) {
      el.inClock.setAttribute('aria-invalid', 'true');
      setText(el.clockHint, 'Type the time as minutes and seconds, like 63:20, or added time, like 45+2.');
      return;
    }
    el.inClock.removeAttribute('aria-invalid');
    setText(el.clockHint, '');
    if (following()) live.clockOffset = M.clamp(Math.round(live.clockOffset + (v - M.elapsed(live))), -600, 600);
    M.setClock(live, v, live.clock.running);
    el.inClock.value = '';
    commit();
  }
  function nudge(d) {
    M.setClock(live, M.elapsed(live) + d, live.clock.running);
    if (following()) live.clockOffset = M.clamp(live.clockOffset + d, -600, 600);
    commit();
  }
  const minuteNow = () => (M.inPlay(live) ? M.minuteMark(live) : '');
  function takePlayer() {
    const name = el.inScorer.value.trim().slice(0, 30);
    el.inScorer.value = '';
    return name;
  }
  function goal(team) {
    const scorer = takePlayer();
    const minute = minuteNow();
    live.score[team] = M.clamp(live.score[team] + 1, 0, 99);
    live.goals.push({ team, scorer, minute, src: 'manual', key: '', at: M.now(), typed: !!scorer });
    M.pushAnim(live, { kind: 'goal', team, name: scorer, minute });
    commit();
  }
  function adjustScore(team, d) {
    if (d > 0) {
      live.score[team] = M.clamp(live.score[team] + 1, 0, 99);
      live.goals.push({ team, scorer: '', minute: minuteNow(), src: 'manual', key: '', at: M.now(), typed: false });
    } else {
      live.score[team] = M.clamp(live.score[team] - 1, 0, 99);
      for (let i = live.goals.length - 1; i >= 0; i -= 1) {
        if (live.goals[i].team === team) {
          const [gone] = live.goals.splice(i, 1);
          if (gone.src === 'feed' && gone.key) pendingIgnore.push(gone.key);
          break;
        }
      }
    }
    commit();
  }
  function redCard(team) {
    const player = takePlayer();
    const minute = minuteNow();
    live.reds.push({ team, player, minute, src: 'manual', key: '', at: M.now() });
    M.pushAnim(live, { kind: 'red', team, name: player, minute });
    commit();
  }
  function removeRed(index) {
    const r = live.reds[index];
    if (!r) return;
    live.reds.splice(index, 1);
    if (r.src === 'feed' && r.key) pendingIgnore.push(r.key);
    commit();
  }
  function replayGoal() {
    if (!live.goals.length) return;
    const last = live.goals.reduce((a, b) => ((b.at || 0) >= (a.at || 0) ? b : a));
    M.pushAnim(live, { kind: 'goal', team: last.team, name: last.scorer, minute: last.minute });
    commit({ keepPreview: true });
  }
  function keepInside(kind) {
    const node = kind === 'bug' ? board.el.bug : board.el.card;
    const p = live[kind];
    const k = p.s * live.scale;
    const w = node.offsetWidth * k;
    const h = node.offsetHeight * k;
    if (kind === 'bug') {
      p.x = Math.round(M.clamp(p.x, 0, Math.max(0, SB.W - w)));
      p.y = Math.round(M.clamp(p.y, 0, Math.max(0, SB.H - h)));
    } else {
      p.x = Math.round(M.clamp(p.x, w / 2, Math.max(w / 2, SB.W - w / 2)));
      p.y = Math.round(M.clamp(p.y, h, SB.H));
    }
  }
  function bugPosition(where) {
    const w = board.el.bug.offsetWidth * live.bug.s * live.scale;
    live.bug.x = Math.round(where === 'left' ? 64 : where === 'right' ? SB.W - 64 - w : (SB.W - w) / 2);
    live.bug.y = 44;
    commit({ keepPreview: true });
  }
  function onDrag(kind, x, y) {
    if (!live || blocked()) return;
    live[kind].x = x;
    live[kind].y = y;
    commit({ keepPreview: true });
  }
  function toggleStat(key) {
    const on = live.statsShown.includes(key);
    if (!on && live.statsShown.length >= M.MAX_SHOWN) return;
    const next = on ? live.statsShown.filter((k) => k !== key) : live.statsShown.concat(key);
    live.statsShown = M.STATS.map((s) => s.key).filter((k) => next.includes(k));
    commit({ keepPreview: true });
  }
  function stepStat(key, team, d) {
    const def = M.STAT[key];
    if (!def) return;
    const step = def.kind === 'dec' ? 0.1 : 1;
    const v = live.stats[key][team] + d * step;
    live.stats[key][team] = M.statClean(def, v);
    commit();
  }

  /* Crest images are shrunk to a 192px PNG on this device, then stored by the server */
  function toPng(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const size = 192;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const iw = img.naturalWidth || size;
        const ih = img.naturalHeight || size;
        const k = Math.min(size / iw, size / ih);
        canvas.getContext('2d').drawImage(img, (size - iw * k) / 2, (size - ih * k) / 2, iw * k, ih * k);
        URL.revokeObjectURL(url);
        try { resolve(canvas.toDataURL('image/png')); } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }
  async function uploadCrest(file, side, label) {
    const err = side === 'home' ? el.crestErrHome : el.crestErrAway;
    if (!/^image\//.test(file.type)) { setText(err, 'That file isn’t an image. Choose a PNG, JPG, SVG or WebP.'); return; }
    setText(err, '');
    label.classList.add('is-busy');
    try {
      const dataUrl = await toPng(file);
      await call('POST', `/api/crest/${side}`, { dataUrl });
    } catch (e) {
      setText(err, e && e.message === 'unreadable' ? 'That image couldn’t be read. Try saving it as a PNG first.' : e.message);
    }
    label.classList.remove('is-busy');
  }
  async function removeCrest(side) {
    const err = side === 'home' ? el.crestErrHome : el.crestErrAway;
    try { await call('DELETE', `/api/crest/${side}`); setText(err, ''); } catch (e) { setText(err, e.message); }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(el.overlayUrl.value);
      setText(el.copyBtn, 'Copied');
    } catch (e) {
      el.overlayUrl.select();
      setText(el.copyBtn, 'Selected');
    }
    setTimeout(() => setText(el.copyBtn, 'Copy'), 1600);
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'unlock') { unlock(); return; }
    if (act === 'copy-link') { copyLink(); return; }
    if (act === 'sample') { startPreview(b.dataset.sample); return; }
    if (act === 'live') { stopPreview(); show(); return; }
    if (!live || blocked()) return;
    const team = Number(b.dataset.team);
    const d = Number(b.dataset.d);
    switch (act) {
      case 'air': live.onAir = b.dataset.val === '1'; commit({ keepPreview: true }); paintTag(); break;
      case 'mode': live.mode = b.dataset.val === 'live' ? 'live' : 'manual'; commit({ keepPreview: true }); break;
      case 'period': jumpPeriod(b.dataset.period); break;
      case 'advance': advance(); break;
      case 'clock': M.setClock(live, M.elapsed(live), !live.clock.running); commit(); break;
      case 'nudge': nudge(d); break;
      case 'set-clock': setClockFromInput(); break;
      case 'added': live.added = M.clamp(live.added + d, 0, 30); commit(); break;
      case 'goal': goal(team); break;
      case 'score': adjustScore(team, d); break;
      case 'red': redCard(team); break;
      case 'red-remove': removeRed(Number(b.dataset.index)); break;
      case 'replay': replayGoal(); break;
      case 'stat': stepStat(b.dataset.key, team, d); break;
      case 'stat-toggle': toggleStat(b.dataset.key); break;
      case 'show':
        if (b.dataset.key === 'card') live.show.card = b.dataset.val;
        else live.show[b.dataset.key] = b.dataset.val === '1';
        commit({ keepPreview: true });
        break;
      case 'expand': {
        const item = b.closest('.item');
        const open = !item.classList.contains('is-open');
        item.classList.toggle('is-open', open);
        b.setAttribute('aria-expanded', String(open));
        break;
      }
      case 'bug-pos': bugPosition(b.dataset.pos); break;
      case 'card-home': live.card.x = SB.W / 2; live.card.y = SB.H - 64; keepInside('card'); commit({ keepPreview: true }); break;
      case 'crest-clear': removeCrest(team === 0 ? 'home' : 'away'); break;
      case 'reset': confirmTwice(b, newMatch); break;
      case 'comp': feedComp = b.dataset.comp; syncFeed(); loadFixtures(false); break;
      case 'day': feedDay = shiftDay(Number(b.dataset.shift)); syncFeed(); loadFixtures(false); break;
      case 'feed-link': linkFixture(Number(b.dataset.id), b); break;
      case 'feed-unlink': call('POST', '/api/feed/unlink').then(() => { fixturesKey = ''; loadFixtures(true); }).catch((err) => setText(el.feedError, err.message)); break;
      case 'feed-refresh': call('POST', '/api/feed/refresh').catch((err) => setText(el.feedError, err.message)); break;
      case 'poll': feedSettings({ pollSeconds: Number(b.dataset.secs) }); break;
      default: break;
    }
  });

  const onInput = (input, fn, opts) => input.addEventListener('input', () => {
    if (!live || blocked()) return;
    fn(input.value);
    commit(opts);
  });
  const look = { keepPreview: true };
  onInput(el.inHomeName, (v) => { live.home.name = v.slice(0, 40); }, look);
  onInput(el.inAwayName, (v) => { live.away.name = v.slice(0, 40); }, look);
  onInput(el.inHomeCode, (v) => { live.home.code = v.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase().slice(0, 4); }, look);
  onInput(el.inAwayCode, (v) => { live.away.code = v.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase().slice(0, 4); }, look);
  const colourInput = (side) => (v) => {
    if (!M.isHex(v)) return;
    live[side].color = v.toLowerCase();
    if (live.feed.kitColours && live.feed.fixtureId) feedSettings({ kitColours: false }); // a colour picked by hand stays
  };
  onInput(el.inHomeColor, colourInput('home'), look);
  onInput(el.inAwayColor, colourInput('away'), look);
  onInput(el.inComp, (v) => { live.comp = v.slice(0, 40); }, look);
  onInput(el.inKickoff, (v) => { live.kickoff = v.trim().slice(0, 5); live.kickoffAt = M.kickoffAtFor(live.kickoff); }, look);
  onInput(el.inPoss, (v) => { const h = M.clamp(Math.round(+v) || 0, 0, 100); live.stats.poss = [h, 100 - h]; });
  onInput(el.inScale, (v) => { live.scale = M.clamp(+v / 100, 0.5, 1.6); keepInside('bug'); keepInside('card'); }, look);
  onInput(el.inBugSize, (v) => { live.bug.s = M.clamp(+v / 100, 0.6, 1.5); keepInside('bug'); }, look);
  onInput(el.inCardSize, (v) => { live.card.s = M.clamp(+v / 100, 0.6, 1.3); keepInside('card'); }, look);
  el.periodMore.addEventListener('change', () => {
    const v = el.periodMore.value;
    el.periodMore.value = '';
    if (v && live && !blocked()) jumpPeriod(v);
  });
  el.dayInput.addEventListener('change', () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(el.dayInput.value)) { feedDay = el.dayInput.value; syncFeed(); loadFixtures(false); }
  });
  el.kitToggle.addEventListener('change', () => feedSettings({ kitColours: el.kitToggle.checked }));
  el.crestToggle.addEventListener('change', () => feedSettings({ crests: el.crestToggle.checked }));
  [['home', el.inHomeCrest], ['away', el.inAwayCrest]].forEach(([side, input]) => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) uploadCrest(file, side, input.closest('label'));
    });
  });
  el.inClock.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setClockFromInput(); } });
  el.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });

  /* ---------- Start ---------- */
  buildCompChips();
  buildStatChips();
  SB.listen({
    onState: (s) => {
      const first = !live;
      receive(s);
      if (first) loadFixtures(false);
    },
    onStatus,
  });
  initAuth();
  setInterval(tickReadout, 250);
})();
