# AgentsEye relay

Lets your phone reach AgentsEye on a Mac that can't accept incoming connections, including company laptops behind a proxy,
Macs where you can't install anything, any network. The Mac opens one outbound HTTPS/WebSocket connection to the
relay; the phone talks to the relay; the relay passes requests along.

**End-to-end encrypted.** Phone and Mac both derive an AES-256 key from your AgentsEye password (PBKDF2-SHA256,
600k rounds, per-Mac salt). Every API request and reply is sealed with it, single-use and timestamped. The relay
and any proxy in between see only: which Mac, when, and how big. Never your password, sessions, files or commands.

**The app comes from the relay, never from a Mac.** All Macs on a relay share one web address, so the relay serves
its own copy of the phone app (deployed with it from `public/`) and a Mac can only answer sealed requests, with
JSON. Each Mac's sign-in cookie gets its own name and only that one is passed to that Mac. Otherwise another Mac on
the same relay could serve a script that reads the keys a phone keeps for your Mac. Redeploy the relay to ship
phone app updates.

**Trust note.** Because the relay serves the app's code, a relay operator could in principle change it to capture
your password. Use this relay, one your team runs, or your own (it's free).

## Your own relay in one command (recommended)

On a Mac with AgentsEye installed:

```bash
agentseye relay deploy
```

It copies the relay and the phone app into `~/.agentseye/relay-build`, signs you in to Cloudflare if needed (free
account), deploys a Worker named `agentseye-<your Mac id>` to **your** account, and switches the Mac over. When
AgentsEye updates, the relay is redeployed in the background so phones get the matching app. Behind a proxy where the
browser sign-in fails, use an API token: `CLOUDFLARE_API_TOKEN=<token> agentseye relay deploy`.

## Running a shared relay for others

Set `MAC_DAILY_LIMIT` (see `wrangler.toml`) to give each Mac a daily share of requests, so one busy phone can't use up
your free Cloudflare quota for everyone. Over the limit, phones get a message pointing them to `agentseye relay deploy`,
and the landing page says it's a shared relay. Exempt your own Macs with a secret:
`npx wrangler secret put UNLIMITED_MACS` (comma-separated Mac ids from `~/.agentseye/relay.json`).

## Deploy to Cloudflare by hand

To distribute your own fork, set `REPO` in `relay/wrangler.toml` to your GitHub `owner/repository` before deploying. Otherwise the installer downloads the default AgentsEye repository. Choose a unique Worker name if needed.

```bash
cd relay
npm install
npx wrangler login        # opens a browser once
npx wrangler deploy       # → https://agentseye-relay.<your-account>.workers.dev
```

Then on the Mac, open **Settings → Phone access → Relay settings**, paste the relay address, and enter your AgentsEye password if asked. Turn on the relay, then scan the QR code with your phone. If it is already on, toggle it off and on to apply the new address.

Each Mac gets its own Durable Object. The first connection for a Mac id registers a hash of its secret; nobody
else can claim that id afterwards. WebSocket hibernation keeps idle connections open without keeping the object
in memory. Heartbeat pings receive automatic replies without waking it; authenticated socket attachments restore
the connection after hibernation. Active phone requests still use compute duration. An existing daily quota block
is not reset by deploying a fix; it clears at Cloudflare’s next daily reset.

## Or self-host with Docker

```bash
docker build -f relay/Dockerfile -t agentseye-relay .      # from the repository root
docker run -d -p 8787:8787 -v agentseye-relay:/data -e TRUST_PROXY=1 agentseye-relay
```

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
