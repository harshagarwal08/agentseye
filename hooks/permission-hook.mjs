#!/usr/bin/env node
// Claude Code PermissionRequest hook: forwards the request to AgentsEye and waits for Allow/Deny from the browser.
// Any failure (AgentsEye not running, timeout, bad reply) prints nothing, so Claude falls back to its normal dialog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = process.env.AGENTSEYE_HOME || path.join(os.homedir(), '.agentseye');
const port = Number(process.env.AGENTSEYE_PORT || 4480);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let token = '';
  try { token = fs.readFileSync(path.join(home, 'hook-token'), 'utf8').trim(); } catch { process.exit(0); }
  const req = http.request({ host:'127.0.0.1', port, path:'/hook/permission', method:'POST', headers:{ 'content-type':'application/json', 'x-agentseye-token':token } }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const { decision, message, updatedInput } = JSON.parse(body);
        if (decision === 'allow' || decision === 'deny') {
          const out = { behavior:decision };
          if (decision === 'deny') out.message = message || 'Denied from AgentsEye.';
          if (decision === 'allow' && updatedInput) out.updatedInput = updatedInput;
          process.stdout.write(JSON.stringify({ hookSpecificOutput:{ hookEventName:'PermissionRequest', decision:out } }));
        }
      } catch {}
      process.exit(0);
    });
  });
  req.on('error', () => process.exit(0));
  req.end(input);
});
