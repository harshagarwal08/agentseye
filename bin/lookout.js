#!/usr/bin/env node
// lookout [start|install-hook|uninstall-hook|install-service|uninstall-service]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const command = process.argv[2] || 'start';
const root = fileURLToPath(new URL('..', import.meta.url));
const plist = path.join(os.homedir(), 'Library/LaunchAgents/dev.lookout.server.plist');
const domain = `gui/${process.getuid()}`;

if (command === 'start') {
  await import('../server/index.js').then(m => m.main());
} else if (command === 'install-hook' || command === 'uninstall-hook') {
  const { installHook, uninstallHook } = await import('../server/hookinstall.js');
  const status = command === 'install-hook' ? installHook() : uninstallHook();
  console.log(`${status.installed ? 'Installed' : 'Removed'} the PermissionRequest hook in ${status.settings}`);
} else if (command === 'install-service') {
  const logs = path.join(os.homedir(), '.lookout');
  fs.mkdirSync(logs, { recursive:true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.lookout.server</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${path.join(root, 'server/index.js')}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logs}/server.log</string>
  <key>StandardErrorPath</key><string>${logs}/server.log</string>
</dict></plist>
`);
  try { execFileSync('launchctl', ['bootout', `${domain}/dev.lookout.server`], { stdio:'ignore' }); } catch {}
  execFileSync('launchctl', ['bootstrap', domain, plist]);
  console.log('Lookout now starts at login: http://localhost:4480');
} else if (command === 'uninstall-service') {
  try { execFileSync('launchctl', ['bootout', `${domain}/dev.lookout.server`], { stdio:'ignore' }); } catch {}
  fs.rmSync(plist, { force:true });
  console.log('Removed the Lookout launch agent.');
} else {
  console.log('Usage: lookout [start|install-hook|uninstall-hook|install-service|uninstall-service]');
  process.exit(1);
}
