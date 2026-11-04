import type { DataConnection, Peer as PeerType } from 'peerjs';
import { createGame, reduce, type Action, type GameState, type Player, type Seat } from '../game/state';
import { decodeFrame, type NetMessage } from './protocol';
import type { RelayLink } from './relay';

const PREFIX = 'generala3d-sala-';
const CONNECT_TIMEOUT = 12_000;
/** Tiempo que se da a la conexión directa antes de probar también el respaldo. */
const FALLBACK_AFTER = 7000;
const HELLO_EVERY = 2500;
const RESYNC_EVERY = 3000;
const GIVE_UP_AFTER = 45_000;

/**
 * Solo STUN: los servidores TURN que PeerJS trae por defecto ya no existen.
 * Si no hay ruta directa, entra en juego el respaldo de `relay.ts`.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** En desarrollo, `?relay` obliga a usar el respaldo para poder probarlo. */
const FORCE_RELAY = import.meta.env.DEV && new URLSearchParams(location.search).has('relay');

export type RoomStatus =
  | { kind: 'connecting' }
  | { kind: 'fallback' }
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

/** Lo que Room necesita de una conexión, sea directa o por el respaldo. */
interface Link {
  readonly open: boolean;
  send(data: NetMessage | ArrayBuffer): void;
  close(): void;
}

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

/** El código también es la clave del respaldo: debe ser difícil de adivinar. */
export function newCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
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
 * Sala para dos jugadores. El anfitrión guarda el estado válido: valida cada
 * acción y la reenvía. Se intenta unir a los navegadores por WebRTC y, si no
 * hay ruta directa, por el respaldo. El anfitrión escucha siempre por las dos
 * vías y el invitado se queda con la primera que le responde.
 */
export class Room {
  seat: Seat;
  state: GameState | null = null;

  private peer: PeerType | null = null;
  private conn: Link | null = null;
  private relay: RelayLink | null = null;
  private session: Session;
  private closed = false;
  private retryTimer = 0;
  private connectTimer = 0;
  private fallbackTimer = 0;
  private helloTimer = 0;
  private resyncTimer = 0;
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

  /** Por el respaldo hay más latencia: conviene enviar menos y esperar más. */
  get viaRelay(): boolean {
    return !!this.conn && this.conn === this.relay;
  }

  async start(): Promise<void> {
    this.events.onStatus({ kind: 'connecting' });
    if (this.isHost) {
      this.state = this.session.state ?? createGame(this.session.player);
      this.persist();
      this.events.onState(this.state);
      void this.startRelay();
      // Por el respaldo se puede perder algún mensaje durante un corte: repetir
      // el estado garantiza que el rival nunca se quede congelado.
      this.resyncTimer = window.setInterval(() => {
        if (this.viaRelay && this.state) this.sendMessage({ k: 'state', state: this.state });
      }, RESYNC_EVERY);
    } else {
      if (this.session.state) {
        // Mientras vuelve a conectar, enseña la última partida conocida.
        this.state = this.session.state;
        this.events.onState(this.state);
      }
      this.fallbackTimer = window.setTimeout(() => {
        if (this.conn?.open) return;
        this.events.onStatus({ kind: 'fallback' });
        void this.startRelay();
      }, FORCE_RELAY ? 0 : FALLBACK_AFTER);
    }
    if (!FORCE_RELAY) await this.openPeer();
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
    clearTimeout(this.fallbackTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.resyncTimer);
    this.conn?.close();
    this.relay?.close();
    this.peer?.destroy();
  }

  private persist(): void {
    if (!this.state) return;
    this.session.state = this.state;
    if (this.persistent) saveSession(this.code, this.session);
  }

  // --- Respaldo ---------------------------------------------------------------

  private async startRelay(): Promise<void> {
    if (this.relay || this.closed) return;
    const { RelayLink } = await import('./relay');
    if (this.relay || this.closed) return;
    const link: RelayLink = new RelayLink(this.code, this.session.role, {
      onOpen: () => this.onRelayOpen(),
      onData: (data) => {
        if (this.isHost) this.onHostData(link, data);
        else this.onGuestData(link, data);
      },
      onPeerLost: () => this.onRelayPeerLost(link),
    });
    this.relay = link;
    await link.connect();
  }

  private onRelayOpen(): void {
    if (this.isHost) {
      // Aunque el servidor de PeerJS no responda, la sala ya se puede compartir.
      if (!this.conn?.open && !this.state?.players[1]) this.events.onStatus({ kind: 'waiting-peer' });
      return;
    }
    this.startHelloLoop();
  }

  /** Los mensajes QoS 0 o el anfitrión pueden no estar aún: se repite hasta que conteste. */
  private startHelloLoop(): void {
    const relay = this.relay;
    if (!relay || this.conn?.open) return;
    clearInterval(this.helloTimer);
    const hello = () => {
      if (this.conn?.open || !relay.open) return;
      relay.send({ k: 'hello', token: this.session.token, player: this.session.player });
    };
    hello();
    this.helloTimer = window.setInterval(hello, HELLO_EVERY);
  }

