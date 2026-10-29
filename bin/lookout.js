#!/usr/bin/env node
// lookout [start|install-hook|uninstall-hook|install-service|uninstall-service]

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
  console.log('Lookout now starts at login: http://localhost:4480');
} else if (command === 'uninstall-service') {
  await (await import('../server/service.js')).uninstall();
  console.log('Removed the Lookout launch agent.');
} else {
  console.log('Usage: lookout [start|install-hook|uninstall-hook|install-service|uninstall-service]');
  process.exit(1);
}
