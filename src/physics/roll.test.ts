import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { CUP_ASIDE, CUP_HEIGHT, CUP_INNER_R, CUP_LANE_X, CUP_OUTER_R, FELT } from './constants';
import { DiceTable, quatForValue, readFace } from './roll';

declare const process: { env: Record<string, string | undefined> };

const ROLLS = Number(process.env.SIM_ROLLS ?? 40);

function rollUntilSettled(table: DiceTable, maxSeconds = 30): number[] | null {
  let result: number[] | null = null;
  table.onSettled = (v) => {
    result = v;
  };
  table.beginRoll(false);
  for (let t = 0; t < maxSeconds && !result; t += 1 / 30) table.step(1 / 30);
  return result;
}

const FIXED = 1 / 120;

/** Avanza paso a paso hasta que la mesa llega a `phase` o se agota el tiempo. */
function runUntil(table: DiceTable, done: () => boolean, onStep?: () => void, maxSeconds = 20): void {
  for (let t = 0; t < maxSeconds && !done(); t += FIXED) {
    table.step(FIXED);
    onStep?.();
  }
}

describe('movimiento del cubilete', () => {
  it('ningún dado cruza la pared al volver al cubilete', () => {
    for (let n = 0; n < 12; n++) {
      const table = new DiceTable();
      rollUntilSettled(table);
      table.beginRoll(false);
      runUntil(
        table,
        () => table.phase !== 'gather',
        () => {
          for (const b of table.phys.dice) {
            const l = table.phys.cup.pointToLocalFrame(b.position);
            const r = Math.hypot(l.x, l.z);
            const insideWall = l.y > 0 && l.y < CUP_HEIGHT && r > CUP_INNER_R && r < CUP_OUTER_R;
            expect(insideWall, `dado dentro de la pared: r=${r} y=${l.y}`).toBe(false);
          }
        },
      );
      expect(table.phase).toBe('shake');
    }
  });

  it('sigue al puntero desde el principio de la segunda tirada, sin pisar el fieltro hasta tener los dados', () => {
    const table = new DiceTable();
    rollUntilSettled(table);
    table.beginRoll(true);
    const startX = table.phys.cup.position.x;
    table.dragTo(CUP_LANE_X + 0.5, -2);
    for (let i = 0; i < 12; i++) table.step(FIXED);
    expect(table.phys.cup.position.z).toBeLessThan(CUP_ASIDE.z - 0.5);

    table.dragTo(-3, 0);
    runUntil(
      table,
      () => table.phase !== 'gather',
      () => expect(table.phys.cup.position.x).toBeGreaterThan(CUP_LANE_X - 0.01),
    );
    expect(table.phase).toBe('shake');
    expect(startX).toBeGreaterThan(CUP_LANE_X - 0.01);

    runUntil(table, () => table.phys.cup.position.x < -2, undefined, 3);
    expect(table.phys.cup.position.x).toBeLessThan(-2);
    table.release();
    runUntil(table, () => table.phase === 'idle');
    expect(table.phase).toBe('idle');
  });

  it('no salta al agarrarlo: el objetivo inicial es su posición actual', () => {
    const table = new DiceTable();
    rollUntilSettled(table);
    const before = table.phys.cup.position.clone();
    table.beginRoll(true);
    table.step(FIXED * 5);
    expect(table.phys.cup.position.distanceTo(before)).toBeLessThan(0.05);
  });

  it('al volcar, el cubilete deja libre casi todo el fieltro', () => {
    const table = new DiceTable();
    let minX = Infinity;
    table.beginRoll(false);
    runUntil(table, () => table.phase === 'pour');
    runUntil(
      table,
      () => table.phase !== 'pour',
      () => {
        // Cuenta desde que se inclina: antes está en su sitio, con los dados dentro.
        const axis = table.phys.cup.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
        if (axis.y > 0.85) return;
        for (let a = 0; a < 12; a++) {
          const angle = (a / 12) * Math.PI * 2;
          for (const y of [0, CUP_HEIGHT]) {
            const local = new CANNON.Vec3(Math.cos(angle) * CUP_OUTER_R, y, Math.sin(angle) * CUP_OUTER_R);
            minX = Math.min(minX, table.phys.cup.pointToWorldFrame(local).x);
          }
        }
      },
    );
    expect(minX).toBeGreaterThan(2.4);
  });

  it('el lanzamiento reparte los dados por el fieltro', () => {
    const table = new DiceTable();
    let total = 0;
    let leftHalf = 0;
    for (let n = 0; n < 30; n++) {
      rollUntilSettled(table);
      for (const b of table.phys.dice) {
        total++;
        if (b.position.x < 0) leftHalf++;
      }
    }
    console.log(`mitad izquierda: ${leftHalf}/${total}`);
    expect(leftHalf / total).toBeGreaterThan(0.25);
    expect(leftHalf / total).toBeLessThan(0.8);
  });
});

