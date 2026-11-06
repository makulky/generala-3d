import * as CANNON from 'cannon-es';
import {
  CUP_ASIDE,
  CUP_FLOOR,
  CUP_HEIGHT,
  CUP_INNER_R,
  CUP_LANE_X,
  CUP_OUTER_R,
  CUP_POUR,
  CUP_POUR_ANGLE,
  CUP_READY,
  CUP_RIM_TOP,
  FACE_NORMALS,
  FELT,
  POSE_FLOATS,
  SLOT_FLOOR_Y,
  SLOT_X,
  SLOT_Z,
} from './constants';
import { GROUP, MASK_DIE_FREE, MASK_DIE_TRAY, createPhysics, type Physics } from './world';

const DT = 1 / 120;
const MAX_CUP_SPEED = 26;
const MAX_DIE_SPEED = 42;
const MAX_DIE_SPIN = 45;
const HOP_TIME = 0.5;
const HOP_STAGGER = 0.07;
const PARK_TIMEOUT = 1.2;
const AUTO_SHAKE_TIME = 0.95;
const MIN_SHAKE_TIME = 0.35;
const WINDUP_TIME = 0.22;
const WINDUP_SPEED = 22;
const THROW_TIME = 0.5;
const MAX_POUR_HOLD = 3;
const STUCK_EXTRA_TILT = 0.4;
const STUCK_EJECT_AFTER = 1;
const SETTLE_NUDGE_TIME = 2;
const SETTLE_FORCE_TIME = 7;
/** Tiempo que un dado debe seguir quieto para contar como parado. */
const REST_STILL = 0.12;
/** Pasado este tiempo, un dado plano que apenas vibra ya cuenta como parado. */
const JITTER_SPEED = 0.8;
/** Tras volcar, el cubilete se aleja de los dados antes de enderezarse. */
const RETREAT_TIME = 0.3;
const FLAT_DOT = 0.985;
const STILL_BEFORE_NUDGE = 0.35;

/** Sitios dentro del cubilete, en coordenadas locales. */
const CUP_SPOTS: [number, number][] = [
  [Math.PI * 0.25, 0],
  [Math.PI * 0.75, 0],
  [Math.PI * 1.25, 0],
  [Math.PI * 1.75, 0],
  [0, 1],
];

type DieState = 'parked' | 'free' | 'held' | 'tween';
type Phase = 'idle' | 'gather' | 'shake' | 'pour' | 'settle';

interface Tween {
  from: CANNON.Vec3;
  fromQ: CANNON.Quaternion;
  to: CANNON.Vec3;
  toQ: CANNON.Quaternion;
  t: number;
  dur: number;
  arc: number;
  done: () => void;
}

/** Salto de un dado por encima del borde hasta la boca del cubilete. */
interface Hop {
  from: CANNON.Vec3;
  fromQ: CANNON.Quaternion;
  toQ: CANNON.Quaternion;
  t: number;
  angle: number;
}

interface DieRuntime {
  hop: Hop | null;
  flung: boolean;
  state: DieState;
  inTray: boolean;
  held: boolean;
  slot: number;
  value: number;
  tween: Tween | null;
  nudges: number;
  stillT: number;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

const UP = new CANNON.Vec3(0, 1, 0);

/** Orientación con la cara `value` hacia arriba y el giro indicado. */
export function quatForValue(value: number, yaw = 0): CANNON.Quaternion {
  const [x, y, z] = FACE_NORMALS[value];
  const toUp = new CANNON.Quaternion();
  toUp.setFromVectors(new CANNON.Vec3(x, y, z), UP);
  const spin = new CANNON.Quaternion();
  spin.setFromAxisAngle(UP, yaw);
  return spin.mult(toUp);
}

/** Cara hacia arriba y cuánto de plano está el dado (1 = totalmente plano). */
export function readFace(q: CANNON.Quaternion): { value: number; dot: number } {
  let value = 1;
  let dot = -2;
  const v = new CANNON.Vec3();
  for (let f = 1; f <= 6; f++) {
    const [x, y, z] = FACE_NORMALS[f];
    q.vmult(new CANNON.Vec3(x, y, z), v);
    if (v.y > dot) {
      dot = v.y;
      value = f;
    }
  }
  return { value, dot };
}

/** Cara hacia arriba del dado `i` en un paquete de poses. */
export function readFaceFromPoses(poses: Float32Array, i: number): { value: number; dot: number } {
  const o = 7 + i * 7;
  return readFace(new CANNON.Quaternion(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]));
}

function randomQuat(): CANNON.Quaternion {
  const q = new CANNON.Quaternion(
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5,
    Math.random() - 0.5,
  );
  q.normalize();
  return q;
}

/**
 * Mesa física del jugador que tiene el turno. No depende del render, de modo
 * que se puede simular en Node. Quien no tiene el turno no la avanza: solo
 * reproduce las poses que recibe.
 */
