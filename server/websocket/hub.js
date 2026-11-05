/**
 * WebSocket hub.
 *
 * One channel for the OBS overlay and for the admin dashboard. Outbound
 * messages are `{ type, payload, ts }`. Inbound messages are intentionally
 * limited to a tiny, validated set.
 */

import { WebSocketServer, WebSocket } from 'ws';

export class Hub {
  constructor({ server, logger = null, path = '/ws' } = {}) {
    this.logger = logger;
    this.clients = new Set();
    this.handlers = new Map();
    this.lastState = null;
    this.wss = new WebSocketServer({ server, path, maxPayload: 16 * 1024 });

    this.wss.on('connection', (socket, request) => {
      socket.isAlive = true;
      socket.role = 'overlay';
      this.clients.add(socket);
      this.logger?.debug?.(`WS client connected (${request.socket.remoteAddress}) total=${this.clients.size}`);

      socket.on('pong', () => {
        socket.isAlive = true;
      });

      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'hello') {
          socket.role = message.role === 'admin' ? 'admin' : 'overlay';
          // Late joiners (a reconnected OBS source, a second preview tab) get the
          // current authoritative snapshot immediately instead of waiting for
          // the next board mutation.
          const snapshot = this.lastState || socket.lastState;
          if (snapshot) socket.send(JSON.stringify({ type: 'state', payload: snapshot, ts: Date.now() }));
          return;
        }
        if (message.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }
        const handler = this.handlers.get(message.type);
        if (handler) handler(message, socket);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });

      socket.on('error', () => {
        this.clients.delete(socket);
      });
    });

    this.heartbeat = setInterval(() => {
      for (const socket of this.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  broadcast(type, payload) {
    const frame = JSON.stringify({ type, payload, ts: Date.now() });
    for (const socket of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(frame);
      } catch {
        /* client went away mid-send */
      }
    }
  }

  cacheState(state) {
    this.lastState = state;
    for (const socket of this.clients) socket.lastState = state;
  }

  get clientCount() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const socket of this.clients) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}
