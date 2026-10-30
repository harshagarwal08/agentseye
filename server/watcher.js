import { claudeLive, findSession, transcript, folderName, sessions } from './agents.js';
import { nameOf } from './names.js';
import * as approvals from './approvals.js';
import * as auth from './auth.js';
import * as push from './push.js';
import { usage, runsOutAt } from './usage.js';
import * as t3 from './t3.js';
import * as ides from './ides.js';

const clip = (text, n = 140) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// A notification reads like a message: the chat's title on top, then what happened and where.
async function describe(id, cwd) {
  let s = null;
  try { s = await findSession('claude', id); } catch {}
  const title = clip(nameOf('claude', id) || (s?.title && s.title !== '(untitled)' ? s.title : '') || folderName(cwd) || 'Claude Code', 60);
  const project = folderName(s?.cwd || cwd);
  let reply = '';
  try { reply = transcript('claude', id, s?.cwd || cwd, { max:6 }).filter(m => m.role === 'assistant').at(-1)?.text || ''; } catch {}
  return { title, project, reply };
}

// Turns state changes into phone notifications: an agent waiting for you, an agent finishing, a device at the door.
export function start() {
  let last = new Map([...claudeLive()].map(([id, s]) => [id, s.status]));
  setInterval(() => {
    const now = claudeLive();
    for (const [id, s] of now) {
      // T3 Code runs its own Claude sessions; those are announced from their T3 thread below.
      if (s.entrypoint === 'sdk-ts') continue;
      const before = last.get(id);
      if (s.status === 'waiting' && before !== 'waiting') {
        describe(id, s.cwd).then(d => push.notify({ title:`✋ ${d.title}`, body:[d.project, 'Claude needs your OK'].filter(Boolean).join(' · '), url:`/#/s/claude/${id}`, tag:`ask-${id}` }));
      } else if (before === 'busy' && s.status === 'idle') {
        describe(id, s.cwd).then(d => push.notify({ title:`✅ ${d.title}`, body:clip(d.reply) || [d.project, 'Done'].filter(Boolean).join(' · '), url:`/#/s/claude/${id}`, tag:`done-${id}` }));
      }
    }
    last = new Map([...now].map(([id, s]) => [id, s.status]));
  }, 5000).unref();

  // T3 Code threads: a ping when one starts waiting on you, and when one finishes or fails.
  t3.onChange(({ kind, before, after }) => {
    if (kind !== 'thread' || !before || !after) return;
    const was = t3.summarize(before);
    const now = t3.summarize(after);
    if (now.status === was.status) return;
    const url = `/#/t/${now.id}`;
    if (now.status === 'waiting') push.notify({ title:`✋ ${now.title}`, body:[now.project, 'Needs your input'].filter(Boolean).join(' · '), url, tag:`t3-${now.id}` });
    else if (was.status === 'busy' && now.status === 'done') push.notify({ title:`✅ ${now.title}`, body:now.preview || [now.project, 'Done'].filter(Boolean).join(' · '), url, tag:`t3-${now.id}` });
    else if (was.status === 'busy' && now.status === 'failed') push.notify({ title:`⚠️ ${now.title}`, body:now.error || 'Failed. Tap to see what happened.', url, tag:`t3-${now.id}` });
  });

  // Cursor and VS Code chats: a ping when one finishes.
  const ideWas = new Map();
  setInterval(async () => {
    for (const c of await ides.list().catch(() => [])) {
      const key = `${c.app}:${c.id}`;
      if (c.status === 'waiting' && ideWas.has(key) && ideWas.get(key) !== 'waiting') push.notify({ title:`✋ ${c.title}`, body:'Cursor · Waiting for you to approve a step', url:`/#/i/${c.app}/${c.id}`, tag:`ide-${key}` });
      if (['busy', 'waiting'].includes(ideWas.get(key)) && c.status === 'done') push.notify({ title:`✅ ${c.title}`, body:`${c.app === 'cursor' ? 'Cursor' : 'VS Code'} · Done`, url:`/#/i/${c.app}/${c.id}`, tag:`ide-${key}` });
      ideWas.set(key, c.status);
    }
  }, 15000).unref();

  // An agent "working" with no new output for 20 minutes is often stuck in a loop or waiting on something hidden.
  const STUCK_AFTER = 20 * 60000;
  const stuckSeen = new Map();
  setInterval(async () => {
    const busy = [
      ...t3.threads().filter(t => t.status === 'busy').map(t => ({ key:`t3:${t.id}`, title:t.title, project:t.project, at:t.updatedAt, url:`/#/t/${t.id}` })),
      ...(await sessions({ limit:30 }).catch(() => [])).filter(s => s.harness === 'claude' && s.live && s.status === 'busy' && s.entrypoint !== 'sdk-ts')
        .map(s => ({ key:`claude:${s.id}`, title:s.name || s.title, project:folderName(s.cwd), at:s.updatedAt, url:`/#/s/claude/${s.id}` })),
    ];
    const now = new Set(busy.map(b => b.key));
    for (const k of stuckSeen.keys()) if (!now.has(k)) stuckSeen.delete(k);
    for (const b of busy) {
      if (Date.now() - b.at < STUCK_AFTER || stuckSeen.get(b.key) === b.at) continue;
      stuckSeen.set(b.key, b.at);
      push.notify({ title:`⏳ ${b.title}`, body:`${b.project ? `${b.project} · ` : ''}No new output for ${Math.round((Date.now() - b.at) / 60000)} minutes. It may be stuck.`, url:b.url, tag:`stuck-${b.key}` });
    }
  }, 60000).unref();

  // One heads-up per limit window when it passes 90%, so you can pace work before you hit the wall.
  const warned = new Set();
  const names = { claude:'Claude Code', codex:'Codex' };
  const day = t => new Date(t).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' });
  setInterval(async () => {
    for (const u of await usage().catch(() => [])) {
      for (const w of u.windows || []) {
        const key = `${u.harness}:${w.key}:${w.resetsAt}`;
        // An early warning: at this rate the limit runs out before it resets (and within two days).
        const hitAt = runsOutAt(w);
        if (hitAt && hitAt - Date.now() < 48 * 3600000 && w.percent >= 20 && w.percent < 90 && !warned.has(`pace:${key}`)) {
          warned.add(`pace:${key}`);
          push.notify({ title:`📉 ${names[u.harness]} ${w.label.toLowerCase()} limit runs out ~${day(hitAt)}`, body:`At this rate. ${w.percent}% used, resets ${day(w.resetsAt)}.`, url:'/#/', tag:`pace-${key}` });
        }
        if (w.percent >= 90 && !warned.has(key)) {
          warned.add(key);
          push.notify({ title:`${names[u.harness]}: ${w.label.toLowerCase()} limit at ${w.percent}%`, body:w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}.` : '', url:'/#/', tag:`limit-${key}` });
        }
      }
    }
  }, 5 * 60000).unref();

  approvals.onRequest(r => {
    if (r.tool === 'AskUserQuestion') {
      const q = r.input?.questions?.[0];
      return describe(r.sessionId, r.cwd).then(d => push.notify({ title:`✋ ${d.title}`, body:clip(q?.question || 'Needs your input', 160), url:r.sessionId ? `/#/s/claude/${r.sessionId}` : '/', tag:`ask-${r.sessionId || r.id}` }));
    }
    const what = r.input?.command || r.input?.file_path || r.input?.url || '';
    describe(r.sessionId, r.cwd).then(d => push.notify({ title:`✋ ${d.title}`, body:clip(`Allow ${r.tool}? ${what}`, 160), url:r.sessionId ? `/#/s/claude/${r.sessionId}` : '/', tag:`ask-${r.sessionId || r.id}` }));
  });
  auth.onDeviceWaiting(d => push.notify({ title:'New device wants to sign in', body:`${d.name}. Approve it on your Mac if this was you.`, url:'/#/settings', tag:`device-${d.id}` }));
}
