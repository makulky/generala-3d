import {
  BONUS_POINTS,
  BONUS_TARGET,
  TOTAL_TURNS,
  bonusFor,
  scoreFor,
  totalFor,
  upperSubtotal,
  type Category,
} from '../game/rules';
import { canScore, currentTurn, type GameState, type Seat } from '../game/state';
import { avatarHtml, dieIcon, glyphIcon } from './icons';

const UPPER_ROWS: [Category, string, number][] = [
  ['unos', 'Unos', 1],
  ['doses', 'Doses', 2],
  ['treses', 'Treses', 3],
  ['cuatros', 'Cuatros', 4],
  ['cincos', 'Cincos', 5],
  ['seises', 'Seises', 6],
];

const LOWER_ROWS: [Category, string][] = [
  ['poker', 'Póker'],
  ['full', 'Full'],
  ['escCorta', 'Esc. corta'],
  ['escLarga', 'Esc. larga'],
  ['generala', 'Generala'],
];

export class Scorecard {
  /** Casilla con un 0 que espera un segundo toque para confirmarse. */
  private armedZero: Category | null = null;
  private state: GameState | null = null;
  private seat: Seat = 0;

  constructor(
    private root: HTMLElement,
    private onScore: (category: Category) => void,
  ) {
    root.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
      if (!cell) return;
      const category = cell.dataset.cat as Category;
      const s = this.state;
      if (!s) return;
      if (scoreFor(category, s.dice) === 0 && this.armedZero !== category) {
        this.armedZero = category;
        this.render(s, this.seat);
        return;
      }
      this.armedZero = null;
      this.onScore(category);
    });
  }

  render(s: GameState, seat: Seat): void {
    this.state = s;
    this.seat = seat;
    if (!canScore(s) || s.current !== seat) this.armedZero = null;
    const finished = s.phase === 'finished';
    const activeCol = (col: Seat) => !finished && s.phase === 'playing' && s.current === col;

    const cell = (cat: Category, col: Seat): string => {
      const value = s.cards[col][cat];
      const active = activeCol(col) ? ' active' : '';
      if (value !== undefined) return `<div class="cell num${active}">${value}</div>`;
      if (activeCol(col) && canScore(s)) {
        const preview = scoreFor(cat, s.dice);
        if (col === seat) {
          const armed = this.armedZero === cat ? ' armed' : '';
          const label = this.armedZero === cat ? '¿0?' : String(preview);
          return `<button class="cell preview${active}${armed}" data-cat="${cat}" aria-label="Anotar ${preview} puntos">${label}</button>`;
        }
        return `<div class="cell preview${active}">${preview}</div>`;
      }
      return `<div class="cell${active}"></div>`;
    };

    const both = (cat: Category) => cell(cat, 0) + cell(cat, 1);

    const upper = UPPER_ROWS.map(
      ([cat, label, n]) =>
        `<div class="row"><div class="label">${dieIcon(n)}<span>${label}</span></div>${both(cat)}</div>`,
    ).join('');

    const lower = LOWER_ROWS.map(
      ([cat, label]) =>
        `<div class="row"><div class="label tight">${glyphIcon(cat)}<span>${label}</span></div>${both(cat)}</div>`,
    ).join('');

    const subtotal = (col: Seat) => `${upperSubtotal(s.cards[col])}/${BONUS_TARGET}`;
    const bonus = (col: Seat) => (bonusFor(s.cards[col]) ? `+${BONUS_POINTS}` : '');
    const turn = s.phase === 'finished' ? TOTAL_TURNS : currentTurn(s);
    const you = (col: Seat) => (col === seat ? ' you' : '');

    this.root.innerHTML = `
      <header class="head">
        <div class="turn"><small>Turno</small><strong>${turn}/${TOTAL_TURNS}</strong></div>
        <div class="player${activeCol(0) ? ' active' : ''}${you(0)}">${avatarHtml(s.players[0].avatar)}</div>
        <div class="player${activeCol(1) ? ' active' : ''}${you(1)}">${avatarHtml(s.players[1]?.avatar)}</div>
      </header>
      <div class="section-title">Categorías</div>
      <div class="block">${upper}</div>
      <div class="sums">
        <div class="sum-row"><div class="sum-label">Subtotal</div><div class="sum-val">${subtotal(0)}</div><div class="sum-val">${subtotal(1)}</div></div>
        <div class="sum-row"><div class="sum-label big">Bonus + ${BONUS_POINTS}</div><div class="sum-val bonus">${bonus(0)}</div><div class="sum-val bonus">${bonus(1)}</div></div>
      </div>
      <p class="hint">Bonus si ${dieIcon(1)}-${dieIcon(6)} llega a ${BONUS_TARGET} puntos</p>
      <div class="block single">
        <div class="row"><div class="label tight">${glyphIcon('libre')}<span>Libre</span></div>${both('libre')}</div>
      </div>
      <div class="block">${lower}</div>
      <div class="total">
        <div class="total-label">Total</div>
        <div class="total-val${activeCol(0) ? ' active' : ''}">${totalFor(s.cards[0])}</div>
        <div class="total-val${activeCol(1) ? ' active' : ''}">${totalFor(s.cards[1])}</div>
      </div>`;
  }
}
