import { avatar } from './avatars.js';
import { markdown } from './markdown.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const bytes = n => { if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(n >= 10 || !i ? 0 : 1)} ${u[i]}`; };
const ago = t => { if (!t) return ''; const s = Math.round((Date.now() - new Date(t)) / 1000); if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; };
const home = p => String(p || '').replace(/^\/Users\/[^/]+/, '~');
const base = p => String(p || '').split('/').filter(Boolean).pop() || '~';
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const level = p => (p > 90 ? 'bad' : p > 75 ? 'warn' : '');
const harnessName = { claude:'Claude Code', codex:'Codex' };
// What a session is called: the name you gave it, else Claude's AI title or the first prompt.
const display = s => s.name || s.title || '(untitled)';
const where = s => [base(s.cwd), s.branch && s.branch !== 'HEAD' ? s.branch : ''].filter(Boolean).join(' · ');
const helpersChip = s => (s.subagents?.running ? `<span class="chip blue">🤖 ${s.subagents.running} working</span>` : '');

// ---------- Talking to the Mac ----------
// Errors carry a kind so screens can say something useful: the Mac is unreachable (asleep, offline, tunnel
// restarting), it took too long, or it answered with a problem of its own.
class ApiError extends Error {
  constructor(message, kind, status) { super(message); this.kind = kind; this.status = status; }
}
const offlineMessage = "Can't reach your Mac. It may be asleep or offline.";

async function api(path, body, { timeout = body === undefined ? 15000 : 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, { signal:ctrl.signal, ...(body === undefined ? {} : { method:'POST', headers:{ 'content-type':'application/json', 'x-lookout':'1' }, body:JSON.stringify(body) }) });
  } catch (e) {
    connection(false);
    throw new ApiError(e.name === 'AbortError' ? 'Your Mac is taking too long to answer.' : offlineMessage, e.name === 'AbortError' ? 'timeout' : 'offline');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => null);
  // Cloudflare answers 502/530 with an HTML page when the Mac side of the tunnel is gone.
  if (!data && res.status >= 500) { connection(false); throw new ApiError(offlineMessage, 'offline', res.status); }
  connection(true);
  if ((res.status === 401 || res.status === 423) && !path.startsWith('/api/auth/')) { gate(); throw new ApiError('Signed out', 'auth', res.status); }
  if (!res.ok) throw new ApiError(data?.error || (res.status >= 500 ? 'Something went wrong on your Mac. Try again.' : `Request failed (${res.status})`), res.status >= 500 ? 'server' : 'client', res.status);
  return data ?? {};
}

// A pill at the top while the Mac is unreachable; screens keep showing their last data underneath.
let online = true;
let offlineSince = 0;
function connection(ok) {
  if (ok === online) return;
  online = ok;
  offlineSince = ok ? 0 : Date.now();
  const pill = $('#conn');
  pill.hidden = false;
  pill.className = `conn ${ok ? 'ok' : 'bad'}`;
  pill.innerHTML = ok ? '✓ Reconnected' : '<span class="spin"></span> Reconnecting to your Mac…';
  if (ok) setTimeout(() => { if (online) pill.hidden = true; }, 1800);
}
window.addEventListener('offline', () => connection(false));
window.addEventListener('online', () => { if (!$('#app').hidden) route(); });

let toastTimer;
function toast(text, bad) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast${bad ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
// Buttons show they are working: the one that was pressed disables and spins until its action settles,
// so nothing is sent twice and a slow Mac never looks like a dead button.
let pressed = null;
document.addEventListener('click', e => { pressed = { el:e.target.closest('button, .send, label.switch input'), at:Date.now() }; }, true);
async function attempt(fn, ok) {
  const el = pressed && Date.now() - pressed.at < 300 ? pressed.el : null;
  if (el?.classList.contains('busy')) return;
  el?.classList.add('busy');
  if (el) el.disabled = true;
  try { const r = await fn(); if (ok) toast(ok); return r; }
  catch (e) { if (e.kind !== 'auth') toast(e.message, true); }
  finally { el?.classList.remove('busy'); if (el?.isConnected) el.disabled = false; }
}

// ---------- Loading and error screens ----------
const skeleton = (rows = 4, kind = 'row') => `<div class="skeleton" aria-busy="true" aria-label="Loading">${Array.from({ length:rows }, () => `<div class="sk ${kind}"></div>`).join('')}</div>`;
const skeletonHome = () => `<div class="top"><h1>Lookout</h1></div>${skeleton(1, 'block')}<div class="section"><div class="sk line"></div></div><div class="live">${skeleton(4, 'card').replace(/^<div class="skeleton"[^>]*>|<\/div>$/g, '')}</div>${skeleton(3)}`;
function errorPanel(e, retry) {
  const icon = { offline:'📡', timeout:'⏳', server:'⚠️' }[e?.kind] || '⚠️';
  const hint = { offline:'Lookout will keep trying. Check that your Mac is awake and online.', timeout:'It may be busy. Try again in a moment.' }[e?.kind] || '';
  return `<div class="state-panel"><div class="big">${icon}</div><b>${esc(e?.message || 'Something went wrong.')}</b>${hint ? `<div class="small muted">${hint}</div>` : ''}<button class="primary" data-retry>Try again</button></div>`;
}
// Runs a screen's first load: skeleton until data arrives, a retryable error panel if it fails.
async function firstLoad(box, load, skel = skeleton()) {
  box.innerHTML = skel;
  try { await load(); }
  catch (e) {
    if (e.kind === 'auth') return;
    box.innerHTML = errorPanel(e);
    box.querySelector('[data-retry]').onclick = () => firstLoad(box, load, skel);
    // Come back by itself once the Mac is reachable again.
    const wait = setInterval(() => { if (online && box.isConnected && box.querySelector('[data-retry]')) { clearInterval(wait); firstLoad(box, load, skel); } else if (!box.isConnected) clearInterval(wait); }, 3000);
  }
}


function sheet(html, bind) {
  $('#sheet-card').innerHTML = html;
  $('#sheet').hidden = false;
  bind?.($('#sheet-card'));
}
const closeSheet = () => { $('#sheet').hidden = true; };
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeSheet(); });
function confirmSheet(title, detail, label, danger) {
  return new Promise(resolve => sheet(`<h3>${esc(title)}</h3>${detail ? `<p class="muted small">${esc(detail)}</p>` : ''}<button class="${danger ? 'bad' : 'primary'}" data-yes>${esc(label)}</button><button class="ghost" data-no>Cancel</button>`, card => {
    card.querySelector('[data-yes]').onclick = () => { closeSheet(); resolve(true); };
    card.querySelector('[data-no]').onclick = () => { closeSheet(); resolve(false); };
  }));
}

// ---------- Sign in / pairing ----------
// The QR on the Mac opens /#pair=CODE; keep the code until sign-in, then drop it from the address bar.
const pairMatch = location.hash.match(/pair=([\w-]+)/);
if (pairMatch) { sessionStorage.setItem('pair', pairMatch[1]); history.replaceState(null, '', '/'); }
const pairCode = () => sessionStorage.getItem('pair') || '';

