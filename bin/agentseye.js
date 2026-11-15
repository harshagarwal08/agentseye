#!/usr/bin/env node
// agentseye — see `agentseye help`.

const [command = 'start', ...rest] = process.argv.slice(2);
const restart = async () => (await import('node:child_process')).spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/dev.agentseye.server`]);

const usage = `AgentsEye: your coding agents, on your phone.

  agentseye                       run the server (normally started at login for you)
  agentseye doctor                which agents and connections AgentsEye can see
  agentseye relay deploy          put your own free relay on your Cloudflare account and use it
  agentseye relay status          which relay this Mac uses
  agentseye set-relay <url>       use a relay you host (empty to turn the relay off)
  agentseye wrap <agent> [args]   run any agent CLI inside tmux, so your phone can drive it from any terminal app
                                  e.g. agentseye wrap gemini · agentseye wrap opencode · agentseye wrap aider
  agentseye install-hook          let Claude Code send permission prompts to your phone
  agentseye uninstall-hook
  agentseye install-service       start AgentsEye at login
  agentseye uninstall-service
  agentseye update                update to the newest version
`;

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
  const status = relay.configure({ url:rest[0] || '', enabled:Boolean(rest[0]) });
  console.log(status.enabled ? `Relay set to ${status.url}` : 'Relay turned off.');
  if (!process.env.AGENTSEYE_SKIP_RESTART) await restart();
  process.exit(0);
} else if (command === 'relay') {
  const sub = rest[0] || 'status';
  const relay = await import('../server/relay-client.js');
  const own = await import('../server/relay-deploy.js');
  if (sub === 'deploy') {
    try {
      const { url } = await own.deploy({ interactive:true });
      relay.configure({ url, enabled:true });
      await restart();
      const auth = await import('../server/auth.js');
      console.log(`\n\x1b[1;32m✓\x1b[0m This Mac now uses your own relay: ${url}`);
      if (!auth.relayKeyInfo()) console.log('  Open http://localhost:4480 and sign in once to turn on encryption.');
      console.log('  On your Mac open http://localhost:4480 → Settings → Phone access and scan the new QR code with your phone.');
      console.log('  The relay is redeployed automatically when AgentsEye updates.');
      process.exit(0);
    } catch (error) {
      console.error(`\n\x1b[1;31m✗\x1b[0m ${error.message}`);
      process.exit(1);
    }
  } else {
    const s = relay.status();
    const o = own.status();
    console.log(s.url ? `Relay: ${s.url} (${s.enabled ? 'on' : 'off'})${o.configured && o.url === s.url ? ' · your own' : ' · not yours'}` : 'Relay: off');
    if (o.configured) console.log(`Your own relay: ${o.url} · v${o.version}${o.outdated ? ' (redeploy pending)' : ''}`);
    else console.log('Get your own free relay: agentseye relay deploy');
    process.exit(0);
  }
} else if (command === 'wrap') {
  const { spawnSync } = await import('node:child_process');
  if (!rest.length) { console.log('Usage: agentseye wrap <agent> [args], e.g. agentseye wrap gemini'); process.exit(1); }
  const { tmuxBin } = await import('../server/terminal.js');
  const tmux = await tmuxBin();
  const quote = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
  if (process.env.TMUX || !tmux) {
    if (!tmux) console.error('tmux is not installed, so this runs directly. Install it (brew install tmux) to drive this agent from your phone in any terminal app.');
    process.exit(spawnSync(rest[0], rest.slice(1), { stdio:'inherit' }).status ?? 1);
  }
  const name = `ae-${rest[0].replace(/[^\w-]/g, '').slice(0, 20)}-${process.pid}`;
  process.exit(spawnSync(tmux, ['new-session', '-s', name, rest.map(quote).join(' ')], { stdio:'inherit' }).status ?? 0);
} else if (command === 'doctor') {
  const cli = await import('../server/cli-agents.js');
  const agents = await import('../server/agents.js');
  const terminal = await import('../server/terminal.js');
  const relay = await import('../server/relay-client.js');
  const own = await import('../server/relay-deploy.js');
  const { run } = await import('../server/exec.js');
  const ok = v => (v ? '\x1b[32m✓\x1b[0m' : '\x1b[2m·\x1b[0m');
  console.log('Agents installed');
  for (const [bin, name] of [['claude', 'Claude Code'], ['codex', 'Codex']]) console.log(`  ${ok((await run('/usr/bin/which', [bin])).ok)} ${name}`);
  const have = new Set((await cli.installed()).map(k => k.kind));
  for (const k of cli.KINDS) console.log(`  ${ok(have.has(k.kind))} ${k.name}`);
  console.log('\nRunning now');
  const live = (await agents.sessions({ limit:30 })).filter(s => s.live);
  if (!live.length) console.log('  none');
  for (const s of live) {
    const tty = s.tty || (s.pid ? await terminal.ttyOf(s.pid) : '');
    const host = tty ? await terminal.hostOf(tty) : '';
    console.log(`  ${s.harness === 'cli' ? s.kindName : s.harness} · ${s.title} · ${s.app || '?'} · ${host ? `controllable via ${terminal.hostName(host)}` : 'watch only'}`);
  }
  console.log('\nTerminal control');
  console.log(`  ${ok(true)} Terminal.app · ${ok(true)} iTerm2 · ${ok(await terminal.tmuxBin())} tmux (any terminal app, VS Code / Cursor terminals)`);
  const s = relay.status();
  const o = own.status();
  console.log(`\nPhone connection\n  ${s.url ? `${ok(s.enabled)} relay ${s.url}${o.configured && o.url === s.url ? ' (your own)' : ' (not yours: run "agentseye relay deploy" for your own)'}` : `${ok(false)} relay off`}`);
  process.exit(0);
} else if (command === 'update') {
  const result = await (await import('../server/updater.js')).update({ force:true });
  console.log(result.message);
  // Run from a terminal, the update replaces the files but the running service is another process: restart it.
  if (result.updated) await restart();
} else {
  console.log(usage);
  process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 1);
}
