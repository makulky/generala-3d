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

function roll(s: GameState, by: Seat, values: number[]): GameState {
  const a = reduce(s, by, { type: 'rollStart' })!;
  return reduce(a, by, { type: 'rollEnd', values })!;
}

describe('partida', () => {
  it('rechaza acciones del jugador que no tiene el turno', () => {
    const s = started();
    expect(reduce(s, 1, { type: 'rollStart' })).toBeNull();
  });

  it('no permite una cuarta tirada', () => {
    let s = started();
    for (let i = 0; i < 3; i++) s = roll(s, 0, [1, 2, 3, 4, 5]);
    expect(s.rollsUsed).toBe(3);
    expect(reduce(s, 0, { type: 'rollStart' })).toBeNull();
  });

  it('no permite anotar antes de tirar ni durante la tirada', () => {
    const s = started();
    expect(reduce(s, 0, { type: 'score', category: 'libre' })).toBeNull();
    const rolling = reduce(s, 0, { type: 'rollStart' })!;
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
    let s = roll(started(), 0, [6, 1, 1, 1, 1]);
    s = reduce(s, 0, { type: 'hold', index: 0 })!;
    const rolling = reduce(s, 0, { type: 'rollStart' })!;
    expect(reduce(rolling, 0, { type: 'rollEnd', values: [5, 1, 1, 1, 1] })).toBeNull();
    expect(reduce(rolling, 0, { type: 'rollEnd', values: [6, 1, 1, 1, 7] })).toBeNull();
    expect(reduce(rolling, 0, { type: 'rollEnd', values: [6, 1, 1, 1] })).toBeNull();
  });

  it('no deja tirar con los cinco dados guardados', () => {
    let s = roll(started(), 0, [1, 2, 3, 4, 5]);
    for (let i = 0; i < 5; i++) s = reduce(s, 0, { type: 'hold', index: i })!;
    expect(reduce(s, 0, { type: 'rollStart' })).toBeNull();
  });

  it('recupera la tirada si se interrumpe', () => {
    const s = reduce(started(), 0, { type: 'rollStart' })!;
    const aborted = reduce(s, 0, { type: 'rollAbort' })!;
    expect(aborted.rolling).toBe(false);
    expect(aborted.rollsUsed).toBe(0);
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
