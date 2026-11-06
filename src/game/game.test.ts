import { describe, expect, it } from 'vitest';
import { CATEGORIES, bonusFor, scoreFor, totalFor, upperSubtotal, type Card, type Category } from './rules';
import { createGame, reduce, type GameState, type Seat } from './state';

describe('puntuación', () => {
  it.each<[Category, number[], number]>([
    ['unos', [1, 1, 2, 3, 4], 2],
    ['doses', [1, 1, 3, 3, 4], 0],
    ['treses', [3, 3, 3, 2, 1], 9],
    ['seises', [6, 6, 6, 6, 6], 30],
    ['libre', [1, 2, 3, 4, 6], 16],
    ['poker', [5, 5, 5, 5, 2], 22],
    ['poker', [5, 5, 5, 2, 2], 0],
    ['poker', [4, 4, 4, 4, 4], 20],
    ['full', [6, 6, 6, 3, 3], 24],
    ['full', [6, 6, 6, 6, 3], 0],
    ['full', [2, 2, 2, 2, 2], 0],
    ['escCorta', [1, 2, 3, 4, 6], 15],
    ['escCorta', [3, 4, 5, 6, 3], 15],
    ['escCorta', [1, 2, 3, 5, 6], 0],
    ['escCorta', [1, 2, 3, 4, 5], 15],
    ['escLarga', [2, 3, 4, 5, 6], 30],
    ['escLarga', [5, 4, 3, 2, 1], 30],
    ['escLarga', [1, 2, 3, 4, 6], 0],
    ['generala', [3, 3, 3, 3, 3], 50],
    ['generala', [3, 3, 3, 3, 4], 0],
  ])('%s con %j vale %i', (category, dice, expected) => {
    expect(scoreFor(category, dice)).toBe(expected);
  });

  it('da el bonus con 63 pero no con 62', () => {
    const card62: Card = { unos: 2, doses: 6, treses: 9, cuatros: 12, cincos: 15, seises: 18 };
    expect(upperSubtotal(card62)).toBe(62);
    expect(bonusFor(card62)).toBe(0);
    const card63: Card = { ...card62, unos: 3 };
    expect(bonusFor(card63)).toBe(35);
    expect(totalFor(card63)).toBe(98);
  });

  it('reproduce el total de la imagen de referencia', () => {
    expect(totalFor({ doses: 6, treses: 9, full: 27, escCorta: 15, generala: 50 })).toBe(107);
    expect(totalFor({ unos: 1, treses: 12, full: 21, escCorta: 15, generala: 50 })).toBe(99);
  });
});

function started(): GameState {
  const s = createGame({ name: 'A', avatar: 'a' });
  return reduce(s, 1, { type: 'join', player: { name: 'B', avatar: 'b' } })!;
}

let nextId = 1;
const NONE = [false, false, false, false, false];

function roll(s: GameState, by: Seat, values: number[]): GameState {
  const id = nextId++;
  const a = reduce(s, by, { type: 'rollStart', id, held: s.held })!;
  return reduce(a, by, { type: 'rollEnd', id, values })!;
}

