import * as THREE from 'three';
import { CUP_FLOOR, CUP_HEIGHT, CUP_INNER_R, CUP_OUTER_R } from '../physics/constants';
import { feltTextures, knurlTexture } from './textures';

/** El origen del grupo coincide con el del cuerpo físico: centro del fondo. */
export function createCup(): THREE.Group {
  const cup = new THREE.Group();
  const segments = 72;

  // Cuerpo exterior.
  const outerProfile = [
    new THREE.Vector2(0, -0.1),
    new THREE.Vector2(CUP_OUTER_R - 0.5, -0.1),
    new THREE.Vector2(CUP_OUTER_R - 0.32, 0.1),
    new THREE.Vector2(CUP_OUTER_R - 0.14, CUP_HEIGHT * 0.5),
    new THREE.Vector2(CUP_OUTER_R - 0.06, CUP_HEIGHT - 0.12),
  ];
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(outerProfile, segments),
    new THREE.MeshStandardMaterial({ color: 0x232325, roughness: 0.72, metalness: 0.1, side: THREE.DoubleSide }),
  );
  body.castShadow = true;
  cup.add(body);

  // Interior de fieltro rojo, un poco más oscuro que la bandeja.
  const { map, bump } = feltTextures(256);
  const wallMap = map.clone();
  wallMap.repeat.set(5, 1.5);
  wallMap.needsUpdate = true;
  const wallBump = bump.clone();
  wallBump.repeat.set(5, 1.5);
  wallBump.needsUpdate = true;
  const feltMat = new THREE.MeshStandardMaterial({
    map: wallMap,
    bumpMap: wallBump,
    bumpScale: 1,
    roughness: 0.95,
    color: 0xa58888,
    side: THREE.BackSide,
  });
  const innerWall = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(CUP_INNER_R - 0.25, CUP_FLOOR),
        new THREE.Vector2(CUP_INNER_R - 0.04, CUP_FLOOR + 0.28),
        new THREE.Vector2(CUP_INNER_R, CUP_HEIGHT),
      ],
      segments,
    ),
    feltMat,
  );
  innerWall.receiveShadow = true;
  cup.add(innerWall);

  const floorMap = map.clone();
  floorMap.repeat.set(2.2, 2.2);
  floorMap.needsUpdate = true;
  const floorBump = bump.clone();
  floorBump.repeat.set(2.2, 2.2);
  floorBump.needsUpdate = true;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(CUP_INNER_R - 0.2, segments),
    new THREE.MeshStandardMaterial({
      map: floorMap,
      bumpMap: floorBump,
      bumpScale: 1,
      roughness: 0.96,
      color: 0xa58888,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = CUP_FLOOR + 0.002;
  floor.receiveShadow = true;
  cup.add(floor);

  // Borde grueso y rugoso.
  const knurl = knurlTexture();
  knurl.repeat.set(70, 4);
  const rimRadius = (CUP_INNER_R + CUP_OUTER_R) / 2;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(rimRadius, (CUP_OUTER_R - CUP_INNER_R) / 2 + 0.02, 18, 96),
    new THREE.MeshStandardMaterial({
      color: 0x47484a,
      roughness: 0.92,
      metalness: 0.08,
      bumpMap: knurl,
      bumpScale: 2.4,
    }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = CUP_HEIGHT;
  rim.castShadow = true;
  rim.receiveShadow = true;
  cup.add(rim);

  return cup;
}