let gateTimer;
async function gate() {
  stop();
  clearTimeout(gateTimer);
  const state = await fetch('/api/auth/state').then(r => r.json()).catch(() => null);
  const g = $('#gate');
  if (!state) {
    // Signed-in phones keep their screen and just show the reconnecting pill; only a cold start lands here.
    if (!$('#app').hidden) { connection(false); gateTimer = setTimeout(gate, 3000); return; }
    g.hidden = false;
    g.innerHTML = `<div class="box"><img src="/icon.svg" alt=""><h1>Can't reach your Mac</h1><p>Make sure it's awake and connected to the internet. If you use the phone link, Lookout may be restarting its connection.</p><p class="small muted"><span class="spin"></span> Trying again…</p><button class="primary" id="retry-gate">Try now</button></div>`;
    $('#retry-gate').onclick = gate;
    gateTimer = setTimeout(gate, 4000);
    return;
  }
  connection(true);
  if (state.authed && state.approved) return start(state);
  $('#app').hidden = true;
  g.hidden = false;
  if (state.authed && !state.approved) {
    g.innerHTML = `<div class="box"><img src="/icon.svg" alt=""><h1>Waiting for your Mac</h1><p>Approve <b>${esc(state.device?.name || 'this device')}</b> on your Mac: open Lookout there and tap <b>Approve</b>.</p><p class="small muted"><span class="dot amber"></span> Checking…</p><button class="ghost" id="cancel">Cancel</button></div>`;
    $('#cancel').onclick = async () => { await api('/api/auth/logout', {}); gate(); };
    gateTimer = setTimeout(gate, 3000);
    return;
  }
  const setup = !state.setup;
  if (setup && !state.local) {
    g.innerHTML = '<div class="box"><img src="/icon.svg" alt=""><h1>Lookout</h1><p>Open Lookout on your Mac first and choose a password.</p></div>';
    return;
  }
  g.innerHTML = `<form class="box" id="signin"><img src="/icon.svg" alt=""><h1>Lookout</h1>
    <p>${setup ? 'Choose a password. You will use it to sign in from your phone.' : pairCode() ? 'Paired with your Mac. Enter your password.' : 'Your Mac and its coding agents, in your pocket.'}</p>
    <input id="pw" type="password" placeholder="Password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required>
    <button class="primary" type="submit">${setup ? 'Set password' : 'Sign in'}</button><div class="error" id="err"></div></form>`;
  $('#pw').focus();
  $('#signin').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#signin button[type=submit]');
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { password:$('#pw').value, pair:pairCode() });
      sessionStorage.removeItem('pair');
      gate();
    } catch (err) { $('#err').textContent = err.message; btn.classList.remove('busy'); btn.disabled = false; }
  };
}

// ---------- Router ----------
let me = { local:false };
let timers = [];
const busyTyping = () => document.activeElement?.matches('textarea, input:not([type=search])') && document.activeElement.value;
const every = (ms, fn) => { timers.push(setInterval(() => { if (!document.hidden && !busyTyping() && $('#sheet').hidden) fn(); }, ms)); };
function stop() { timers.forEach(clearInterval); timers = []; }

function start(state) {
  me = state;
  $('#gate').hidden = true;
  $('#app').hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  route();
}
window.addEventListener('hashchange', () => { if (!$('#app').hidden) route(); });

function route() {
  stop();
  closeSheet();
  const [, page, ...rest] = location.hash.split('/');
  const tab = page === 's' ? 'home' : page || 'home';
  document.querySelectorAll('#tabs [data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  document.body.classList.toggle('in-session', page === 's');
  window.scrollTo(0, 0);
  const view = { s:() => (rest[2] === 'a' ? subagentView(rest[0], decodeURIComponent(rest[1] || ''), decodeURIComponent(rest[3] || '')) : sessionView(rest[0], decodeURIComponent(rest[1] || ''))), system:() => systemView(rest[0] || 'processes'), settings:settingsView }[page] || homeView;
  view();
  pollBadges();
  every(4000, pollBadges);
}

async function pollBadges() {
  const b = await api('/api/badges').catch(() => null);
  if (!b) return;
  $('#pip-home').textContent = b.needsYou || '';
  $('#pip-system').textContent = b.updates || '';
  $('#pip-settings').textContent = b.devicesWaiting || '';
  document.title = b.needsYou ? `(${b.needsYou}) Lookout` : 'Lookout';
}

// ---------- Home ----------
const draft = { harness:localStorage.getItem('harness') || 'claude', cwd:localStorage.getItem('cwd') || '', text:'', model:'default', skip:false, name:'' };
const models = { claude:['default', 'opus', 'sonnet', 'haiku'], codex:['default'] };
const optsLabel = () => [draft.model === 'default' ? 'Default model' : draft.model, draft.skip ? 'no prompts' : '', draft.name ? `“${draft.name}”` : ''].filter(Boolean).join(' · ');

function optionsSheet(done) {
  sheet(`<h3>Options for this session</h3>
    <div class="small muted">Model</div><div class="seg" id="models">${models[draft.harness].map(m => `<button data-m="${m}" class="${m === draft.model ? 'on' : ''}">${m === 'default' ? 'Default' : m}</button>`).join('')}</div>
    <input id="model-other" placeholder="Or another model id, e.g. claude-opus-5-5 / gpt-6" value="${models[draft.harness].includes(draft.model) ? '' : esc(draft.model)}" autocapitalize="off" autocorrect="off">
    <div class="small muted">Name (optional)</div><input id="opt-name" maxlength="80" value="${esc(draft.name)}" placeholder="e.g. Fix login bug">
    <label class="row" style="background:var(--card)"><div class="grow"><div class="t">Skip permission prompts</div><div class="s" style="white-space:normal">The agent runs commands and edits files without asking. Only for work you trust.</div></div><span class="switch"><input type="checkbox" id="opt-skip" ${draft.skip ? 'checked' : ''}><i></i></span></label>
    <button class="primary" id="opt-done">Done</button>`, card => {
    card.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { card.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b)); card.querySelector('#model-other').value = ''; });
    card.querySelector('#opt-done').onclick = () => {
      const other = card.querySelector('#model-other').value.trim();
      draft.model = other || card.querySelector('[data-m].on')?.dataset.m || 'default';
      draft.name = card.querySelector('#opt-name').value.trim();
      draft.skip = card.querySelector('#opt-skip').checked;
      closeSheet();
      done();
    };
  });
}

