import * as THREE from 'three';
import {
  BAND_TOP_Y,
  FELT,
  RIM_INSET,
  SLOT_FLOOR_Y,
  SLOT_SIZE,
  SLOT_X,
  SLOT_Z,
  TABLE_Y,
  TRAY_HALF,
  TRAY_RADIUS,
} from '../physics/constants';
import { feltTextures } from './textures';

/** Contorno de un cuadrado redondeado, siempre con el mismo número de puntos. */
function contour(half: number, radius: number, cornerSteps: number): [number, number][] {
  const pts: [number, number][] = [];
  const r = Math.min(radius, half);
  const corners: [number, number, number][] = [
    [half - r, half - r, 0],
    [-(half - r), half - r, Math.PI / 2],
    [-(half - r), -(half - r), Math.PI],
    [half - r, -(half - r), Math.PI * 1.5],
  ];
  for (const [cx, cz, start] of corners) {
    for (let i = 0; i <= cornerSteps; i++) {
      const a = start + (i / cornerSteps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Barre un perfil [hundimiento, altura] alrededor del cuadrado redondeado. */
function sweep(profile: [number, number][]): THREE.BufferGeometry {
  const steps = 10;
  const rings = profile.map(([inset, y]) =>
    contour(TRAY_HALF - inset, Math.max(TRAY_RADIUS - inset, 0.22), steps).map(
      ([x, z]) => [x, y, z] as const,
    ),
  );
  const count = rings[0].length;
  const positions: number[] = [];
  const indices: number[] = [];
  rings.forEach((ring) => ring.forEach((p) => positions.push(p[0], p[1], p[2])));
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < count; i++) {
      const a = r * count + i;
      const b = r * count + ((i + 1) % count);
      const c = (r + 1) * count + i;
      const d = (r + 1) * count + ((i + 1) % count);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

export function createTray(): THREE.Group {
  const tray = new THREE.Group();

  const silver = new THREE.MeshStandardMaterial({ color: 0xd2ded9, roughness: 0.24, metalness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x45474c, roughness: 0.42, metalness: 0.72 });
  const darker = new THREE.MeshStandardMaterial({ color: 0x2f3034, roughness: 0.55, metalness: 0.55 });
  const slotFloor = new THREE.MeshStandardMaterial({ color: 0x55575a, roughness: 0.6, metalness: 0.4 });

  // Canto exterior plateado.
  const outer = new THREE.Mesh(
    sweep([
      [0, TABLE_Y],
      [0, 0.72],
      [0.07, 0.86],
      [0.2, 0.9],
      [0.32, 0.8],
    ]),
    silver,
  );
  outer.castShadow = true;
  outer.receiveShadow = true;
  tray.add(outer);

  // Escalones concéntricos oscuros.
  const profile: [number, number][] = [[0.32, 0.8]];
  const ridges = 5;
  const span = RIM_INSET - 0.32;
  for (let r = 0; r < ridges; r++) {
    const start = 0.32 + (r / ridges) * span;
    const w = span / ridges;
    const top = 0.74 - r * 0.035;
    profile.push(
      [start + w * 0.12, top + 0.03],
      [start + w * 0.55, top + 0.03],
      [start + w * 0.72, top - 0.09],
      [start + w, top - 0.09],
    );
  }
  const rim = new THREE.Mesh(sweep(profile), dark);
  rim.receiveShadow = true;
  rim.castShadow = true;
  tray.add(rim);

  // Pared interior hasta el fieltro.
  const lastY = profile[profile.length - 1][1];
  const inner = new THREE.Mesh(
    sweep([
      [RIM_INSET, lastY],
      [RIM_INSET + 0.08, lastY - 0.06],
      [TRAY_HALF - FELT.maxX, 0],
    ]),
    darker,
  );
  inner.receiveShadow = true;
  tray.add(inner);

  // Fieltro.
  const { map, bump } = feltTextures();
  const felt = map.clone();
  felt.repeat.set(2.5, 2.5);
  felt.needsUpdate = true;
  const feltBump = bump.clone();
  feltBump.repeat.set(2.5, 2.5);
  feltBump.needsUpdate = true;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FELT.maxX - FELT.minX + 0.2, FELT.maxZ - FELT.minZ + 2.2),
    new THREE.MeshStandardMaterial({
      map: felt,
      color: 0x8f6f6f,
      bumpMap: feltBump,
      bumpScale: 2.4,
      roughness: 0.96,
      metalness: 0,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((FELT.minX + FELT.maxX) / 2, 0, (FELT.minZ + FELT.maxZ) / 2 - 1);
  floor.receiveShadow = true;
  tray.add(floor);

  // Banda superior con los 5 huecos para los dados guardados.
  const edge = TRAY_HALF - RIM_INSET;
  const bandFront = FELT.minZ;
  const bandDepth = bandFront + edge;
  const shape = new THREE.Shape();
  shape.moveTo(-edge, -bandDepth / 2);
  shape.lineTo(edge, -bandDepth / 2);
  shape.lineTo(edge, bandDepth / 2);
  shape.lineTo(-edge, bandDepth / 2);
  shape.closePath();
  const bandCenter = (bandFront - edge) / 2;
  const s = SLOT_SIZE / 2;
  for (const x of SLOT_X) {
    const hole = new THREE.Path();
    const zc = -(SLOT_Z - bandCenter);
    hole.moveTo(x - s, zc - s);
    hole.lineTo(x - s, zc + s);
    hole.lineTo(x + s, zc + s);
    hole.lineTo(x + s, zc - s);
    hole.closePath();
    shape.holes.push(hole);
  }
  const bandHeight = BAND_TOP_Y - SLOT_FLOOR_Y;
  const bandGeo = new THREE.ExtrudeGeometry(shape, {
    depth: bandHeight,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    bevelSegments: 2,
  });
  bandGeo.rotateX(-Math.PI / 2);
  const band = new THREE.Mesh(bandGeo, dark);
  band.position.set(0, SLOT_FLOOR_Y, bandCenter);
  band.castShadow = true;
  band.receiveShadow = true;
  tray.add(band);

  for (const x of SLOT_X) {
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(SLOT_SIZE + 0.1, SLOT_SIZE + 0.1), slotFloor);
    slot.rotation.x = -Math.PI / 2;
    slot.position.set(x, SLOT_FLOOR_Y + 0.003, SLOT_Z);
    slot.receiveShadow = true;
    tray.add(slot);
  }

  return tray;
}
