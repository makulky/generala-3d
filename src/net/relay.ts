import type { MqttClient } from 'mqtt';
import type { NetMessage } from './protocol';

/**
 * Respaldo para cuando WebRTC no consigue unir a los dos navegadores: los
 * mensajes pasan por un servidor MQTT público. Van cifrados con una clave
 * derivada del código de sala, que el servidor nunca ve (el canal usa otro
 * hash distinto), así que no puede leer nombres, dados ni puntos.
 */
const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const PING_EVERY = 3000;
const PEER_LOST_AFTER = 12_000;

const KIND_JSON = 0;
const KIND_BINARY = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function deriveRelay(code: string): Promise<{ key: CryptoKey; channel: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    await sha256(`generala3d:clave:${code}`),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  const hash = await sha256(`generala3d:canal:${code}`);
  const channel = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return { key, channel };
}

/** Empaqueta y cifra: IV (12 bytes) + texto cifrado de [tipo + contenido]. */
export async function seal(key: CryptoKey, kind: number, body: Uint8Array): Promise<Uint8Array> {
  const plain = new Uint8Array(body.length + 1);
  plain[0] = kind;
  plain.set(body, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return out;
}

/** Devuelve null si el paquete está corrupto o se cifró con otra clave. */
export async function unseal(key: CryptoKey, packet: Uint8Array): Promise<{ kind: number; body: Uint8Array } | null> {
  if (packet.length < 13) return null;
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packet.slice(0, 12) }, key, packet.slice(12)),
    );
    return { kind: plain[0], body: plain.slice(1) };
  } catch {
    return null;
  }
}

export interface RelayEvents {
  onOpen(): void;
  onData(data: unknown): void;
  /** El otro jugador ha dejado de dar señales de vida. */
  onPeerLost(): void;
}

export class RelayLink {
  open = false;

  private client: MqttClient | null = null;
  private key: CryptoKey | null = null;
  private outTopic = '';
  private closed = false;
  private seq = 0;
  private lastSeq = 0;
  private lastSeen = 0;
  private peerSeen = false;
  private timer = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private receiveChain: Promise<unknown> = Promise.resolve();

  constructor(
    private code: string,
    private role: 'host' | 'guest',
    private events: RelayEvents,
  ) {}

  async connect(): Promise<void> {
    const { key, channel } = await deriveRelay(this.code);
    this.key = key;
    const base = `generala3d/${channel}`;
    const inTopic = `${base}/${this.role === 'host' ? 'a-anfitrion' : 'a-invitado'}`;
    this.outTopic = `${base}/${this.role === 'host' ? 'a-invitado' : 'a-anfitrion'}`;

    // La versión para navegador solo expone `connect` dentro de la exportación por defecto.
    const mqtt = await import('mqtt');
    const connect = mqtt.connect ?? (mqtt.default as unknown as typeof mqtt).connect;
    if (this.closed) return;
    const client = connect(BROKER, {
      clean: true,
      connectTimeout: 8000,
      keepalive: 30,
      protocolVersion: 4,
      reconnectPeriod: 2000,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(inTopic, { qos: 1 }, (err) => {
        if (err || this.closed) return;
        this.open = true;
        this.events.onOpen();
      });
    });
    // `open` sigue activo durante los cortes: mqtt.js reconecta solo y guarda los
    // mensajes en cola. Si el corte se alarga, lo detecta `onPeerLost`.
    client.on('close', () => console.warn('[respaldo] conexión con el servidor cerrada'));
    client.on('error', (err) => console.warn('[respaldo]', err.message));
    client.on('message', (_topic, payload) => {
      const packet = new Uint8Array(payload);
      // Se descifra en orden para no alterar la secuencia de mensajes. El catch
      // evita que un mensaje que falle bloquee todos los siguientes.
      this.receiveChain = this.receiveChain
        .then(() => this.receive(packet))
        .catch((err) => console.warn('[respaldo] mensaje descartado', err));
    });

    this.timer = window.setInterval(() => this.heartbeat(), PING_EVERY);
  }

  send(data: NetMessage | ArrayBuffer): void {
    if (!this.open || !this.key) return;
    const key = this.key;
    let kind: number;
    let body: Uint8Array;
    let qos: 0 | 1;
    if (data instanceof ArrayBuffer) {
      // Una posición atrasada no sirve de nada: durante un corte no se acumulan.
      if (!this.client?.connected) return;
      kind = KIND_BINARY;
      body = new Uint8Array(data);
      qos = 0;
    } else {
      // El QoS 1 puede duplicar mensajes: el número de secuencia permite descartarlos.
      this.seq = Math.max(this.seq + 1, Date.now() * 1000);
      kind = KIND_JSON;
      body = encoder.encode(JSON.stringify({ s: this.seq, m: data }));
      qos = 1;
    }
    this.sendChain = this.sendChain
      .then(async () => {
        const packet = await seal(key, kind, body);
        // mqtt.js declara Buffer, pero en el navegador también acepta Uint8Array.
        this.client?.publish(this.outTopic, packet as never, { qos });
      })
      .catch((err) => console.warn('[respaldo] envío fallido', err));
  }

  close(): void {
    this.closed = true;
    this.open = false;
    clearInterval(this.timer);
    this.client?.end(true);
    this.client = null;
  }

  private async receive(packet: Uint8Array): Promise<void> {
    if (this.closed || !this.key) return;
    const message = await unseal(this.key, packet);
    if (!message) return;
    this.lastSeen = Date.now();
    this.peerSeen = true;
    if (message.kind === KIND_BINARY) {
      const { buffer, byteOffset, byteLength } = message.body;
      this.events.onData(buffer.slice(byteOffset, byteOffset + byteLength));
      return;
    }
    const { s, m } = JSON.parse(decoder.decode(message.body)) as { s: number; m: NetMessage };
    if (s <= this.lastSeq) return;
    this.lastSeq = s;
    if (m.k !== 'ping') this.events.onData(m);
  }

  private heartbeat(): void {
    if (!this.peerSeen) return;
    if (Date.now() - this.lastSeen > PEER_LOST_AFTER) {
      this.peerSeen = false;
      this.events.onPeerLost();
      return;
    }
    this.send({ k: 'ping' });
  }
}
