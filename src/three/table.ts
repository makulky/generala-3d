import * as THREE from 'three';
import { TABLE_Y } from '../physics/constants';
import { woodTextures } from './textures';

export function createTable(quality: 'high' | 'low'): THREE.Group {
  const group = new THREE.Group();
  const { map, bump } = woodTextures(quality === 'high' ? 2048 : 1024);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 44),
    new THREE.MeshStandardMaterial({ map, color: 0xb09a84, bumpMap: bump, bumpScale: 0.6, roughness: 0.62, metalness: 0 }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = TABLE_Y;
  plane.receiveShadow = true;
  group.add(plane);
  group.add(createPencil());
  return group;
}

function createPencil(): THREE.Group {
  const pencil = new THREE.Group();
  const radius = 0.24;

  const part = (
    len: number,
    y: number,
    material: THREE.Material,
    r = radius,
    sides = 6,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, sides), material);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    pencil.add(m);
    return m;
  };

  const lacquer = new THREE.MeshStandardMaterial({ color: 0x2c2d2f, roughness: 0.32, metalness: 0.1 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9ccc9, roughness: 0.3, metalness: 0.95 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0xece9e2, roughness: 0.85 });

  part(14, 7, lacquer);
  part(0.95, -0.45, metal, radius * 1.04, 20);
  for (const y of [-0.2, -0.45, -0.7]) part(0.05, y, metal, radius * 1.1, 20);
  part(0.7, -1.25, rubber, radius * 0.98, 20);

  pencil.position.set(-8.05, TABLE_Y + radius, 5.1);
  pencil.rotation.set(-Math.PI / 2, 0, 0);
  pencil.rotateZ(0.13);
  return pencil;
}
