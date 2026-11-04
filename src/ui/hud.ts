import { totalFor } from '../game/rules';
import { canRoll, type GameState, type Seat } from '../game/state';
import type { RoomStatus } from '../net/room';
import { BUTTON_ICON, avatarHtml, escapeHtml } from './icons';

export interface HudEvents {
  onRoll(): void;
  onRematch(): void;
  onLeave(): void;
}

/** Todo lo que flota sobre la mesa: Tirar, avatar, avisos, salir y resultado. */
export class Hud {
  private rollBtn: HTMLButtonElement;
  private avatar: HTMLElement;
  private notice: HTMLElement;
  private leave: HTMLButtonElement;
  private end: HTMLElement;
  private leaveTimer = 0;
  private status: RoomStatus = { kind: 'connecting' };
  private lastEndKey = '';

  constructor(
    stage: HTMLElement,
    private code: string,
    private events: HudEvents,
  ) {
    stage.insertAdjacentHTML(
      'beforeend',
      `<button class="hud-action roll" type="button" hidden>${BUTTON_ICON}<span>Tirar</span></button>
       <div class="current-player"></div>
       <div class="notice" role="status" hidden></div>
       <button class="hud-action leave" type="button">${BUTTON_ICON}<span>Salir</span></button>
       <div class="end" hidden></div>`,
    );
    this.rollBtn = stage.querySelector('.roll')!;
    this.avatar = stage.querySelector('.current-player')!;
    this.notice = stage.querySelector('.notice')!;
    this.leave = stage.querySelector('.leave')!;
    this.end = stage.querySelector('.end')!;

    this.rollBtn.addEventListener('click', () => events.onRoll());
    this.leave.addEventListener('click', () => this.onLeaveClick());
    this.notice.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.copy')) void this.copyLink();
    });
    this.end.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.rematch')) events.onRematch();
      if ((e.target as HTMLElement).closest('.exit')) events.onLeave();
    });
  }

  placeRollButton(x: number, y: number, stageW: number): void {
    const margin = 70;
    this.rollBtn.style.left = `${Math.min(stageW - margin, Math.max(margin, x))}px`;
    this.rollBtn.style.top = `${y}px`;
  }

  setStatus(status: RoomStatus): void {
    this.status = status;
  }

  render(s: GameState | null, seat: Seat, canAct: boolean): void {
    this.renderNotice(s, seat, canAct);
    this.rollBtn.hidden = !(s && canAct && canRoll(s));
    if (!s) return;

    const shown = s.players[s.current] ?? s.players[0];
    this.avatar.innerHTML = `${avatarHtml(shown.avatar, 'large')}<span class="name">${escapeHtml(shown.name)}</span>`;
    this.renderEnd(s, seat);
  }

  private renderNotice(s: GameState | null, seat: Seat, canAct: boolean): void {
    const link = `${location.origin}${location.pathname}?sala=${this.code}`;
    let html = '';
    let cls = '';
    switch (this.status.kind) {
      case 'connecting':
        html = 'Conectando…';
        break;
      case 'reconnecting':
        html = s?.players[1] ? 'Se ha perdido la conexión. Reconectando…' : 'Conectando…';
        cls = 'warn';
        break;
      case 'failed':
        html = escapeHtml(this.status.message);
        cls = 'error';
        break;
      case 'waiting-peer':
        html = `<span>Envía este enlace a tu amigo:</span>
          <span class="link">${escapeHtml(link)}</span>
          <button class="copy" type="button">Copiar</button>`;
        cls = 'invite';
        break;
      case 'connected':
        if (s?.phase === 'playing') {
          if (canAct) {
            if (s.rolling) html = '';
            else if (s.rollsUsed === 0) html = 'Tu turno: agita el cubilete';
            else if (s.rollsUsed < 3) html = 'Guarda dados y vuelve a tirar, o anota en la planilla';
            else html = 'Última tirada: elige dónde anotar';
          } else if (s.current !== seat) {
            html = `Turno de ${escapeHtml(s.players[s.current]?.name ?? '')}`;
          }
        }
        break;
    }
    if (this.notice.dataset.html !== html) {
      this.notice.innerHTML = html;
      this.notice.dataset.html = html;
    }
    this.notice.className = `notice ${cls}`;
    this.notice.hidden = !html;
  }

  private renderEnd(s: GameState, seat: Seat): void {
    if (s.phase !== 'finished') {
      this.end.hidden = true;
      this.lastEndKey = '';
      return;
    }
    const key = `${s.game}`;
    if (this.lastEndKey === key) return;
    this.lastEndKey = key;
    const a = totalFor(s.cards[0]);
    const b = totalFor(s.cards[1]);
    const title =
      a === b ? '¡Empate!' : (a > b ? 0 : 1) === seat ? '¡Has ganado!' : `Gana ${escapeHtml(s.players[a > b ? 0 : 1]?.name ?? '')}`;
    const line = (col: Seat, total: number) =>
      `<div class="end-player">${avatarHtml(s.players[col]?.avatar)}<span>${escapeHtml(s.players[col]?.name ?? '')}</span><strong>${total}</strong></div>`;
    this.end.innerHTML = `
      <div class="end-card">
        <h2>${title}</h2>
        ${line(0, a)}${line(1, b)}
        <button class="primary rematch" type="button">Revancha</button>
        <button class="secondary exit" type="button">Salir</button>
      </div>`;
    this.end.hidden = false;
  }

  private async copyLink(): Promise<void> {
    const link = `${location.origin}${location.pathname}?sala=${this.code}`;
    const btn = this.notice.querySelector<HTMLElement>('.copy');
    try {
      await navigator.clipboard.writeText(link);
      if (btn) btn.textContent = '¡Copiado!';
    } catch {
      if (btn) btn.textContent = 'Cópialo a mano';
    }
  }

  private onLeaveClick(): void {
    const label = this.leave.querySelector('span')!;
    if (this.leaveTimer) {
      this.events.onLeave();
      return;
    }
    label.textContent = '¿Salir?';
    this.leaveTimer = window.setTimeout(() => {
      this.leaveTimer = 0;
      label.textContent = 'Salir';
    }, 3000);
  }
}
