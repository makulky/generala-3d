import type { Player } from '../game/state';
import { AVATARS, avatarHtml, escapeHtml } from './icons';

const PROFILE_KEY = 'generala:perfil';

function loadProfile(): Player {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw) as Player;
  } catch {
    // Sin almacenamiento se empieza con los valores por defecto.
  }
  return { name: '', avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)].id };
}

function saveProfile(p: Player): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    // No es imprescindible recordar el perfil.
  }
}

export function showLobby(root: HTMLElement, joining: boolean, onSubmit: (player: Player) => void): void {
  const profile = loadProfile();
  const avatars = AVATARS.map(
    (a) => `
      <label class="avatar-pick">
        <input type="radio" name="avatar" value="${a.id}" ${a.id === profile.avatar ? 'checked' : ''}>
        ${avatarHtml(a.id)}
      </label>`,
  ).join('');

  root.innerHTML = `
    <form class="lobby-card">
      <h1>Generala</h1>
      <label class="field">
        <span>Tu nombre</span>
        <input name="name" maxlength="14" required autocomplete="nickname" value="${escapeHtml(profile.name)}" placeholder="Escribe tu nombre">
      </label>
      <fieldset class="avatars">
        <legend>Tu avatar</legend>
        <div class="avatar-grid">${avatars}</div>
      </fieldset>
      <button class="primary" type="submit">${joining ? 'Unirme a la partida' : 'Crear partida'}</button>
    </form>`;
  root.hidden = false;

  root.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(e.target as HTMLFormElement);
    const player: Player = {
      name: String(data.get('name')).trim().slice(0, 14) || 'Jugador',
      avatar: String(data.get('avatar')),
    };
    saveProfile(player);
    root.hidden = true;
    onSubmit(player);
  });
}