// Starting takes a few seconds (the Mac opens Terminal and the shell loads); wait for the session, then open it.
function openWhenReady(started, name) {
  sheet(`<h3>Starting ${esc(harnessName[started.harness])}…</h3><p class="small muted">A Terminal window is opening on your Mac in ${esc(base(started.cwd))}. This page opens the session as soon as it appears.</p><div class="row"><span class="dot amber"></span><span class="grow small muted" id="wait-note">Waiting for the agent</span></div><button class="ghost" data-close>Keep browsing</button>`);
  let tries = 0;
  const tick = async () => {
    if ($('#sheet').hidden) return;
    const q = new URLSearchParams({ harness:started.harness, cwd:started.cwd, since:started.startedAt, id:started.id || '' });
    const r = await api(`/api/agents/new?${q}`).catch(() => ({}));
    if (r.id) {
      if (name && !started.id) await api('/api/session/rename', { harness:started.harness, id:r.id, name }).catch(() => {});
      closeSheet();
      location.hash = `#/s/${started.harness}/${encodeURIComponent(r.id)}`;
      return;
    }
    if (++tries > 45) { closeSheet(); toast('Still starting. It will show up under Live sessions.'); return; }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

// ---------- Limits ----------
const until = t => { if (!t) return ''; const m = Math.max(0, Math.round((t - Date.now()) / 60000)); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`; return `${Math.round(h / 24)}d`; };
const planName = p => String(p || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function limitsCard(limits = []) {
  const rows = limits.filter(u => u.state !== 'missing');
  if (!rows.length) return '';
  return `<button class="limits" id="limits" aria-label="Usage limits, tap to refresh">${rows.map(u => `
    <div class="lim"><div class="lim-head"><span class="avatar mini">${avatar(u.harness, 'open')}</span><b>${esc(harnessName[u.harness])}</b><span class="muted small">${esc(planName(u.plan))}</span>${u.state === 'ok' && !u.live && u.checkedAt ? `<span class="muted small" style="margin-left:auto">as of ${ago(u.checkedAt)}</span>` : ''}</div>
    ${u.state === 'ok' ? `<div class="bars">${u.windows.map(w => `<div class="lbar"><div class="lbar-top"><span>${esc(w.label)}</span><b class="${w.percent >= 90 ? 'hot' : ''}">${w.percent}%</b></div><div class="meter ${level(w.percent)}"><i style="width:${Math.min(100, w.percent)}%"></i></div><div class="small muted">${w.resetsAt ? `resets in ${until(w.resetsAt)}` : ''}</div></div>`).join('')}</div>`
      : `<div class="small muted">${esc(u.note || 'Unavailable')}</div>`}</div>`).join('')}</button>`;
}
async function homeView() {
  const view = $('#view');
  view.innerHTML = '<div class="home"></div>';
  const box = view.querySelector('.home');
  let shown = '';
  let showAll = false;
  const render = async () => {
    const d = await api('/api/home');
    const rank = { waiting:0, busy:1 };
    const live = d.sessions.filter(s => s.live).sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || b.updatedAt - a.updatedAt);
    const recent = d.sessions.filter(s => !s.live).slice(0, 6);
    const waiting = live.filter(s => s.status === 'waiting' && !d.approvals.some(a => a.sessionId === s.id));
    const st = d.stats;
    const mem = pct(st.memory.used, st.memory.total);
    const disk = st.disk ? pct(st.disk.used, st.disk.total) : 0;
    const cpu = Math.min(100, Math.round(st.load[0] / st.cpus * 100));
    const html = `
      <div class="top"><h1>Lookout</h1><span class="mac"><span class="dot green"></span>${esc(st.host.replace(/\.local$/, ''))}</span></div>
      ${limitsCard(d.limits)}
      ${d.devicesWaiting.map(dev => `<div class="banner"><div class="grow"><b>${esc(dev.name)}</b> wants to sign in<div class="small muted">${ago(dev.createdAt)}${me.local ? '' : ' · approve it on the Mac'}</div></div>${me.local ? `<button class="good small" data-approve="${dev.id}">Approve</button><button class="ghost small" data-reject="${dev.id}">✕</button>` : ''}</div>`).join('')}
      ${d.approvals.length || waiting.length ? `<div class="section"><h2>Needs you<span class="count">${d.approvals.length + waiting.length}</span></h2></div><div class="list">
        ${d.approvals.map(approvalCard).join('')}
        ${waiting.map(s => `<a class="row" href="#/s/${s.harness}/${s.id}"><div class="avatar">${avatar(s.harness, 'waiting')}</div><div class="grow"><div class="t">${esc(display(s))}</div><div class="s">${esc(where(s))}</div></div><span class="chip amber">Answer ›</span></a>`).join('')}
      </div>` : ''}
      <div class="section"><h2>Live sessions<span class="count">${live.length}</span></h2></div>
      ${live.length ? `<div class="live">${live.slice(0, showAll ? 99 : 6).map(s => `
        <a href="#/s/${s.harness}/${s.id}" class="${s.status === 'waiting' ? 'waiting' : ''}">
          <span class="harness">${esc(harnessName[s.harness] || s.harness)}</span>
          <div class="avatar big">${avatar(s.harness, s.status)}</div>
          <div><div class="name">${esc(display(s))}</div><div class="what">${esc(where(s))}</div></div>
          <div class="chips">${statusChip(s)}${helpersChip(s)}</div>
        </a>`).join('')}</div>${live.length > 6 ? `<button class="more" id="more">${showAll ? 'Show fewer' : `Show all ${live.length}`}</button>` : ''}` : '<div class="empty">No agents running. Start one below.</div>'}
      ${recent.length ? `<div class="section"><h2>Pick up where you left off</h2></div><div class="list">${recent.map(s => `
        <a class="row" href="#/s/${s.harness}/${s.id}"><div class="avatar">${avatar(s.harness, 'off')}</div><div class="grow"><div class="t">${esc(display(s))}</div><div class="s">${esc(where(s))} · ${ago(s.updatedAt)}${s.subagents?.total ? ` · ${s.subagents.total} helpers` : ''}</div></div><span class="chev">›</span></a>`).join('')}</div>` : ''}
      <div class="section"><h2>This Mac</h2><a href="#/system" class="small muted">More ›</a></div>
      <div class="glance">
        ${glance('#/system/processes', 'CPU', `${cpu}%`, cpu)}
        ${glance('#/system/processes', 'Memory', `${mem}%`, mem)}
        ${glance('#/system/ports', 'Disk free', bytes(st.disk?.free), disk)}
        ${glance('#/system/updates', 'Updates', d.updates, null)}
      </div>
      <div id="composer-slot"></div>`;
    if (html === shown) return;
    shown = html;
    const keep = $('#draft')?.value;
    box.innerHTML = html;
    composer(d.projects, keep, render);
    bindApprovals(box, render);
    $('#more')?.addEventListener('click', () => { showAll = !showAll; render(); });
    $('#limits')?.addEventListener('click', () => attempt(async () => { await api('/api/usage?force=1'); shown = ''; render(); }, 'Refreshed'));
    box.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/devices/approve', { id:b.dataset.approve }); render(); }, 'Device approved'));
    box.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/devices/remove', { id:b.dataset.reject }); render(); }));
  };
  await firstLoad(box, render, skeletonHome());
  every(4000, () => render().catch(() => {}));
}

function composer(projects, keep, after) {
  $('#composer-slot').outerHTML = `<form class="composer" id="composer">
    <textarea id="draft" rows="1" placeholder="Ask an agent to do something…"></textarea>
    <div class="bar"><button type="button" class="pick" id="pick-harness">${esc(harnessName[draft.harness])}</button><button type="button" class="pick" id="pick-cwd">📁 ${esc(draft.cwd ? base(draft.cwd) : 'Project')}</button><button type="button" class="pick" id="pick-opts">${esc(optsLabel())}</button><span class="grow"></span><button class="send" type="submit" aria-label="Start">↑</button></div>
  </form>`;
  const ta = $('#draft');
  ta.value = keep ?? draft.text;
  ta.oninput = () => { draft.text = ta.value; grow(ta); };
  grow(ta);
  const setCwd = cwd => { draft.cwd = cwd; localStorage.setItem('cwd', cwd); $('#pick-cwd').textContent = `📁 ${base(cwd)}`; };
  $('#pick-harness').onclick = () => sheet(`<h3>Which agent?</h3>${Object.entries(harnessName).map(([k, v]) => `<button data-h="${k}" class="row" style="text-align:left"><div class="avatar">${avatar(k, 'open')}</div><div class="grow t">${v}</div>${k === draft.harness ? '✓' : ''}</button>`).join('')}`, card => card.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
    draft.harness = b.dataset.h;
    localStorage.setItem('harness', draft.harness);
    $('#pick-harness').textContent = harnessName[draft.harness];
    draft.model = 'default';
    $('#pick-opts').textContent = optsLabel();
    closeSheet();
  }));
  $('#pick-opts').onclick = () => optionsSheet(() => { $('#pick-opts').textContent = optsLabel(); });
  $('#pick-cwd').onclick = () => pickProject(projects, setCwd);
  $('#composer').onsubmit = e => {
    e.preventDefault();
    if (!draft.cwd) return pickProject(projects, setCwd);
    attempt(async () => {
      const name = draft.name;
      const started = await api('/api/agents/start', { harness:draft.harness, cwd:draft.cwd, prompt:ta.value, model:draft.model, skipPermissions:draft.skip, name });
      draft.text = '';
      draft.name = '';
      ta.value = '';
      grow(ta);
      $('#pick-opts').textContent = optsLabel();
      openWhenReady(started, name);
    });
  };
}
const grow = ta => { ta.style.height = 'auto'; ta.style.height = `${Math.min(160, ta.scrollHeight)}px`; };
const glance = (href, label, value, fill) => `<a href="${href}"><div class="l">${label}</div><div class="v">${value}</div>${fill == null ? '' : `<div class="meter ${level(fill)}"><i style="width:${fill}%"></i></div>`}</a>`;
function statusChip(s) {
  if (!s.live) return '<span class="chip">Closed</span>';
  if (s.status === 'waiting') return '<span class="chip amber"><span class="dot amber"></span>Waiting for you</span>';
  if (s.status === 'busy') return '<span class="chip blue"><span class="dot blue"></span>Working</span>';
  return '<span class="chip green"><span class="dot green"></span>Idle</span>';
}

function pickProject(projects, done) {
  sheet(`<h3>Project</h3><div class="list">${projects.map(p => `<button class="row" data-cwd="${esc(p)}" style="text-align:left"><div class="grow"><div class="t">${esc(base(p))}</div><div class="s">${esc(home(p))}</div></div></button>`).join('')}</div>
    <input id="custom-cwd" placeholder="Or a folder path, e.g. ~/code/app" autocapitalize="off" autocorrect="off"><button class="primary" id="use-cwd">Use this folder</button>`, card => {
    card.querySelectorAll('[data-cwd]').forEach(b => b.onclick = () => { closeSheet(); done(b.dataset.cwd); });
    card.querySelector('#use-cwd').onclick = () => { const v = card.querySelector('#custom-cwd').value.trim(); if (v) { closeSheet(); done(v); } };
  });
}

// ---------- Approvals ----------
const summarize = i => i?.command || i?.file_path || i?.url || i?.pattern || i?.description || JSON.stringify(i ?? {}).slice(0, 160);
function approvalCard(p) {
  const i = p.input || {};
  let body = `<pre>${esc(JSON.stringify(i, null, 2).slice(0, 3000))}</pre>`;
  if (i.command) body = `<pre>$ ${esc(i.command)}</pre>${i.description ? `<div class="small muted">${esc(i.description)}</div>` : ''}`;
  else if (i.file_path) body = `<div class="mono small">${esc(home(i.file_path))}</div>${i.content != null || i.new_string != null ? `<pre>${esc(String(i.content ?? `- ${i.old_string}\n+ ${i.new_string}`).slice(0, 3000))}</pre>` : ''}`;
  return `<div class="approval"><div class="head"><div class="avatar">${avatar('claude', 'waiting')}</div><div class="grow"><b>Claude wants to use ${esc(p.tool)}</b><div class="small muted">${esc(base(p.cwd))} · ${ago(p.createdAt)}</div></div></div>
    ${body}<div class="actions"><button class="bad" data-deny="${p.id}">Deny</button><button class="good" data-allow="${p.id}">Allow</button></div></div>`;
}
function bindApprovals(root, after) {
  root.querySelectorAll('[data-allow]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/approvals/decide', { id:b.dataset.allow, decision:'allow' }); after(); }, 'Allowed'));
  root.querySelectorAll('[data-deny]').forEach(b => b.onclick = () => sheet(`<h3>Deny this request?</h3><input id="why" placeholder="Tell Claude what to do instead (optional)"><button class="bad" id="do-deny">Deny</button><button class="ghost" data-close>Cancel</button>`, card => {
    card.querySelector('#do-deny').onclick = () => { closeSheet(); attempt(async () => { await api('/api/approvals/decide', { id:b.dataset.deny, decision:'deny', message:card.querySelector('#why').value }); after(); }, 'Denied'); };
  }));
}

// ---------- Session ----------
async function sessionView(harness, id) {
  let tab = 'chat';
  let info = null;
  const view = $('#view');
  view.innerHTML = `<div class="session"><header><div class="who"><button class="back" id="back" aria-label="Back">‹</button><div class="avatar" id="s-avatar">${avatar(harness, 'open')}</div><button class="grow title-btn" id="s-name" aria-label="Rename"><h1 id="s-title">Loading…</h1><div class="small muted" id="s-sub"></div></button><span id="s-chip"></span></div>
    <div class="seg" id="s-tabs"><button data-t="chat" class="on">Chat</button>${harness === 'claude' ? '<button data-t="helpers">Helpers</button>' : ''}<button data-t="terminal">Terminal</button><button data-t="files">Files</button></div></header>
    <div class="pane" id="pane"></div><div class="foot" id="foot"></div></div>`;
  $('#back').onclick = () => { location.hash = '#/'; };
  $('#s-name').onclick = () => renameSheet(harness, id, info?.session, () => draw(false));
  const pane = $('#pane');
  const foot = $('#foot');
  let lastPane = '';
  $('#s-tabs').onclick = e => {
    const b = e.target.closest('[data-t]');
    if (!b || b.dataset.t === tab) return;
    tab = b.dataset.t;
    $('#s-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    lastPane = '';
    foot.dataset.key = '';
    pane.innerHTML = skeleton(4, tab === 'chat' ? 'bubble' : 'row');
    draw(true).catch(e => sessionError(pane, e, () => draw(true)));
  };

  // Fetching and painting are separate so a pending message can be shown even while the Mac is unreachable.
  const draw = async first => {
    info = await api(`/api/session?harness=${harness}&id=${encodeURIComponent(id)}&view=${tab}`);
    paint(first);
  };
  const paint = first => {
    if (!info) return;
    const s = info.session;
    $('#s-title').textContent = `${display(s)} ✎`;
    $('#s-sub').textContent = where(s);
    const helperTab = $('#s-tabs [data-t=helpers]');
    if (helperTab) helperTab.textContent = s.subagents?.length ? `Helpers ${s.subagents.filter(a => a.status === 'running').length || s.subagents.length}` : 'Helpers';
    $('#s-chip').innerHTML = statusChip(s);
    $('#s-avatar').innerHTML = avatar(harness, s.live ? s.status : 'off');
    let html;
    if (tab === 'chat') {
      // A sent message stays as a pending bubble until it shows up in the transcript.
      const said = new Set(info.messages.filter(m => m.role === 'user').map(m => m.text.trim()));
      outbox = outbox.filter(o => o.state !== 'sent' || !said.has(o.text));
      html = (info.messages.map(m => m.role === 'tool' ? `<div class="tool">▸ ${esc(m.text)}</div>` : `<div class="msg ${m.role}">${m.role === 'assistant' ? markdown(m.text) : esc(m.text).replace(/\n/g, '<br>')}${fileButtons(m.files, harness, id)}<div class="when">${ago(m.time)}</div></div>`).join('') || (outbox.length ? '' : '<div class="empty">No messages yet. Say something below.</div>'))
        + outbox.map((o, i) => `<div class="msg user pending ${o.state}">${esc(o.text).replace(/\n/g, '<br>')}<div class="when">${{ sending:'<span class="spin"></span> Sending to your Mac…', sent:'✓ Delivered · waiting for the agent', failed:`Not sent: ${esc(o.error)} · <button class="linkish" data-resend="${i}">Retry</button>` }[o.state]}</div></div>`).join('');
    } else if (tab === 'helpers') {
      html = info.helpers.length ? `<div class="list">${info.helpers.map(helperRow(harness, id)).join('')}</div>` : '<div class="empty">This session has not started any subagents.</div>';
    } else if (tab === 'terminal') {
      html = info.terminal ? `<div class="small muted">Live · ${esc(info.terminal.tty.replace('/dev/', ''))} on your Mac · updates every 2s</div><div class="screen" id="screen">${esc(info.terminal.screen)}</div>` : `<div class="empty">${esc(info.terminalNote)}</div>`;
    } else {
      html = info.files.length ? info.files.map(f => `<button class="file" data-path="${esc(f.path)}" style="text-align:left"><div class="ico">${f.kind === 'image' ? `<img loading="lazy" src="${fileUrl(harness, id, f.path)}" alt="">` : { video:'🎬', audio:'🎵', pdf:'📄', doc:'📝' }[f.kind]}</div><div style="flex:1;min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">${esc(base(f.path))}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.path)} · ${bytes(f.size)} · ${ago(f.mtime)}</div></div></button>`).join('') : '<div class="empty">No images, videos or documents in this project yet.</div>';
    }
    if (html !== lastPane) {
      const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140;
      pane.innerHTML = html;
      lastPane = html;
      if (tab === 'helpers' || tab === 'files') { if (first) pane.scrollTop = 0; } else if (first || atEnd || tab === 'terminal' || outbox.length) pane.scrollTop = pane.scrollHeight;
      pane.querySelectorAll('[data-resend]').forEach(b => b.onclick = () => { const o = outbox.splice(Number(b.dataset.resend), 1)[0]; send(o.text); });
      $('#screen') && ($('#screen').scrollTop = $('#screen').scrollHeight);
      pane.querySelectorAll('[data-path]').forEach(el => el.onclick = () => previewFile(harness, id, el.dataset.path));
    }
    drawFoot();
  };

  const drawFoot = () => {
    const s = info.session;
    const t = info.terminal;
    if (tab === 'helpers') { foot.innerHTML = ''; foot.dataset.key = 'helpers'; return; }
    const key = tab === 'chat' ? `chat|${info.approvals.map(a => a.id)}|${info.delivery}` : tab === 'terminal' ? `term|${Boolean(t)}|${t?.choices?.map(c => c.label).join()}` : 'files';
    if (foot.dataset.key === key) return;
    foot.dataset.key = key;
    if (tab === 'files') { foot.innerHTML = ''; return; }
    if (tab === 'terminal') {
      foot.innerHTML = t ? `${t.choices?.length ? `<div class="list">${t.choices.map(c => `<button data-k="${c.key}" style="text-align:left">${esc(c.key)}. ${esc(c.label)}</button>`).join('')}</div>` : ''}
        <div class="keys"><button class="stop" data-k="esc">Stop</button><button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button data-k="enter">Enter</button><button data-k="mode" aria-label="Change mode">Mode</button></div>` : '';
      foot.querySelectorAll('[data-k]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/session/keys', { harness, id, key:b.dataset.k }); setTimeout(() => draw(false), 400); }));
      return;
    }
    const keep = $('#reply')?.value || '';
    const copying = info.delivery === 'none';
    const hint = { terminal:'Types into its Terminal tab on your Mac', resume:'Resumes it in a new Terminal window', none:'It is open in another app, so this continues in a copy in Terminal' }[info.delivery] || '';
    foot.innerHTML = `${info.approvals.map(approvalCard).join('')}<form class="composer" id="reply-form"><textarea id="reply" rows="1" placeholder="${copying ? 'Continue in a copy…' : `Message ${harnessName[harness] || 'agent'}…`}"></textarea>
      <div class="bar"><span class="small muted grow">${esc(hint)}</span><button class="send" aria-label="Send">↑</button></div></form>`;
    bindApprovals(foot, () => { foot.dataset.key = ''; draw(false); });
    const ta = $('#reply');
    ta.value = keep;
    ta.oninput = () => grow(ta);
    grow(ta);
    $('#reply-form').onsubmit = e => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      if (copying) {
        return attempt(async () => { const copy = await api('/api/session/fork', { harness, id, text }); ta.value = ''; grow(ta); openWhenReady(copy, copy.name); });
      }
      ta.value = '';
      grow(ta);
      send(text);
    };
  };
  let outbox = [];
  const send = async text => {
    const o = { text, state:'sending' };
    outbox.push(o);
    paint(false);
    try { await api('/api/session/send', { harness, id, text }); o.state = 'sent'; }
    catch (e) { o.state = 'failed'; o.error = e.message; }
    paint(false);
    draw(false).catch(() => {});
  };
  pane.innerHTML = skeleton(5, 'bubble');
  await draw(true).catch(e => sessionError(pane, e, () => draw(true)));
  every(tab === 'terminal' ? 2000 : 3000, () => draw(false).catch(() => {}));
}
function sessionError(pane, e, retry) {
  if (e.kind === 'auth') return;
  if (e.status === 404) {
    pane.innerHTML = '<div class="state-panel"><div class="big">🔍</div><b>This session is gone.</b><div class="small muted">Its transcript was deleted or moved.</div><a href="#/"><button class="primary">Back to Home</button></a></div>';
    return;
  }
  pane.innerHTML = errorPanel(e);
  pane.querySelector('[data-retry]').onclick = () => { pane.innerHTML = skeleton(5, 'bubble'); retry().catch(err => sessionError(pane, err, retry)); };
}

const fileUrl = (h, id, p, dl) => `/api/session/file?harness=${h}&id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}${dl ? '&download=1' : ''}`;
const fileButtons = (files, h, id) => (files?.length ? `<div class="filebtns">${files.map(f => `<a href="${fileUrl(h, id, f, true)}">⬇ ${esc(base(f))}</a>`).join('')}</div>` : '');
function previewFile(h, id, p) {
  const url = fileUrl(h, id, p);
  const ext = p.split('.').pop().toLowerCase();
  const media = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext) ? `<img src="${url}" alt="">` : ['mp4', 'mov', 'webm', 'm4v'].includes(ext) ? `<video src="${url}" controls playsinline></video>` : ['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext) ? `<audio src="${url}" controls></audio>` : '';
  sheet(`<h3>${esc(base(p))}</h3><div class="small muted">${esc(p)}</div><div class="preview">${media}</div><a href="${fileUrl(h, id, p, true)}" class="button-link"><button class="primary" style="width:100%">Download</button></a><button class="ghost" data-close>Close</button>`);
}

const helperChip = a => ({ running:'<span class="chip blue"><span class="dot blue"></span>Working</span>', done:'<span class="chip green">Done</span>', stopped:'<span class="chip">Stopped</span>' })[a.status];
const helperRow = (harness, id) => a => `<a class="row helper" href="#/s/${harness}/${encodeURIComponent(id)}/a/${encodeURIComponent(a.id)}"><div class="avatar">${avatar(harness, a.status === 'running' ? 'busy' : a.status === 'done' ? 'open' : 'off')}</div>
  <div class="grow"><div class="t">${esc(a.task || a.type)}</div><div class="s">${esc(a.type)} · ${ago(a.updatedAt)}${a.lastText ? ` · ${esc(a.lastText)}` : ''}</div></div>${helperChip(a)}</a>`;

function renameSheet(harness, id, session, after) {
  sheet(`<h3>Name this session</h3><p class="small muted">Shown on your phone and in notifications. Leave empty to use ${esc(session?.title || 'the AI title')}.</p>
    <input id="new-name" maxlength="80" value="${esc(session?.name || '')}" placeholder="${esc(session?.title || '')}"><button class="primary" id="save-name">Save</button><button class="ghost" data-close>Cancel</button>`, card => {
    const input = card.querySelector('#new-name');
    input.focus();
    const save = () => attempt(async () => { await api('/api/session/rename', { harness, id, name:input.value }); closeSheet(); after(); }, 'Renamed');
    card.querySelector('#save-name').onclick = save;
    input.onkeydown = e => { if (e.key === 'Enter') save(); };
  });
}

// A subagent's own transcript, read-only, reached from its parent's Helpers tab.
async function subagentView(harness, id, agent) {
  const view = $('#view');
  view.innerHTML = `<div class="session"><header><div class="who"><button class="back" id="back" aria-label="Back">‹</button><div class="avatar" id="s-avatar">${avatar(harness, 'busy')}</div><div class="grow"><h1 id="s-title">Loading…</h1><div class="small muted" id="s-sub"></div></div><span id="s-chip"></span></div></header>
    <div class="pane" id="pane"></div><div class="foot"><div class="small muted" id="s-foot" style="text-align:center">Subagents take their instructions from the main session.</div></div></div>`;
  $('#back').onclick = () => { location.hash = `#/s/${harness}/${encodeURIComponent(id)}`; };
  const pane = $('#pane');
  let last = '';
  const draw = async first => {
    const d = await api(`/api/session?harness=${harness}&id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agent)}`);
    const a = d.subagent;
    $('#s-title').textContent = a.task || a.type;
    $('#s-sub').textContent = `${a.type} · helper of ${display(d.session)}`;
    $('#s-chip').innerHTML = helperChip(a);
    $('#s-avatar').innerHTML = avatar(harness, a.status === 'running' ? 'busy' : a.status === 'done' ? 'open' : 'off');
    const html = d.messages.map(m => m.role === 'tool' ? `<div class="tool">▸ ${esc(m.text)}</div>` : `<div class="msg ${m.role === 'user' ? 'brief' : 'assistant'}">${m.role === 'user' ? `<div class="when">Task from ${esc(display(d.session))}</div>` : ''}${markdown(m.text)}<div class="when">${ago(m.time)}</div></div>`).join('') || '<div class="empty">Nothing yet.</div>';
    if (html === last) return;
    const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 140;
    pane.innerHTML = html;
    last = html;
    if (first || atEnd) pane.scrollTop = pane.scrollHeight;
  };
  pane.innerHTML = skeleton(5, 'bubble');
  await draw(true).catch(e => sessionError(pane, e, () => draw(true)));
  every(3000, () => draw(false).catch(() => {}));
}

