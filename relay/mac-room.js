import { Room, sha256, MAC_ID } from './core.js';

// Cloudflare keeps these sockets connected while the object sleeps. Only active phone requests need memory.
export class HibernatingMacRoom {
  constructor(state, env, version = '') {
    this.state = state;
    this.env = env;
    this.version = version;
    this.room = new Room({ verify:async () => false });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    for (const socket of state.getWebSockets()) {
      const saved = socket.deserializeAttachment();
      if (saved?.authenticated && socket.readyState === 1) {
        this.room.socket = socket;
        this.room.macId = saved.macId;
      }
    }
  }

  async scheduleHelloDeadline() {
    const deadlines = this.state.getWebSockets()
      .filter(socket => socket.readyState === 1)
      .map(socket => socket.deserializeAttachment())
      .filter(saved => saved && !saved.authenticated)
      .map(saved => saved.deadline);
    if (deadlines.length) await this.state.storage.setAlarm(Math.min(...deadlines));
    else await this.state.storage.deleteAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const macId = url.searchParams.get('mac') || '';
      if (!MAC_ID.test(macId)) return new Response('Bad Mac id', { status:400 });
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ macId, authenticated:false, deadline:Date.now() + 10000 });
      await this.scheduleHelloDeadline();
      return new Response(null, { status:101, webSocket:client });
    }
    const read = async name => {
      const res = await this.env.ASSETS.fetch(new Request(`https://assets${name}`));
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    };
    return this.room.serve(request, { ip:request.headers.get('x-agentseye-ip') || '', macId:request.headers.get('x-agentseye-mac'), read, version:this.version });
  }

  async webSocketMessage(socket, data) {
    let message;
    try { message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    const saved = socket.deserializeAttachment();
    if (!saved?.authenticated) {
      if (!saved || Date.now() > saved.deadline || message?.t !== 'hello' || message.mac !== saved.macId || typeof message.secret !== 'string' || !message.secret || message.secret.length > 256) {
        socket.close(4003, 'not allowed');
        await this.scheduleHelloDeadline();
        return;
      }
      // A first registration and a reconnect must not race each other to replace the secret.
      await this.state.blockConcurrencyWhile(async () => {
        const hash = await sha256(`${saved.macId}:${message.secret}`);
        const expected = await this.state.storage.get('secret');
        if (expected && expected !== hash) { socket.close(4003, 'not allowed'); return; }
        if (!expected) await this.state.storage.put('secret', hash);
        const previous = this.room.socket;
        socket.serializeAttachment({ macId:saved.macId, authenticated:true });
        this.room.socket = socket;
        this.room.macId = saved.macId;
        if (previous && previous !== socket) {
          for (const pending of this.room.pending.values()) pending.fail('Your Mac reconnected. Please retry.');
          this.room.pending.clear();
          previous.close(4000, 'replaced');
        }
        socket.send(JSON.stringify({ t:'welcome' }));
      });
      await this.scheduleHelloDeadline();
      return;
    }
    if (socket === this.room.socket && message && typeof message === 'object') this.room.receive(message);
  }

  async webSocketClose(socket) {
    if (socket === this.room.socket) {
      this.room.socket = null;
      for (const pending of this.room.pending.values()) pending.fail('Your Mac disconnected.');
      this.room.pending.clear();
    }
    await this.scheduleHelloDeadline();
  }

  async webSocketError(socket) {
    socket.close(1011, 'connection error');
    await this.webSocketClose(socket);
  }

  async alarm() {
    for (const socket of this.state.getWebSockets()) {
      const saved = socket.deserializeAttachment();
      if (socket.readyState === 1 && saved && !saved.authenticated && saved.deadline <= Date.now()) socket.close(4001, 'hello timeout');
    }
    await this.scheduleHelloDeadline();
  }
}
