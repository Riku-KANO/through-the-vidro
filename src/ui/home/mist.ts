import {
  clamp,
  dot,
  exp,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  positionGeometry,
  screenSize,
  screenUV,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

export interface Mist {
  mesh: THREE.Mesh;
  /** 1 = white-out (loading), small = wisps left low on the home screen. */
  fog: THREE.UniformNode<'float', number>;
  /** Light of the vessel spreading into the fog. */
  glow: THREE.UniformNode<'float', number>;
  glowSpread: THREE.UniformNode<'float', number>;
  glowCenter: THREE.UniformNode<'vec2', THREE.Vector2>;
  dispose(): void;
}

/**
 * The white fog of the loading screen as a full-screen shader (トランジション設計 > 遷移の一覧:
 * 霧はフルスクリーンのシェーダ。玉は最初から同じシーンにあり、霧の濃さだけを動かす).
 */
export function createMist(): Mist {
  const fog = uniform(1);
  const glow = uniform(0);
  const glowSpread = uniform(0.12);
  const glowCenter = uniform(new THREE.Vector2(0.5, 0.5));

  const aspect = screenSize.x.div(screenSize.y);
  const p = vec2(screenUV.x.mul(aspect), screenUV.y);
  const drift = vec3(p.mul(2.1).add(vec2(time.mul(0.018), time.mul(-0.006))), time.mul(0.035));
  const n = mx_fractal_noise_float(drift, 4, 2, 0.5).mul(0.5).add(0.5);
  const fine = mx_fractal_noise_float(drift.mul(3.1).add(vec3(7.3, 1.1, 0)), 2, 2, 0.5)
    .mul(0.5)
    .add(0.5);
  const cloud = clamp(n.mul(0.78).add(fine.mul(0.22)).sub(0.5).mul(0.7).add(0.5), 0, 1);

  // as the fog clears, what is left gathers low on the screen and thins out at the top
  const low = smoothstep(0.55, 1.1, screenUV.y);
  const where = mix(low.mul(1.6).add(0.03), float(1), fog);
  const density = fog.mul(float(1.65).add(cloud.sub(0.5).mul(1.5))).mul(where);
  const alpha = clamp(max(density, fog.mul(fog).mul(1.2)), 0, 1);

  const d = screenUV.sub(glowCenter).mul(vec2(aspect, 1));
  const light = exp(
    dot(d, d)
      .negate()
      .div(max(glowSpread.mul(glowSpread), float(1e-4))),
  ).mul(glow);
  // linear values well above 1: AgX compresses them, so this is what ends up near white on screen.
  // What is left on the home screen is dimmer, a blue-white haze rather than a white-out.
  const base = mix(vec3(1.9, 2.0, 2.15), vec3(3.1, 3.2, 3.3), cloud).mul(mix(float(0.32), float(1), fog));
  const color = base.add(vec3(1.0, 0.9, 0.74).mul(light).mul(2.2));

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.colorNode = color;
  material.opacityNode = clamp(alpha.add(light.mul(0.6)), 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 40;
  mesh.name = 'mist';

  return {
    mesh,
    fog,
    glow,
    glowSpread,
    glowCenter,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
