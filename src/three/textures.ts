import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function colorTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function dataTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Ruido determinista para que la madera sea igual en los dos jugadores. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function woodTextures(size: number): { map: THREE.Texture; bump: THREE.Texture } {
  const [c, g] = canvas(size, size);
  const [b, h] = canvas(size, size);
  const rand = rng(7);
  const plankCount = 4;
  const plankH = size / plankCount;
  const hues = ['#c98f48', '#c58a42', '#d09750', '#bf8440'];

  for (let p = 0; p < plankCount; p++) {
    const y0 = p * plankH;
    g.fillStyle = hues[p % hues.length];
    g.fillRect(0, y0, size, plankH);
    h.fillStyle = '#808080';
    h.fillRect(0, y0, size, plankH);

    // Vetas largas y onduladas a lo largo de la tabla.
    const streaks = Math.round(size / 8);
    const phase = rand() * 10;
    for (let s = 0; s < streaks; s++) {
      const y = y0 + rand() * plankH;
      const dark = rand() > 0.42;
      const alpha = 0.04 + rand() * 0.14;
      const color = dark ? `rgba(92,50,14,${alpha})` : `rgba(240,196,130,${alpha})`;
      const amp = 2 + rand() * (size / 90);
      const freq = 0.002 + rand() * 0.004;
      g.strokeStyle = color;
      g.lineWidth = 0.6 + rand() * 2.6;
      h.strokeStyle = dark ? `rgba(40,40,40,${alpha * 1.6})` : `rgba(210,210,210,${alpha})`;
      h.lineWidth = g.lineWidth;
      g.beginPath();
      h.beginPath();
      for (let x = 0; x <= size; x += 12) {
        const yy = y + Math.sin(x * freq + phase + s * 0.04) * amp;
        if (x === 0) {
          g.moveTo(x, yy);
          h.moveTo(x, yy);
        } else {
          g.lineTo(x, yy);
          h.lineTo(x, yy);
        }
      }
      g.stroke();
      h.stroke();
    }

    // Junta entre tablas.
    g.fillStyle = 'rgba(62,32,8,0.72)';
    g.fillRect(0, y0, size, 3);
    h.fillStyle = '#101010';
    h.fillRect(0, y0, size, 4);
  }

  const map = colorTexture(c);
  const bump = dataTexture(b);
  return { map, bump };
}

export function feltTextures(size = 512): { map: THREE.Texture; bump: THREE.Texture } {
  const [c, g] = canvas(size, size);
  const [b, h] = canvas(size, size);
  const rand = rng(11);
  const img = g.createImageData(size, size);
  const bump = h.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = rand();
    const speck = rand() > 0.965 ? 34 : 0;
    img.data[i] = 158 + n * 42 + speck;
    img.data[i + 1] = 14 + n * 16;
    img.data[i + 2] = 20 + n * 18;
    img.data[i + 3] = 255;
    const v = 70 + n * 150;
    bump.data[i] = bump.data[i + 1] = bump.data[i + 2] = v;
    bump.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  h.putImageData(bump, 0, 0);
  const map = colorTexture(c);
  const bumpT = dataTexture(b);
  for (const t of [map, bumpT]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return { map, bump: bumpT };
}

/** Moleteado del borde del cubilete. */
export function knurlTexture(): THREE.Texture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#7a7a7a';
  g.fillRect(0, 0, 128, 128);
  g.lineWidth = 5;
  for (let i = -128; i < 256; i += 16) {
    g.strokeStyle = '#d8d8d8';
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 128, 128);
    g.stroke();
    g.strokeStyle = '#1a1a1a';
    g.beginPath();
    g.moveTo(i + 128, 0);
    g.lineTo(i, 128);
    g.stroke();
  }
  const t = dataTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

/** Textura de color y relieve de una cara: puntos oscuros y hundidos. */
export function dieFace(value: number, size: number): { map: THREE.Texture; bump: THREE.Texture } {
  const [c, g] = canvas(size, size);
  const [b, h] = canvas(size, size);
  g.fillStyle = '#f4f1e8';
  g.fillRect(0, 0, size, size);
  h.fillStyle = '#ffffff';
  h.fillRect(0, 0, size, size);

  const step = size * 0.255;
  const r = size * (value === 1 ? 0.115 : 0.092);
  for (const [px, py] of PIPS[value]) {
    const x = size / 2 + px * step;
    const y = size / 2 + py * step;

    const pip = g.createRadialGradient(x - r * 0.15, y - r * 0.2, r * 0.1, x, y, r);
    pip.addColorStop(0, '#3f5a4a');
    pip.addColorStop(0.72, '#1d2a22');
    pip.addColorStop(0.92, '#121812');
    pip.addColorStop(1, 'rgba(70,70,60,0.5)');
    g.fillStyle = pip;
    g.beginPath();
    g.arc(x, y, r * 1.02, 0, Math.PI * 2);
    g.fill();

    const dent = h.createRadialGradient(x, y, r * 0.2, x, y, r * 1.08);
    dent.addColorStop(0, '#000000');
    dent.addColorStop(0.8, '#303030');
    dent.addColorStop(1, '#ffffff');
    h.fillStyle = dent;
    h.beginPath();
    h.arc(x, y, r * 1.08, 0, Math.PI * 2);
    h.fill();
  }
  return { map: colorTexture(c), bump: dataTexture(b) };
}
