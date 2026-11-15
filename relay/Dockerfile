# Self-hosted AgentsEye relay for any server with Docker (VPS, Fly.io, Railway, Render, a home server…).
#   docker build -f relay/Dockerfile -t agentseye-relay .
#   docker run -d -p 8787:8787 -v agentseye-relay:/data -e TRUST_PROXY=1 agentseye-relay
# Put HTTPS in front (Caddy, nginx, or your platform's TLS) — phones need https for encryption and notifications.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY relay/package.json ./relay/
RUN cd relay && npm install --omit=dev --no-audit --no-fund
COPY public ./public
COPY relay/*.js ./relay/
ENV PORT=8787 RELAY_DATA=/data/relay-data.json
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "relay/server.js"]
