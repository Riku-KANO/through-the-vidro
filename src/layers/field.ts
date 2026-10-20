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
import { clipFor, type LayerKind, layerMask, peekStandInMask, viewMask } from './layers';
import { MAX_SPHERES } from './materialize';

/** One materializing sphere as the renderer sees it. */
export interface FieldSphere {
  center: Vec3;
  radius: number;
  /** Brightness of its boundary film (materialize.boundaryGlow). */
  glow: number;
}

/** 仮: warm white for the boundary film and the cut edges (キーワード「朝の光」「温度のある透明」から). */
const GLOW_COLOR = new THREE.Color(1.0, 0.8, 0.52);
/** Width of the bright seam where a surface is cut by a sphere, in metres. */
const SEAM_WIDTH = 0.045;
/** Width of the soft halo around the seam. */
const HALO_WIDTH = 0.4;
/** HDR strength of the seam before tone mapping. */
const SEAM_INTENSITY = 5;
const FAR = 1e4;
/** 仮: how strongly the cheap stand-in of a transmissive object shows in the peek image. */
const PEEK_STAND_IN_OPACITY = 0.35;

type MaskedMaterial = THREE.NodeMaterial & { emissiveNode: unknown };

type Renderable = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

/** Materials of any renderable (mesh, line, points, sprite); empty for groups, lights, cameras. */
const materialsOf = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as Partial<Renderable>).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
};
const isTransmissive = (m: THREE.Material): boolean =>
  ((m as { transmission?: number }).transmission ?? 0) > 0;

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
  /** source material → its version per layer kind */
  private readonly patched = new Map<THREE.Material, Map<LayerKind, THREE.Material>>();
  /** source material → an untouched copy taken before the first patch */
  private readonly pristine = new Map<THREE.Material, THREE.Material>();
  /** patched version → source material */
  private readonly origin = new Map<THREE.Material, THREE.Material>();
  /** source material → its peek-image stand-in (transmissive materials only) */
  private readonly standIns = new Map<THREE.Material, THREE.Material>();
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
   * The caller's material is patched in place for the first kind it meets; a material shared by
   * several kinds gets one copy per kind, each made from an untouched copy of the original.
   *
   * Transmission and the peek image: on the WebGPU path, transmission drawn into the smaller peek
   * target in the same frame invalidates the frame (three r186, found in S-05). So a back/shared
   * object with transmission is drawn by the normal view only, and the peek image draws a
   * stand-in child instead (same geometry, the same material without transmission, translucent).
   * `inPeek: false` keeps an object out of the peek image entirely.
   */
  assign(root: THREE.Object3D, kind: LayerKind, opts: { inPeek?: boolean } = {}): void {
    const standIns: [THREE.Object3D, THREE.Mesh][] = [];
    root.traverse((o) => {
      const mats = materialsOf(o);
      const transmissive = mats.some(isTransmissive);
      o.layers.mask = layerMask(kind, { transmissive: transmissive || opts.inPeek === false });
      if (mats.length > 0) {
        const r = o as Renderable;
        r.material = Array.isArray(r.material)
          ? r.material.map((m) => this.patch(m, kind))
          : this.patch(mats[0] as THREE.Material, kind);
      }
      if (transmissive && kind !== 'surface' && opts.inPeek !== false && o instanceof THREE.Mesh) {
        standIns.push([o, this.createStandIn(o, kind)]);
      }
      // The shadow map is drawn once per frame by whichever render uses it first; when the peek image
      // is drawn first its camera would decide what casts shadows. Pin shadows to the normal view.
      const shadow = (o as { shadow?: { camera?: THREE.Camera } }).shadow;
      if (shadow?.camera) shadow.camera.layers.mask = viewMask('main');
    });
    for (const [parent, twin] of standIns) parent.add(twin);
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
    this.pristine.clear();
    this.origin.clear();
    this.standIns.clear();
  }

  private createStandIn(o: THREE.Mesh, kind: LayerKind): THREE.Mesh {
    const source = materialsOf(o).map((m) => this.origin.get(m) ?? m);
    const materials = source.map((m) => {
      let standIn = this.standIns.get(m);
      if (!standIn) {
        const copy = (this.pristine.get(m) ?? m).clone() as THREE.Material & { transmission?: number };
        copy.transmission = 0;
        copy.transparent = true;
        copy.opacity = PEEK_STAND_IN_OPACITY;
        copy.depthWrite = false;
        this.owned.push(copy);
        standIn = this.patchCopy(copy, kind);
        this.standIns.set(m, standIn);
      }
      return standIn;
    });
    const twin = new THREE.Mesh(o.geometry, materials.length === 1 ? materials[0] : materials);
    twin.name = `${o.name || o.type}:peek-stand-in`;
    twin.layers.mask = peekStandInMask();
    twin.renderOrder = o.renderOrder;
    return twin;
  }

  private patch(material: THREE.Material, kind: LayerKind): THREE.Material {
    // An already patched version (the object is assigned again) stands for its source material.
    const source = this.origin.get(material) ?? material;
    let byKind = this.patched.get(source);
    const cached = byKind?.get(kind);
    if (cached) return cached;
    if (!(source instanceof THREE.NodeMaterial)) {
      throw new Error(`LayerField: ${source.type} is not a node material; use the *NodeMaterial classes`);
    }
    let pristine = this.pristine.get(source);
    if (!pristine) {
      pristine = source.clone();
      this.pristine.set(source, pristine);
      this.owned.push(pristine);
    }
    let target: THREE.Material;
    if (!byKind || byKind.size === 0) {
      target = this.patchCopy(source, kind);
    } else {
      const copy = pristine.clone();
      this.owned.push(copy);
      target = this.patchCopy(copy, kind);
    }
    if (!byKind) {
      byKind = new Map();
      this.patched.set(source, byKind);
    }
    byKind.set(kind, target);
    this.origin.set(target, source);
    return target;
  }

  /** Adds the cut, the shadow cut and the seam light to a node material (in place). */
  private patchCopy(material: THREE.Material, kind: LayerKind): THREE.Material {
    if (!(material instanceof THREE.NodeMaterial)) {
      throw new Error(`LayerField: ${material.type} is not a node material; use the *NodeMaterial classes`);
    }
    const target = material as MaskedMaterial;
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
    // Shadows always follow the normal view's cut, whichever pass draws the shadow map first.
    const shadowMask =
      clip === 'hide-inside' ? d.greaterThan(0) : clip === 'hide-outside' ? d.lessThan(0) : null;
    if (shadowMask) target.maskShadowNode = shadowMask;
    const hasEmissiveColor = (target as { emissive?: { isColor?: boolean } }).emissive?.isColor === true;
    const base =
      (target.emissiveNode as THREE.Node<'vec3'> | null) ?? (hasEmissiveColor ? materialEmissive : vec3(0));
    target.emissiveNode = vec3(base).add(this.seamNode);
    target.needsUpdate = true;
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
