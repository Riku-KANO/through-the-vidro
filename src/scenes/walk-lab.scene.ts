import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  abs,
  color,
  float,
  fract,
  fwidth,
  min,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';
import { InputSystem } from '../game/input/input-system';
import { PEEK_MODIFIER } from '../game/player/constants';
import { createWorld, initPhysics } from '../game/player/physics';
import { PlayerController, type Vec3 } from '../game/player/player';

export const title = 'S-03 walk lab: first-person movement on steps, a ramp, ledges and round walls';

/**
 * Grey test field for the first-person body (S-03). Everything you see is also exactly what you collide with
 * (空間の可読性 4: 当たり判定は見た目に正直に): rounded boxes ↔ round cuboids, cylinders ↔ cylinders,
 * the curved wall ↔ a triangle mesh built from the same vertices.
 *
 * URL switches: spawn=<name> (see SPAWNS), peek=toggle, bob=0, fov=<deg>, dot=1 (centre dot).
 * Publishes position, velocity and grounding on window.__vidro.sceneProbe for tests/e2e/S-03-walk.spec.ts.
 */

interface Spawn {
  feet: Vec3;
  yaw: number;
  pitch?: number;
}

/** The raised platform (高台): top at 1.2 m. */
const HIGH = { minX: -10, maxX: -4, minZ: -9, maxZ: -3, top: 1.2 };

const SPAWNS: Record<string, Spawn> = {
  /** Default view for the sensor screenshot: the whole field from its south-east corner. */
  overview: { feet: { x: 7.5, y: 0, z: 8.5 }, yaw: 0.68, pitch: -0.12 },
  /** Clear runway toward -Z. */
  start: { feet: { x: 0, y: 0, z: 8 }, yaw: 0 },
  /** On the platform, 3 m from its west edge (a 1.2 m drop), facing it. */
  edge: { feet: { x: -7, y: HIGH.top, z: -6 }, yaw: Math.PI / 2, pitch: -0.8 },
  /** In front of six 0.2 m steps that lead up to the platform. */
  steps: { feet: { x: -7, y: 0, z: 1.5 }, yaw: 0 },
  /** At the foot of the 15 degree ramp up to the platform. */
  slope: { feet: { x: 1.5, y: 0, z: -6 }, yaw: Math.PI / 2 },
  /** Facing the round pillar 30 degrees off its centre. */
  pillar: { feet: { x: 3.75, y: 0, z: 1 }, yaw: 0 },
  /** Facing the inside of the curved wall at an angle. */
  curve: { feet: { x: 4.2, y: 0, z: -8 }, yaw: 0 },
  /** On the platform in front of the 1 m wide bridge. */
  bridge: { feet: { x: -7, y: HIGH.top, z: -7.5 }, yaw: 0, pitch: -0.25 },
};

/** トランジション設計: 覗く開始・終了は0.25秒. Stand-in for S-02 until the two are integrated. */
const PEEK_TRANSITION = 0.25;