export class DiceTable {
  readonly phys: Physics;
  readonly dice: DieRuntime[];
  phase: Phase = 'idle';
  onSettled: ((values: number[]) => void) | null = null;
  /** Estadísticas para las pruebas de simulación. */
  stats = { recovered: 0, nudged: 0, forced: 0, rehops: 0, reconciled: 0, stuck: 0 };

  private acc = 0;
  private phaseT = 0;
  private cupTargetPos = new CANNON.Vec3(CUP_READY.x, CUP_READY.y, CUP_READY.z);
  private cupTargetQ = new CANNON.Quaternion();
  private pourFromPos = new CANNON.Vec3();
  private pourFromQ = new CANNON.Quaternion();
  private pourZ = 0;
  private windupTime = WINDUP_TIME;
  private shakeFromX = CUP_READY.x;
  private shakeFromZ = CUP_READY.z;
  private parkT = 0;
  private dragX = CUP_READY.x;
  private dragZ = CUP_READY.z;
  private manual = false;
  private released = false;
  private rollAfterGather = false;
  private settleT = 0;
  private jitterT = 0;

  constructor() {
    this.phys = createPhysics();
    this.dice = this.phys.dice.map(() => ({
      hop: null,
      flung: false,
      state: 'parked',
      inTray: false,
      held: false,
      slot: -1,
      value: 0,
      tween: null,
      nudges: 0,
      stillT: 0,
    }));
    this.restore([0, 0, 0, 0, 0], [false, false, false, false, false], 0);
  }

  // --- Colocación directa ---------------------------------------------------

  /** Recoloca todo a partir del estado de la partida (inicio o recarga). */
  restore(values: number[], held: boolean[], rollsUsed: number): void {
    this.phase = 'idle';
    this.acc = 0;
    let nextSlot = 0;
    const free = this.scatterSpots();
    this.phys.dice.forEach((body, i) => {
      const die = this.dice[i];
      die.tween = null;
      die.hop = null;
      die.held = held[i];
      die.value = values[i];
      die.nudges = 0;
      if (rollsUsed === 0) {
        die.state = 'parked';
        this.freeze(i);
        body.position.copy(this.cupSpotWorld(i));
        body.quaternion.copy(randomQuat());
        die.slot = -1;
        return;
      }
      if (held[i]) {
        die.state = 'held';
        die.slot = nextSlot++;
        this.freeze(i);
        body.position.set(SLOT_X[die.slot], SLOT_FLOOR_Y + 0.5, SLOT_Z);
        body.quaternion.copy(quatForValue(values[i]));
        return;
      }
      die.slot = -1;
      this.toResting(i, free[i], quatForValue(values[i], Math.random() * Math.PI));
    });
    const cupPos = rollsUsed === 0 ? CUP_READY : CUP_ASIDE;
    this.phys.cup.position.set(cupPos.x, cupPos.y, cupPos.z);
    this.phys.cup.quaternion.set(0, 0, 0, 1);
    this.phys.cup.velocity.setZero();
    this.phys.cup.angularVelocity.setZero();
    this.cupTargetPos.set(cupPos.x, cupPos.y, cupPos.z);
    this.cupTargetQ.set(0, 0, 0, 1);
    this.setCupCollision(false, false);
  }

