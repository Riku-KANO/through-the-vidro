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
  max,
  mix,
  normalView,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  renderGroup,
  select,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Vec3 } from './footing';
import { clipFor, type LayerKind, layerMask, peekStandInMask, viewMask } from './layers';
import { MAX_SPHERES } from './materialize';
import type { SettleSweep } from './settle';

/**
 * 定着 (S-34, settle.ts) as the renderer sees it: what the sweep fixes, where its front stands (along its direction, as
 * settle.ts sweepFront measures it) and how bright the band of light at the front is (0 = none).
 */
export interface SettledView {
  sweep: SettleSweep;
  front: number;
  glow: number;
}

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
/**
 * 仮 (S-34): the settling front drawn like a materializing sphere's wavefront (the seam): a thin bright line of light with a
 * soft halo before and behind it, in metres, and its HDR strength at glow 1.
 */
const SETTLE_LINE = 0.05;
const SETTLE_HALO = 0.3;
const SETTLE_HALO_SHARE = 0.08;
const SETTLE_INTENSITY = 4;
/** 仮 (S-34): the front's light is gone within the first of these distances from the eye and full beyond the second. */
const SETTLE_NEAR = [0.8, 2.6] as const;

type MaskedMaterial = THREE.NodeMaterial & { emissiveNode: unknown };

/** S-34 (S-40: one per slot): a settled region's box, its direction and front (xyz, w), and the band's brightness. */
function settleSlot() {
  return {
    min: uniform(new THREE.Vector3(FAR, FAR, FAR)).setGroup(renderGroup),
    max: uniform(new THREE.Vector3(-FAR, -FAR, -FAR)).setGroup(renderGroup),
    front: uniform(new THREE.Vector4(0, 0, -1, -FAR)).setGroup(renderGroup),
    glow: uniform(0).setGroup(renderGroup),
  };
}
type SettleSlot = ReturnType<typeof settleSlot>;
/** S-40: the slots a material reads unless told otherwise: the first (S-34's one region). */
const DEFAULT_SETTLE_SLOTS: readonly [number, number] = [0, 0];

type Renderable = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

/** Materials of any renderable (mesh, line, points, sprite); empty for groups, lights, cameras. */
const materialsOf = (o: THREE.Object3D): THREE.Material[] => {
  const m = (o as Partial<Renderable>).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
};

/** Same test as three's `useTransmission`: a transmission value or a transmission node. */
const isTransmissive = (m: THREE.Material): boolean => {
  const useTransmission = (m as { useTransmission?: unknown }).useTransmission;
  if (typeof useTransmission === 'boolean') return useTransmission;
  const t = m as { transmission?: number; transmissionNode?: unknown };
  return (t.transmission ?? 0) > 0 || (t.transmissionNode ?? null) !== null;
};

