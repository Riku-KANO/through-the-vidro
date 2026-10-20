import {
  abs,
  bool,
  cos,
  dot,
  exp,
  Fn,
  float,
  If,
  length,
  materialEmissive,
  mix,
  normalView,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  renderGroup,
  select,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Vec3 } from './footing';
import { clipFor, type LayerKind, layerMask } from './layers';
import { MAX_SPHERES } from './materialize';

/** One materializing sphere as the renderer sees it. */
export interface FieldSphere {
  center: Vec3;
  radius: number;
  /** Brightness of its boundary film (materialize.boundaryGlow). */
  glow: number;
}

/** 朝の光: warm white for the boundary film and the cut edges (アートディレクション > 光と時間帯). */
const GLOW_COLOR = new THREE.Color(1.0, 0.8, 0.52);
/** Width of the bright seam where a surface is cut by a sphere, in metres. */
const SEAM_WIDTH = 0.045;
/** Width of the soft halo around the seam. */
const HALO_WIDTH = 0.4;
/** HDR strength of the seam before tone mapping. */
const SEAM_INTENSITY = 5;
const FAR = 1e4;

type MaskedMaterial = THREE.NodeMaterial & { emissiveNode: unknown };

/**
 * The materialized field: up to 3 spheres (技術設計 > 裏の層の実装 > 実体化) handed to every layered
 * material as shared uniforms. Surface objects are not drawn inside the spheres, back objects are
 * drawn only inside, and every cut surface glows along the boundary. The boundary itself is drawn
 * as a thin luminous film (membrane meshes, main view only).
 *
 * While the peek image is rendered, `setPeekPass(true)` lifts the cut so the whole back layer shows.
 */
export class LayerField {
  readonly membranes: THREE.Mesh[] = [];

  private readonly sphereUniforms = Array.from({ length: MAX_SPHERES }, () =>
    uniform(new THREE.Vector4(0, -FAR, 0, 0)).setGroup(renderGroup),
  );
  private readonly glowUniform = uniform(new THREE.Vector3()).setGroup(renderGroup);
  // Per-object group on purpose: shared (render group) buffers are not refreshed between the two
  // render calls of one frame, so the peek pass would not see the toggle.
  private readonly peekPassUniform = uniform(0);
  private readonly membraneGlow = Array.from({ length: MAX_SPHERES }, () => uniform(0));
  private readonly patched = new Map<THREE.Material, Map<LayerKind, THREE.Material>>();
  private readonly owned: THREE.Material[] = [];
  private readonly membraneGeometry = new THREE.SphereGeometry(1, 72, 36);

  /** vec2(signed distance to the union of spheres, glow of the nearest sphere) at the fragment. */
  private readonly fieldNode = Fn(() => {
    const d = float(FAR).toVar();
    const g = float(0).toVar();
    const glows = [this.glowUniform.x, this.glowUniform.y, this.glowUniform.z];
    this.sphereUniforms.forEach((s, i) => {
      const di = select(s.w.greaterThan(0), length(positionWorld.sub(s.xyz)).sub(s.w), float(FAR));
      If(di.lessThan(d), () => {
        d.assign(di);
        g.assign(glows[i] ?? 0);
      });
    });
    return vec2(d, g);
  })();

  /** Seam light on every layered surface, off while the peek image renders. */
  private readonly seamNode = Fn(() => {
    const d = this.fieldNode.x;
    const band = exp(d.div(SEAM_WIDTH).pow(2).negate()).add(exp(d.div(HALO_WIDTH).pow(2).negate()).mul(0.18));
    return vec3(GLOW_COLOR.r, GLOW_COLOR.g, GLOW_COLOR.b)
      .mul(band.mul(this.fieldNode.y).mul(SEAM_INTENSITY))
      .mul(float(1).sub(this.peekPassUniform));
  })();

  constructor() {
    for (let i = 0; i < MAX_SPHERES; i++) this.membranes.push(this.createMembrane(i));
  }