// ---------- This Mac ----------
const sysTabs = { processes:'Processes', ports:'Network', startup:'Startup', updates:'Updates', privacy:'Privacy' };
async function systemView(sub) {
  const view = $('#view');
  view.innerHTML = `<div class="top"><h1>This Mac</h1></div><div class="seg" id="sys-tabs">${Object.entries(sysTabs).map(([k, v]) => `<button data-k="${k}" class="${k === sub ? 'on' : ''}">${v}</button>`).join('')}</div><div id="sys"></div>`;
  $('#sys-tabs').onclick = e => { const b = e.target.closest('[data-k]'); if (b) location.hash = `#/system/${b.dataset.k}`; };
  const box = $('#sys');
  const show = { processes, ports, startup, updates, privacy }[sub] || processes;
  // Each attempt renders into a fresh container, swapped in once its first data has arrived.
  await firstLoad(box, async () => { const inner = document.createElement('div'); await show(inner); box.replaceChildren(inner); }, `<div style="margin-top:12px">${skeleton(1, 'line')}${skeleton(7)}</div>`);
}

function searchable(box, placeholder, renderRows) {
  let q = '';
  box.innerHTML = `<div class="search"><input type="search" id="q" placeholder="${placeholder}" autocapitalize="off" autocorrect="off"></div><div class="list" id="rows"></div>`;
  const draw = () => { box.querySelector('#rows').innerHTML = renderRows(q.toLowerCase()); };
  box.querySelector('#q').oninput = e => { q = e.target.value; draw(); };
  return draw;
}

