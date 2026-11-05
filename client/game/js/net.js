/**
 * Auto-reconnecting WebSocket client for the overlay.
 * The overlay never decides game outcomes; it only renders server messages.
 */

export class Net {
  constructor({ onMessage, onStatus } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.attempt = 0;
    this.closedByUs = false;
    this.connected = false;
    this.pingTimer = null;
  }

  url() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  connect() {
    this.closedByUs = false;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.attempt = 0;
      this.connected = true;
      this.onStatus({ connected: true });
      this.send('hello', { role: 'overlay' });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send('ping', {}), 20000);
    });

    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && typeof message.type === 'string') {
        this.onMessage(message.type, message.payload ?? message);
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.onStatus({ connected: false });
      if (!this.closedByUs) this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.connected = false;
    });
  }

  scheduleReconnect() {
    this.attempt += 1;
    const delay = Math.min(15000, 800 * 2 ** Math.min(this.attempt, 5));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, payload }));
    return true;
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
