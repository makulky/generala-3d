import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { DIE_SIZE, FACE_NORMALS } from '../physics/constants';
import { dieFace } from './textures';

export function createDice(quality: 'high' | 'low'): THREE.Mesh[] {
  const size = quality === 'high' ? 256 : 128;
  const geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 4, 0.11);

  // Orden de materiales de BoxGeometry: +x, -x, +y, -y, +z, -z.
  const faceOrder = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const materials = faceOrder.map((n) => {
    const value = Number(
      Object.keys(FACE_NORMALS).find((k) => FACE_NORMALS[Number(k)].every((c, i) => c === n[i])),
    );
    const { map, bump } = dieFace(value, size);
    return new THREE.MeshStandardMaterial({
      map,
      bumpMap: bump,
      bumpScale: 1.4,
      roughness: 0.34,
      metalness: 0,
    });
  });

  return Array.from({ length: 5 }, (_, i) => {
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.dieIndex = i;
    return mesh;
  });
}
