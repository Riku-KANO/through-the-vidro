import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  dot,
  exp,
  float,
  mix,
  normalize,
  normalView,
  positionLocal,
  positionView,
  pow,
  smoothstep,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';
import type { DiveWorld } from '../game/dive-world';
import { createHomeDive } from '../ui/home/dive-host';

export const title = 'S-04 loading → home → dive into the orb (?autoplay=1 plays the script)';

/** 操作とカメラ > カメラ: 目の高さ1.6m、視野角70度 */
const EYE_HEIGHT = 1.6;
const GAME_FOV = 70;
/** Game camera field of view while it shows the miniature city inside the home orb. M0 tuning value. */
const MINIATURE_FOV = 44;

// ---------------------------------------------------------------------------------------------
// Placeholder game world: the city as bubbles, the workshop (序章「工房」) at its edge.
// S-06 replaces this with the prologue scene; the home orb always shows whatever this scene is.
// ---------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GameWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Game camera pose along the dive (0 = the miniature view, 1 = standing in the workshop). */
  pose(u: number, outPos: THREE.Vector3, outTarget: THREE.Vector3): void;
  /** Point the miniature view turns around when the orb tilts. */
  pivot: THREE.Vector3;
  skyScene: THREE.Scene;
  dispose(): void;
}

function createGameWorld(): GameWorld {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const up = new THREE.Vector3(0, 1, 0);
  // 序章「工房」: 街外れの吹きガラス工房。夜明け前の青 (進行構造とエリア設計, 光と時間帯)
  const W = new THREE.Vector3(Math.sin(0.62) * 28, 0, Math.cos(0.62) * 28);
  const f = W.clone().setY(0).normalize().negate(); // workshop → city centre
  const side = new THREE.Vector3().crossVectors(f, up).normalize();
  const at = (fwd: number, s: number, h: number): THREE.Vector3 =>
    W.clone().addScaledVector(f, fwd).addScaledVector(side, s).addScaledVector(up, h);

  // sky: pre-dawn blue with a faint glow low over the city (the way the player looks when standing)
  const dawn = f.clone().setY(0.08).normalize();
  const skyMat = keep(
    new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  {
    const d = normalize(positionLocal);
    const zenith = vec3(0.012, 0.03, 0.085);
    const horizon = vec3(0.3, 0.38, 0.5);
    const below = vec3(0.12, 0.15, 0.2);
    const h = d.y;
    const skyCol = mix(horizon, zenith, pow(smoothstep(0, 1, h.max(0)), 0.55));
    const glowAmt = pow(dot(d, vec3(dawn.x, dawn.y, dawn.z)).max(0), 6).mul(exp(abs(h).mul(-6)));
    skyMat.colorNode = mix(below, skyCol, smoothstep(-0.08, 0.02, h)).add(vec3(0.42, 0.3, 0.26).mul(glowAmt));
  }
  const skyGeo = keep(new THREE.SphereGeometry(500, 48, 24));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(keep(new THREE.SphereGeometry(50, 32, 16)), skyMat));

  const fog = new THREE.Fog(new THREE.Color(0.3, 0.38, 0.5), 45, 230);
  scene.fog = fog;
  scene.add(new THREE.HemisphereLight(0xa9c1de, 0x2a313d, 1.7));
  const moon = new THREE.DirectionalLight(0xe2e8ff, 1.2);
  moon.position.copy(at(120, -40, 45));
  moon.target.position.copy(W);
  scene.add(moon, moon.target);

  // ground: pale stone, fades into the fog at the edge of the city
  const groundMat = keep(
    new THREE.MeshStandardNodeMaterial({ color: 0x8796a4, roughness: 0.93, metalness: 0 }),
  );
  const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(160, 96)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const brass = keep(new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.34 }));

  // cheap far glass: reflections + fresnel opacity, no transmission (品質プリセット: 遠景のガラスは安価な表現)
  const cheapGlass = (color: number, rim: number): THREE.MeshStandardNodeMaterial => {
    const m = keep(
      new THREE.MeshStandardNodeMaterial({
        color,
        roughness: 0.06,
        metalness: 0,
        transparent: true,
        depthWrite: false,
      }),
    );
    const facing = abs(dot(normalView, positionView.normalize().negate()));
    const fres = pow(float(1).sub(facing), 2.2);
    m.opacityNode = mix(float(0.2), float(0.88), fres);
    m.emissiveNode = vec3(0.32, 0.42, 0.5).mul(fres.mul(rim));
    return m;
  };

  // the city: bubble clusters (形のルール: 建物は泡の集合) around the lighthouse
  const rand = rng(20261021);
  const bubbles: { p: THREE.Vector3; r: number }[] = [];
  const clusters = 26;
  for (let k = 0; k < clusters; k++) {
    const a = (k / clusters) * Math.PI * 2 + rand() * 0.2;
    const rad = 11 + rand() * 25;
    const c = new THREE.Vector3(Math.sin(a) * rad, 0, Math.cos(a) * rad);
    if (c.distanceTo(W) < 11) continue;
    const main = 2.2 + rand() * 2.6;
    const count = 2 + Math.floor(rand() * 4);
    bubbles.push({ p: c.clone().setY(main * (0.3 + rand() * 0.25)), r: main });
    for (let i = 0; i < count; i++) {
      const r = main * (0.35 + rand() * 0.45);
      const o = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5)
        .normalize()
        .multiplyScalar(main * (0.55 + rand() * 0.4));
      bubbles.push({
        p: c
          .clone()
          .add(o)
          .setY(r * (0.3 + rand() * 0.7) + (rand() < 0.3 ? main * 0.7 : 0)),
        r,
      });
    }
  }
  // the lighthouse (灯塔): stacked bubbles, a brass spire, the great orb on top
  const tower = [
    [4.2, 2.0],
    [3.1, 6.1],
    [2.3, 9.3],
    [1.7, 11.9],
  ] as const;
  for (const [r, y] of tower) bubbles.push({ p: new THREE.Vector3(0, y, 0), r });
  // draw far → near as seen from the miniature view, so the transparent bubbles blend in order
  const viewFrom = at(-99, 0, 79.5);
  bubbles.sort((x, y) => y.p.distanceToSquared(viewFrom) - x.p.distanceToSquared(viewFrom));
  const bubbleGeo = keep(new THREE.SphereGeometry(1, 32, 20));
  const city = new THREE.InstancedMesh(bubbleGeo, cheapGlass(0xdce8f0, 0.9), bubbles.length);
  const m4 = new THREE.Matrix4();
  const noTurn = new THREE.Quaternion();
  bubbles.forEach((b, i) => {
    city.setMatrixAt(i, m4.compose(b.p, noTurn, new THREE.Vector3(b.r, b.r, b.r)));
  });
  city.computeBoundingSphere();
  scene.add(city);
  // brass rings where the bubbles meet the ground
  const grounded = bubbles.filter((b) => b.p.y < b.r * 0.95 && b.p.y > 0);
  const ringGeo = keep(new THREE.TorusGeometry(1, 0.02, 6, 64));
  const rings = new THREE.InstancedMesh(ringGeo, brass, grounded.length);
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  grounded.forEach((b, i) => {
    const rr = Math.sqrt(b.r * b.r - b.p.y * b.p.y);
    rings.setMatrixAt(
      i,
      m4.compose(new THREE.Vector3(b.p.x, 0.04, b.p.z), flat, new THREE.Vector3(rr, rr, rr * 3)),
    );
  });
  rings.computeBoundingSphere();
  scene.add(rings);
  const spire = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.3, 4.4, 12)), brass);
  spire.position.set(0, 14.6, 0);
  scene.add(spire);
  const great = new THREE.Mesh(keep(new THREE.SphereGeometry(2.5, 48, 32)), cheapGlass(0xeaf3f8, 1.6));
  great.position.set(0, 19.2, 0);
  scene.add(great);
  const greatRing = new THREE.Mesh(keep(new THREE.TorusGeometry(2.75, 0.05, 8, 96)), brass);
  greatRing.position.copy(great.position);
  greatRing.rotation.set(1.2, 0.3, 0);
  scene.add(greatRing);

  // the workshop: a glass dome with an open oculus, brass ribs, a workbench, a furnace, a milk-glass lamp
  const domeCentre = at(0, 0, 1);
  const domeR = 6;
  const oculus = 0.2;
  const domeGeo = keep(
    new THREE.SphereGeometry(domeR, 72, 36, 0, Math.PI * 2, oculus, Math.PI / 2 + 0.2 - oculus),
  );
  const domeMat = cheapGlass(0xe4eef4, 0.6);
  domeMat.side = THREE.DoubleSide;
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.copy(domeCentre);
  scene.add(dome);
  {
    const ribs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 24; j++) {
        const phi = oculus + ((Math.PI / 2 + 0.18 - oculus) * j) / 24;
        pts.push(new THREE.Vector3(Math.sin(phi) * domeR, Math.cos(phi) * domeR, 0));
      }
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.04, 6, false);
      // keep the ribs off the line of sight from the bench to the lighthouse
      g.rotateY(Math.atan2(-f.z, f.x) + Math.PI / 8 + (i / 8) * Math.PI * 2);
      ribs.push(g);
    }
    const ribGeo = keep(mergeGeometries(ribs));
    for (const g of ribs) g.dispose();
    const ribMesh = new THREE.Mesh(ribGeo, brass);
    ribMesh.position.copy(domeCentre);
    scene.add(ribMesh);
    const ocR = Math.sin(oculus) * domeR;
    const ocRing = new THREE.Mesh(keep(new THREE.TorusGeometry(ocR, 0.06, 8, 48)), brass);
    ocRing.position.copy(domeCentre).add(new THREE.Vector3(0, Math.cos(oculus) * domeR, 0));
    ocRing.rotation.x = Math.PI / 2;
    scene.add(ocRing);
    const baseR = Math.sqrt(domeR * domeR - 1);
    const baseRing = new THREE.Mesh(keep(new THREE.TorusGeometry(baseR, 0.07, 8, 96)), brass);
    baseRing.position.copy(W).setY(0.05);
    baseRing.rotation.x = Math.PI / 2;
    scene.add(baseRing);
    const floor = new THREE.Mesh(
      keep(new THREE.CircleGeometry(baseR, 64)),
      keep(new THREE.MeshStandardNodeMaterial({ color: 0xa3afb9, roughness: 0.55, metalness: 0 })),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(W).setY(0.02);
    scene.add(floor);
  }
  const wood = keep(new THREE.MeshStandardNodeMaterial({ color: 0x5f4a3b, roughness: 0.78, metalness: 0 }));
  const bench = new THREE.Group();
  const top = new THREE.Mesh(keep(new RoundedBoxGeometry(2.6, 0.1, 0.95, 3, 0.04)), wood);
  top.position.y = 0.9;
  bench.add(top);
  for (const sx of [-1.05, 1.05]) {
    const leg = new THREE.Mesh(keep(new RoundedBoxGeometry(0.12, 0.86, 0.78, 2, 0.04)), wood);
    leg.position.set(sx, 0.43, 0);
    bench.add(leg);
  }
  const pipe = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.018, 0.018, 1.5, 8)), brass);
  pipe.rotation.z = Math.PI / 2 - 0.08;
  pipe.position.set(-0.15, 0.97, 0.28);
  bench.add(pipe);
  // a few blown vessels on the bench: near transmission glass, kept to a handful (性能の目標と予算)
  const vesselMat = keep(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xffffff,
      roughness: 0,
      metalness: 0,
      transmission: 1,
      ior: 1.5,
      thickness: 0.08,
      attenuationColor: new THREE.Color(0xdaf2e6),
      attenuationDistance: 0.5,
    }),
  );
  const profiles: [number, number][][] = [
    [
      [0.001, 0],
      [0.13, 0.02],
      [0.16, 0.12],
      [0.12, 0.24],
      [0.05, 0.3],
      [0.045, 0.42],
      [0.06, 0.44],
    ],
    [
      [0.001, 0],
      [0.09, 0.01],
      [0.15, 0.09],
      [0.14, 0.18],
      [0.06, 0.24],
      [0.04, 0.36],
    ],
    [
      [0.001, 0],
      [0.07, 0.005],
      [0.09, 0.12],
      [0.06, 0.3],
      [0.08, 0.52],
      [0.1, 0.56],
    ],
  ];
  [-0.75, -0.2, 0.62].forEach((x, i) => {
    const prof = profiles[i % profiles.length] ?? [];
    const g = keep(
      new THREE.LatheGeometry(
        prof.map(([px, py]) => new THREE.Vector2(px, py)),
        40,
      ),
    );
    const v = new THREE.Mesh(g, vesselMat);
    v.position.set(x, 0.95, -0.12 + (i % 2) * 0.12);
    bench.add(v);
  });
  bench.position.copy(at(1.7, 0.2, 0));
  bench.lookAt(bench.position.clone().add(f));
  scene.add(bench);

  const furnace = new THREE.Group();
  const kiln = new THREE.Mesh(
    keep(new THREE.SphereGeometry(1.05, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2)),
    keep(new THREE.MeshStandardNodeMaterial({ color: 0x4a4440, roughness: 0.9, metalness: 0 })),
  );
  kiln.scale.set(1, 1.2, 1);
  furnace.add(kiln);
  const mouth = new THREE.Mesh(
    keep(new THREE.CircleGeometry(0.3, 32)),
    keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(3.2, 1.4, 0.45) })),
  );
  mouth.position.set(0, 0.5, 1.07);
  mouth.rotation.x = -0.2;
  furnace.add(mouth);
  const fire = new THREE.PointLight(0xff8a40, 18, 9, 2);
  fire.position.set(0, 0.7, 1.3);
  furnace.add(fire);
  furnace.position.copy(at(2.4, -3.3, 0));
  furnace.lookAt(at(-0.5, 0, 0).setY(0));
  scene.add(furnace);

  const lamp = new THREE.Mesh(
    keep(new THREE.SphereGeometry(0.2, 32, 16)),
    keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(2.4, 2.1, 1.7) })),
  );
  lamp.position.copy(at(0.2, 3.1, 2.6));
  scene.add(lamp);
  const lampRod = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 0.01, 2.0, 6)), brass);
  lampRod.position.copy(lamp.position).add(new THREE.Vector3(0, 1.1, 0));
  scene.add(lampRod);
  const lampLight = new THREE.PointLight(0xffe0b8, 6, 9, 2);
  lampLight.position.copy(lamp.position);
  scene.add(lampLight);

  // the dive path: from the miniature view over the city, down through the oculus, to standing at the bench
  const posCurve = new THREE.CatmullRomCurve3(
    [at(-99, 0, 79.5), at(-38, 1.5, 33), at(-0.5, 0.1, 10.2), at(-1.1, 0.1, 3.7), at(-1.8, 0.25, EYE_HEIGHT)],
    false,
    'centripetal',
  );
  const lookCurve = new THREE.CatmullRomCurve3(
    [new THREE.Vector3(0, 2, 0), at(9, 0, 0), at(3.5, 0, -2.2), at(6, 0, 0.9), at(8, 0, 1.4)],
    false,
    'centripetal',
  );

  const camera = new THREE.PerspectiveCamera(MINIATURE_FOV, 1, 0.05, 1200);

  return {
    scene,
    camera,
    skyScene,
    pivot: new THREE.Vector3(0, 0, 0),
    pose(u, outPos, outTarget) {
      const t = Math.min(1, Math.max(0, u));
      posCurve.getPoint(t, outPos);
      lookCurve.getPoint(t, outTarget);
      // the haze is set for standing in the town; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 40);
      fog.near = 45 + away;
      fog.far = 230 + away * 1.6;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      city.dispose();
      rings.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * The placeholder world as a DiveWorld: no play of its own, it is just drawn once the dive has landed.
 * Its reflections come from its own sky, built while loading.
 */
function asDiveWorld(renderer: THREE.WebGPURenderer, world: GameWorld): DiveWorld {
  let env: THREE.RenderTarget | null = null;
  return {
    scene: world.scene,
    camera: world.camera,
    pivot: world.pivot,
    miniatureFov: MINIATURE_FOV,
    standingFov: GAME_FOV,
    pose: (u, outPos, outTarget) => world.pose(u, outPos, outTarget),
    prepare() {
      const pmrem = new THREE.PMREMGenerator(renderer);
      env = pmrem.fromScene(world.skyScene, 0.02);
      world.scene.environment = env.texture;
      pmrem.dispose();
    },
    warm: () => renderer.render(world.scene, world.camera),
    update() {},
    render: () => renderer.render(world.scene, world.camera),
    setPlaying() {},
    resize() {},
    dispose() {
      world.dispose();
      env?.dispose();
    },
  };
}

// In this sandbox Esc in the workshop plays the dive back to home (the real game opens the pause screen).
const create: SceneFactory = async (ctx) =>
  createHomeDive(ctx, asDiveWorld(ctx.renderer, createGameWorld()), { rewindFromGame: true });

export default create;