async function processes(box) {
  let rows = [];
  let sort = 'cpu';
  const draw = searchable(box, 'Search processes', q => {
    const list = rows.filter(p => !q || `${p.name} ${p.command} ${p.pid}`.toLowerCase().includes(q)).sort((a, b) => sort === 'cpu' ? b.cpu - a.cpu : b.rss - a.rss).slice(0, 80);
    return `<div class="seg"><button data-sort="cpu" class="${sort === 'cpu' ? 'on' : ''}">By CPU</button><button data-sort="mem" class="${sort === 'mem' ? 'on' : ''}">By memory</button></div>` +
      list.map(p => `<button class="row" data-pid="${p.pid}" style="text-align:left"><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${p.pid} · ${esc(p.user)} · up ${esc(p.elapsed)}</div></div><div class="metric">${p.cpu.toFixed(1)}%<div class="small muted">${bytes(p.rss)}</div></div></button>`).join('');
  });
  const load = async () => { rows = await api('/api/processes'); draw(); };
  box.addEventListener('click', e => {
    const s = e.target.closest('[data-sort]');
    if (s) { sort = s.dataset.sort; return draw(); }
    const r = e.target.closest('[data-pid]');
    if (!r) return;
    const p = rows.find(x => x.pid === Number(r.dataset.pid));
    sheet(`<h3>${esc(p.name)}</h3><pre class="small muted">${esc(p.command)}</pre><div class="small muted">PID ${p.pid} · ${esc(p.user)} · ${p.cpu.toFixed(1)}% CPU · ${bytes(p.rss)} · up ${esc(p.elapsed)}</div>
      <button data-sig="term">Quit</button><button class="bad" data-sig="kill">Force quit</button><button class="ghost" data-close>Close</button>`, card => {
      card.querySelectorAll('[data-sig]').forEach(b => b.onclick = () => { closeSheet(); attempt(async () => { await api('/api/processes/kill', { pid:p.pid, force:b.dataset.sig === 'kill' }); load(); }, 'Signal sent'); });
    });
  });
  await load();
  every(5000, load);
}