const create: SceneFactory = async ({ renderer, canvas, overlay, quality, params }) => {
  const R = await initPhysics();
  const world = createWorld();

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xcfd8e0);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 18, 80);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 300);

  // Low sun from the north-west: the default view looks into it, so tops are lit and the faces toward
  // the camera fall into cool shade, which reads the shapes (one light + sky, アートディレクション > 光と時間帯).
  scene.add(new THREE.HemisphereLight(0xdde7f0, 0x7d776c, 1.25));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  sun.position.set(-14, 16, -10);
  scene.add(sun);
  if (quality.dynamicShadowSize > 0) {
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.dynamicShadowSize, quality.dynamicShadowSize);
    const cam = sun.shadow.camera;
    cam.left = -20;
    cam.right = 20;
    cam.top = 20;
    cam.bottom = -20;
    cam.near = 1;
    cam.far = 60;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
  }

  // Walkable surfaces carry a 1 m world grid on their tops so distances and heights can be judged by eye.
  const walkable = gridMaterial(0xcfcac0, 0xf1ede6, 0xa9a397);
  const wall = new THREE.MeshStandardNodeMaterial({ color: 0xa3afba, roughness: 0.85 });
  const below = new THREE.MeshStandardNodeMaterial({ color: 0x8995a1, roughness: 1 });
  const materials = [walkable, wall, below];
  const geometries: THREE.BufferGeometry[] = [];

  const addMesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    pos: Vec3,
    rot?: THREE.Euler,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pos.x, pos.y, pos.z);
    if (rot) mesh.rotation.copy(rot);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    geometries.push(geometry);
    return mesh;
  };

  const quat = (rot?: THREE.Euler) => {
    const q = new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler());
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  };

  /** Rounded box: identical rounded cuboid for the eye and for Rapier. */
  const box = (pos: Vec3, size: Vec3, radius: number, material: THREE.Material, rot?: THREE.Euler) => {
    addMesh(new RoundedBoxGeometry(size.x, size.y, size.z, 3, radius), material, pos, rot);
    world.createCollider(
      R.ColliderDesc.roundCuboid(size.x / 2 - radius, size.y / 2 - radius, size.z / 2 - radius, radius)
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(quat(rot)),
    );
  };

  const cylinder = (pos: Vec3, radius: number, height: number, material: THREE.Material) => {
    addMesh(new THREE.CylinderGeometry(radius, radius, height, 64), material, pos);
    world.createCollider(R.ColliderDesc.cylinder(height / 2, radius).setTranslation(pos.x, pos.y, pos.z));
  };

  /** Curved wall: the render mesh and the collision mesh share the same vertices. */
  const curvedWall = (centre: Vec3, inner: number, outer: number, height: number, a0: number, a1: number) => {
    const geometry = arcWallGeometry(inner, outer, height, a0, a1, 48);
    addMesh(geometry, wall, centre);
    const pos = geometry.getAttribute('position');
    const vertices = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      vertices[i * 3] = pos.getX(i) + centre.x;
      vertices[i * 3 + 1] = pos.getY(i) + centre.y;
      vertices[i * 3 + 2] = pos.getZ(i) + centre.z;
    }
    const index = geometry.getIndex();
    if (!index) throw new Error('arc wall geometry must be indexed');
    world.createCollider(
      R.ColliderDesc.trimesh(
        vertices,
        new Uint32Array(index.array),
        R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES,
      ),
    );
  };

  // Main floor (30 × 30 m, top at y = 0) floating above a lower ground, so its rim is a real ledge.
  box({ x: 0, y: -0.5, z: 0 }, { x: 30, y: 1, z: 30 }, 0.25, walkable);
  addMesh(
    new THREE.PlaneGeometry(400, 400),
    below,
    { x: 0, y: -6, z: 0 },
    new THREE.Euler(-Math.PI / 2, 0, 0),
  );

  // 高台: the raised platform, reached by stairs (south) and a ramp (east).
  box(
    { x: (HIGH.minX + HIGH.maxX) / 2, y: HIGH.top / 2, z: (HIGH.minZ + HIGH.maxZ) / 2 },
    { x: HIGH.maxX - HIGH.minX, y: HIGH.top, z: HIGH.maxZ - HIGH.minZ },
    0.08,
    walkable,
  );
  // 段差: six 0.2 m risers with 0.4 m treads.
  for (let i = 0; i < 6; i++) {
    const top = 0.2 * (i + 1);
    box({ x: -7, y: top / 2, z: HIGH.maxZ + 2.4 - 0.2 - 0.4 * i }, { x: 2, y: top, z: 0.4 }, 0.03, walkable);
  }
  // 斜面: 15 degrees, from the platform's east edge down to the floor.
  {
    const angle = (15 * Math.PI) / 180;
    const length = HIGH.top / Math.sin(angle);
    const run = HIGH.top / Math.tan(angle);
    const thickness = 0.2;
    const topMid = { x: HIGH.maxX + run / 2, y: HIGH.top / 2 };
    box(
      {
        x: topMid.x - (thickness / 2) * Math.sin(angle),
        y: topMid.y - (thickness / 2) * Math.cos(angle),
        z: -6,
      },
      { x: length, y: thickness, z: 2 },
      0.03,
      walkable,
      new THREE.Euler(0, 0, -angle),
    );
  }
  // 縁: a 1 m wide bridge off the platform's north edge to a round lookout.
  box({ x: -7, y: HIGH.top - 0.15, z: HIGH.minZ - 1.5 }, { x: 1, y: 0.3, z: 3 }, 0.03, walkable);
  cylinder({ x: -7, y: HIGH.top / 2, z: HIGH.minZ - 4.3 }, 1.3, HIGH.top, walkable);

  // 丸い壁: a round pillar and the inside of a curved wall.
  cylinder({ x: 4.5, y: 1.6, z: -2.5 }, 1.2, 3.2, wall);
  curvedWall({ x: 6, y: 0, z: -10 }, 3.5, 3.8, 2.4, Math.PI, 2 * Math.PI);

  // Step heights side by side: 0.15 and 0.3 m are climbed, 0.45 m is a wall.
  [0.15, 0.3, 0.45].forEach((h, i) => {
    box({ x: 8 + 2.2 * i, y: h / 2, z: 6.5 }, { x: 1.6, y: h, z: 2 }, 0.03, walkable);
  });

  world.step();

  const spawnName = params.get('spawn') ?? 'overview';
  const spawn = SPAWNS[spawnName] ?? SPAWNS.overview;
  if (!spawn) throw new Error('walk-lab: no spawn');
  const bob = params.get('bob');
  const fov = Number(params.get('fov'));
  const player = new PlayerController(world, {
    feet: spawn.feet,
    yaw: spawn.yaw,
    pitch: spawn.pitch ?? 0,
    settings: {
      headBob: bob === '0' ? 0 : 1,
      ...(params.has('fov') && Number.isFinite(fov) ? { fovDeg: fov } : {}),
    },
  });
  player.applyToCamera(camera);

  const input = new InputSystem(canvas, {
    settings: { peekMode: params.get('peek') === 'toggle' ? 'toggle' : 'hold' },
  });
  input.canRing = true;
  const events: string[] = [];
  const offInput = input.on((e) => {
    events.push(e.type);
    if (events.length > 30) events.shift();
  });

  const hint = createHint(overlay);
  const dot = params.get('dot') === '1' ? createCentreDot(overlay) : null;

  let peekT = 0;
  let time = 0;
  const probe = window.__vidro.sceneProbe;

  return {
    scene,
    camera,
    update(dt) {
      time += dt;
      world.step();
      input.update(dt);

      // Stand-in for S-02: blend the peek modifier in and out over 0.25 s.
      peekT = Math.min(1, Math.max(0, peekT + (input.peeking ? dt : -dt) / PEEK_TRANSITION));
      if (peekT > 0)
        player.modifiers.set('peek', { ...PEEK_MODIFIER, weight: peekT * peekT * (3 - 2 * peekT) });
      else player.modifiers.delete('peek');

      const look = input.consumeLook();
      player.update(dt, { move: input.move, sprint: input.sprint, lookYaw: look.yaw, lookPitch: look.pitch });
      player.applyToCamera(camera);
      hint.style.opacity = input.locked ? '0' : '1';

      const feet = player.feet;
      const v = player.velocity;
      const eye = player.eye;
      Object.assign(probe, {
        ready: time > 1.5 && player.grounded,
        time,
        spawn: spawnName,
        position: feet,
        velocity: v,
        speed: Math.hypot(v.x, v.z),
        grounded: player.grounded,
        eyeHeight: eye.y - feet.y,
        yaw: player.yaw,
        pitch: player.pitch,
        fov: camera.fov,
        locked: input.locked,
        lockRequests: input.lockRequests,
        peeking: input.peeking,
        ledges: player.ledges.length,
        events: [...events],
        ledge: spawnName === 'edge' ? HIGH : null,
      });
    },
    dispose() {
      offInput();
      input.dispose();
      hint.remove();
      dot?.remove();
      player.dispose();
      world.free();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
};

export default create;

/**
 * Matte material with a 1 m world-space grid on upward faces, anti-aliased with screen-space derivatives.
 * Higher ground is lighter, so a drop reads even when both levels face the light the same way.
 */
function gridMaterial(low: number, high: number, line: number): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const p = positionWorld.xz;
  const distance = abs(fract(p.sub(0.5)).sub(0.5)).div(fwidth(p));
  const onLine = float(1).sub(min(min(distance.x, distance.y), float(1)));
  const facingUp = smoothstep(0.7, 0.95, normalWorld.y);
  const base = mix(color(low), color(high), smoothstep(-0.1, 1.3, positionWorld.y));
  material.colorNode = mix(base, color(line), onLine.mul(facingUp).mul(0.55));
  return material;
}

