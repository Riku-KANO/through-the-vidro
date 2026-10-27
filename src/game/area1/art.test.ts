import { float, fog, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../core/quality';
import { LayerField } from '../../layers/field';
import { EYE_HEIGHT, FOV_DEFAULT } from '../player/constants';
import { SLOPE, slopeHeight } from '../prologue/layout';
import { type Area1Art, buildArea1, hazeOf } from './art';
import { AREA1_GATES, area1GateAngle, gateLeaves, SHORTCUT_LEGS } from './layout';

/**
 * S-36: エリア1 as drawn (area1/art.ts buildArea1), and the boxes the room tests against the view before it adds エリア1 to the
 * scene (room.ts: built from the slope's brow, added at the first frame none of `bounds` is in view).
 */
function build(): Area1Art {
  const gen = buildArea1(QUALITY_PRESETS.mid, new LayerField({ settle: 3 }), {
    coreGeometry: new THREE.SphereGeometry(0.05),
    shellGeometry: new THREE.SphereGeometry(0.1),
    shellMaterial: new THREE.MeshBasicNodeMaterial(),
  });
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/** A 16:9 view from the slope's middle line at z, turned `yaw` from straight down the way (−Z), positive to the right (west → east). */
function viewFromSlope(z: number, yaw: number): THREE.Frustum {
  const camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 16 / 9, 0.05, 420);
  const eye = new THREE.Vector3(0, slopeHeight(z) + EYE_HEIGHT, z);
  camera.position.copy(eye);
  // straight down the way is −Z; turning right (toward +X, east) by yaw
  camera.lookAt(eye.x + Math.sin(yaw) * 10, eye.y, eye.z - Math.cos(yaw) * 10);
  camera.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

describe('S-36: エリア1 as drawn, and the boxes the room adds it by', () => {
  it('the boxes hold everything drawn (so "none in view" means nothing of it is seen when it is added)', () => {
    const art = build();
    art.animate(3, 0);
    art.root.updateMatrixWorld(true);
    const outside: string[] = [];
    const p = new THREE.Vector3();
    art.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // every vertex it draws (merged meshes span several boxes) is within one of the boxes
      const pos = mesh.geometry.getAttribute('position');
      let lost = 0;
      let example = '';
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (art.bounds.some((b) => b.containsPoint(p))) continue;
        lost++;
        example ||= p
          .toArray()
          .map((v) => v.toFixed(1))
          .join(', ');
      }
      if (lost > 0) outside.push(`${mesh.name}: ${lost} of ${pos.count}, e.g. (${example})`);
    });
    expect(outside).toEqual([]);
    art.dispose();
  });

  it('S-40: from the slope’s brow down the way it is in view (the room brings it out of the haze), turned back it is not', () => {
    const art = build();
    const inView = (z: number, yaw: number) => {
      const f = viewFromSlope(z, yaw);
      return art.bounds.some((b) => f.intersectsBox(b));
    };
    // down the way, or toward the chimney and the dawn (east): in view nearly all the way down (S-36 判断待ち 1; S-40: the summit
    // and the shortcut west of it are in the picture now) — so where it is added in view it comes out of the haze
    expect(inView(SLOPE.fromZ - 2, 0)).toBe(true);
    expect(inView(SLOPE.fromZ - 2, (25 * Math.PI) / 180)).toBe(true);
    // turned back up the slope, toward the workshop: out of view (added at once there, appear 1)
    expect(inView(SLOPE.fromZ - 2, Math.PI)).toBe(false);
    art.dispose();
  });

  it('S-40: what is drawn of the north bridge, the shortcut’s stairs and its gate lies within the light’s legs (all of it settles)', () => {
    const art = build();
    art.root.updateMatrixWorld(true);
    const inLeg = (p: THREE.Vector3) =>
      SHORTCUT_LEGS.some(
        (l) =>
          p.x >= l.box.min[0] - 1e-6 &&
          p.x <= l.box.max[0] + 1e-6 &&
          p.y >= l.box.min[1] - 1e-6 &&
          p.y <= l.box.max[1] + 1e-6 &&
          p.z >= l.box.min[2] - 1e-6 &&
          p.z <= l.box.max[2] + 1e-6,
      );
    const p = new THREE.Vector3();
    let checked = 0;
    const out: string[] = [];
    art.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (
        !mesh.isMesh ||
        !['area1-back-glass', 'area1-back-rails', 'area1-shortcut-gate'].includes(mesh.name)
      )
        return;
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        // the north bridge, the ridge and the stairs (not the south bridge, not the courtyard's stair)
        if (p.x > 113.6 || p.z < -161) continue;
        checked++;
        if (!inLeg(p) && out.length < 5)
          out.push(`${mesh.name} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
      }
    });
    expect(checked).toBeGreaterThan(1000);
    expect(out).toEqual([]);
    art.dispose();
  });

  it('S-40: each part is its own entry under the root (the room shows them one at a time), holding what it warms', () => {
    const art = build();
    expect(art.entries.length).toBe(art.warm.length);
    expect(art.entries.length).toBeGreaterThan(15);
    art.entries.forEach((e, i) => {
      expect(e.parent).toBe(art.root);
      for (const o of art.warm[i] ?? []) expect(o.parent).toBe(e);
    });
    // every drop of the area is drawn, 部屋1's under its S-36 name too
    expect(Object.keys(art.drops).sort()).toEqual(['area1-room1', 'area1-room2', 'area1-room3']);
    expect(art.drop).toBe(art.drops['area1-room1']);
    art.dispose();
  });

  it('S-40: out of the haze — given the scene fog’s colour, every material of its own mixes toward it while `appear` is short', () => {
    const scene = new THREE.Scene();
    const color = vec3(0.3, 0.4, 0.5);
    scene.fogNode = fog(color, float(0.2));
    expect(hazeOf(scene)).toBe(color);
    expect(hazeOf(new THREE.Scene())).toBeNull();
    const gen = buildArea1(
      QUALITY_PRESETS.mid,
      new LayerField({ settle: 3 }),
      {
        coreGeometry: new THREE.SphereGeometry(0.05),
        shellGeometry: new THREE.SphereGeometry(0.1),
        shellMaterial: new THREE.MeshBasicNodeMaterial(),
      },
      { haze: color },
    );
    let art: Area1Art | null = null;
    for (let r = gen.next(); ; r = gen.next())
      if (r.done) {
        art = r.value;
        break;
      }
    const shell = new Set<THREE.Material>();
    let mixed = 0;
    art.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.NodeMaterial | undefined;
      if (!(o as THREE.Mesh).isMesh || !m) return;
      if (m.blending === THREE.AdditiveBlending) return;
      if (m.type === 'MeshBasicNodeMaterial' && !(m as { colorNode?: unknown }).colorNode) {
        shell.add(m);
        return;
      }
      expect(m.outputNode, `${o.name}`).not.toBeNull();
      mixed++;
    });
    expect(mixed).toBeGreaterThan(10);
    expect(art.appear.value).toBe(1);
    art.dispose();
  });
});

describe('S-41: the gates between the rooms as drawn', () => {
  it('their leaves turn as their colliders do (layout gateLeaves): shut across the way, open along its sides', () => {
    const art = build();
    const end = new THREE.Vector3();
    for (const angle of [0, 0.7, area1GateAngle(1)]) {
      art.setGates(Object.fromEntries(AREA1_GATES.map((g) => [g.id, angle])));
      art.root.updateMatrixWorld(true);
      for (const g of AREA1_GATES) {
        const leaves = gateLeaves(g, angle);
        ['west', 'east'].forEach((side, i) => {
          const leaf = leaves[i] as (typeof leaves)[0];
          const pivot = art.root.getObjectByName(`area1-gate-leaf:${g.id}:${side}`);
          expect(pivot, `${g.id} ${side}`).toBeDefined();
          // its hinge, and its far end (the pivot's local +x, the leaf's length along)
          end.set(0, 0, 0).applyMatrix4(pivot?.matrixWorld ?? new THREE.Matrix4());
          expect(end.x).toBeCloseTo(leaf.hinge[0], 6);
          expect(end.z).toBeCloseTo(leaf.hinge[1], 6);
          end.set(leaf.length, 0, 0).applyMatrix4(pivot?.matrixWorld ?? new THREE.Matrix4());
          expect(end.x, `${g.id} ${side} at ${angle}`).toBeCloseTo(
            leaf.hinge[0] + leaf.dir[0] * leaf.length,
            6,
          );
          expect(end.z, `${g.id} ${side} at ${angle}`).toBeCloseTo(
            leaf.hinge[1] + leaf.dir[1] * leaf.length,
            6,
          );
        });
      }
    }
    art.dispose();
  });
});