async function ports(box) {
  let rows = [];
  const draw = searchable(box, 'Search ports or programs', q => rows.filter(p => !q || `${p.command} ${p.port}`.toLowerCase().includes(q)).map(p => `
    <button class="row" data-pid="${p.pid}" data-name="${esc(p.command)}" style="text-align:left"><div class="metric" style="text-align:left;min-width:64px">:${p.port}</div><div class="grow"><div class="t">${esc(p.command)}</div><div class="s">${p.protocol} · ${esc(p.address)} · pid ${p.pid}</div></div>${p.exposed ? '<span class="chip amber">Exposed</span>' : '<span class="chip green">Local</span>'}</button>`).join('') || '<div class="empty">Nothing is listening.</div>');
  const load = async () => { rows = await api('/api/ports'); draw(); };
  box.addEventListener('click', e => {
    const r = e.target.closest('[data-pid]');
    if (r) confirmSheet(`Stop ${r.dataset.name}?`, `PID ${r.dataset.pid}. Anything using this port will disconnect.`, 'Stop it', true).then(ok => ok && attempt(async () => { await api('/api/processes/kill', { pid:Number(r.dataset.pid) }); load(); }, 'Signal sent'));
  });
  await load();
  every(8000, load);
}

async function startup(box) {
  let rows = [];
  const scope = { user:'Yours', 'global-agent':'All users', daemon:'System' };
  const draw = searchable(box, 'Search startup items', q => rows.filter(r => !q || `${r.label} ${r.program}`.toLowerCase().includes(q)).map(r => `
    <button class="row" data-label="${esc(r.label)}" style="text-align:left"><span class="dot ${r.pid ? 'green' : ''}"></span><div class="grow"><div class="t">${esc(r.label)}</div><div class="s">${scope[r.scope]} · ${r.pid ? `running (${r.pid})` : r.loaded ? 'loaded' : r.scope === 'daemon' ? 'system' : 'not loaded'}${r.runAtLoad ? ' · at login' : ''}</div></div><span class="chev">›</span></button>`).join(''));
  const load = async () => { rows = await api('/api/startup'); draw(); };
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-label]');
    if (!b) return;
    const r = rows.find(x => x.label === b.dataset.label);
    sheet(`<h3>${esc(r.label)}</h3><pre class="small muted">${esc(r.program || r.file)}</pre><div class="small muted">${esc(home(r.file))}</div>
      ${r.controllable ? (r.loaded ? '<button class="bad" data-a="stop">Stop and unload</button>' : '<button class="primary" data-a="start">Start</button>') : '<div class="small muted">System daemons need sudo to change.</div>'}
      ${me.local ? '<button data-a="reveal">Show in Finder</button>' : ''}<button class="ghost" data-close>Close</button>`, card => {
      card.querySelectorAll('[data-a]').forEach(x => x.onclick = () => { closeSheet(); attempt(async () => { await api(x.dataset.a === 'reveal' ? '/api/startup/reveal' : '/api/startup/action', { label:r.label, action:x.dataset.a }); load(); }, x.dataset.a === 'reveal' ? '' : 'Done'); });
    });
  });
  await load();
}