  private onRelayPeerLost(link: RelayLink): void {
    if (this.conn !== link) return;
    this.conn = null;
    this.events.onStatus({ kind: 'reconnecting' });
    if (!this.isHost) this.startHelloLoop();
  }

  // --- WebRTC -----------------------------------------------------------------

  private async openPeer(): Promise<void> {
    if (this.closed) return;
    const { Peer } = await import('peerjs');
    if (this.closed) return;
    this.peer?.destroy();
    const options = { config: { iceServers: ICE_SERVERS } };
    const peer = this.isHost ? new Peer(PREFIX + this.code, options) : new Peer(options);
    this.peer = peer;

    peer.on('open', () => {
      this.retries = 0;
      if (this.isHost) {
        this.troubleSince = null;
        if (this.conn?.open) return;
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
          // Sin WebRTC todavía queda el respaldo.
          void this.startRelay();
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
    if (!this.conn?.open && !this.relay?.open) {
      this.events.onStatus({ kind: this.state?.players[1] ? 'reconnecting' : 'connecting' });
    }
    this.retryTimer = window.setTimeout(() => void this.openPeer(), wait);
  }

  private retryConnect(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    if (this.giveUpIfTooLong()) return;
    if (!this.relay) this.events.onStatus({ kind: this.state ? 'reconnecting' : 'connecting' });
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
        : 'No se encuentra la sala. Asegúrate de que quien la creó sigue con la página abierta, o recarga para volver a intentarlo.',
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
      this.send(conn, { k: 'hello', token: this.session.token, player: this.session.player });
    });
    conn.on('data', (data) => this.onGuestData(conn, data));
    conn.on('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        void this.startRelay();
      }
      if (!this.closed && !this.viaRelay) this.retryConnect();
    });
    conn.on('error', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.retryConnect();
    });
  }

  // --- Mensajes ---------------------------------------------------------------

  private onGuestData(link: Link, data: unknown): void {
    const frame = decodeFrame(data);
    if (frame) {
      if (link === this.conn) this.events.onFrame(frame.time, frame.poses);
      return;
    }
    const msg = data as NetMessage;
    switch (msg?.k) {
      case 'welcome':
        if (msg.to === this.session.token) this.onWelcome(link);
        break;
      case 'full':
        if (msg.to !== this.session.token) break;
        this.closed = true;
        clearTimeout(this.fallbackTimer);
        clearInterval(this.helloTimer);
        this.events.onStatus({ kind: 'failed', message: 'Esta sala ya tiene dos jugadores.' });
        break;
      case 'state':
        if (link !== this.conn) break;
        // Por el respaldo el estado se repite periódicamente: si no cambia, no hay nada que hacer.
        if (JSON.stringify(msg.state) === JSON.stringify(this.state)) break;
        this.state = msg.state;
        this.persist();
        this.events.onState(msg.state);
        break;
    }
  }

  /** La primera vía que contesta se queda; la otra se cierra para no gastar recursos. */
  private onWelcome(link: Link): void {
    if (this.conn?.open && this.conn !== link) return;
    this.conn = link;
    this.troubleSince = null;
    clearInterval(this.helloTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.fallbackTimer);
    if (link === this.relay) {
      this.peer?.destroy();
      this.peer = null;
    } else {
      this.relay?.close();
      this.relay = null;
    }
    this.events.onStatus({ kind: 'connected' });
    this.sendMessage({ k: 'ready' });
  }

  private acceptGuest(conn: DataConnection): void {
    conn.on('data', (data) => this.onHostData(conn, data));
    conn.on('close', () => {
      if (conn !== this.conn) return;
      this.conn = null;
      this.events.onStatus({ kind: 'reconnecting' });
    });
  }

  private onHostData(link: Link, data: unknown): void {
    const frame = decodeFrame(data);
    if (frame) {
      if (link === this.conn) this.events.onFrame(frame.time, frame.poses);
      return;
    }
    const msg = data as NetMessage;
    switch (msg?.k) {
      case 'hello':
        this.onHello(link, msg.token, msg.player);
        break;
      case 'action':
        if (link === this.conn) this.applyAsHost(1, msg.action);
        break;
      case 'ready':
        if (link === this.conn) this.events.onPeerReady();
        break;
    }
  }

  private onHello(link: Link, token: string, player: Player): void {
    if (!this.state) return;
    const known = this.session.guestToken;
    if (known && known !== token) {
      this.send(link, { k: 'full', to: token });
      if (link !== this.relay) setTimeout(() => link.close(), 300);
      return;
    }
    if (!known) {
      this.session.guestToken = token;
      const joined = reduce(this.state, 1, { type: 'join', player });
      if (joined) this.state = joined;
    }
    // El respaldo es compartido: al cambiar de vía no se desconecta del servidor.
    if (this.conn && this.conn !== link && this.conn !== this.relay) this.conn.close();
    this.conn = link;
    this.persist();
    this.send(link, { k: 'welcome', seat: 1, to: token });
    this.send(link, { k: 'state', state: this.state });
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

  private send(link: Link, msg: NetMessage): void {
    link.send(msg);
  }
}