/** Annular sector (a curved wall with thickness), indexed, with hard edges between its faces. */
function arcWallGeometry(
  inner: number,
  outer: number,
  height: number,
  a0: number,
  a1: number,
  segments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const quad = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    n: number[] | ((p: number[]) => number[]),
  ) => {
    const base = positions.length / 3;
    for (const v of [a, b, c, d]) {
      positions.push(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      const nv = typeof n === 'function' ? n(v) : n;
      normals.push(nv[0] ?? 0, nv[1] ?? 0, nv[2] ?? 0);
    }
    // Wind the quad so its front faces along the given normal.
    const ab = new THREE.Vector3().fromArray(b).sub(new THREE.Vector3().fromArray(a));
    const ac = new THREE.Vector3().fromArray(c).sub(new THREE.Vector3().fromArray(a));
    const front = ab.cross(ac).dot(new THREE.Vector3().fromArray(typeof n === 'function' ? n(a) : n)) > 0;
    if (front) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const at = (r: number, a: number, y: number) => [Math.cos(a) * r, y, Math.sin(a) * r];
  const radial = (sign: number) => (v: number[]) => {
    const len = Math.hypot(v[0] ?? 0, v[2] ?? 0);
    return [((v[0] ?? 0) / len) * sign, 0, ((v[2] ?? 0) / len) * sign];
  };
  for (let i = 0; i < segments; i++) {
    const s = a0 + ((a1 - a0) * i) / segments;
    const e = a0 + ((a1 - a0) * (i + 1)) / segments;
    quad(at(inner, s, 0), at(inner, s, height), at(inner, e, height), at(inner, e, 0), radial(-1));
    quad(at(outer, e, 0), at(outer, e, height), at(outer, s, height), at(outer, s, 0), radial(1));
    quad(at(inner, s, height), at(outer, s, height), at(outer, e, height), at(inner, e, height), [0, 1, 0]);
  }
  const cap = (a: number, sign: number) => {
    const n = [-Math.sin(a) * sign, 0, Math.cos(a) * sign];
    quad(at(inner, a, 0), at(outer, a, 0), at(outer, a, height), at(inner, a, height), n);
  };
  cap(a0, -1);
  cap(a1, 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Small frosted hint shown only while the mouse is free. */
function createHint(overlay: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.textContent = 'クリックで視点を固定 ・ WASD 歩く ・ Shift 早歩き ・ 右クリック 覗く ・ Esc 解除';
  el.style.cssText =
    'position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;' +
    'font:13px/1.4 "Shippori Mincho",serif;color:#2d3640;background:rgba(255,255,255,.35);' +
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.6);' +
    'transition:opacity .4s;white-space:nowrap';
  overlay.appendChild(el);
  return el;
}

/** 3D酔い対策: 画面中央の小さな点(視点の基準)を表示できる. */
function createCentreDot(overlay: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;' +
    'background:rgba(255,255,255,.85);box-shadow:0 0 2px rgba(0,0,0,.35)';
  overlay.appendChild(el);
  return el;
}