async function updates(box) {
  const names = { macos:'macOS', brew:'Homebrew', npm:'npm global' };
  let shown = '';
  const load = async () => {
    const u = await api('/api/updates');
    const running = new Set(u.jobs.filter(j => j.status === 'running').map(j => j.itemId));
    const active = u.jobs.filter(j => j.status === 'running' || Date.now() - (j.finishedAt || 0) < 60000);
    const html = `<div class="section"><span class="muted small">${u.checking ? 'Checking… macOS can take a minute' : `Checked ${ago(u.checkedAt)}`}</span><button class="small" id="recheck" ${u.checking ? 'disabled' : ''}>Check now</button></div>
      ${active.map(j => `<div class="card" style="margin-bottom:8px"><div class="kv"><span class="chip ${j.status === 'done' ? 'green' : j.status === 'failed' ? 'red' : 'blue'}">${j.status}</span><span class="mono small">${esc(j.title)}</span></div><pre class="small muted" style="max-height:120px;overflow:auto;margin-top:8px">${esc(j.output.slice(-1500))}</pre></div>`).join('')}
      ${['macos', 'brew', 'npm'].map(k => {
        const s = u.sources[k];
        const items = s?.items || [];
        const head = `<div class="section"><h2>${names[k]}<span class="count">${items.length}</span></h2>${k === 'brew' && items.length ? '<button class="small" id="all-brew">Update all</button>' : ''}</div>`;
        if (!s) return `${head}<div class="empty">${u.checking ? 'Checking…' : 'Not checked yet'}</div>`;
        if (!s.available) return `${head}<div class="empty">${esc(s.error)}</div>`;
        return head + (items.length ? `<div class="list">${items.map(i => `<div class="row"><div class="grow"><div class="t">${esc(i.name)}</div><div class="s">${esc(i.installed || '')}${i.installed ? ' → ' : ''}${esc(i.latest)}${i.restart ? ' · needs restart' : ''}</div></div>
          ${i.kind === 'macos' ? (me.local ? '<button class="small" data-open-su>Open</button>' : '<span class="small muted">On Mac</span>') : `<button class="small primary" data-up="${esc(i.id)}" ${running.has(i.id) || i.pinned ? 'disabled' : ''}>${running.has(i.id) ? '…' : 'Update'}</button>`}</div>`).join('')}</div>` : '<div class="empty">Up to date</div>');
      }).join('')}`;
    if (html === shown) return;
    shown = html;
    box.innerHTML = html;
    box.querySelector('#recheck').onclick = () => attempt(async () => { await api('/api/updates/refresh', {}); load(); });
    box.querySelectorAll('[data-up]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/updates/upgrade', { id:b.dataset.up }); load(); }, 'Updating'));
    box.querySelectorAll('[data-open-su]').forEach(b => b.onclick = () => attempt(() => api('/api/updates/open-macos', {})));
    box.querySelector('#all-brew')?.addEventListener('click', async () => {
      if (!await confirmSheet('Update all Homebrew packages?', `${u.sources.brew.items.length} packages, one at a time.`, 'Update all')) return;
      attempt(async () => { await api('/api/updates/upgrade-all', { source:'brew' }); load(); }, 'Updating');
    });
  };
  await load();
  every(4000, load);
}

