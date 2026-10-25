import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../core/quality';
import { LayerField } from '../../layers/field';
import { EYE_HEIGHT, FOV_DEFAULT } from '../player/constants';
import { SLOPE, slopeHeight } from '../prologue/layout';
import { type Area1Art, buildArea1 } from './art';

/**
 * S-36: エリア1 as drawn (area1/art.ts buildArea1), and the boxes the room tests against the view before it adds エリア1 to the
 * scene (room.ts: built from the slope's brow, added at the first frame none of `bounds` is in view).
 */
function build(): Area1Art {
  const gen = buildArea1(QUALITY_PRESETS.mid, new LayerField({ settle: true }), {
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

  it('walking down the slope looking down the way, it is out of view before the slope’s foot (added there, unseen)', () => {
    const art = build();
    const inView = (z: number, yaw: number) => {
      const f = viewFromSlope(z, yaw);
      return art.bounds.some((b) => f.intersectsBox(b));
    };
    // down the way, or glancing west (the lighthouse): out of view for a stretch of the slope's lower half. Looking east
    // (toward エリア1's chimney and the dawn) it stays in view down to the plaza and beyond (S-36 判断待ち 1: from 15
    // degrees right it is out only in the plaza, from 25 degrees never)
    const outFrom = (yaw: number): number | null => {
      for (let z = SLOPE.fromZ; z >= SLOPE.toZ; z -= 1) if (!inView(z, yaw)) return z;
      return null;
    };
    for (const yaw of [-20, 0].map((d) => (d * Math.PI) / 180)) {
      const z = outFrom(yaw);
      expect(z, `yaw ${((yaw * 180) / Math.PI).toFixed(0)}°`).not.toBeNull();
      // with some of the slope still ahead (about 15 s of walking at least)
      expect((z ?? SLOPE.toZ) - SLOPE.toZ).toBeGreaterThan(20);
    }
    art.dispose();
  });
});
