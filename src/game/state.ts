import { CATEGORIES, TOTAL_TURNS, filledCount, scoreFor, type Card, type Category } from './rules';

export type Seat = 0 | 1;
export const MAX_ROLLS = 3;

export interface Player {
  name: string;
  avatar: string;
}

export interface GameState {
  phase: 'lobby' | 'playing' | 'finished';
  players: [Player, Player | null];
  cards: [Card, Card];
  current: Seat;
  starter: Seat;
  /** Valor de cada dado; 0 mientras todavía no se ha tirado este turno. */
  dice: number[];
  held: boolean[];
  rollsUsed: number;
  rolling: boolean;
  /** Número de partida, para distinguir revanchas. */
  game: number;
}

export type Action =
  | { type: 'join'; player: Player }
  | { type: 'rollStart' }
  | { type: 'rollEnd'; values: number[] }
  | { type: 'rollAbort' }
  | { type: 'hold'; index: number }
  | { type: 'score'; category: Category }
  | { type: 'rematch' };

export function createGame(host: Player): GameState {
  return {
    phase: 'lobby',
    players: [host, null],
    cards: [{}, {}],
    current: 0,
    starter: 0,
    dice: [0, 0, 0, 0, 0],
    held: [false, false, false, false, false],
    rollsUsed: 0,
    rolling: false,
    game: 1,
  };
}

const isDie = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 6;

export function canRoll(s: GameState): boolean {
  return s.phase === 'playing' && !s.rolling && s.rollsUsed < MAX_ROLLS && !s.held.every(Boolean);
}

export function canScore(s: GameState): boolean {
  return s.phase === 'playing' && !s.rolling && s.rollsUsed > 0;
}

export function canHold(s: GameState): boolean {
  return s.phase === 'playing' && !s.rolling && s.rollsUsed > 0 && s.rollsUsed < MAX_ROLLS;
}

export function currentTurn(s: GameState): number {
  return Math.min(filledCount(s.cards[s.current]) + 1, TOTAL_TURNS);
}

/**
 * Aplica una acción de un jugador. Devuelve el estado nuevo, o null si la
 * acción no es válida. `by` lo fija el anfitrión según la conexión de origen.
 */
export function reduce(s: GameState, by: Seat, a: Action): GameState | null {
  switch (a.type) {
    case 'join':
      if (s.phase !== 'lobby' || by !== 1) return null;
      return { ...s, phase: 'playing', players: [s.players[0], a.player] };

    case 'rematch':
      if (s.phase !== 'finished') return null;
      {
        const starter: Seat = s.starter === 0 ? 1 : 0;
        return {
          ...s,
          phase: 'playing',
          cards: [{}, {}],
          current: starter,
          starter,
          dice: [0, 0, 0, 0, 0],
          held: [false, false, false, false, false],
          rollsUsed: 0,
          rolling: false,
          game: s.game + 1,
        };
      }
  }

  if (by !== s.current) return null;

  switch (a.type) {
    case 'rollStart':
      if (!canRoll(s)) return null;
      return { ...s, rolling: true, rollsUsed: s.rollsUsed + 1 };

    case 'rollEnd':
      if (s.phase !== 'playing' || !s.rolling) return null;
      if (!Array.isArray(a.values) || a.values.length !== 5 || !a.values.every(isDie)) return null;
      // Los dados guardados no pueden cambiar de valor.
      if (s.held.some((h, i) => h && a.values[i] !== s.dice[i])) return null;
      return { ...s, rolling: false, dice: [...a.values] };

    case 'rollAbort':
      if (s.phase !== 'playing' || !s.rolling) return null;
      return { ...s, rolling: false, rollsUsed: s.rollsUsed - 1 };

    case 'hold': {
      if (!canHold(s) || !Number.isInteger(a.index) || a.index < 0 || a.index > 4) return null;
      const held = [...s.held];
      held[a.index] = !held[a.index];
      return { ...s, held };
    }

    case 'score': {
      if (!canScore(s) || !CATEGORIES.includes(a.category)) return null;
      const card = s.cards[by];
      if (card[a.category] !== undefined) return null;

      const updated: Card = { ...card, [a.category]: scoreFor(a.category, s.dice) };
      const cards: [Card, Card] = by === 0 ? [updated, s.cards[1]] : [s.cards[0], updated];
      const finished = cards.every((c) => filledCount(c) === TOTAL_TURNS);
      return {
        ...s,
        phase: finished ? 'finished' : 'playing',
        cards,
        current: finished ? s.current : by === 0 ? 1 : 0,
        dice: finished ? s.dice : [0, 0, 0, 0, 0],
        held: finished ? s.held : [false, false, false, false, false],
        rollsUsed: finished ? s.rollsUsed : 0,
      };
    }
  }
  return null;
}
