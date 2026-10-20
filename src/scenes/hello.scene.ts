import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';

export const title = 'S-00 pipeline check: one transmissive glass orb over a checker floor';

/**
 * Smoke scene for the harness. Proves that transmission, AgX tone mapping and the
 * WebGPU/WebGL2 paths render. Camera motion depends only on t, so screenshots are stable.
 */
const create: SceneFactory = async ({ renderer }) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe7ec);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  envScene.dispose();

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(3, 6, 2);
  scene.add(sun);

  const checker = new THREE.DataTexture(
    new Uint8Array([230, 230, 230, 255, 160, 170, 178, 255, 160, 170, 178, 255, 230, 230, 230, 255]),
    2,
    2,
  );
  checker.magFilter = THREE.NearestFilter;
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.repeat.set(10, 10);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.needsUpdate = true;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardNodeMaterial({ map: checker, roughness: 0.8 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const glass = new THREE.MeshPhysicalNodeMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0,
    transmission: 1,
    ior: 1.5,
    thickness: 0.6,
    attenuationColor: new THREE.Color(0xe8fff4),
    attenuationDistance: 2.5,
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.6, 96, 64), glass);
  orb.position.set(0, 0.6, 0);
  scene.add(orb);

  const brass = new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.35 });
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2 + i * 0.5, 0.02, 12, 96), brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.01;
    scene.add(ring);
  }

  return {
    scene,
    camera,
    update(_dt, t) {
      const a = t * 0.25;
      camera.position.set(Math.sin(a) * 2.6, 1.6, Math.cos(a) * 2.6);
      camera.lookAt(0, 0.5, 0);
    },
    dispose() {
      pmrem.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      glass.dispose();
      brass.dispose();
      checker.dispose();
    },
  };
};

export default create;
