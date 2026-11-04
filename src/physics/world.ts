import * as CANNON from 'cannon-es';
import {
  CUP_FLOOR,
  CUP_HEIGHT,
  CUP_INNER_R,
  CUP_OUTER_R,
  DIE_SIZE,
  FELT,
} from './constants';

export const GROUP = { DIE: 1, FLOOR: 2, WALL: 4, CUP: 8, LID: 16 };
export const MASK_DIE_FREE = GROUP.DIE | GROUP.FLOOR | GROUP.CUP | GROUP.LID;
export const MASK_DIE_TRAY = MASK_DIE_FREE | GROUP.WALL;

export interface Physics {
  world: CANNON.World;
  dice: CANNON.Body[];
  cup: CANNON.Body;
  lid: CANNON.Body;
}

export function createPhysics(): Physics {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -50, 0) });
  world.allowSleep = true;
  (world.solver as CANNON.GSSolver).iterations = 24;
  (world.solver as CANNON.GSSolver).tolerance = 1e-4;

  const mDie = new CANNON.Material('die');
  const mFelt = new CANNON.Material('felt');
  const mWall = new CANNON.Material('wall');
  const mCup = new CANNON.Material('cup');
  world.addContactMaterial(new CANNON.ContactMaterial(mDie, mFelt, { friction: 0.55, restitution: 0.32 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mDie, mWall, { friction: 0.12, restitution: 0.5 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mDie, mCup, { friction: 0.08, restitution: 0.3 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mDie, mDie, { friction: 0.15, restitution: 0.4 }));

  const floor = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
    material: mFelt,
    collisionFilterGroup: GROUP.FLOOR,
    collisionFilterMask: GROUP.DIE,
  });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);

  // Paredes invisibles y altas: un dado que ha entrado en la bandeja no puede salir.
  const thick = 2;
  const height = 40;
  const cx = (FELT.minX + FELT.maxX) / 2;
  const cz = (FELT.minZ + FELT.maxZ) / 2;
  const hx = (FELT.maxX - FELT.minX) / 2;
  const hz = (FELT.maxZ - FELT.minZ) / 2;
  const walls: [number, number, number, number][] = [
    [FELT.minX - thick, cz, thick, hz + thick * 2],
    [FELT.maxX + thick, cz, thick, hz + thick * 2],
    [cx, FELT.minZ - thick, hx + thick * 2, thick],
    [cx, FELT.maxZ + thick, hx + thick * 2, thick],
  ];
  for (const [x, z, wx, wz] of walls) {
    world.addBody(
      new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Box(new CANNON.Vec3(wx, height / 2, wz)),
        position: new CANNON.Vec3(x, height / 2, z),
        material: mWall,
        collisionFilterGroup: GROUP.WALL,
        collisionFilterMask: GROUP.DIE,
      }),
    );
  }

  const half = DIE_SIZE / 2;
  const dice = Array.from({ length: 5 }, () => {
    const body = new CANNON.Body({
      mass: 1,
      shape: new CANNON.Box(new CANNON.Vec3(half, half, half)),
      material: mDie,
      linearDamping: 0.02,
      angularDamping: 0.04,
      allowSleep: true,
      sleepSpeedLimit: 0.25,
      sleepTimeLimit: 0.25,
      collisionFilterGroup: GROUP.DIE,
      collisionFilterMask: MASK_DIE_FREE,
    });
    world.addBody(body);
    return body;
  });

  // Cubilete: anillo de 16 tramos gruesos y un fondo octogonal.
  const cup = new CANNON.Body({
    type: CANNON.Body.KINEMATIC,
    material: mCup,
    allowSleep: false,
    collisionFilterGroup: GROUP.CUP,
    collisionFilterMask: 0,
  });
  const segments = 16;
  const wallThick = CUP_OUTER_R - CUP_INNER_R;
  const wallR = CUP_INNER_R + wallThick / 2;
  const segWidth = 2 * CUP_OUTER_R * Math.tan(Math.PI / segments) + 0.1;
  const seg = new CANNON.Box(new CANNON.Vec3(wallThick / 2, CUP_HEIGHT / 2, segWidth / 2));
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const q = new CANNON.Quaternion();
    q.setFromEuler(0, -a, 0);
    cup.addShape(seg, new CANNON.Vec3(Math.cos(a) * wallR, CUP_HEIGHT / 2, Math.sin(a) * wallR), q);
  }
  const base = new CANNON.Box(new CANNON.Vec3(1.8, CUP_FLOOR, 1.8));
  const baseQ = new CANNON.Quaternion();
  baseQ.setFromEuler(0, Math.PI / 4, 0);
  cup.addShape(base, new CANNON.Vec3(0, 0, 0));
  cup.addShape(base, new CANNON.Vec3(0, 0, 0), baseQ);
  world.addBody(cup);

  // Tapa invisible para que ningún dado salte mientras se agita.
  const lid = new CANNON.Body({
    type: CANNON.Body.KINEMATIC,
    material: mCup,
    allowSleep: false,
    shape: new CANNON.Box(new CANNON.Vec3(CUP_OUTER_R, 0.5, CUP_OUTER_R)),
    collisionFilterGroup: GROUP.LID,
    collisionFilterMask: 0,
  });
  world.addBody(lid);

  return { world, dice, cup, lid };
}
