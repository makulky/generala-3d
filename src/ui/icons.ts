const PIPS: Record<number, [number, number][]> = {
  1: [[12, 12]],
  2: [[7, 7], [17, 17]],
  3: [[6.5, 6.5], [12, 12], [17.5, 17.5]],
  4: [[7, 7], [17, 7], [7, 17], [17, 17]],
  5: [[6.5, 6.5], [17.5, 6.5], [12, 12], [6.5, 17.5], [17.5, 17.5]],
  6: [[7, 6], [17, 6], [7, 12], [17, 12], [7, 18], [17, 18]],
};

export function dieIcon(value: number): string {
  const pips = PIPS[value].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.5" fill="#fff"/>`).join('');
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="5" fill="#111"/>${pips}</svg>`;
}

const GLYPHS: Record<string, [number, number][]> = {
  libre: [[4, 4], [20, 4], [12, 12], [4, 20], [20, 20]],
  poker: [[5, 5], [19, 5], [5, 19], [19, 19]],
  full: [[4, 8], [12, 8], [20, 8], [8, 17], [17, 17]],
  escCorta: [[4, 4], [10, 10], [15, 15], [20, 20]],
  escLarga: [[3, 4], [20, 4], [7, 11], [15, 12], [11, 20]],
  generala: [[12, 3], [3, 12], [21, 12], [12, 21], [12, 12]],
};

export function glyphIcon(name: string): string {
  const dots = GLYPHS[name]
    .map(([x, y]) => `<rect x="${x - 2.8}" y="${y - 2.8}" width="5.6" height="5.6" rx="1.2" fill="#111"/>`)
    .join('');
  return `<svg class="icon glyph" viewBox="0 0 24 24" aria-hidden="true">${dots}</svg>`;
}

/** Cuatro botones con el activo relleno, como pista de "pulsa aquí". */
export const BUTTON_ICON = `<svg class="btn-icon" viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="7" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="16" cy="25" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="25" cy="16" r="5.8" fill="currentColor"/>
</svg>`;

export const AVATARS: { id: string; emoji: string; bg: string }[] = [
  { id: 'zorro', emoji: '🦊', bg: '#7b1e1e' },
  { id: 'ballena', emoji: '🐳', bg: '#2f7fe0' },
  { id: 'rana', emoji: '🐸', bg: '#3f8f4f' },
  { id: 'pulpo', emoji: '🐙', bg: '#7a3fa8' },
  { id: 'panda', emoji: '🐼', bg: '#4a4d57' },
  { id: 'dino', emoji: '🦖', bg: '#c98a1a' },
  { id: 'abeja', emoji: '🐝', bg: '#1f6f78' },
  { id: 'buho', emoji: '🦉', bg: '#8a5a33' },
];

export function avatarHtml(id: string | undefined, extraClass = ''): string {
  const a = AVATARS.find((x) => x.id === id);
  if (!a) return `<span class="avatar avatar-empty ${extraClass}">?</span>`;
  return `<span class="avatar ${extraClass}" style="--bg:${a.bg}"><span>${a.emoji}</span></span>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