  /** Toma la mesa tal como la veía este jugador al recibir el turno. */
  adopt(poses: Float32Array): void {
    this.phase = 'idle';
    const set = (b: CANNON.Body, o: number) => {
      b.position.set(poses[o], poses[o + 1], poses[o + 2]);
      b.quaternion.set(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]);
      b.velocity.setZero();
      b.angularVelocity.setZero();
    };
    set(this.phys.cup, 0);
    this.phys.dice.forEach((b, i) => {
      set(b, 7 + i * 7);
      const die = this.dice[i];
      die.tween = null;
      die.hop = null;
      die.held = false;
      die.slot = -1;
      die.state = 'free';
      this.freeze(i);
    });
    this.cupTargetPos.copy(this.phys.cup.position);
    this.cupTargetQ.copy(this.phys.cup.quaternion);
  }

  /** Lleva todos los dados al cubilete para empezar un turno. */
  gatherAll(): void {
    for (const die of this.dice) {
      die.held = false;
      die.slot = -1;
    }
    this.rollAfterGather = false;
    this.startGather();
  }

  // --- Tirada ---------------------------------------------------------------

  /** Se puede tirar con la mesa parada o mientras los dados vuelven al empezar el turno. */
  canBeginRoll(): boolean {
    return this.phase === 'idle' || (this.phase === 'gather' && !this.rollAfterGather);
  }

  /** Empieza a tirar. Con `manual`, el cubilete se agita hasta `release()`. */
  beginRoll(manual: boolean): void {
    if (!this.canBeginRoll()) return;
    const wasIdle = this.phase === 'idle';
    this.manual = manual;
    this.released = !manual;
    this.rollAfterGather = true;
    // El cubilete se queda donde está hasta que el puntero lo mueva: nada de saltos.
    this.dragX = this.phys.cup.position.x;
    this.dragZ = this.phys.cup.position.z;
    if (wasIdle) this.startGather();
  }

  dragTo(x: number, z: number): void {
    this.dragX = Math.min(8.5, Math.max(-5, x));
    this.dragZ = Math.min(4.5, Math.max(-4, z));
  }

  release(): void {
    this.released = true;
  }

  setHeld(i: number, held: boolean): void {
    const die = this.dice[i];
    if (die.held === held) return;
    die.held = held;
    const body = this.phys.dice[i];
    if (held) {
      die.slot = this.firstFreeSlot();
      this.freeze(i);
      this.startTween(
        i,
        new CANNON.Vec3(SLOT_X[die.slot], SLOT_FLOOR_Y + 0.5, SLOT_Z),
        quatForValue(die.value),
        0.34,
        1.6,
        () => {
          die.state = 'held';
        },
      );
    } else {
      die.slot = -1;
      const spot = this.freeSpot(i);
      this.freeze(i);
      this.startTween(i, spot, quatForValue(die.value, Math.random() * Math.PI), 0.34, 1.6, () => {
        this.toResting(i, spot, body.quaternion);
      });
    }
  }

  heldMask(): boolean[] {
    return this.dice.map((d) => d.held);
  }

  /** ¿Lo que muestra la mesa coincide con estos valores y dados guardados? */
  matches(values: number[], held: boolean[]): boolean {
    return this.dice.every((die, i) => {
      if (die.tween || die.held !== held[i] || die.state === 'parked') return false;
      return readFace(this.phys.dice[i].quaternion).value === values[i];
    });
  }

  /**
   * Corrige la mesa para que muestre exactamente lo que dice el estado de la
   * partida, que es lo que puntúa. No debería hacer falta nunca: es la red de
   * seguridad por si algo se pierde por el camino.
   */
  reconcile(values: number[], held: boolean[]): void {
    if (this.phase !== 'idle') return;
    this.stats.reconciled++;
    this.dice.forEach((die, i) => {
      if (die.tween) return;
      const body = this.phys.dice[i];
      const wrongFace = readFace(body.quaternion).value !== values[i];
      const parked = die.state === 'parked';
      die.value = values[i];
      if (die.held !== held[i]) {
        this.setHeld(i, held[i]);
        return;
      }
      if (!wrongFace && !parked) return;
      this.freeze(i);
      if (held[i]) {
        const slot = new CANNON.Vec3(SLOT_X[die.slot], SLOT_FLOOR_Y + 0.5, SLOT_Z);
        this.startTween(i, slot, quatForValue(values[i]), 0.3, 1, () => {
          die.state = 'held';
        });
      } else {
        const spot = this.freeSpot(i);
        this.startTween(i, spot, quatForValue(values[i], Math.random() * Math.PI), 0.3, 1, () => {
          this.toResting(i, spot, body.quaternion);
        });
      }
    });
    this.cupTargetPos.set(CUP_ASIDE.x, CUP_ASIDE.y, CUP_ASIDE.z);
    this.cupTargetQ.set(0, 0, 0, 1);
  }

  /** ¿Hay algo moviéndose que obligue a seguir simulando y enviando poses? */
  isActive(): boolean {
    if (this.phase !== 'idle') return true;
    if (this.dice.some((d) => d.tween)) return true;
    const cup = this.phys.cup;
    return cup.position.distanceTo(this.cupTargetPos) > 0.01 || this.quatDistance(cup.quaternion, this.cupTargetQ) > 0.005;
  }

  poses(out: Float32Array = new Float32Array(POSE_FLOATS)): Float32Array {
    const put = (b: CANNON.Body, o: number) => {
      out[o] = b.position.x;
      out[o + 1] = b.position.y;
      out[o + 2] = b.position.z;
      out[o + 3] = b.quaternion.x;
      out[o + 4] = b.quaternion.y;
      out[o + 5] = b.quaternion.z;
      out[o + 6] = b.quaternion.w;
    };
    put(this.phys.cup, 0);
    this.phys.dice.forEach((b, i) => put(b, 7 + i * 7));
    return out;
  }

  /** Avanza la simulación con paso fijo. */
  step(elapsed: number): void {
    this.acc += Math.min(elapsed, 1);
    while (this.acc >= DT) {
      this.fixedStep();
      this.acc -= DT;
    }
  }

  // --- Interno --------------------------------------------------------------

  private fixedStep(): void {
    this.phaseT += DT;
    this.updateTweens();
    this.updateHops();
    this.updatePhase();
    this.driveCup();
    // Mientras el cubilete se mueve rápido, la física va más fina para que nada lo atraviese.
    const substeps = this.phase === 'shake' || this.phase === 'pour' ? 2 : 1;
    for (let s = 0; s < substeps; s++) {
      this.phys.world.step(DT / substeps);
      this.clampDice();
    }
  }

  private startGather(): void {
    this.phase = 'gather';
    this.phaseT = 0;
    this.parkT = 0;
    this.cupTargetQ.set(0, 0, 0, 1);
    const pending = this.dice.filter((d) => !d.held && d.state !== 'parked');
    if (pending.length === 0) {
      // Los dados ya están en el cubilete: se empieza sin espera.
      if (this.rollAfterGather) {
        this.startShake();
      } else {
        this.setCupCollision(false, false);
        this.cupTargetPos.set(CUP_READY.x, CUP_READY.y, CUP_READY.z);
        this.phase = 'idle';
      }
      return;
    }
    this.setCupCollision(true, false);
    let delay = 0;
    this.dice.forEach((die, i) => {
      if (die.held) return;
      if (die.state === 'parked') {
        this.releaseIntoCup(i);
        return;
      }
      this.freeze(i);
      this.startHop(i, delay);
      delay += HOP_STAGGER;
    });
  }

  private startHop(i: number, delay: number): void {
    const body = this.phys.dice[i];
    const die = this.dice[i];
    die.state = 'tween';
    die.hop = {
      from: body.position.clone(),
      fromQ: body.quaternion.clone(),
      toQ: randomQuat(),
      t: -delay,
      angle: i * ((Math.PI * 2) / 5),
    };
  }

  /** El dado sube en vertical, cruza por encima del borde y cae dentro con física. */
  private updateHops(): void {
    const cup = this.phys.cup.position;
    const top = cup.y + CUP_RIM_TOP + 1;
    this.phys.dice.forEach((body, i) => {
      const die = this.dice[i];
      const hop = die.hop;
      if (!hop) return;
      hop.t += DT;
      if (hop.t < 0) return;
      const k = hop.t / HOP_TIME;
      const mouthX = cup.x + Math.cos(hop.angle) * 0.9;
      const mouthZ = cup.z + Math.sin(hop.angle) * 0.9;
      const rise = smooth(k / 0.45);
      const across = smooth((k - 0.45) / 0.55);
      body.position.set(
        hop.from.x + (mouthX - hop.from.x) * across,
        hop.from.y + (top - hop.from.y) * rise,
        hop.from.z + (mouthZ - hop.from.z) * across,
      );
      hop.fromQ.slerp(hop.toQ, Math.min(1, k), body.quaternion);
      if (k >= 1) {
        die.hop = null;
        this.releaseIntoCup(i);
        body.velocity.set(this.phys.cup.velocity.x, -2, this.phys.cup.velocity.z);
      }
    });
  }

  /** Devuelve el dado a la física, en su posición actual y sin colisión con la mesa. */
  private releaseIntoCup(i: number): void {
    const body = this.phys.dice[i];
    const die = this.dice[i];
    die.state = 'free';
    die.inTray = false;
    die.flung = false;
    die.nudges = 0;
    body.type = CANNON.Body.DYNAMIC;
    body.collisionFilterGroup = GROUP.DIE;
    body.collisionFilterMask = MASK_DIE_FREE;
    body.wakeUp();
  }

  private isSeatedInCup(b: CANNON.Body): boolean {
    const local = this.phys.cup.pointToLocalFrame(b.position);
    return Math.hypot(local.x, local.z) < CUP_INNER_R && local.y > 0 && local.y < CUP_HEIGHT - 0.6;
  }

  private updateGather(): void {
    const unheld = this.dice.map((_, i) => i).filter((i) => !this.dice[i].held);
    const seated = unheld.every((i) => !this.dice[i].hop && this.isSeatedInCup(this.phys.dice[i]));

    if (seated && this.rollAfterGather) {
      this.startShake();
      return;
    }

    if (seated) {
      // Empieza el turno de este jugador: el cubilete vuelve a su sitio con la tapa puesta.
      this.setCupCollision(true, true);
      this.cupTargetPos.set(CUP_READY.x, CUP_READY.y, CUP_READY.z);
      this.parkT += DT;
      const arrived = this.phys.cup.position.distanceTo(this.cupTargetPos) < 0.02;
      const still = unheld.every((i) => this.phys.dice[i].velocity.length() < 0.2);
      if ((arrived && still) || this.parkT > PARK_TIMEOUT) {
        for (const i of unheld) {
          this.freeze(i);
          this.dice[i].state = 'parked';
        }
        this.setCupCollision(false, false);
        this.phase = 'idle';
      }
      return;
    }

    // Un dado que ha rebotado fuera vuelve a intentarlo.
    for (const i of unheld) {
      const die = this.dice[i];
      if (die.hop || die.state !== 'free') continue;
      const local = this.phys.cup.pointToLocalFrame(this.phys.dice[i].position);
      if (Math.hypot(local.x, local.z) > CUP_INNER_R && local.y < CUP_RIM_TOP + 0.5) {
        this.stats.rehops++;
        this.freeze(i);
        this.startHop(i, 0);
      }
    }

    // Mientras entran, el cubilete sigue al puntero, pero sin ponerse sobre el fieltro.
    const cup = this.phys.cup.position;
    const manual = this.rollAfterGather && this.manual;
    this.cupTargetPos.set(
      Math.max(manual ? this.dragX : cup.x, CUP_LANE_X),
      CUP_ASIDE.y,
      manual ? this.dragZ : cup.z,
    );
  }

  private startShake(): void {
    this.phase = 'shake';
    this.phaseT = 0;
    this.setCupCollision(true, true);
    this.shakeFromX = this.phys.cup.position.x;
    this.shakeFromZ = this.phys.cup.position.z;
    this.phys.dice.forEach((body, i) => {
      const die = this.dice[i];
      if (die.held) return;
      this.releaseIntoCup(i);
      body.angularVelocity.set(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
      );
    });
  }

  private startPour(): void {
    this.phase = 'pour';
    this.phaseT = 0;
    this.pourFromPos.copy(this.phys.cup.position);
    this.pourFromQ.copy(this.phys.cup.quaternion);
    this.pourZ = Math.min(CUP_POUR.maxZ, Math.max(CUP_POUR.minZ, this.phys.cup.position.z));
    // Soltado lejos del lateral, el cubilete necesita más tiempo para llegar.
    const distance = Math.abs(CUP_POUR.x + 1.4 - this.pourFromPos.x);
    this.windupTime = Math.max(WINDUP_TIME, distance / WINDUP_SPEED);
  }

  private startSettle(): void {
    this.phase = 'settle';
    this.phaseT = 0;
    this.settleT = 0;
    // Sigue siendo sólido mientras haya dados cerca y se retira sin enderezarse aún.
    this.setCupCollision(true, false);
    this.cupTargetPos.set(CUP_POUR.x + 3.2, CUP_POUR.y, this.pourZ);
    for (const die of this.dice) {
      die.nudges = 0;
      die.stillT = 0;
    }
  }

  private updatePhase(): void {
    switch (this.phase) {
      case 'gather':
        this.updateGather();
        break;

      case 'shake': {
        const t = this.phaseT;
        const lift = smooth(t / 0.2) * 1.0;
        const auto = !this.manual;
        const toReady = smooth(t / 0.3);
        const baseX = auto ? this.shakeFromX + (CUP_READY.x - this.shakeFromX) * toReady : this.dragX;
        const baseZ = auto ? this.shakeFromZ + (CUP_READY.z - this.shakeFromZ) * toReady : this.dragZ;
        const a = smooth(t / 0.15);
        this.cupTargetPos.set(
          baseX + a * 0.55 * Math.sin(t * 32),
          CUP_READY.y + lift + a * 0.3 * (0.5 + 0.5 * Math.sin(t * 43)),
          baseZ + a * 0.55 * Math.cos(t * 27),
        );
        this.cupTargetQ.setFromEuler(a * 0.1 * Math.sin(t * 24), 0, a * 0.1 * Math.cos(t * 29));
        const shakeDone = auto ? t >= AUTO_SHAKE_TIME : this.released && t >= MIN_SHAKE_TIME;
        if (shakeDone) this.startPour();
        break;
      }

      case 'pour': {
        const t = this.phaseT;
        const windupX = CUP_POUR.x + 1.4;
        const windupY = CUP_POUR.y - 0.6;
        if (t < this.windupTime) {
          // Toma impulso hacia la derecha, aún con la tapa puesta.
          const k = smooth(t / this.windupTime);
          this.cupTargetPos.set(
            this.pourFromPos.x + (windupX - this.pourFromPos.x) * k,
            this.pourFromPos.y + (windupY - this.pourFromPos.y) * k,
            this.pourFromPos.z + (this.pourZ - this.pourFromPos.z) * k,
          );
          this.pourFromQ.slerp(new CANNON.Quaternion(), k, this.cupTargetQ);
          break;
        }
        // Lanzamiento: se inclina hacia la izquierda con un giro suave, para que el
        // borde no vaya tan rápido como para atravesar un dado.
        this.setCupCollision(true, false);
        const since = t - this.windupTime;
        const u = Math.min(1, since / THROW_TIME);
        const k = smooth(u);
        this.cupTargetPos.set(windupX + (CUP_POUR.x - windupX) * k, windupY + (CUP_POUR.y - windupY) * k, this.pourZ);
        // Si un dado se resiste, el cubilete se inclina más y lo sacude.
        const held = Math.max(0, since - THROW_TIME);
        const wobble = held > 0 ? 0.05 * Math.sin(held * 26) : 0;
        const steeper = Math.min(STUCK_EXTRA_TILT, Math.max(0, held - 0.35) * 0.6);
        this.cupTargetQ.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), CUP_POUR_ANGLE * k + wobble + steeper);
        if (held > STUCK_EJECT_AFTER) this.ejectStuckDice();
        this.flingExitingDice();
        this.updateInTray();
        // No se retira con un dado dentro: lo arrastraría a través de la pared.
        if (held > 0 && this.allOutOfCup()) this.startSettle();
        else if (held >= MAX_POUR_HOLD) {
          this.stats.stuck++;
          this.startSettle();
          this.setCupCollision(false, false);
        }
        break;
      }

      case 'settle':
        this.settleT += DT;
        if (this.settleT >= RETREAT_TIME) {
          this.cupTargetPos.set(CUP_ASIDE.x, CUP_ASIDE.y, CUP_ASIDE.z);
          this.cupTargetQ.set(0, 0, 0, 1);
        }
        this.updateInTray();
        this.recoverEscaped();
        if (this.settleT > 0.25 && this.allAtRest()) this.finishSettle();
        break;

      case 'idle':
        break;
    }
  }

  /**
   * Al salir, cada dado recibe un giro aleatorio en los tres ejes y va hacia el
   * fieltro. Sin esto, el giro del cubilete (en un solo eje) favorece algunas caras.
   */
  private flingExitingDice(): void {
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.held || die.flung || this.isInCup(b)) return;
      die.flung = true;
      b.velocity.x = Math.min(b.velocity.x, -5 - Math.random() * 9);
      b.velocity.z += (Math.random() - 0.5) * 7;
      b.angularVelocity.set(
        (Math.random() - 0.5) * 34,
        (Math.random() - 0.5) * 34,
        (Math.random() - 0.5) * 34,
      );
    });
  }

  /** Empuja hacia la boca a los dados que siguen dentro, con su propio impulso físico. */
  private ejectStuckDice(): void {
    const axis = this.phys.cup.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    this.phys.dice.forEach((b, i) => {
      if (this.dice[i].held || !this.isInCup(b)) return;
      if (b.velocity.dot(axis) >= 6) return;
      b.velocity.set(axis.x * 12, axis.y * 12, axis.z * 12);
      b.wakeUp();
    });
  }

  private updateInTray(): void {
    const m = 0.75;
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.state !== 'free' || die.inTray) return;
      if (
        b.position.x > FELT.minX + m &&
        b.position.x < FELT.maxX - m &&
        b.position.z > FELT.minZ + m &&
        b.position.z < FELT.maxZ - m &&
        !this.isInCup(b)
      ) {
        die.inTray = true;
        b.collisionFilterMask = MASK_DIE_TRAY;
      }
    });
  }

  private isInCup(b: CANNON.Body): boolean {
    const local = this.phys.cup.pointToLocalFrame(b.position);
    return Math.hypot(local.x, local.z) < CUP_OUTER_R && local.y > -0.2 && local.y < CUP_RIM_TOP + 0.2;
  }

  private allOutOfCup(): boolean {
    return this.phys.dice.every((b, i) => this.dice[i].held || !this.isInCup(b));
  }

  /** Vuelve a lanzar los dados que se han escapado, en vez de darlos por buenos. */
  private recoverEscaped(): void {
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.state !== 'free') return;
      const p = b.position;
      const out =
        p.y < -1 ||
        (!die.inTray &&
          this.settleT > 0.8 &&
          (p.x < FELT.minX || p.x > FELT.maxX || p.z < FELT.minZ || p.z > FELT.maxZ));
      if (!out) return;
      this.stats.recovered++;
      this.dropIntoTray(i);
    });
  }

  private dropIntoTray(i: number): void {
    const body = this.phys.dice[i];
    const die = this.dice[i];
    const spot = this.freeSpot(i);
    body.position.set(spot.x, 3, spot.z);
    body.quaternion.copy(randomQuat());
    body.velocity.set((Math.random() - 0.5) * 4, -3, (Math.random() - 0.5) * 4);
    body.angularVelocity.set(
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20,
    );
    die.inTray = true;
    body.collisionFilterMask = MASK_DIE_TRAY;
    body.wakeUp();
  }

  private allAtRest(): boolean {
    let rest = true;
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.state !== 'free') return;
      const { dot } = readFace(b.quaternion);
      const onFloor = b.position.y < 0.56;
      const flat = dot >= FLAT_DOT && onFloor && die.inTray;
      // Un dado plano que solo vibra no va a cambiar de cara: no hay que hacer esperar al jugador.
      const tolerate = flat && this.settleT > SETTLE_NUDGE_TIME;
      const moving =
        b.sleepState !== CANNON.Body.SLEEPING &&
        (b.velocity.length() > (tolerate ? JITTER_SPEED : 0.08) ||
          b.angularVelocity.length() > (tolerate ? JITTER_SPEED : 0.12));
      if (moving) {
        die.stillT = 0;
        rest = false;
        return;
      }
      die.stillT += DT;
      if (flat) {
        if (die.stillT < REST_STILL) rest = false;
      } else {
        rest = false;
        // Al balancearse un dado se para un instante: solo se considera montado
        // sobre otro o apoyado en la pared si sigue quieto un rato.
        if (die.stillT > STILL_BEFORE_NUDGE) {
          die.stillT = 0;
          this.nudge(i);
        }
      }
    });
    if (!rest && this.settleT > SETTLE_NUDGE_TIME) {
      // Un dado que vibra apoyado en otro nunca llega a "quieto": se le empuja cada segundo.
      this.jitterT += DT;
      if (this.jitterT >= 1) {
        this.jitterT = 0;
        this.phys.dice.forEach((b, i) => {
          const die = this.dice[i];
          if (die.state !== 'free' || b.sleepState === CANNON.Body.SLEEPING) return;
          if (b.velocity.length() < 3 && (readFace(b.quaternion).dot < FLAT_DOT || b.position.y >= 0.56)) this.nudge(i);
        });
      }
    }
    if (!rest && this.settleT > SETTLE_FORCE_TIME) this.forceFlat();
    return rest;
  }

  private nudge(i: number): void {
    const body = this.phys.dice[i];
    const die = this.dice[i];
    die.nudges++;
    this.stats.nudged++;
    if (!die.inTray || die.nudges > 4) {
      this.dropIntoTray(i);
      die.nudges = 0;
      return;
    }
    const cx = (FELT.minX + FELT.maxX) / 2 - body.position.x;
    const cz = (FELT.minZ + FELT.maxZ) / 2 - body.position.z;
    body.velocity.set(cx * 0.6, 9, cz * 0.6);
    body.angularVelocity.set(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
    );
    body.wakeUp();
  }

  /** Último recurso tras un tiempo excesivo: asienta cada dado en su cara más alta. */
  private forceFlat(): void {
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.state !== 'free') return;
      const { value, dot } = readFace(b.quaternion);
      if (dot >= FLAT_DOT && b.position.y < 0.56 && die.inTray) return;
      this.stats.forced++;
      const spot = this.freeSpot(i);
      this.toResting(i, spot, quatForValue(value, Math.random() * Math.PI));
    });
  }

  private finishSettle(): void {
    this.phys.dice.forEach((b, i) => {
      const die = this.dice[i];
      if (die.held) return;
      die.value = readFace(b.quaternion).value;
      // Ya leído, nada debe poder moverlo y cambiar lo que se ve.
      b.velocity.setZero();
      b.angularVelocity.setZero();
      b.sleep();
    });
    this.setCupCollision(false, false);
    this.phase = 'idle';
    this.onSettled?.(this.dice.map((d) => d.value));
  }

  private driveCup(): void {
    const { cup, lid } = this.phys;
    const dx = this.cupTargetPos.x - cup.position.x;
    const dy = this.cupTargetPos.y - cup.position.y;
    const dz = this.cupTargetPos.z - cup.position.z;
    const follow = this.phase === 'gather' || this.phase === 'settle' || this.phase === 'idle' ? 0.14 : 1;
    let vx = (dx * follow) / DT;
    let vy = (dy * follow) / DT;
    let vz = (dz * follow) / DT;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > MAX_CUP_SPEED) {
      const s = MAX_CUP_SPEED / speed;
      vx *= s;
      vy *= s;
      vz *= s;
    }
    cup.velocity.set(vx, vy, vz);

    // Velocidad angular a partir de la diferencia de cuaterniones.
    const inv = cup.quaternion.inverse();
    const q = this.cupTargetQ.mult(inv);
    if (q.w < 0) {
      q.x *= -1;
      q.y *= -1;
      q.z *= -1;
      q.w *= -1;
    }
    const k = (2 * follow) / DT;
    let wx = q.x * k;
    let wy = q.y * k;
    let wz = q.z * k;
    const spin = Math.hypot(wx, wy, wz);
    if (spin > 14) {
      const s = 14 / spin;
      wx *= s;
      wy *= s;
      wz *= s;
    }
    cup.angularVelocity.set(wx, wy, wz);

    // La tapa acompaña al cubilete, justo por encima del borde.
    const offset = cup.quaternion.vmult(new CANNON.Vec3(0, CUP_RIM_TOP + 0.5, 0));
    lid.position.set(cup.position.x + offset.x, cup.position.y + offset.y, cup.position.z + offset.z);
    lid.quaternion.copy(cup.quaternion);
    lid.velocity.copy(cup.velocity);
    lid.angularVelocity.copy(cup.angularVelocity);
  }

  private clampDice(): void {
    for (const b of this.phys.dice) {
      if (b.type !== CANNON.Body.DYNAMIC) continue;
      const v = b.velocity.length();
      if (v > MAX_DIE_SPEED) b.velocity.scale(MAX_DIE_SPEED / v, b.velocity);
      const w = b.angularVelocity.length();
      if (w > MAX_DIE_SPIN) b.angularVelocity.scale(MAX_DIE_SPIN / w, b.angularVelocity);
    }
  }

  private updateTweens(): void {
    this.phys.dice.forEach((body, i) => {
      const die = this.dice[i];
      const tw = die.tween;
      if (!tw) return;
      tw.t += DT;
      const k = smooth(tw.t / tw.dur);
      tw.from.lerp(tw.to, k, body.position);
      body.position.y += Math.sin(k * Math.PI) * tw.arc;
      tw.fromQ.slerp(tw.toQ, k, body.quaternion);
      if (tw.t >= tw.dur) {
        body.position.copy(tw.to);
        body.quaternion.copy(tw.toQ);
        die.tween = null;
        tw.done();
      }
    });
  }

  private startTween(
    i: number,
    to: CANNON.Vec3,
    toQ: CANNON.Quaternion,
    dur: number,
    arc: number,
    done: () => void,
  ): void {
    const body = this.phys.dice[i];
    this.dice[i].state = 'tween';
    this.dice[i].tween = {
      from: body.position.clone(),
      fromQ: body.quaternion.clone(),
      to: to.clone(),
      toQ: toQ.clone(),
      t: 0,
      dur,
      arc,
      done,
    };
  }

  /** Deja el dado fuera de la simulación: lo mueve el código, no la física. */
  private freeze(i: number): void {
    const body = this.phys.dice[i];
    body.type = CANNON.Body.KINEMATIC;
    body.collisionFilterGroup = 0;
    body.collisionFilterMask = 0;
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.wakeUp();
  }

  /** Deja un dado quieto sobre el fieltro y vuelve a participar en colisiones. */
  private toResting(i: number, spot: CANNON.Vec3, q: CANNON.Quaternion): void {
    const body = this.phys.dice[i];
    const die = this.dice[i];
    die.state = 'free';
    die.inTray = true;
    die.tween = null;
    body.type = CANNON.Body.DYNAMIC;
    body.collisionFilterGroup = GROUP.DIE;
    body.collisionFilterMask = MASK_DIE_TRAY;
    body.position.set(spot.x, 0.5, spot.z);
    body.quaternion.copy(q);
    body.velocity.setZero();
    body.angularVelocity.setZero();
    body.sleep();
  }

  private setCupCollision(cup: boolean, lid: boolean): void {
    this.phys.cup.collisionFilterMask = cup ? GROUP.DIE : 0;
    this.phys.lid.collisionFilterMask = lid ? GROUP.DIE : 0;
  }

  private cupSpotWorld(i: number): CANNON.Vec3 {
    const [angle, layer] = CUP_SPOTS[i];
    const y = CUP_READY.y + CUP_FLOOR + 0.5 + layer * 1.45;
    const r = layer === 0 ? 1.25 : 0;
    return new CANNON.Vec3(CUP_READY.x + Math.cos(angle) * r, y, CUP_READY.z + Math.sin(angle) * r);
  }

  private firstFreeSlot(): number {
    const used = new Set(this.dice.map((d) => d.slot));
    for (let s = 0; s < 5; s++) if (!used.has(s)) return s;
    return 0;
  }

  private scatterSpots(): CANNON.Vec3[] {
    return [
      new CANNON.Vec3(-2.6, 0.5, -0.6),
      new CANNON.Vec3(-0.5, 0.5, 1.6),
      new CANNON.Vec3(1.5, 0.5, -0.9),
      new CANNON.Vec3(-2.7, 0.5, 2.5),
      new CANNON.Vec3(2.2, 0.5, 2.3),
    ];
  }

  private freeSpot(self: number): CANNON.Vec3 {
    const others = this.phys.dice.filter((_, i) => i !== self && !this.dice[i].held && this.dice[i].state !== 'parked');
    for (let tries = 0; tries < 80; tries++) {
      const x = FELT.minX + 0.9 + Math.random() * (FELT.maxX - FELT.minX - 1.8);
      const z = FELT.minZ + 0.9 + Math.random() * (FELT.maxZ - FELT.minZ - 1.8);
      const clear = others.every((b) => Math.hypot(b.position.x - x, b.position.z - z) > 1.6);
      if (clear) return new CANNON.Vec3(x, 0.5, z);
    }
    return new CANNON.Vec3(0, 0.5, 0.8);
  }

  private quatDistance(a: CANNON.Quaternion, b: CANNON.Quaternion): number {
    return 1 - Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  }
}
