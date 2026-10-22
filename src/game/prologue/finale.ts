import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createBrassMaterial, createGlass } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import { glassEase } from '../../layers/tween';
import { GATE, GATE_OPEN_DEG, GATE_SPRINGS, LAMP_HEIGHT, LAMP_POST_RADIUS, LOOKOUT, ROAD } from './layout';

/**
 * 序章の締め (S-34; 発案者 2026-10-22, 2026-10-23): the light drop taken, its light runs back out of the vidro across the
 * bridge and fixes it onto the surface (定着: the drawing is LayerField's settled region, the rule session.ts); when the light
 * has reached the far shore, the gate at its back opens (the reason it opens is seen: パズル設計 > 原則4). Past it, the first
 * 4 m of the slope down to the plaza (S-35), with a provisional railing over the mist and the town (門の先の道).
 *
 * This file is how that looks and moves: the gate (its posts and arch as S-06 drew them, and two brass leaves that swing
 * open about the posts), its keystone lamp, the lookout's railing and lamps, and the curves the room plays them on.
 * Built from code like the rest of the way (room-art.ts), on the shared layer; Blender takes it over with the area's art.
 * アートディレクション > 形のルール: straight and thin lines only as brass frames (the bars, the rails), everything else round
 * (the arch, the rings, the globes). Values here are 仮 (process/slices/S-34.md).
 */

