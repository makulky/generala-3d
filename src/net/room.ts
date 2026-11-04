import type { DataConnection, Peer as PeerType } from 'peerjs';
import { createGame, reduce, type Action, type GameState, type Player, type Seat } from '../game/state';
import { decodeFrame, type NetMessage } from './protocol';

const PREFIX = 'generala3d-sala-';
const CONNECT_TIMEOUT = 12_000;
const GIVE_UP_AFTER = 45_000;

export type RoomStatus =
  | { kind: 'connecting' }
  | { kind: 'waiting-peer' }
  | { kind: 'connected' }
  | { kind: 'reconnecting' }
  | { kind: 'failed'; message: string };

interface Session {
  role: 'host' | 'guest';
  token: string;
  player: Player;
  guestToken?: string;
  state?: GameState;
}

type Role = Session['role'];

const key = (code: string, role: Role) => `generala:sala:${code}:${role}`;

function loadSession(code: string, role: Role): Session | null {
  try {
    const raw = localStorage.getItem(key(code, role));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(code: string, s: Session): void {
  try {
    localStorage.setItem(key(code, s.role), JSON.stringify(s));
  } catch {
    // Sin almacenamiento la partida funciona, pero no sobrevive a una recarga.
  }
}

/**
 * Reserva un rol para esta pestaña mientras siga abierta. Así, abrir el enlace
 * en otra pestaña del mismo navegador entra como invitado en vez de suplantar
 * al anfitrión, con el que comparte el almacenamiento.
 */
export function claimRole(code: string, role: Role): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request(`generala:${code}:${role}`, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      // Una promesa que no termina mantiene el bloqueo hasta cerrar la pestaña.
      return lock ? new Promise<void>(() => {}) : undefined;
    });
  });
}

/** Busca una partida anterior de este navegador cuyo rol esté libre. */
export async function resumeSession(code: string): Promise<{ role: Role; player: Player } | null> {
  for (const role of ['host', 'guest'] as const) {
    const session = loadSession(code, role);
    if (session && (await claimRole(code, role))) return { role, player: session.player };
  }
  return null;
}

export function newCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RoomEvents {
  onState(state: GameState): void;
  onFrame(time: number, poses: Float32Array): void;
  onStatus(status: RoomStatus): void;
  /** El otro jugador acaba de conectarse y necesita una foto de la mesa. */
  onPeerReady(): void;
}

/**
 * Sala para dos jugadores sobre WebRTC. El anfitrión guarda el estado válido:
 * valida cada acción y la reenvía. Las poses de los dados van directas entre
 * los dos navegadores.
 */
export class Room {
  seat: Seat;
  state: GameState | null = null;

  private peer: PeerType | null = null;
  private conn: DataConnection | null = null;
  private session: Session;
  private closed = false;
  private retryTimer = 0;
  private connectTimer = 0;
  /** Desde cuándo fallan los intentos; null si la conexión va bien. */
  private troubleSince: number | null = null;
  private retries = 0;

  constructor(
    readonly code: string,
    player: Player,
    role: Role,
    /** Si esta pestaña tiene reservado el rol y puede guardar la sesión. */
    private persistent: boolean,
    private events: RoomEvents,
  ) {
    const existing = persistent ? loadSession(code, role) : null;
    this.session = existing
      ? { ...existing, player: existing.state ? existing.player : player }
      : { role, token: newToken(), player };
    if (persistent) saveSession(code, this.session);
    this.seat = role === 'host' ? 0 : 1;
  }

  get isHost(): boolean {
    return this.session.role === 'host';
  }

  get connected(): boolean {
    return !!this.conn?.open;
  }

  async start(): Promise<void> {
    this.events.onStatus({ kind: 'connecting' });
    if (this.isHost) {
      this.state = this.session.state ?? createGame(this.session.player);
      this.persist();
      this.events.onState(this.state);
    } else if (this.session.state) {
      // Mientras vuelve a conectar, enseña la última partida conocida.
      this.state = this.session.state;
      this.events.onState(this.state);
    }
    await this.openPeer();
  }

  /** Aplica una acción de este jugador. */
  dispatch(action: Action): void {
    if (this.isHost) {
      this.applyAsHost(0, action);
    } else {
      this.sendMessage({ k: 'action', action });
    }
  }

  sendFrame(buffer: ArrayBuffer): void {
    if (this.conn?.open) this.conn.send(buffer);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.conn?.close();
    this.peer?.destroy();
  }

  private persist(): void {
    if (!this.state) return;
    this.session.state = this.state;
    if (this.persistent) saveSession(this.code, this.session);
  }

  private async openPeer(): Promise<void> {
    if (this.closed) return;
    const { Peer } = await import('peerjs');
    this.peer?.destroy();
    const peer = this.isHost ? new Peer(PREFIX + this.code) : new Peer();
    this.peer = peer;

    peer.on('open', () => {
      this.retries = 0;
      if (this.isHost) {
        this.troubleSince = null;
        const hasGuest = this.state?.players[1];
        this.events.onStatus(hasGuest ? { kind: 'reconnecting' } : { kind: 'waiting-peer' });
      } else {
        this.connectToHost();
      }
    });

    peer.on('connection', (conn) => {
      if (this.isHost) this.acceptGuest(conn);
      else conn.close();
    });

    peer.on('disconnected', () => {
      if (!this.closed && !peer.destroyed) peer.reconnect();
    });

    peer.on('error', (err: Error & { type?: string }) => {
      if (this.closed) return;
      switch (err.type) {
        case 'unavailable-id':
          // Tras recargar, el servidor aún reserva el ID del anfitrión unos segundos.
          this.retryOpen();
          break;
        case 'peer-unavailable':
          this.retryConnect();
          break;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          this.retryOpen();
          break;
        case 'browser-incompatible':
        case 'webrtc':
          this.events.onStatus({
            kind: 'failed',
            message: 'Este navegador o esta red no permiten la conexión directa (WebRTC).',
          });
          break;
        default:
          console.warn('[sala]', err.type, err.message);
      }
    });
  }

