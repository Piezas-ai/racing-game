/** WebSocket wrapper with a small listener bus so App and the race screen can
 * both react to server messages. */
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

type Listener = (msg: ServerMessage) => void;

export class GameSocket {
  private ws: WebSocket;
  private listeners = new Set<Listener>();
  private queue: ClientMessage[] = [];
  onDisconnect: (() => void) | null = null;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      for (const msg of this.queue.splice(0)) this.send(msg);
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        for (const l of [...this.listeners]) l(msg);
      } catch {
        // ignore malformed frames
      }
    };
    this.ws.onclose = () => this.onDisconnect?.();
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING;
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(msg);
  }

  listen(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    this.onDisconnect = null;
    this.ws.close();
  }
}
