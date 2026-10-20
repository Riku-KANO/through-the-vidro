import {
  exp,
  float,
  max,
  normalize,
  positionGeometry,
  screenSize,
  screenUV,
  sin,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { HOME_COMPOSITION } from './choreography';
import { glassShade, type LensUniforms } from './lens';

export interface Membrane {
  mesh: THREE.Mesh;
  /** 0 = hidden (the orb is on screen), 1 = this image covers the screen. */
  opacity: THREE.UniformNode<'float', number>;
  /** Outer camera distance from the orb centre (the orb surface is reconstructed analytically). */
  cameraDistance: THREE.UniformNode<'float', number>;
  /** 1 = glass surface still in front of us, 0 = only the game image. */
  surface: THREE.UniformNode<'float', number>;
  ripple: THREE.UniformNode<'float', number>;
  ringRadius: THREE.UniformNode<'float', number>;
  dispose(): void;
}

/**
 * The full-screen image of the dive. Once the orb fills the screen it takes over from the orb with the
 * same shading (the orb's surface is recomputed per pixel from the camera distance), then the refraction
 * and the glass surface relax until it is exactly the game image (トランジション設計 > 遷移の一覧:
 * 玉越しに描いていた映像を、画面全体の描画へ連続的に切り替える).
 */
export function createMembrane(inner: THREE.Texture, lens: LensUniforms): Membrane {
  const opacity = uniform(0);
  const cameraDistance = uniform(HOME_COMPOSITION.cameraDistance);
  const surface = uniform(1);
  const ripple = uniform(0);
  const ringRadius = uniform(0);
  const R = HOME_COMPOSITION.orbRadius;

  const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)));
  const viewDir = normalize(vec3(ndc.x.div(lens.proj.x), ndc.y.div(lens.proj.y), -1));
  // ray from the camera to the near side of the orb, centre on the view axis
  const d = max(cameraDistance, float(R * 1.0001));
  const b = d.mul(viewDir.z.negate());
  const disc = max(b.mul(b).sub(d.mul(d).sub(R * R)), float(0));
  const hit = viewDir.mul(b.sub(disc.sqrt()));
  const centre = vec3(0, 0, d.negate());
  const normal = normalize(hit.sub(centre));

  // the ripple of passing through the surface: a ring running outwards from the middle
  const aspect = screenSize.x.div(screenSize.y);
  const q = ndc.mul(vec2(aspect, 1));
  const r = q.length();
  const k = r.sub(ringRadius);
  const env = exp(k.mul(k).negate().div(0.035));
  const wave = sin(k.mul(30)).mul(env).mul(ripple).mul(0.022);
  const dir = q.div(max(r, float(1e-3)));
  const extraShift = dir.mul(wave).mul(vec2(1, -1));

  const shaded = glassShade({
    inner,
    lens,
    viewDir,
    normal,
    local: normal,
    surface,
    extraShift,
  });
  const rim = vec3(0.86, 1, 0.94).mul(env.mul(ripple).mul(0.1));

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.colorNode = shaded.add(rim);
  material.opacityNode = opacity;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  mesh.name = 'dive-membrane';

  return {
    mesh,
    opacity,
    cameraDistance,
    surface,
    ripple,
    ringRadius,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