describe('partida', () => {
  it('rechaza acciones del jugador que no tiene el turno', () => {
    const s = started();
    expect(reduce(s, 1, { type: 'rollStart', id: nextId++, held: NONE })).toBeNull();
  });

  it('no permite una cuarta tirada', () => {
    let s = started();
    for (let i = 0; i < 3; i++) s = roll(s, 0, [1, 2, 3, 4, 5]);
    expect(s.rollsUsed).toBe(3);
    expect(reduce(s, 0, { type: 'rollStart', id: nextId++, held: NONE })).toBeNull();
  });

  it('no permite anotar antes de tirar ni durante la tirada', () => {
    const s = started();
    expect(reduce(s, 0, { type: 'score', category: 'libre' })).toBeNull();
    const rolling = reduce(s, 0, { type: 'rollStart', id: nextId++, held: NONE })!;
    expect(reduce(rolling, 0, { type: 'score', category: 'libre' })).toBeNull();
  });

  it('no permite repetir casilla, tampoco una segunda generala', () => {
    let s = roll(started(), 0, [2, 2, 2, 2, 2]);
    s = reduce(s, 0, { type: 'score', category: 'generala' })!;
    expect(s.cards[0].generala).toBe(50);
    s = roll(s, 1, [1, 2, 3, 4, 6]);
    s = reduce(s, 1, { type: 'score', category: 'libre' })!;
    s = roll(s, 0, [2, 2, 2, 2, 2]);
    expect(reduce(s, 0, { type: 'score', category: 'generala' })).toBeNull();
  });

  it('impide cambiar un dado guardado y rechaza valores no válidos', () => {
    const s = roll(started(), 0, [6, 1, 1, 1, 1]);
    const id = nextId++;
    const rolling = reduce(s, 0, { type: 'rollStart', id, held: [true, false, false, false, false] })!;
    expect(reduce(rolling, 0, { type: 'rollEnd', id, values: [5, 1, 1, 1, 1] })).toBeNull();
    expect(reduce(rolling, 0, { type: 'rollEnd', id, values: [6, 1, 1, 1, 7] })).toBeNull();
    expect(reduce(rolling, 0, { type: 'rollEnd', id, values: [6, 1, 1, 1] })).toBeNull();
  });

  it('no deja tirar con los cinco dados guardados ni guardar antes de la primera tirada', () => {
    const allHeld = [true, true, true, true, true];
    const s = roll(started(), 0, [1, 2, 3, 4, 5]);
    expect(reduce(s, 0, { type: 'rollStart', id: nextId++, held: allHeld })).toBeNull();
    expect(
      reduce(started(), 0, { type: 'rollStart', id: nextId++, held: [true, false, false, false, false] }),
    ).toBeNull();
    expect(reduce(s, 0, { type: 'rollStart', id: nextId++, held: [true] })).toBeNull();
  });

  it('recupera la tirada si se interrumpe', () => {
    const id = nextId++;
    const s = reduce(started(), 0, { type: 'rollStart', id, held: NONE })!;
    expect(reduce(s, 0, { type: 'rollAbort', id: id + 999 })).toBeNull();
    const aborted = reduce(s, 0, { type: 'rollAbort', id })!;
    expect(aborted.rolling).toBe(false);
    expect(aborted.rollsUsed).toBe(0);
  });

  it('guardar y tirar sin esperar a la red: el resultado se acepta', () => {
    // La confirmación del guardado aún no ha llegado, pero la tirada ya lleva los guardados.
    const s = roll(started(), 0, [5, 3, 1, 2, 6]);
    const id = nextId++;
    const rolling = reduce(s, 0, { type: 'rollStart', id, held: [true, false, false, false, false] })!;
    expect(rolling.held[0]).toBe(true);
    const done = reduce(rolling, 0, { type: 'rollEnd', id, values: [5, 4, 4, 4, 4] })!;
    expect(done.dice).toEqual([5, 4, 4, 4, 4]);
    expect(done.rolling).toBe(false);
  });

  it('repetir una tirada no cuenta doble', () => {
    const s = started();
    const id = nextId++;
    const once = reduce(s, 0, { type: 'rollStart', id, held: NONE })!;
    expect(reduce(once, 0, { type: 'rollStart', id, held: NONE })).toBe(once);
    expect(once.rollsUsed).toBe(1);
    const done = reduce(once, 0, { type: 'rollEnd', id, values: [1, 2, 3, 4, 5] })!;
    expect(reduce(done, 0, { type: 'rollStart', id, held: NONE })).toBe(done);
    expect(reduce(done, 0, { type: 'rollEnd', id, values: [6, 6, 6, 6, 6] })).toBe(done);
    expect(done.rollsUsed).toBe(1);
  });

  it('un rollStart perdido se recupera al repetirlo junto al resultado', () => {
    const s = roll(started(), 0, [5, 3, 1, 2, 6]);
    const id = nextId++;
    // Solo llega el resultado: se rechaza y el estado no cambia.
    expect(reduce(s, 0, { type: 'rollEnd', id, values: [5, 5, 5, 5, 5] })).toBeNull();
    // El reintento manda las dos acciones y el estado queda igual que la pantalla.
    const started2 = reduce(s, 0, { type: 'rollStart', id, held: NONE })!;
    const done = reduce(started2, 0, { type: 'rollEnd', id, values: [5, 5, 5, 5, 5] })!;
    expect(done.dice).toEqual([5, 5, 5, 5, 5]);
    expect(done.rollsUsed).toBe(2);
  });

  it('guardar un dado es idempotente', () => {
    const s = roll(started(), 0, [1, 2, 3, 4, 5]);
    const once = reduce(s, 0, { type: 'hold', index: 2, held: true })!;
    expect(reduce(once, 0, { type: 'hold', index: 2, held: true })!.held[2]).toBe(true);
    expect(reduce(once, 0, { type: 'hold', index: 2, held: false })!.held[2]).toBe(false);
  });

  it('termina tras 12 turnos de cada jugador y admite revancha', () => {
    let s = started();
    for (const category of CATEGORIES) {
      for (const by of [0, 1] as const) {
        s = roll(s, by, [1, 2, 3, 4, 5]);
        s = reduce(s, by, { type: 'score', category })!;
      }
    }
    expect(s.phase).toBe('finished');
    const again = reduce(s, 1, { type: 'rematch' })!;
    expect(again.phase).toBe('playing');
    expect(again.current).toBe(1);
    expect(again.cards).toEqual([{}, {}]);
  });
});
