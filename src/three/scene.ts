import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TRAY_HALF } from '../physics/constants';
import { createCup } from './cup';
import { createDice } from './dice';
import { createTable } from './table';
import { createTray } from './tray';

const CAMERA_POS = new THREE.Vector3(0, 30, 2.4);
/** Zona que debe verse siempre a la altura de la bandeja. */
const VIEW_H = TRAY_HALF * 2 + 1.6;
const VIEW_W = 17.4;

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 1, 1, 80);
  private cup: THREE.Group;
  private dice: THREE.Mesh[];
  private ray = new THREE.Raycaster();
  private width = 1;
  private height = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const quality: 'high' | 'low' =
      matchMedia('(pointer: coarse)').matches || Math.max(screen.width, screen.height) < 1000 ? 'low' : 'high';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 2 : 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0xb98244);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xfff6e6, 0x6b4a2a, 0.62));

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.5);
    sun.position.set(13, 24, -7);
    sun.castShadow = true;
    const shadowSize = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    const cam = sun.shadow.camera;
    cam.left = -17;
    cam.right = 17;
    cam.top = 17;
    cam.bottom = -17;
    cam.near = 5;
    cam.far = 60;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 5;
    this.scene.add(sun);

    this.scene.add(createTable(quality));
    this.scene.add(createTray());
    this.cup = createCup();
    this.scene.add(this.cup);
    this.dice = createDice(quality);
    this.dice.forEach((d) => this.scene.add(d));

    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(0, 0, 0);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    const aspect = this.width / this.height;
    const distance = CAMERA_POS.length();
    const needH = Math.max(VIEW_H, VIEW_W / aspect);
    this.camera.aspect = aspect;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(needH / 2 / distance));
    this.camera.updateProjectionMatrix();
  }

  applyPoses(p: Float32Array): void {
    this.cup.position.set(p[0], p[1], p[2]);
    this.cup.quaternion.set(p[3], p[4], p[5], p[6]);
    this.dice.forEach((d, i) => {
      const o = 7 + i * 7;
      d.position.set(p[o], p[o + 1], p[o + 2]);
      d.quaternion.set(p[o + 3], p[o + 4], p[o + 5], p[o + 6]);
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private aim(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(ndc, this.camera);
  }

  /** Índice del dado bajo el puntero, o null. Da algo de margen para móviles. */
  pickDie(clientX: number, clientY: number): number | null {
    this.aim(clientX, clientY);
    const hit = this.ray.intersectObjects(this.dice, false)[0];
    if (hit) return hit.object.userData.dieIndex as number;
    let best: number | null = null;
    let bestDist = 0.8;
    this.dice.forEach((d, i) => {
      const dist = this.ray.ray.distanceToPoint(d.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  pickCup(clientX: number, clientY: number): boolean {
    this.aim(clientX, clientY);
    return this.ray.intersectObject(this.cup, true).length > 0;
  }

  /** Punto de la mesa bajo el puntero, a la altura indicada. */
  pointerOnPlane(clientX: number, clientY: number, y: number): { x: number; z: number } | null {
    this.aim(clientX, clientY);
    const target = new THREE.Vector3();
    const hit = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), target);
    return hit ? { x: target.x, z: target.z } : null;
  }

  /** Coordenadas en píxeles, relativas al lienzo, de un punto del mundo. */
  project(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }
}
