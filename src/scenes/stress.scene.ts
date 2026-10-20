import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  float,
  mix,
  normalView,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  texture,
  vec2,
  vec3,
  viewportSharedTexture,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';

export const title =
  'S-05 stress: estimated worst case of M0 (near/far glass, props, shadows, peek pass, post)';

/**
 * Estimated heaviest M0 view (技術設計 > 性能の目標と予算 / 1フレームの描画の流れ), built from the budget, not from art:
 *   - 20 near transmissive glass clusters (透過ガラスの同時表示: 近景で20個程度)
 *   - 100 far glass clusters on the cheap path (env reflection + haze), transmissive on high
 *   - 90 individual props, merged brass frames, a floor: ≈250 draw calls in the worst view
 *   - 3 moving orbs casting dynamic shadows (quality.dynamicShadowSize)
 *   - peek pass: shared + back layer at quality.peekScale; the hand orb blends front and back,
 *     with dispersion when the preset allows it
 *   - finishing: restrained bloom, then FXAA or SMAA per preset (画面の仕上げ)
 * Layers: 0 shared, 1 front, 2 back (the convention S-02 is expected to formalise).
 * Switches: ?peek=0 disables the peek pass. Camera motion depends only on t.
 */
const LAYER_FRONT = 1;
const LAYER_BACK = 2;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('mergeGeometries failed');
  return g;
}

function bubbleCluster(rand: () => number, count: number, w: number, h: number, size: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const r = size * (0.35 + rand() * 0.65);
    const g = new THREE.SphereGeometry(r, w, h);
    g.translate((rand() - 0.5) * size * 1.6, r + rand() * size * 1.2, (rand() - 0.5) * size * 1.6);
    parts.push(g);
  }
  return merged(parts);
}

function brassFrame(size: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const g = new THREE.TorusGeometry(size * (0.8 + i * 0.12), 0.025, 8, 96);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0.2 + i * size * 0.35, 0);
    parts.push(g);
  }
  return merged(parts);
}

function bottle(): THREE.BufferGeometry {
  const profile = [
    [0, 0],
    [0.09, 0],
    [0.1, 0.05],
    [0.1, 0.22],
    [0.05, 0.3],
    [0.035, 0.38],
    [0.04, 0.4],
    [0, 0.4],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 32);
}