/** 0..1 → the leaves' swing in radians, on the game's one curve (遷移のルール5: ゆっくり始まって粘りながら止まる). */
export function gateAngle(progress: number): number {
  return ((GATE_OPEN_DEG * Math.PI) / 180) * glassEase(Math.min(1, Math.max(0, progress)));
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 0..1 → how bright the band of light at the settling front is: it comes up as the light leaves the vidro, is full while it
 * crosses and is gone as it reaches the far shore (so nothing is left glowing after: 画面をうるさくしない).
 */
export function settleGlow(progress: number): number {
  const u = Math.min(1, Math.max(0, progress));
  if (u <= 0 || u >= 1) return 0;
  return smooth(0, 0.15, u) * (1 - smooth(0.78, 1, u));
}

/** 仮: the keystone lamp before the drop (a faint ember: 乳白ガラスは内側から光る) and lit (a light source: it blooms). */
const KEYSTONE_DIM = 0.12;
const KEYSTONE_LIT = 1;

export interface FinaleArt {
  /** The gate's two leaves, each turned about its hinge (setGate). */
  readonly leaves: { readonly left: THREE.Object3D; readonly right: THREE.Object3D };
  /** Swings both leaves `angle` radians from shut (the same angle as physics.ts GateLeaves). */
  setGate(angle: number): void;
  /** 0..1: the keystone lamp lights as the gate opens. */
  setKeystone(lit: number): void;
  dispose(): void;
}

/** Builds the gate, its keystone lamp and the lookout into `scene`, every piece through `field` (shared layer). */
export function buildFinale(quality: QualityPreset, field: LayerField, scene: THREE.Object3D): FinaleArt {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!g) throw new Error('mergeGeometries failed');
    return keep(g);
  };
  const put = (o: THREE.Object3D): void => {
    field.assign(o, 'shared');
    scene.add(o);
  };
  const brass = keep(createBrassMaterial());
  const lampMilk = keep(
    createGlass('milky', quality, { glow: { color: 0xffbf80, intensity: 1.5 } }).material,
  );
  const keystoneMilk = keep(
    createGlass('milky', quality, { glow: { color: 0xffc58a, intensity: 2.4 } }).material,
  );
  const keystone = uniform(KEYSTONE_DIM);
  const km = keystoneMilk as THREE.MeshPhysicalNodeMaterial;
  km.emissiveNode = (km.emissiveNode as THREE.Node<'vec3'>).mul(keystone);

  const hw = GATE.halfWidth;
  /** The arch's underside at |x| (the arch tube is 5 cm thick). */
  const archAt = (ax: number): number => GATE_SPRINGS + 0.6 * Math.sqrt(Math.max(0, hw * hw - ax * ax));

  // ---- the gate's frame: posts and arch as S-06 drew them, with the leaves' hinges and the keystone's cup ----------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const x of [-hw, hw]) {
      parts.push(
        new THREE.CylinderGeometry(0.06, 0.07, GATE_SPRINGS, 12).translate(x, GATE_SPRINGS / 2, GATE.z),
      );
      // the hinges' knuckles, where the leaves hang
      for (const y of [0.32, 1.5])
        parts.push(new THREE.CylinderGeometry(0.034, 0.034, 0.13, 10).translate(x, y, GATE.z));
    }
    const arch = new THREE.TorusGeometry(hw, 0.05, 10, 64, Math.PI);
    arch.scale(1, 0.6, 1);
    arch.translate(0, GATE_SPRINGS, GATE.z);
    parts.push(arch);
    // a brass cup on the apex holds the keystone lamp
    parts.push(
      new THREE.LatheGeometry(
        [
          [0.0, 0],
          [0.035, 0],
          [0.05, 0.03],
          [0.075, 0.07],
          [0.07, 0.075],
        ].map(([x = 0, y = 0]) => new THREE.Vector2(x, y)),
        24,
      ).translate(0, GATE.height + 0.03, GATE.z),
    );
    const frame = new THREE.Mesh(merged(parts), brass);
    frame.castShadow = true;
    put(frame);
    const lamp = new THREE.Mesh(keep(new THREE.SphereGeometry(0.075, 24, 12)), keystoneMilk);
    lamp.position.set(0, GATE.height + 0.15, GATE.z);
    put(lamp);
  }

  // ---- the leaves: brass frames with bars, a rail and a ring, the top following the arch ----------------------------
  const leaf = (side: 1 | -1): THREE.Object3D => {
    // in the pivot's frame: the hinge at the origin, the leaf running along -side·x toward the middle
    const top = (u: number): number => archAt(hw - u) - 0.06;
    const parts: THREE.BufferGeometry[] = [];
    const bar = (u: number, r: number): void => {
      const h = top(u) - 0.05;
      parts.push(new THREE.CylinderGeometry(r, r, h, 8).translate(-side * u, 0.05 + h / 2, 0));
    };
    const from = 0.03;
    const to = hw - 0.016;
    bar(from, 0.022);
    bar(to, 0.02);
    for (let i = 1; i < 6; i++) bar((hw * i) / 6, 0.013);
    for (const [y, r] of [
      [0.1, 0.018],
      [1.05, 0.02],
    ] as const)
      parts.push(
        new THREE.CylinderGeometry(r, r, to - from, 8)
          .rotateZ(Math.PI / 2)
          .translate(-side * (from + to) * 0.5, y, 0),
      );
    const curve = new THREE.CatmullRomCurve3(
      Array.from({ length: 25 }, (_, i) => {
        const u = from + ((to - from) * i) / 24;
        return new THREE.Vector3(-side * u, top(u), 0);
      }),
    );
    parts.push(new THREE.TubeGeometry(curve, 48, 0.016, 6, false));
    // 円: a ring on the middle bar, between the rail and the top (the two meet as a pair when shut)
    parts.push(new THREE.TorusGeometry(0.13, 0.012, 8, 40).translate(-side * hw * 0.5, 1.62, 0));
    const mesh = new THREE.Mesh(merged(parts), brass);
    // it moves: no shadow in the shadow map that is drawn once (room-art.ts)
    mesh.castShadow = false;
    const pivot = new THREE.Group();
    pivot.name = side > 0 ? 'gate-leaf-right' : 'gate-leaf-left';
    pivot.position.set(side * hw, 0, GATE.z);
    pivot.add(mesh);
    put(pivot);
    return pivot;
  };
  const right = leaf(1);
  const left = leaf(-1);

  // ---- the lookout at the road's end: a brass railing with rings, two lamps, the lip ---------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    const x0 = ROAD.minX + 0.12;
    const x1 = ROAD.maxX - 0.12;
    const z = LOOKOUT.z;
    const h = LOOKOUT.height;
    const posts = 7;
    for (let i = 0; i < posts; i++) {
      const x = x0 + ((x1 - x0) * i) / (posts - 1);
      parts.push(new THREE.CylinderGeometry(0.02, 0.026, h, 8).translate(x, h / 2, z));
      if (i < posts - 1) {
        const mid = x + (x1 - x0) / (posts - 1) / 2;
        parts.push(new THREE.TorusGeometry(0.15, 0.01, 8, 36).translate(mid, (h + 0.55) / 2, z));
      }
    }
    for (const [y, r] of [
      [h, 0.03],
      [0.55, 0.014],
      [0.1, 0.014],
    ] as const)
      parts.push(
        new THREE.CylinderGeometry(r, r, x1 - x0 + 0.06, 8)
          .rotateZ(Math.PI / 2)
          .translate((x0 + x1) / 2, y, z),
      );
    // the brass lip along the road's end (形は縁で伝える)
    parts.push(
      new THREE.CylinderGeometry(0.018, 0.018, ROAD.maxX - ROAD.minX + 0.04, 6)
        .rotateZ(Math.PI / 2)
        .translate(0, 0, ROAD.minZ - 0.01),
    );
    const globes: THREE.BufferGeometry[] = [];
    for (const x of [-LOOKOUT.lampX, LOOKOUT.lampX]) {
      parts.push(
        new THREE.CylinderGeometry(LAMP_POST_RADIUS, LAMP_POST_RADIUS * 1.5, LAMP_HEIGHT, 8).translate(
          x,
          LAMP_HEIGHT / 2,
          z,
        ),
      );
      parts.push(
        new THREE.TorusGeometry(0.11, 0.012, 6, 24).rotateX(Math.PI / 2).translate(x, LAMP_HEIGHT - 0.06, z),
      );
      globes.push(new THREE.SphereGeometry(0.12, 24, 12).translate(x, LAMP_HEIGHT + 0.04, z));
    }
    put(new THREE.Mesh(merged(parts), brass));
    put(new THREE.Mesh(merged(globes), lampMilk));
  }

  return {
    leaves: { left, right },
    setGate(angle) {
      // shut, a leaf runs toward the middle; it turns about its hinge away from the far shore (layout gateLeafDirection)
      right.rotation.y = -angle;
      left.rotation.y = angle;
    },
    setKeystone(lit) {
      const u = Math.min(1, Math.max(0, lit));
      keystone.value = KEYSTONE_DIM + (KEYSTONE_LIT - KEYSTONE_DIM) * u;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