  private retryOpen(): void {
    clearTimeout(this.retryTimer);
    if (this.giveUpIfTooLong()) return;
    this.retries++;
    const wait = Math.min(1000 * 2 ** Math.min(this.retries, 3), 8000);
    this.events.onStatus({ kind: this.state?.players[1] ? 'reconnecting' : 'connecting' });
    this.retryTimer = window.setTimeout(() => void this.openPeer(), wait);
  }

  private retryConnect(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    if (this.giveUpIfTooLong()) return;
    this.events.onStatus({ kind: this.state ? 'reconnecting' : 'connecting' });
    this.retryTimer = window.setTimeout(() => this.connectToHost(), 2500);
  }

  private giveUpIfTooLong(): boolean {
    if (this.conn?.open) return false;
    this.troubleSince ??= Date.now();
    if (Date.now() - this.troubleSince < GIVE_UP_AFTER) return false;
    this.events.onStatus({
      kind: 'failed',
      message: this.isHost
        ? 'No se puede abrir la sala. Comprueba tu conexión a internet y vuelve a intentarlo.'
        : 'No se encuentra la sala. Asegúrate de que quien la creó sigue con la página abierta, o prueba con otra red.',
    });
    return true;
  }

  private connectToHost(): void {
    if (this.closed || !this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (!conn.open) {
        conn.close();
        this.retryConnect();
      }
    }, CONNECT_TIMEOUT);

    conn.on('open', () => {
      clearTimeout(this.connectTimer);
      this.conn = conn;
      this.troubleSince = null;
      this.send(conn, { k: 'hello', token: this.session.token, player: this.session.player });
    });
    conn.on('data', (data) => this.onGuestData(data));
    conn.on('close', () => {
      if (this.conn === conn) this.conn = null;
      if (!this.closed) this.retryConnect();
    });
    conn.on('error', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.retryConnect();
    });
  }

  private onGuestData(data: unknown): void {
    const frame = decodeFrame(data);
    if (frame) {
      this.events.onFrame(frame.time, frame.poses);
      return;
    }
    const msg = data as NetMessage;
    switch (msg?.k) {
      case 'welcome':
        this.events.onStatus({ kind: 'connected' });
        this.sendMessage({ k: 'ready' });
        break;
      case 'full':
        this.closed = true;
        this.events.onStatus({ kind: 'failed', message: 'Esta sala ya tiene dos jugadores.' });
        break;
      case 'state':
        this.state = msg.state;
        this.persist();
        this.events.onState(msg.state);
        break;
    }
  }

  private acceptGuest(conn: DataConnection): void {
    conn.on('data', (data) => {
      const frame = decodeFrame(data);
      if (frame) {
        if (conn === this.conn) this.events.onFrame(frame.time, frame.poses);
        return;
      }
      const msg = data as NetMessage;
      switch (msg?.k) {
        case 'hello':
          this.onHello(conn, msg.token, msg.player);
          break;
        case 'action':
          if (conn === this.conn) this.applyAsHost(1, msg.action);
          break;
        case 'ready':
          if (conn === this.conn) this.events.onPeerReady();
          break;
      }
    });
    conn.on('close', () => {
      if (conn !== this.conn) return;
      this.conn = null;
      this.events.onStatus({ kind: 'reconnecting' });
    });
  }

  private onHello(conn: DataConnection, token: string, player: Player): void {
    if (!this.state) return;
    const known = this.session.guestToken;
    if (known && known !== token) {
      this.send(conn, { k: 'full' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    if (!known) {
      this.session.guestToken = token;
      const joined = reduce(this.state, 1, { type: 'join', player });
      if (joined) this.state = joined;
    }
    if (this.conn && this.conn !== conn) this.conn.close();
    this.conn = conn;
    this.persist();
    this.send(conn, { k: 'welcome', seat: 1 });
    this.send(conn, { k: 'state', state: this.state });
    this.events.onStatus({ kind: 'connected' });
    this.events.onState(this.state);
  }

  private applyAsHost(by: Seat, action: Action): void {
    if (!this.state) return;
    const next = reduce(this.state, by, action);
    if (!next) {
      // Si el otro lado iba desfasado, le reenvía el estado válido.
      if (by === 1) this.sendMessage({ k: 'state', state: this.state });
      return;
    }
    this.state = next;
    this.persist();
    this.events.onState(next);
    this.sendMessage({ k: 'state', state: next });
  }

  private sendMessage(msg: NetMessage): void {
    if (this.conn?.open) this.send(this.conn, msg);
  }

  private send(conn: DataConnection, msg: NetMessage): void {
    conn.send(msg);
  }
}
