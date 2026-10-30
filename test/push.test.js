import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
mock.module('web-push', { defaultExport:{
  setVapidDetails() {},
  sendNotification:async (subscription, payload) => sent.push(JSON.parse(payload)),
} });
mock.module('../server/paths.js', { namedExports:{
  DATA:'/unused',
  readJson:file => file.endsWith('push-subscriptions.json') ? { phone:{ endpoint:'https://push.example/device' } } : { publicKey:'public', privateKey:'private' },
  writeJson() {},
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