async function privacy(box) {
  const p = await api('/api/privacy');
  const groups = new Map();
  for (const r of p.rows) { if (!groups.has(r.label)) groups.set(r.label, []); groups.get(r.label).push(r); }
  box.innerHTML = `<p class="small muted" style="margin:14px 2px">Which apps can use your camera, microphone, screen and files. macOS only lets you grant access in System Settings; you can revoke it from here.</p>
    ${p.needsFullDiskAccess ? `<div class="banner"><div class="grow small">macOS hides this list unless Lookout's <code>node</code> has <b>Full Disk Access</b>. Add <code>${esc(p.node)}</code> in System Settings, then restart Lookout.</div>${me.local ? '<button class="small primary" data-pane="kTCCServiceSystemPolicyAllFiles">Open</button>' : ''}</div>` : ''}
    ${[...groups].sort().map(([label, rows]) => `<div class="section"><h2>${esc(label)}<span class="count">${rows.length}</span></h2>${me.local ? `<button class="small ghost" data-pane="${esc(rows[0].service)}">Settings ›</button>` : ''}</div><div class="list">${rows.map(r => `
      <div class="row"><div class="grow"><div class="t">${esc(r.client.split(/[./]/).pop())}</div><div class="s">${esc(r.client)}</div></div><span class="chip ${r.status === 'allowed' ? 'green' : r.status === 'denied' ? 'red' : 'amber'}">${esc(r.status)}</span>${r.revocable && r.status !== 'denied' ? `<button class="small bad" data-revoke="${esc(r.service)}" data-client="${esc(r.client)}">Revoke</button>` : ''}</div>`).join('')}</div>`).join('')}`;
  box.querySelectorAll('[data-pane]').forEach(b => b.onclick = () => attempt(() => api('/api/privacy/open', { service:b.dataset.pane })));
  box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    if (await confirmSheet(`Revoke ${b.dataset.client}?`, 'It will ask again the next time it needs access.', 'Revoke', true)) attempt(async () => { await api('/api/privacy/revoke', { service:b.dataset.revoke, client:b.dataset.client }); privacy(box); }, 'Revoked');
  });
}

// ---------- Settings ----------
async function settingsView() {
  const view = $('#view');
  let shown = '';
  const render = async () => {
    const s = await api('/api/settings');
    const t = s.tunnel;
    const pushOn = await pushState();
    const html = `<div class="top"><h1>Settings</h1></div>
      <div class="section"><h2>Phone access</h2></div>
      <div class="group">
        <div class="item"><div class="grow"><b>Use Lookout from your phone</b><div class="s">${{ on:'On · private https link through Cloudflare', missing:'Needs cloudflared (free, installs with Homebrew)', off:'Off · only this Mac can open Lookout', starting:'Starting…', restarting:'Reconnecting…' }[t.status] || esc(t.status)}</div></div>
          ${me.local ? (t.status === 'missing' ? `<button class="small primary" id="install-cf" ${s.installingCloudflared ? 'disabled' : ''}>${s.installingCloudflared ? 'Installing…' : 'Install'}</button>` : `<label class="switch"><input type="checkbox" id="tunnel" ${t.enabled ? 'checked' : ''}><i></i></label>`) : ''}</div>
        ${t.url && me.local ? `<div class="qr"><img src="/api/pair/qr?ts=${s.pairingAt}" alt="QR code to open Lookout on your phone"><b>Scan with your phone's camera</b><div class="small muted" style="text-align:center">Then sign in with your password. Scanning skips the approval step; the code works once and expires in 10 minutes.</div><div class="url mono muted">${esc(t.url)}</div><button class="small" id="copy">Copy link</button></div>
          <div class="item"><div class="grow small muted">On iPhone: in Safari tap Share → <b>Add to Home Screen</b>, open Lookout from there, then turn on notifications below.</div></div>` : ''}
        ${!me.local ? `<div class="item"><div class="grow small muted">Connected through ${esc(location.host)}</div></div>` : ''}
        ${t.error && t.status !== 'missing' ? `<div class="item small" style="color:var(--red)">${esc(t.error)}</div>` : ''}
      </div>
      <div class="section"><h2>Notifications</h2></div>
      <div class="group"><div class="item"><div class="grow"><b>Notify this device</b><div class="s">When an agent needs your OK or finishes, and when a new device asks to sign in.</div></div>
        ${'PushManager' in window && window.isSecureContext && location.protocol === 'https:' ? `<label class="switch"><input type="checkbox" id="push" ${pushOn ? 'checked' : ''}><i></i></label>` : `<span class="small muted" style="max-width:40%;text-align:right">${/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? 'Add to Home Screen first' : 'Needs the https phone link'}</span>`}</div>
        ${pushOn ? '<div class="item"><button class="small" id="test-push">Send a test notification</button></div>' : ''}</div>
      <div class="section"><h2>Approvals</h2></div>
      <div class="group">
        <div class="item"><div class="grow"><b>Answer Claude's permission prompts here</b><div class="s">${s.hook.installed ? 'New Claude sessions send their prompts to Lookout.' : 'Adds a hook to ~/.claude/settings.json (backed up first). Restart Claude sessions afterwards.'}</div></div>
          ${s.hook.installed ? `<label class="switch"><input type="checkbox" id="hold" ${s.approvals.hold ? 'checked' : ''}><i></i></label>` : me.local ? '<button class="small primary" id="hook">Install</button>' : '<span class="small muted">Set up on the Mac</span>'}</div>
        ${s.hook.installed ? `<div class="item"><div class="grow small">If nobody answers, Claude asks in its own window after</div><select id="wait" style="width:auto">${[60, 120, 300, 600].map(n => `<option value="${n}" ${s.approvals.waitSeconds === n ? 'selected' : ''}>${n / 60} min</option>`).join('')}</select></div>` : ''}
      </div>
      ${s.history.length ? `<div class="section"><h2>Recent decisions</h2></div><div class="list">${s.history.slice(0, 5).map(h => `<div class="row"><div class="grow"><div class="t mono small">${esc(summarize(h.input))}</div><div class="s">${esc(h.tool)} · ${esc(base(h.cwd))} · ${ago(h.decidedAt)}</div></div><span class="chip ${h.decision === 'allow' ? 'green' : h.decision === 'deny' ? 'red' : ''}">${h.decision === 'terminal' ? 'in app' : h.decision}</span></div>`).join('')}</div>` : ''}
      <div class="section"><h2>Devices</h2>${s.devices.length > 1 ? '<button class="small ghost" id="others">Sign out others</button>' : ''}</div>
      <div class="group">${s.devices.map(d => `<div class="item"><div class="grow"><b>${esc(d.name)}</b> ${d.id === s.deviceId ? '<span class="chip green">This device</span>' : ''}${d.approved ? '' : '<span class="chip amber">Waiting</span>'}<div class="s">${d.remote ? 'Phone link' : 'On this Mac'} · ${ago(d.lastSeen)}</div></div>
        ${!d.approved && me.local ? `<button class="small good" data-approve="${d.id}">Approve</button>` : ''}${d.id !== s.deviceId ? `<button class="small ghost" data-remove="${d.id}">${d.approved ? 'Sign out' : 'Reject'}</button>` : ''}</div>`).join('')}</div>
      <div style="margin:28px 0"><button class="bad" id="logout" style="width:100%">Sign out</button></div>`;
    if (html === shown) return;
    shown = html;
    view.innerHTML = html;
    $('#tunnel')?.addEventListener('change', e => attempt(async () => { await api('/api/tunnel', { on:e.target.checked }); shown = ''; setTimeout(render, 800); }));
    $('#install-cf')?.addEventListener('click', () => attempt(async () => { await api('/api/tunnel/install', {}); render(); }, 'Installing cloudflared…'));
    $('#copy')?.addEventListener('click', () => navigator.clipboard.writeText(t.url).then(() => toast('Copied')));
    $('#push')?.addEventListener('change', e => attempt(async () => { await (e.target.checked ? enablePush() : disablePush()); shown = ''; render(); }, e.target.checked ? 'Notifications on' : 'Notifications off'));
    $('#test-push')?.addEventListener('click', () => attempt(() => api('/api/push/test', {}), 'Sent'));
    $('#hook')?.addEventListener('click', () => attempt(async () => { await api('/api/approvals/hook', { install:true }); render(); }, 'Installed. Restart Claude sessions to use it.'));
    $('#hold')?.addEventListener('change', e => attempt(() => api('/api/approvals/settings', { hold:e.target.checked }), 'Saved'));
    $('#wait')?.addEventListener('change', e => attempt(() => api('/api/approvals/settings', { waitSeconds:Number(e.target.value) }), 'Saved'));
    $('#others')?.addEventListener('click', async () => { if (await confirmSheet('Sign out every other device?', '', 'Sign out others', true)) attempt(async () => { await api('/api/devices/others', {}); render(); }); });
    view.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/devices/approve', { id:b.dataset.approve }); render(); }, 'Approved'));
    view.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => attempt(async () => { await api('/api/devices/remove', { id:b.dataset.remove }); render(); }));
    $('#logout').onclick = async () => { await disablePush().catch(() => {}); await api('/api/auth/logout', {}); gate(); };
  };
  await firstLoad(view, render, `<div class="top"><h1>Settings</h1></div>${skeleton(4, 'block')}`);
  every(5000, () => render().catch(() => {}));
}

// ---------- Push ----------
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}
async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('/api/push/key');
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:raw });
  await api('/api/push/subscribe', { subscription:sub.toJSON() });
}
async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
  await api('/api/push/unsubscribe', {});
}

gate();
