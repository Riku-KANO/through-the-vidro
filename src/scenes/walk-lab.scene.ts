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
import { PlayerController } from '../game/player/player';
import {
  addFieldColliders,
  arcWallMesh,
  cylinderMesh,
  type FieldPart,
  HIGH,
  SPAWNS,
  walkLabParts,
} from '../game/player/walk-lab-field';

export const title = 'S-03 walk lab: first-person movement on steps, a ramp, ledges and round walls';

/**
 * Grey test field for the first-person body (S-03). The layout is data (src/game/player/walk-lab-field.ts):
 * the meshes here and the Rapier colliders are made from the same numbers, so everything you see is exactly
 * what you collide with (空間の可読性 4: 当たり判定は見た目に正直に).
 *
 * URL switches: spawn=<name> (see SPAWNS), peek=toggle, bob=0, fov=<deg>, dot=1 (centre dot).
 * Publishes position, velocity and grounding on window.__vidro.sceneProbe for tests/e2e/S-03-walk.spec.ts.
 */

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
  const shadowsBefore = renderer.shadowMap.enabled;
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

  const geometryOf = (part: FieldPart): THREE.BufferGeometry => {
    switch (part.kind) {
      case 'box':
        return new RoundedBoxGeometry(part.size.x, part.size.y, part.size.z, 3, part.radius);
      case 'cylinder':
      case 'arcWall': {
        const mesh = part.kind === 'cylinder' ? cylinderMesh(part) : arcWallMesh(part);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        return g;
      }
    }
  };
  const addMesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    geometries.push(geometry);
    return mesh;
  };

  const parts = walkLabParts();
  for (const part of parts) {
    const mesh = addMesh(geometryOf(part), part.surface === 'walk' ? walkable : wall);
    mesh.position.set(part.centre.x, part.centre.y, part.centre.z);
    if (part.kind === 'box' && part.rotZ) mesh.rotation.z = part.rotZ;
  }
  addFieldColliders(R, world, parts);
  // The ground far below the main floor: only seen, never reached (the floor's rim is a ledge).
  const lower = addMesh(new THREE.PlaneGeometry(400, 400), below);
  lower.position.y = -6;
  lower.rotation.x = -Math.PI / 2;

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
      sun.dispose();
      renderer.shadowMap.enabled = shadowsBefore;
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