/**
 * The materialized field: up to 3 spheres (技術設計 > 裏の層の実装 > 実体化) handed to every layered
 * material as shared uniforms. Surface objects are not drawn inside the spheres, back objects are
 * drawn only inside, and every cut surface glows along the boundary. The boundary itself is drawn
 * as a thin luminous film (membrane meshes, main view only).
 *
 * While the peek image is rendered, `setPeekPass(true)` lifts the cut so the whole back layer shows.
 *
 * 定着 (S-34): built with `{ settle: true }`, the field also takes one settled region (`setSettled`, settle.ts); S-40: with
 * `{ settle: n }`, n of them at once (the prologue's bridge and エリア1's shortcut, leg after leg), each in its own slot. Behind
 * a region's front and inside its box it is as if a placed orb stood there for good, without the film or the seams: back
 * objects are drawn, surface objects are not. A band of warm light runs at each front (光が渡っていく). Without the option no
 * material carries any of it (the other scenes' shaders stay as they were; with one slot the shader is S-34's).
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
  /** source material → its peek-image stand-in material per layer kind (transmissive materials only) */
  private readonly standIns = new Map<THREE.Material, Map<LayerKind, THREE.Material>>();
  /** object → its peek-image stand-in child, and the set of stand-ins themselves */
  private readonly standInOf = new WeakMap<THREE.Object3D, THREE.Mesh>();
  private readonly standInObjects = new WeakSet<THREE.Object3D>();
  private readonly warned = new Set<string>();
  private readonly owned: THREE.Material[] = [];
  private readonly membraneGeometry = new THREE.SphereGeometry(1, 72, 36);
  /** S-34 (S-40: one per slot): each settled region's box, its direction and front (xyz, w), and the band's brightness. */
  private readonly settleSlots: SettleSlot[];
  /**
   * vec2(1 where settled else 0, the band's light) at the fragment, by the range of slots a material reads (S-40: "from-to");
   * none without the option.
   */
  private readonly settleNodes = new Map<string, THREE.Node<'vec2'>>();

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

  /**
   * @param options.settle S-34: true for one settled region, (S-40) a number for that many (0 or absent: none).
   */
  constructor(options: { settle?: boolean | number } = {}) {
    for (let i = 0; i < MAX_SPHERES; i++) this.membranes.push(this.createMembrane(i));
    const slots =
      options.settle === true
        ? 1
        : typeof options.settle === 'number'
          ? Math.max(0, Math.floor(options.settle))
          : 0;
    this.settleSlots = Array.from({ length: slots }, settleSlot);
  }

  /**
   * The settled regions' node for a material that reads slots `from`..`to` (S-40: each part of the world only the slots whose
   * light can reach it, so the prologue's materials keep S-34's one-slot shader); null without the option or for an empty
   * range. One node per range.
   */
  private settleNodeFor(range: readonly [number, number] | null): THREE.Node<'vec2'> | null {
    if (!range) return null;
    const from = Math.max(0, range[0]);
    const to = Math.min(this.settleSlots.length - 1, range[1]);
    if (to < from) return null;
    const key = `${from}-${to}`;
    const cached = this.settleNodes.get(key);
    if (cached) return cached;
    const slots = this.settleSlots.slice(from, to + 1);
    const node = Fn(() => {
      const p = positionWorld;
      // the light fades where it passes close to the eye, like the film and the lanterns (画面をうるさくしない)
      const near = smoothstep(SETTLE_NEAR[0], SETTLE_NEAR[1], length(positionView));
      let settled: THREE.Node<'float'> | null = null;
      let light: THREE.Node<'float'> | null = null;
      for (const slot of slots) {
        const inBox = step(slot.min, p).mul(step(p, slot.max));
        const box = inBox.x.mul(inBox.y).mul(inBox.z);
        const s = dot(slot.front.xyz, p);
        const behind = step(s, slot.front.w);
        const line = s.sub(slot.front.w).div(SETTLE_LINE);
        const halo = s.sub(slot.front.w).div(SETTLE_HALO);
        const band = exp(line.mul(line).negate()).add(exp(halo.mul(halo).negate()).mul(SETTLE_HALO_SHARE));
        const here = box.mul(behind);
        const lit = box.mul(band).mul(slot.glow);
        // one slot: S-34's expression exactly; more: settled where any is, their bands added
        settled = settled === null ? here : (max(settled, here) as THREE.Node<'float'>);
        light = light === null ? lit : light.add(lit);
      }
      return vec2(settled ?? float(0), (light ?? float(0)).mul(near));
    })();
    this.settleNodes.set(key, node);
    return node;
  }

  /** S-40: how many settled regions the field takes at once (0 without the option). */
  get settleSlotCount(): number {
    return this.settleSlots.length;
  }

  /**
   * Puts `root` and all its descendants on a layer and makes their materials obey the field.
   * The caller's material is patched in place for the first kind it meets; a material shared by
   * several kinds gets one copy per kind, each made from an untouched copy of the original. Those
   * copies are snapshots: later changes to the caller's material reach only the first kind's version
   * (change the material before assigning, or assign each kind its own material).
   *
   * Transmission and the peek image: on the WebGPU path, transmission drawn into the smaller peek
   * target in the same frame invalidates the frame (three r186, found in S-05). So a back/shared
   * object with transmission is drawn by the normal view only, and the peek image draws a
   * stand-in child instead (same geometry, the same material without transmission, translucent).
   * `inPeek: false` keeps an object out of the peek image entirely.
   *
   * S-40: `settleSlots` — the range of settled regions (slots, inclusive) its materials read: [0, 0] by default (S-34's one
   * region; the shader as it was). A part of the world no other light reaches reads only its own (エリア1: its shortcut's legs).
   * A material already patched for this kind keeps the range it was patched with (a drop's glass shared with the prologue).
   */
  assign(
    root: THREE.Object3D,
    kind: LayerKind,
    opts: { inPeek?: boolean; settleSlots?: readonly [number, number] } = {},
  ): void {
    const range = opts.settleSlots ?? DEFAULT_SETTLE_SLOTS;
    const standInWanted: [THREE.Mesh, boolean][] = [];
    root.traverse((o) => {
      // our own stand-ins keep their peek-only layer and material when their owner is assigned again
      if (this.standInObjects.has(o)) return;
      const mats = materialsOf(o);
      const transmissive = mats.some(isTransmissive);
      o.layers.mask = layerMask(kind, { transmissive: transmissive || opts.inPeek === false });
      if (mats.length > 0) {
        const r = o as Renderable;
        r.material = Array.isArray(r.material)
          ? r.material.map((m) => this.patch(m, kind, range))
          : this.patch(mats[0] as THREE.Material, kind, range);
      }
      if (o instanceof THREE.Mesh) {
        standInWanted.push([o, transmissive && kind !== 'surface' && opts.inPeek !== false]);
      }
      // The shadow map is drawn once per frame by whichever render uses it first; when the peek image
      // is drawn first its camera would decide what casts shadows. Pin shadows to the normal view.
      const shadow = (o as { shadow?: { camera?: THREE.Camera } }).shadow;
      if (shadow?.camera) shadow.camera.layers.mask = viewMask('main');
    });
    for (const [mesh, wanted] of standInWanted) this.syncStandIn(mesh, kind, wanted, range);
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

  /**
   * S-34: the settled region in a slot now (null: none). Needs `{ settle }` at construction; without it, or for a slot past
   * the last, this does nothing. S-40: `slot` (0 by default, S-34's one region). Allocation-free.
   */
  setSettled(view: SettledView | null, slot = 0): void {
    const u = this.settleSlots[slot];
    if (!u) return;
    if (!view) {
      u.min.value.set(FAR, FAR, FAR);
      u.max.value.set(-FAR, -FAR, -FAR);
      u.front.value.set(0, 0, -1, -FAR);
      u.glow.value = 0;
      return;
    }
    const { box, direction } = view.sweep;
    u.min.value.set(box.min[0], box.min[1], box.min[2]);
    u.max.value.set(box.max[0], box.max[1], box.max[2]);
    u.front.value.set(direction[0], direction[1], direction[2], view.front);
    u.glow.value = view.glow;
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

  /** Adds, updates or removes the peek-image stand-in child of a transmissive mesh. */
  private syncStandIn(
    o: THREE.Mesh,
    kind: LayerKind,
    wanted: boolean,
    range: readonly [number, number],
  ): void {
    const existing = this.standInOf.get(o);
    if (!wanted || o instanceof THREE.SkinnedMesh) {
      if (wanted) this.warnOnce(o, 'is skinned; its transmissive glass is left out of the peek image');
      if (existing) {
        o.remove(existing);
        this.standInOf.delete(o);
        this.standInObjects.delete(existing);
      }
      return;
    }
    const mats = materialsOf(o).map((m) => this.standInMaterial(m, kind, range));
    const material = mats.length === 1 ? (mats[0] as THREE.Material) : mats;
    if (existing) {
      existing.material = material;
      return;
    }
    let twin: THREE.Mesh;
    if (o instanceof THREE.InstancedMesh) {
      const inst = new THREE.InstancedMesh(o.geometry, material, o.count);
      inst.instanceMatrix = o.instanceMatrix;
      inst.instanceColor = o.instanceColor;
      twin = inst;
    } else {
      twin = new THREE.Mesh(o.geometry, material);
    }
    twin.name = `${o.name || o.type}:peek-stand-in`;
    twin.layers.mask = peekStandInMask();
    twin.renderOrder = o.renderOrder;
    this.standInObjects.add(twin);
    this.standInOf.set(o, twin);
    o.add(twin);
  }

  /** The same material without transmission, translucent, cut for `kind`. One per (material, kind). */
  private standInMaterial(
    material: THREE.Material,
    kind: LayerKind,
    range: readonly [number, number],
  ): THREE.Material {
    const source = this.origin.get(material) ?? material;
    let byKind = this.standIns.get(source);
    const cached = byKind?.get(kind);
    if (cached) return cached;
    const copy = (this.pristine.get(source) ?? source).clone() as THREE.Material & {
      transmission?: number;
      transmissionNode?: unknown;
    };
    copy.transmission = 0;
    copy.transmissionNode = null;
    copy.transparent = true;
    copy.opacity = PEEK_STAND_IN_OPACITY;
    copy.depthWrite = false;
    this.owned.push(copy);
    const standIn = this.patchCopy(copy, kind, range);
    if (!byKind) {
      byKind = new Map();
      this.standIns.set(source, byKind);
    }
    byKind.set(kind, standIn);
    return standIn;
  }

  private warnOnce(o: THREE.Object3D, what: string): void {
    const key = `${o.uuid}:${what}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`LayerField: "${o.name || o.type}" ${what}`);
  }

  private patch(material: THREE.Material, kind: LayerKind, range: readonly [number, number]): THREE.Material {
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
      target = this.patchCopy(source, kind, range);
    } else {
      const copy = pristine.clone();
      this.owned.push(copy);
      target = this.patchCopy(copy, kind, range);
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
  private patchCopy(
    material: THREE.Material,
    kind: LayerKind,
    range: readonly [number, number] = DEFAULT_SETTLE_SLOTS,
  ): THREE.Material {
    if (!(material instanceof THREE.NodeMaterial)) {
      throw new Error(`LayerField: ${material.type} is not a node material; use the *NodeMaterial classes`);
    }
    const target = material as MaskedMaterial;
    const clip = clipFor(kind, 'main');
    const d = this.fieldNode.x;
    // S-34: inside a settled region it is as if a placed orb stood there for good
    const settleNode = this.settleNodeFor(range);
    const settled = settleNode ? settleNode.x.greaterThan(0.5) : null;
    // (which settled regions it reads, for the record: none without the option)
    target.userData.settleSlots = settleNode ? [range[0], range[1]] : null;
    const outside = settled ? d.greaterThan(0).and(settled.not()) : d.greaterThan(0);
    const within = settled ? d.lessThan(0).or(settled) : d.lessThan(0);
    const mask =
      clip === 'hide-inside'
        ? outside
        : clip === 'hide-outside'
          ? within.or(this.peekPassUniform.greaterThan(0.5))
          : null;
    if (mask)
      target.maskNode = target.maskNode ? bool(target.maskNode as THREE.Node<'bool'>).and(mask) : mask;
    // Shadows always follow the normal view's cut, whichever pass draws the shadow map first.
    const shadowMask = clip === 'hide-inside' ? outside : clip === 'hide-outside' ? within : null;
    if (shadowMask) target.maskShadowNode = shadowMask;
    const hasEmissiveColor = (target as { emissive?: { isColor?: boolean } }).emissive?.isColor === true;
    const base =
      (target.emissiveNode as THREE.Node<'vec3'> | null) ?? (hasEmissiveColor ? materialEmissive : vec3(0));
    let light: THREE.Node<'vec3'> = this.seamNode;
    if (settleNode) {
      // nothing is cut on what is settled: no seam there; the band of light runs at the front instead
      const glow = vec3(GLOW_COLOR.r, GLOW_COLOR.g, GLOW_COLOR.b)
        .mul(settleNode.y.mul(SETTLE_INTENSITY))
        .mul(float(1).sub(this.peekPassUniform));
      light = this.seamNode.mul(float(1).sub(settleNode.x)).add(glow);
    }
    target.emissiveNode = vec3(base).add(light);
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