describe('dados', () => {
  it('lee correctamente cada cara colocada hacia arriba', () => {
    for (let v = 1; v <= 6; v++) {
      const { value, dot } = readFace(quatForValue(v, 1.1));
      expect(value).toBe(v);
      expect(dot).toBeCloseTo(1, 5);
    }
  });
});

describe(`simulación de ${ROLLS} tiradas`, () => {
  it(
    'siempre termina en reposo, sobre el fieltro, con caras equilibradas',
    () => {
      const table = new DiceTable();
      const faces = [0, 0, 0, 0, 0, 0, 0];
      let simulated = 0;

      for (let n = 0; n < ROLLS; n++) {
        const values = rollUntilSettled(table);
        expect(values, `la tirada ${n} no terminó`).not.toBeNull();
        simulated++;
        for (const v of values!) faces[v]++;

        for (const b of table.phys.dice) {
          expect(b.position.x).toBeGreaterThan(FELT.minX);
          expect(b.position.x).toBeLessThan(FELT.maxX);
          expect(b.position.z).toBeGreaterThan(FELT.minZ);
          expect(b.position.z).toBeLessThan(FELT.maxZ);
          expect(b.position.y).toBeLessThan(0.56);
          expect(readFace(b.quaternion).dot).toBeGreaterThan(0.98);
        }
      }

      const total = simulated * 5;
      const expected = total / 6;
      const chi2 = faces.slice(1).reduce((acc, f) => acc + (f - expected) ** 2 / expected, 0);
      console.log(
        `caras=${faces.slice(1).join(',')} chi2=${chi2.toFixed(2)} ` +
          `recuperados=${table.stats.recovered} empujones=${table.stats.nudged} forzados=${table.stats.forced} reintentos=${table.stats.rehops}`,
      );
      // Con 5 grados de libertad, 20.5 corresponde a p≈0.001.
      if (ROLLS >= 400) expect(chi2).toBeLessThan(20.5);
    },
    Math.max(60_000, ROLLS * 2000),
  );

  it('los dados guardados no se mueven ni cambian de valor al tirar', () => {
    const table = new DiceTable();
    const first = rollUntilSettled(table)!;
    table.setHeld(2, true);
    for (let i = 0; i < 40; i++) table.step(1 / 60);
    const before = table.phys.dice[2].position.clone();
    const second = rollUntilSettled(table)!;
    expect(second[2]).toBe(first[2]);
    expect(table.phys.dice[2].position.distanceTo(before)).toBeLessThan(1e-6);
  });

  it('un dado que se suelta vuelve al fieltro y puede tirarse otra vez', () => {
    const table = new DiceTable();
    rollUntilSettled(table);
    table.setHeld(0, true);
    for (let i = 0; i < 40; i++) table.step(1 / 60);
    table.setHeld(0, false);
    for (let i = 0; i < 40; i++) table.step(1 / 60);
    expect(table.dice[0].state).toBe('free');
    expect(rollUntilSettled(table)).not.toBeNull();
  });
});