const create: SceneFactory = async ({ renderer, quality, params, canvas }) => {
  const rand = seeded(7);
  const peekEnabled = params.get('peek') !== '0';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9e2e8);
  scene.fog = new THREE.Fog(0xd9e2e8, 18, 95);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };

  const pmrem = track(new THREE.PMREMGenerator(renderer));
  const envScene = new RoomEnvironment();
  scene.environment = track(pmrem.fromScene(envScene, 0.04)).texture;
  envScene.dispose();

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 220);
  camera.layers.enable(LAYER_FRONT);
  scene.add(camera);

  const sun = track(new THREE.DirectionalLight(0xfff1dc, 2.4));
  sun.position.set(12, 20, 6);
  scene.add(sun, sun.target);
  if (quality.dynamicShadowSize > 0) {
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.dynamicShadowSize, quality.dynamicShadowSize);
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    // The shadow map is drawn once per frame by the first render that needs it (here the peek pass).
    // With only layer 0 set, three copies that render's camera mask, so front casters would be missed.
    sun.shadow.camera.layers.enable(LAYER_FRONT);
  }
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x8a8478, 0.6));

  const floor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(240, 240)),
    track(new THREE.MeshStandardNodeMaterial({ color: 0xc9d1d6, roughness: 0.55 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const nearGlass = track(
    new THREE.MeshPhysicalNodeMaterial({
      roughness: 0.02,
      transmission: 1,
      ior: 1.5,
      thickness: 0.5,
      attenuationColor: new THREE.Color(0xeefaf2),
      attenuationDistance: 3,
      dispersion: quality.dispersion === 'showcase' ? 0.25 : 0,
    }),
  );
  const farGlass = track(
    quality.farGlassTransmission
      ? new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, transmission: 1, ior: 1.5, thickness: 0.3 })
      : new THREE.MeshStandardNodeMaterial({
          color: 0xf2f7fa,
          roughness: 0.05,
          metalness: 0,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        }),
  );
  const brass = track(new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.35 }));
  const milk = track(
    new THREE.MeshStandardNodeMaterial({
      color: 0xf4efe6,
      roughness: 0.6,
      emissive: new THREE.Color(0xffe2b8),
      emissiveIntensity: 0.6,
    }),
  );
  // No transmission here: see AGENTS.md (transmission into a render target of a different size than the canvas).
  const backGlass = track(
    new THREE.MeshPhysicalNodeMaterial({
      roughness: 0.1,
      transparent: true,
      opacity: 0.75,
      iridescence: 1,
      iridescenceIOR: 1.3,
      emissive: new THREE.Color(0x9fd8ff),
      emissiveIntensity: 0.3,
    }),
  );

  // Near: two rows of buildings along the avenue the camera travels.
  for (let i = 0; i < 20; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const m = new THREE.Mesh(track(bubbleCluster(rand, 10, 48, 36, 1.4)), nearGlass);
    m.position.set(side * (4 + rand() * 1.5), 0, -Math.floor(i / 2) * 6);
    m.layers.set(LAYER_FRONT);
    scene.add(m);
  }
  // Brass frames, merged per block as the Blender export would.
  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const m = new THREE.Mesh(track(brassFrame(1.6)), brass);
    m.position.set(side * 6.5, 0, -Math.floor(i / 2) * 10 - 2);
    m.castShadow = true;
    scene.add(m);
  }
  // Individual props (bottles, lamps) that are not merged: the draw-call load.
  const bottleGeo = track(bottle());
  for (let i = 0; i < 90; i++) {
    const m = new THREE.Mesh(bottleGeo, i % 3 === 0 ? milk : brass);
    const side = i % 2 === 0 ? -1 : 1;
    m.position.set(side * (2.2 + rand() * 0.8), 0, -rand() * 60);
    m.scale.setScalar(0.8 + rand() * 1.6);
    m.layers.set(LAYER_FRONT);
    scene.add(m);
  }
  // Far: rings of smaller clusters toward the horizon.
  for (let i = 0; i < 100; i++) {
    const a = rand() * Math.PI * 2;
    const r = 30 + rand() * 55;
    const m = new THREE.Mesh(track(bubbleCluster(rand, 4, 24, 16, 2.4)), farGlass);
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r - 30);
    m.layers.set(LAYER_FRONT);
    scene.add(m);
  }
  // Back layer: bridges and drops that only exist through the orb.
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(track(new THREE.SphereGeometry(0.4 + rand() * 0.5, 32, 24)), backGlass);
    m.position.set((rand() - 0.5) * 10, 0.5 + rand() * 3, -rand() * 55);
    m.layers.set(LAYER_BACK);
    scene.add(m);
  }
  // Moving orbs with dynamic shadows.
  const movers: THREE.Mesh[] = [];
  const moverGeo = track(new THREE.SphereGeometry(0.5, 64, 48));
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(moverGeo, nearGlass);
    m.castShadow = true;
    m.layers.set(LAYER_FRONT);
    movers.push(m);
    scene.add(m);
  }

  // Peek pass (1フレームの描画の流れ 4-5): back layer at peekScale; the hand orb blends it with the front view.
  const peekTarget = track(new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType }));
  const refracted = screenUV.add(normalView.xy.mul(vec2(-0.08, 0.08)));
  const backSample = texture(peekTarget.texture, refracted);
  const spread = normalView.xy.mul(0.006);
  const backRgb =
    quality.dispersion === 'none'
      ? backSample.rgb
      : vec3(
          texture(peekTarget.texture, refracted.add(spread)).r,
          backSample.g,
          texture(peekTarget.texture, refracted.sub(spread)).b,
        );
  const frontRgb = viewportSharedTexture(refracted).rgb;
  const facing = normalView.z.abs();
  const rim = float(1).sub(facing).pow(3);
  // Transparent + a late render order: the front view is copied after the opaque and transmissive objects are drawn
  // (1フレームの描画の流れ 5), not right after the clear.
  const handMat = track(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
  handMat.colorNode = mix(frontRgb, backRgb, smoothstep(0.25, 0.85, facing)).add(rim.mul(0.6));
  const hand = new THREE.Mesh(track(new THREE.SphereGeometry(0.11, 64, 48)), handMat);
  hand.position.set(0, -0.12, -0.42);
  hand.renderOrder = 1000;
  hand.layers.set(LAYER_FRONT);
  hand.visible = peekEnabled;
  camera.add(hand);

  const resizePeek = (): void => {
    peekTarget.setSize(
      Math.max(1, Math.floor(canvas.width * quality.peekScale)),
      Math.max(1, Math.floor(canvas.height * quality.peekScale)),
    );
  };
  resizePeek();

  // Finishing (画面の仕上げ): restrained bloom, AgX via renderOutput, then the preset's anti-aliasing.
  const pipeline = track(new THREE.RenderPipeline(renderer));
  const scenePass = track(pass(scene, camera));
  const color = scenePass.getTextureNode('output');
  const glow = track(bloom(color, 0.25, 0.3, 0.9));
  const graded = renderOutput(color.add(glow));
  pipeline.outputColorTransform = false;
  pipeline.outputNode = track(quality.antialias === 'smaa' ? smaa(graded) : fxaa(graded));

  return {
    scene,
    camera,
    update(_dt, t) {
      const z = 4 - ((t * 1.4) % 50);
      camera.position.set(Math.sin(t * 0.3) * 0.6, 1.6, z);
      camera.lookAt(Math.sin(t * 0.2) * 3, 1.4, z - 8);
      for (let i = 0; i < movers.length; i++) {
        const a = t * 0.6 + (i * Math.PI * 2) / 3;
        movers[i]?.position.set(Math.cos(a) * 2.2, 1.2 + Math.sin(t + i) * 0.3, z - 6 + Math.sin(a) * 2.2);
      }
      sun.target.position.set(0, 0, z - 6);
      sun.position.set(12, 20, z);
    },
    render() {
      if (peekEnabled) {
        camera.layers.set(0);
        camera.layers.enable(LAYER_BACK);
        renderer.setRenderTarget(peekTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        camera.layers.set(0);
        camera.layers.enable(LAYER_FRONT);
      }
      pipeline.render();
    },
    resize() {
      resizePeek();
    },
    dispose() {
      for (const d of disposables) d.dispose();
      renderer.shadowMap.enabled = false;
    },
  };
};

export default create;
