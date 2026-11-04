import '@fontsource/m-plus-rounded-1c/latin-400.css';
import '@fontsource/m-plus-rounded-1c/latin-800.css';
import './ui/styles.css';
import type { Player } from './game/state';
import { claimRole, newCode, resumeSession } from './net/room';
import { showLobby } from './ui/lobby';

const lobby = document.getElementById('lobby')!;
const card = document.getElementById('card')!;
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;

const params = new URLSearchParams(location.search);
const sala = params.get('sala')?.trim().toUpperCase() || null;

// La parte pesada (Three.js y física) se descarga aparte.
const loadApp = () => import('./app');

async function boot(code: string, role: 'host' | 'guest', player: Player, persistent: boolean): Promise<void> {
  document.body.classList.add('in-game');
  stage.setAttribute('aria-busy', 'true');
  try {
    const { startGame } = await loadApp();
    startGame({ code, role, player, persistent, card, stage, canvas });
  } catch (err) {
    console.error(err);
    stage.insertAdjacentHTML(
      'beforeend',
      '<div class="notice error">No se ha podido iniciar el juego. Comprueba que tu navegador tiene WebGL activado y recarga la página.</div>',
    );
  } finally {
    stage.removeAttribute('aria-busy');
  }
}

const resumed = sala ? await resumeSession(sala) : null;
if (sala && resumed) {
  // Recarga o regreso a una partida ya empezada.
  void boot(sala, resumed.role, resumed.player, true);
} else {
  showLobby(lobby, !!sala, async (player) => {
    const code = sala ?? newCode();
    const role = sala ? 'guest' : 'host';
    if (!sala) history.replaceState(null, '', `?sala=${code}`);
    void boot(code, role, player, await claimRole(code, role));
  });
  // Precarga mientras se rellena el formulario.
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 400));
  idle(() => void loadApp());
}
