import type { Action, GameState, Player, Seat } from '../game/state';
import { POSE_FLOATS } from '../physics/constants';

export type NetMessage =
  | { k: 'hello'; token: string; player: Player }
  | { k: 'welcome'; seat: Seat; to: string }
  | { k: 'full'; to: string }
  | { k: 'state'; state: GameState }
  | { k: 'action'; action: Action }
  | { k: 'ready' }
  | { k: 'ping' };

/** Paquete binario de poses: marca de tiempo (ms) + poses. */
export const FRAME_FLOATS = POSE_FLOATS + 1;

export function encodeFrame(timeMs: number, poses: Float32Array): ArrayBuffer {
  const out = new Float32Array(FRAME_FLOATS);
  out[0] = timeMs;
  out.set(poses, 1);
  return out.buffer as ArrayBuffer;
}

export function decodeFrame(data: unknown): { time: number; poses: Float32Array } | null {
  let view: Float32Array | null = null;
  if (data instanceof ArrayBuffer && data.byteLength === FRAME_FLOATS * 4) view = new Float32Array(data);
  else if (ArrayBuffer.isView(data) && data.byteLength === FRAME_FLOATS * 4) {
    view = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  }
  if (!view || view.some((v) => !Number.isFinite(v))) return null;
  return { time: view[0], poses: view.slice(1) };
}
