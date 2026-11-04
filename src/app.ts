import { canHold, canRoll, type GameState, type Player } from './game/state';
import type { Category } from './game/rules';
import { encodeFrame } from './net/protocol';
import { Room, type RoomStatus } from './net/room';
import { CUP_ASIDE, CUP_READY, CUP_HEIGHT, POSE_FLOATS } from './physics/constants';
import { DiceTable } from './physics/roll';
import { Scene3D } from './three/scene';
import { Hud } from './ui/hud';
import { Scorecard } from './ui/scorecard';

const FRAME_INTERVAL = 1000 / 30;
const PLAYBACK_DELAY = 90;
/** Por el servidor de respaldo: menos paquetes y más margen para los retrasos. */
const RELAY_FRAME_INTERVAL = 1000 / 15;
const RELAY_PLAYBACK_DELAY = 260;
const GRAB_PLANE_Y = 3;

interface BufferedFrame {
  time: number;
  poses: Float32Array;
}

export interface GameOptions {
  code: string;
  role: 'host' | 'guest';
  player: Player;
  persistent: boolean;
  card: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
}

/** Une física, escena, red e interfaz durante una partida. */
export function startGame(o: GameOptions): void {
  const scene = new Scene3D(o.canvas);
  const table = new DiceTable();
  const display = new Float32Array(POSE_FLOATS);
  table.poses(display);
  scene.applyPoses(display);

  let state: GameState | null = null;
  let status: RoomStatus = { kind: 'connecting' };
  let wasOwner = false;
  let awaitingRollEnd = false;
  let dragging = false;
  let grabX = 0;
  let grabZ = 0;
  let firstState = true;

  // --- Bucle: solo corre mientras hay algo moviéndose -----------------------
  let running = false;
  let lastTime = 0;
  let lastSent = 0;
  let sentActive = false;
  const frames: BufferedFrame[] = [];
  let clockOffset: number | null = null;

  const isOwner = () => !!state && state.phase === 'playing' && state.current === room.seat;
  const canAct = () => isOwner() && status.kind === 'connected';

  const sendSnapshot = (now = performance.now()) => {
    table.poses(display);
    room.sendFrame(encodeFrame(now % 1e7, display));
    lastSent = now;
  };

  function tick(now: number): boolean {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (isOwner()) {
      if (table.isActive()) {
        table.step(dt);
        table.poses(display);
        scene.applyPoses(display);
        if (now - lastSent >= (room.viaRelay ? RELAY_FRAME_INTERVAL : FRAME_INTERVAL)) sendSnapshot(now);
        sentActive = true;
        return true;
      }
      if (sentActive) {
        sentActive = false;
        sendSnapshot(now);
        scene.applyPoses(display);
      }
      return false;
    }
    return playBuffered(now);
  }

  function playBuffered(now: number): boolean {
    if (frames.length === 0 || clockOffset === null) return false;
    const t = now - clockOffset - (room.viaRelay ? RELAY_PLAYBACK_DELAY : PLAYBACK_DELAY);
    while (frames.length > 1 && frames[1].time <= t) frames.shift();
    const a = frames[0];
    const b = frames[1];
    if (!b || t <= a.time) {
      display.set(a.poses);
      scene.applyPoses(display);
      return t < a.time;
    }
    const k = Math.min(1, (t - a.time) / (b.time - a.time));
    interpolate(a.poses, b.poses, k, display);
    scene.applyPoses(display);
    return true;
  }

  function frame(now: number): void {
    const alive = tick(now);
    scene.render();
    updateRollButton();
    if (alive) requestAnimationFrame(frame);
    else running = false;
  }

  function wake(): void {
    if (running) return;
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  // En una pestaña oculta requestAnimationFrame se para: la tirada debe acabar igual.
  setInterval(() => {
    if (document.hidden && running) tick(performance.now());
  }, 250);

  // --- Red ------------------------------------------------------------------
  const room = new Room(o.code, o.player, o.role, o.persistent, {
    onState: applyState,
    onFrame(time, poses) {
      if (isOwner()) return;
      const now = performance.now();
      const last = frames[frames.length - 1];
      if (last && time < last.time - 1000) {
        // Se ha reiniciado el reloj del otro jugador.
        frames.length = 0;
        clockOffset = null;
      }
      if (last && time <= last.time) return;
      const offset = now - time;
      clockOffset = clockOffset === null ? offset : clockOffset * 0.95 + offset * 0.05;
      frames.push({ time, poses });
      if (frames.length > 60) frames.shift();
      wake();
    },
    onStatus(next) {
      status = next;
      if (next.kind === 'connected') awaitingRollEnd = false;
      hud.setStatus(next);
      refreshUi();
    },
    onPeerReady() {
      if (isOwner()) sendSnapshot();
    },
  });

  let lastRoll: number[] | null = null;
  table.onSettled = (values) => {
    awaitingRollEnd = true;
    lastRoll = values;
    room.dispatch({ type: 'rollEnd', values });
  };

  // Si se pierde el aviso de fin de tirada, la partida no debe quedarse esperando.
  setInterval(() => {
    if (awaitingRollEnd && lastRoll && state?.rolling && isOwner() && room.connected) {
      room.dispatch({ type: 'rollEnd', values: lastRoll });
    }
  }, 2000);

  const scorecard = new Scorecard(o.card, (category: Category) => {
    room.dispatch({ type: 'score', category });
  });

  const hud = new Hud(o.stage, o.code, {
    onRoll: () => startRoll(false),
    onRematch: () => room.dispatch({ type: 'rematch' }),
    onLeave: () => {
      room.close();
      location.href = location.pathname;
    },
  });

  function applyState(next: GameState): void {
    const prev = state;
    state = next;
    if (!next.rolling) awaitingRollEnd = false;
    const owner = isOwner();

    if (firstState) {
      firstState = false;
      restoreTable(next);
    } else if (owner && (!wasOwner || prev?.game !== next.game) && prev?.phase !== 'lobby') {
      // Recibe el turno: la mesa continúa desde lo último que veía este jugador.
      frames.length = 0;
      clockOffset = null;
      table.adopt(display);
      table.gatherAll();
    } else if (owner && table.phase === 'idle') {
      next.held.forEach((h, i) => table.setHeld(i, h));
    }
    wasOwner = owner;

    // Una tirada interrumpida por una recarga o un corte se puede repetir.
    if (owner && next.rolling && table.phase === 'idle' && !awaitingRollEnd) {
      room.dispatch({ type: 'rollAbort' });
    }

    if (owner && room.connected && !table.isActive()) sendSnapshot();
    refreshUi();
    wake();
  }

  function restoreTable(s: GameState): void {
    const used = s.rolling ? s.rollsUsed - 1 : s.rollsUsed;
    const hasValues = s.dice.every((v) => v > 0);
    table.restore(s.dice, s.held, hasValues ? used : 0);
    table.poses(display);
    scene.applyPoses(display);
  }

  function refreshUi(): void {
    if (state) scorecard.render(state, room.seat);
    hud.render(state, room.seat, canAct());
    updateRollButton();
  }

  function updateRollButton(): void {
    const parked = !state || state.rollsUsed === 0;
    const anchor = parked ? CUP_READY : CUP_ASIDE;
    const dx = parked ? -1.6 : -1.2;
    const dz = parked ? 3.9 : 3.3;
    const p = scene.project(anchor.x + dx, anchor.y + CUP_HEIGHT * 0.5, anchor.z + dz);
    hud.placeRollButton(p.x, p.y, o.stage.clientWidth);
  }

  // --- Interacción ----------------------------------------------------------
  function startRoll(manual: boolean): boolean {
    if (!state || !canAct() || !canRoll(state) || !table.canBeginRoll()) return false;
    // La mesa arranca antes: el anfitrión aplica la acción de forma síncrona y,
    // si la viera parada, creería que es una tirada interrumpida.
    table.beginRoll(manual);
    room.dispatch({ type: 'rollStart' });
    wake();
    return true;
  }

  function toggleHold(i: number): void {
    if (!state || !canAct() || !canHold(state) || table.phase !== 'idle') return;
    room.dispatch({ type: 'hold', index: i });
    wake();
  }

  o.canvas.addEventListener('pointerdown', (e) => {
    if (!state || !canAct()) return;
    if (canHold(state)) {
      const die = scene.pickDie(e.clientX, e.clientY);
      if (die !== null && table.phase === 'idle') {
        toggleHold(die);
        return;
      }
    }
    if (scene.pickCup(e.clientX, e.clientY) && startRoll(true)) {
      dragging = true;
      // Se conserva el punto por donde se ha agarrado para que el cubilete no salte.
      const p = scene.pointerOnPlane(e.clientX, e.clientY, GRAB_PLANE_Y);
      const cup = table.phys.cup.position;
      grabX = p ? cup.x - p.x : 0;
      grabZ = p ? cup.z - p.z : 0;
      o.canvas.setPointerCapture(e.pointerId);
    }
  });

  o.canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const p = scene.pointerOnPlane(e.clientX, e.clientY, GRAB_PLANE_Y);
      if (p) table.dragTo(p.x + grabX, p.z + grabZ);
      return;
    }
    if (!state || !canAct() || e.pointerType !== 'mouse') return;
    const overDie = canHold(state) && scene.pickDie(e.clientX, e.clientY) !== null;
    const overCup = canRoll(state) && scene.pickCup(e.clientX, e.clientY);
    o.canvas.style.cursor = overDie || overCup ? 'pointer' : '';
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    table.release();
    wake();
  };
  o.canvas.addEventListener('pointerup', endDrag);
  o.canvas.addEventListener('pointercancel', endDrag);

  addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || e.repeat) return;
    if (e.code === 'Space') {
      e.preventDefault();
      startRoll(false);
    } else if (/^[1-5]$/.test(e.key)) {
      toggleHold(Number(e.key) - 1);
    }
  });

  // --- Tamaño ---------------------------------------------------------------
  const resize = () => {
    scene.resize(o.stage.clientWidth, o.stage.clientHeight);
    updateRollButton();
    scene.render();
  };
  new ResizeObserver(resize).observe(o.stage);
  resize();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });

  if (import.meta.env.DEV) {
    Object.assign(window, { __generala: { room, table, startRoll, getState: () => state } });
  }

  void room.start();
}

function interpolate(a: Float32Array, b: Float32Array, k: number, out: Float32Array): void {
  for (let o = 0; o < POSE_FLOATS; o += 7) {
    for (let i = 0; i < 3; i++) out[o + i] = a[o + i] + (b[o + i] - a[o + i]) * k;
    let dot = 0;
    for (let i = 3; i < 7; i++) dot += a[o + i] * b[o + i];
    const sign = dot < 0 ? -1 : 1;
    let len = 0;
    for (let i = 3; i < 7; i++) {
      out[o + i] = a[o + i] + (b[o + i] * sign - a[o + i]) * k;
      len += out[o + i] * out[o + i];
    }
    len = Math.sqrt(len) || 1;
    for (let i = 3; i < 7; i++) out[o + i] /= len;
  }
}
