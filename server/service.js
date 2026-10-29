import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';
import { HOME } from './paths.js';

// Starts Lookout at login (and restarts it if it stops) with a user LaunchAgent.
const LABEL = 'dev.lookout.server';
const plist = () => path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;
const entry = fileURLToPath(new URL('./index.js', import.meta.url));

export async function status() {
  const loaded = (await run('/bin/launchctl', ['print', `${domain()}/${LABEL}`])).ok;
  return { installed:fs.existsSync(plist()), loaded, runningAsService:process.env.XPC_SERVICE_NAME === LABEL };
}

export async function install() {
  const logs = path.join(HOME, '.lookout');
  fs.mkdirSync(logs, { recursive:true });
  fs.mkdirSync(path.dirname(plist()), { recursive:true });
  fs.writeFileSync(plist(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${entry}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logs}/server.log</string>
  <key>StandardErrorPath</key><string>${logs}/server.log</string>
</dict></plist>
`);
  return status();
}

// Loading the agent starts a second copy of Lookout on the same port, so the caller should exit afterwards
// when it is not already the service (the CLI does; the dashboard tells you to close the terminal copy).
export async function load() {
  await run('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  const r = await run('/bin/launchctl', ['bootstrap', domain(), plist()]);
  if (!r.ok) throw Object.assign(new Error((r.stderr || 'launchctl failed').trim()), { status:500 });
}

export async function uninstall() {
  await run('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  fs.rmSync(plist(), { force:true });
  return status();
}
