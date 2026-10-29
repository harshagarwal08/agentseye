#!/usr/bin/env node
// agentseye [start|install-hook|uninstall-hook|install-service|uninstall-service|set-relay <url>|update]

const command = process.argv[2] || 'start';

if (command === 'start') {
  await import('../server/index.js').then(m => m.main());
} else if (command === 'install-hook' || command === 'uninstall-hook') {
  const { installHook, uninstallHook } = await import('../server/hookinstall.js');
  const status = command === 'install-hook' ? installHook() : uninstallHook();
  console.log(`${status.installed ? 'Installed' : 'Removed'} the PermissionRequest hook in ${status.settings}`);
} else if (command === 'install-service') {
  const service = await import('../server/service.js');
  await service.install();
  await service.load();
  console.log('AgentsEye now starts at login: http://localhost:4480');
} else if (command === 'uninstall-service') {
  await (await import('../server/service.js')).uninstall();
  console.log('Removed the AgentsEye launch agent.');
} else if (command === 'set-relay') {
  const relay = await import('../server/relay-client.js');
  const status = relay.configure({ url:process.argv[3] || '', enabled:Boolean(process.argv[3]) });
  console.log(status.enabled ? `Relay set to ${status.url}` : 'Relay turned off.');
  process.exit(0);
} else if (command === 'update') {
  const result = await (await import('../server/updater.js')).update({ force:true });
  console.log(result.message);
} else {
  console.log('Usage: agentseye [start|install-hook|uninstall-hook|install-service|uninstall-service|set-relay <url>|update]');
  process.exit(1);
}