  /**
   * Puts `root` and all its descendants on a layer and makes their materials obey the field.
   * A material shared by two kinds is cloned for the second kind.
   */
  assign(root: THREE.Object3D, kind: LayerKind): void {
    root.traverse((o) => {
      o.layers.mask = layerMask(kind);
      if (o instanceof THREE.Mesh) {
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => this.patch(m, kind))
          : this.patch(o.material, kind);
      }
    });
  }

  /** Updates the spheres (at most 3; extra entries are ignored). Allocation-free. */
  setSpheres(spheres: readonly FieldSphere[]): void {
    for (let i = 0; i < MAX_SPHERES; i++) {
      const s = spheres[i];
      const u = this.sphereUniforms[i];
      const membrane = this.membranes[i];
      const mg = this.membraneGlow[i];
      if (!u || !membrane || !mg) continue;
      if (s && s.radius > 0) {
        u.value.set(s.center[0], s.center[1], s.center[2], s.radius);
        membrane.position.set(s.center[0], s.center[1], s.center[2]);
        membrane.scale.setScalar(s.radius);
        membrane.visible = true;
        mg.value = s.glow;
      } else {
        u.value.set(0, -FAR, 0, 0);
        membrane.visible = false;
        mg.value = 0;
      }
      this.glowUniform.value.setComponent(i, s && s.radius > 0 ? s.glow : 0);
    }
  }

  /** True while the peek image is drawn: back objects are shown whole and seams are dark. */
  setPeekPass(on: boolean): void {
    this.peekPassUniform.value = on ? 1 : 0;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.membraneGeometry.dispose();
    for (const m of this.membranes) (m.material as THREE.Material).dispose();
    this.patched.clear();
  }

  private patch(material: THREE.Material, kind: LayerKind): THREE.Material {
    let byKind = this.patched.get(material);
    const cached = byKind?.get(kind);
    if (cached) return cached;
    if (!(material instanceof THREE.NodeMaterial)) {
      throw new Error(`LayerField: ${material.type} is not a node material; use the *NodeMaterial classes`);
    }
    const target = (byKind && byKind.size > 0 ? material.clone() : material) as MaskedMaterial;
    if (target !== material) this.owned.push(target);
    const clip = clipFor(kind, 'main');
    const d = this.fieldNode.x;
    const mask =
      clip === 'hide-inside'
        ? d.greaterThan(0)
        : clip === 'hide-outside'
          ? d.lessThan(0).or(this.peekPassUniform.greaterThan(0.5))
          : null;
    if (mask)
      target.maskNode = target.maskNode ? bool(target.maskNode as THREE.Node<'bool'>).and(mask) : mask;
    const hasEmissiveColor = (target as { emissive?: { isColor?: boolean } }).emissive?.isColor === true;
    const base =
      (target.emissiveNode as THREE.Node<'vec3'> | null) ?? (hasEmissiveColor ? materialEmissive : vec3(0));
    target.emissiveNode = vec3(base).add(this.seamNode);
    target.needsUpdate = true;
    if (!byKind) {
      byKind = new Map();
      this.patched.set(material, byKind);
    }
    byKind.set(kind, target);
    return target;
  }

  private createMembrane(index: number): THREE.Mesh {
    const glow = this.membraneGlow[index] ?? uniform(0);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    material.fog = false;
    // Fresnel-like rim: the film is nearly invisible face-on and bright at grazing angles.
    const facing = abs(dot(normalView, positionViewDirection));
    const rim = pow(float(1).sub(facing), 3);
    // A faint thin-film shimmer (虹色ガラス: 裏の層の物) mixed into the warm light.
    const film = cos(vec3(0, 2.1, 4.2).add(facing.mul(7)))
      .mul(0.5)
      .add(0.5);
    const tint = mix(vec3(GLOW_COLOR.r, GLOW_COLOR.g, GLOW_COLOR.b), film, 0.3);
    // Fade the film where it passes close to the eye, so a sphere sweeping past the camera does not
    // wash the view white (画面をうるさくしない).
    const near = smoothstep(0.35, 1.6, length(positionView));
    material.colorNode = vec4(tint.mul(rim.mul(0.75).add(0.012)).mul(glow).mul(near), 1);
    // Only the outer boundary of the union: parts of a film inside another sphere are not drawn.
    material.maskNode = this.fieldNode.x.greaterThan(-0.03);
    const mesh = new THREE.Mesh(this.membraneGeometry, material);
    mesh.name = `layer-membrane-${index}`;
    mesh.visible = false;
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    return mesh;
  }
}
