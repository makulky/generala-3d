export const UPPER = ['unos', 'doses', 'treses', 'cuatros', 'cincos', 'seises'] as const;
export const LOWER = ['libre', 'poker', 'full', 'escCorta', 'escLarga', 'generala'] as const;
export const CATEGORIES = [...UPPER, ...LOWER] as const;

export type Category = (typeof CATEGORIES)[number];
export type Card = Partial<Record<Category, number>>;

export const BONUS_TARGET = 63;
export const BONUS_POINTS = 35;
export const TOTAL_TURNS = CATEGORIES.length;

const sum = (dice: readonly number[]) => dice.reduce((a, b) => a + b, 0);

function counts(dice: readonly number[]): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) c[d]++;
  return c;
}

function longestRun(dice: readonly number[]): number {
  const c = counts(dice);
  let best = 0;
  let run = 0;
  for (let v = 1; v <= 6; v++) {
    run = c[v] > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Puntos que valdría una tirada de 5 dados en una casilla. */
export function scoreFor(category: Category, dice: readonly number[]): number {
  const upperIndex = (UPPER as readonly string[]).indexOf(category);
  if (upperIndex >= 0) {
    const face = upperIndex + 1;
    return dice.filter((d) => d === face).reduce((a, b) => a + b, 0);
  }

  const c = counts(dice);
  switch (category) {
    case 'libre':
      return sum(dice);
    case 'poker':
      return c.some((n) => n >= 4) ? sum(dice) : 0;
    case 'full':
      return c.includes(3) && c.includes(2) ? sum(dice) : 0;
    case 'escCorta':
      return longestRun(dice) >= 4 ? 15 : 0;
    case 'escLarga':
      return longestRun(dice) >= 5 ? 30 : 0;
    case 'generala':
      return c.includes(5) ? 50 : 0;
    default:
      return 0;
  }
}

export function upperSubtotal(card: Card): number {
  return UPPER.reduce((acc, c) => acc + (card[c] ?? 0), 0);
}

export function bonusFor(card: Card): number {
  return upperSubtotal(card) >= BONUS_TARGET ? BONUS_POINTS : 0;
}

export function totalFor(card: Card): number {
  return CATEGORIES.reduce((acc, c) => acc + (card[c] ?? 0), 0) + bonusFor(card);
}

export function filledCount(card: Card): number {
  return CATEGORIES.filter((c) => card[c] !== undefined).length;
}
