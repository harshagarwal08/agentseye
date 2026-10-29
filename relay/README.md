# AgentsEye relay

Lets your phone reach AgentsEye on a Mac that can't accept incoming connections — company laptops behind a proxy,
Macs where you can't install anything, any network. The Mac opens one outbound HTTPS/WebSocket connection to the
relay; the phone talks to the relay; the relay passes requests along.

**End-to-end encrypted.** Phone and Mac both derive an AES-256 key from your AgentsEye password (PBKDF2-SHA256,
600k rounds, per-Mac salt). Every API request and reply is sealed with it, single-use and timestamped. The relay
and any proxy in between see only: which Mac, when, and how big. Never your password, sessions, files or commands.

**Trust note.** The relay also serves the app's public files (HTML/JS) from your Mac. A relay operator could in
principle tamper with those, so run your own (it's free) or use one your team trusts.

## Deploy to Cloudflare (free)

```bash
cd relay
npm install
npx wrangler login        # opens a browser once
npx wrangler deploy       # → https://agentseye-relay.<your-account>.workers.dev
```

Then on the Mac: **AgentsEye → Settings → AgentsEye relay**, paste that address, enter your password once, switch it on,
and scan the QR code with your phone.

Each Mac gets its own Durable Object. The first connection for a Mac id registers a hash of its secret; nobody
else can claim that id afterwards.

## Or self-host on any Node server

```bash
cd relay && npm install && PORT=8787 node server.js
```

Put it behind HTTPS (any reverse proxy or platform with WebSocket support). Secrets are kept in
`relay-data.json` (`RELAY_DATA` to move it).

## Test locally

```bash
npm run dev:worker                                   # the real Workers runtime on :8788
RELAY_URL=http://127.0.0.1:8788 node --test ../test/relay.test.js
```
