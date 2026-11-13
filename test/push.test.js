import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const stored = new Map();
mock.module('web-push', { defaultExport:{
  setVapidDetails() {},
  sendNotification:async (subscription, payload) => sent.push(JSON.parse(payload)),
} });
mock.module('../server/paths.js', { namedExports:{
  DATA:'/unused',
  readJson:(file, fallback) => stored.get(file) ?? (file.endsWith('push-subscriptions.json') ? { phone:{ endpoint:'https://push.example/device' } } : file.endsWith('push.json') ? { publicKey:'public', privateKey:'private' } : fallback),
  writeJson(file, value) { stored.set(file, value); },
} });
mock.module('../server/auth.js', { namedExports:{ listDevices:() => [{ id:'phone' }] } });
const { notify } = await import('../server/push.js');

test('pushes keep long names and previews short without breaking emoji or navigation', async () => {
  await notify({ title:'😀'.repeat(80), body:'  A question\n\n' + 'x'.repeat(150), url:'/#/t/chat', tag:'t3-chat' });
  const message = sent.at(-1);
  assert.equal(Array.from(message.title).length, 60);
  assert.equal(message.title, '😀'.repeat(59) + '…');
  assert.equal(Array.from(message.body).length, 100);
  assert.match(message.body, /^A question x+…$/);
  assert.equal(message.url, '/#/t/chat');
  assert.equal(message.tag, 't3-chat');
});

test('short status messages stay intact and blank titles use the app name', async () => {
  await notify({ title:'  Fix login\n', body:'Done', url:'/#/s/claude/chat', tag:'done-chat' });
  assert.deepEqual(sent.at(-1), { title:'Fix login', body:'Done', url:'/#/s/claude/chat', tag:'done-chat' });
  await notify({ title:' ', body:'Needs approval' });
  assert.equal(sent.at(-1).title, 'AgentsEye');
  assert.equal(sent.at(-1).body, 'Needs approval');
});


test('Claude limit and pace warnings never send a notification', async () => {
  const before = sent.length;
  for (const tag of ['limit-claude:five_hour:today', 'pace-claude:seven_day:tomorrow']) {
    await notify({ title:'Claude Code · limit', body:'100% used', tag });
  }
  assert.equal(sent.length, before);
});

test('simultaneous identical pushes are sent once, including across module reloads', async () => {
  const message = { title:'A task', body:'Needs approval', tag:'ask-repeat', url:'/#/s/claude/repeat' };
  const before = sent.length;
  await Promise.all([notify(message), notify(message), notify(message)]);
  assert.equal(sent.length, before + 1);
  const fresh = await import('../server/push.js?restart');
  await fresh.notify(message);
  assert.equal(sent.length, before + 1);
  await notify({ ...message, body:'Allow Bash?' });
  assert.equal(sent.length, before + 2, 'new actionable content is delivered');
});

test('test notifications stay repeatable and Codex alerts remain available', async () => {
  const before = sent.length;
  await notify({ title:'AgentsEye', body:'Notifications on', tag:'test' });
  await notify({ title:'AgentsEye', body:'Notifications on', tag:'test' });
  await notify({ title:'Codex limit', body:'90% used', tag:'limit-codex:weekly:today' });
  assert.equal(sent.length, before + 3);
});
