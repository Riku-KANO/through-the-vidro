import { float, normalView, positionLocal, positionView } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { HOME_COMPOSITION } from './choreography';
import { glassShade, type LensUniforms } from './lens';

export interface HomeOrb {
  /** Orb and its brass ring. Tilt and rise move this group. */
  group: THREE.Group;
  orb: THREE.Mesh;
  dispose(): void;
}

/**
 * The large glass orb of the home screen. What is seen inside it is the game scene itself,
 * drawn into `inner` with the game camera (トランジション設計 > 遷移の一覧: 玉の中身は序章のシーンそのもの).
 * The thin brass ring follows 形のルール (直線と細い線は真鍮の枠だけ).
 */
export function createHomeOrb(inner: THREE.Texture, lens: LensUniforms): HomeOrb {
  const group = new THREE.Group();
  const R = HOME_COMPOSITION.orbRadius;

  const orbMaterial = new THREE.MeshBasicNodeMaterial();
  orbMaterial.colorNode = glassShade({
    inner,
    lens,
    viewDir: positionView.normalize(),
    normal: normalView,
    local: positionLocal.div(R),
    surface: float(1),
  });
  const orbGeometry = new THREE.SphereGeometry(R, 128, 96);
  const orb = new THREE.Mesh(orbGeometry, orbMaterial);
  orb.name = 'home-orb';
  group.add(orb);

  const brass = new THREE.MeshStandardNodeMaterial({ color: 0xb79a63, metalness: 1, roughness: 0.32 });
  const ringGeometry = new THREE.TorusGeometry(R * 1.13, R * 0.0075, 10, 220);
  const ring = new THREE.Mesh(ringGeometry, brass);
  ring.rotation.set(Math.PI / 2 - 0.32, 0.18, 0);
  group.add(ring);

  return {
    group,
    orb,
    dispose() {
      orbGeometry.dispose();
      orbMaterial.dispose();
      ringGeometry.dispose();
      brass.dispose();
    },
  };
}
