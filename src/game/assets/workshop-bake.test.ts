import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { readGlbJson } from '../../core/assets/glb';
import {
  applyLightmaps,
  BakedStandardNodeMaterial,
  lightmapOf,
  loadLightmaps,
} from '../../core/assets/lightmap';
import { convertMaterials } from '../../core/assets/materials';
import { WORKSHOP_ASSET, WORKSHOP_OBJECTS } from '../prologue/layout';
import { WORKSHOP_LIGHTS } from '../prologue/room-art';
import { parseAssetName, parseGlassMark } from './naming';
import { loadGlbInNode } from './node-glb.test-helper';
import { proceduralMaterial } from './procedural';

/**
 * S-26: the workshop's light baked by `pnpm assets` (blender/scripts/pipeline.py, common/bake.py) into the committed glb, read
 * the way the game reads it. What it shows: the opaque pieces (受け入れ条件2: the floor, the dome's brass, the furniture, the
 * furnace, the annealer, the shelf's back) carry one lightmap of the area, which is in the file as KTX2 (decided: glb の中に
 * KTX2), on their second UV; the glass and the colliders carry none; and what was baked is the dawn the game lights with
 * (the lights recorded in the scene's extras are room-art.ts's WORKSHOP_LIGHTS, in Blender's units).
 */
interface Light {
  name: string;
  type: 'SUN' | 'SPOT' | 'POINT' | 'AREA';
  color: [number, number, number];
  energy: number;
  position: [number, number, number];
  direction: [number, number, number];
  shadow: boolean;
  spot_size?: number;
  spot_blend?: number;
}
interface Bake {
  size: number;
  samples: number;
  world: {
    name: string;
    sky: { zenith: number[]; horizon_cool: number[]; horizon_warm: number[]; dawn: number[] };
    hemisphere: { sky: string; ground: string; intensity: number };
  };
  lights: Light[];
  images: { name: string; scale: number; objects: string[]; excluded_materials: string[] }[];
}
interface Json {
  scenes?: { extras?: { bake?: Bake } }[];
  nodes?: { name?: string; mesh?: number; extras?: Record<string, unknown>; children?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  materials?: { name?: string; extras?: Record<string, unknown> }[];
  textures?: {
    name?: string;
    sampler?: number;
    source?: number;
    extensions?: Record<string, { source?: number }>;
  }[];
  images?: { name?: string; mimeType?: string }[];
  samplers?: { wrapS?: number; wrapT?: number; minFilter?: number }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

const file = join(process.cwd(), 'public', WORKSHOP_ASSET);
let json: Json;
let gltf: GLTF;
let bake: Bake;
beforeAll(async () => {
  json = readGlbJson(readFileSync(file)) as Json;
  gltf = await loadGlbInNode(file);
  const b = json.scenes?.[0]?.extras?.bake;
  if (!b)
    throw new Error('the glb has no bake record (scene extras `bake`): run `pnpm assets -- --job workshop`');
  bake = b;
});

/** The named object a node belongs to (quantization can move a mesh into an unnamed child). */
function owners(): Map<number, string> {
  const nodes = json.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => {
    for (const c of n.children ?? []) parent.set(c, i);
  });
  const out = new Map<number, string>();
  nodes.forEach((_, i) => {
    for (let j: number | undefined = i; j !== undefined; j = parent.get(j)) {
      const name = nodes[j]?.name ?? '';
      if (parseAssetName(name).ok) {
        out.set(i, name);
        return;
      }
    }
  });
  return out;
}

const close = (a: readonly number[], b: readonly number[], tol: number) =>
  a.every((x, i) => Math.abs(x - (b[i] ?? Number.NaN)) <= tol);
const unit = (v: readonly number[]) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const linear = (hex: number) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/**
 * The largest difference, over the cone, between how a three SpotLight fades toward its edge (smoothstep from cos A to
 * cos(A(1 − penumbra)) over cos θ) and how a Cycles spot light with that full size and `blend` does (Blender 5.2's kernel,
 * light/spot.h: smoothstep of (cos θ − cos A) / ((1 − cos A) × blend)). Zero when the bake fades its spots as the game does.
 */
function spotMismatch(angle: number, penumbra: number, blend: number): number {
  let worst = 0;
  for (let i = 0; i <= 200; i++) {
    const c = Math.cos((angle * i) / 200);
    const three = smoothstep(Math.cos(angle), Math.cos(angle * (1 - penumbra)), c);
    const cycles = smoothstep(0, 1, (c - Math.cos(angle)) / ((1 - Math.cos(angle)) * blend));
    worst = Math.max(worst, Math.abs(three - cycles));
  }
  return worst;
}

describe('S-26 the workshop’s light, baked into the glb', () => {
  it('the opaque pieces carry one lightmap of the area and its scale; the glass and the colliders none', () => {
    const named = new Map<string, Record<string, unknown>>();
    for (const n of json.nodes ?? [])
      if (n.name && parseAssetName(n.name).ok) named.set(n.name, n.extras ?? {});
    const baked = [...named].filter(([, e]) => lightmapOf(e) !== null).map(([name]) => name);
    // 受け入れ条件2: 床、ドームの真鍮、家具、炉、徐冷炉、棚の背板
    for (const p of [
      WORKSHOP_OBJECTS.floor,
      WORKSHOP_OBJECTS.frame,
      WORKSHOP_OBJECTS.bench,
      WORKSHOP_OBJECTS.chair,
      WORKSHOP_OBJECTS.marver,
      WORKSHOP_OBJECTS.rack,
      WORKSHOP_OBJECTS.tub,
      WORKSHOP_OBJECTS.cart,
      WORKSHOP_OBJECTS.shelf,
      WORKSHOP_OBJECTS.furnace,
      WORKSHOP_OBJECTS.annealer,
      WORKSHOP_OBJECTS.shelfBoard,
    ])
      expect(baked, p.name).toContain(p.name);
    // the works of clear glass are not baked; nor any collider
    expect(baked).not.toContain(WORKSHOP_OBJECTS.shelfClear.name);
    expect(baked.filter((n) => n.endsWith('_col'))).toEqual([]);
    const names = new Set(baked.map((n) => lightmapOf(named.get(n) ?? {})?.name));
    expect([...names]).toEqual(['A0_lightmap']);
    for (const n of baked) expect(lightmapOf(named.get(n) ?? {})?.scale, n).toBeGreaterThan(0);
  });

  it('the lightmap is in the file: KTX2 (sRGB, ETC1S or UASTC), clamped at its edges, with mip levels, used by no material', () => {
    const index = (json.textures ?? []).findIndex((t) => t.name === 'A0_lightmap');
    expect(index).toBeGreaterThanOrEqual(0);
    const texture = json.textures?.[index];
    const image = json.images?.[texture?.extensions?.KHR_texture_basisu?.source ?? -1];
    expect(image?.mimeType).toBe('image/ktx2');
    const sampler = json.samplers?.[texture?.sampler ?? -1];
    expect(sampler?.wrapS).toBe(33071);
    expect(sampler?.wrapT).toBe(33071);
    // with mip levels (a mipmap filter: 9984–9987)
    expect(sampler?.minFilter).toBeGreaterThanOrEqual(9984);
    expect(sampler?.minFilter).toBeLessThanOrEqual(9987);
    // no material points at it: the game finds it by name
    const text = JSON.stringify(json.materials);
    expect(text).not.toMatch(new RegExp(`"index":${index}[,}]`));
  });

  it('baked pieces draw their opaque faces with the second UV, inside the unit square', () => {
    const own = owners();
    const glass = new Set(
      (json.materials ?? []).flatMap((m, i) => (parseGlassMark(m.name ?? '') !== null ? [i] : [])),
    );
    let checked = 0;
    (json.nodes ?? []).forEach((n, i) => {
      if (n.mesh === undefined) return;
      const name = own.get(i) ?? '';
      const extras = (json.nodes ?? []).find((x) => x.name === name)?.extras ?? {};
      if (!lightmapOf(extras)) return;
      for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
        if (p.material !== undefined && glass.has(p.material)) continue;
        expect(Object.keys(p.attributes), name).toContain('TEXCOORD_1');
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(20);
    // the UVs in the game (quantization keeps them normalized): every baked mesh's second UV inside 0..1
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const uv1 = mesh.geometry.getAttribute('uv1');
      if (!uv1) return;
      for (let k = 0; k < uv1.count; k++) {
        const u = uv1.getX(k);
        const v = uv1.getY(k);
        expect(u >= -1e-3 && u <= 1 + 1e-3 && v >= -1e-3 && v <= 1 + 1e-3, mesh.name).toBe(true);
      }
    });
  });

  it('what the game makes of it: the floor is the code’s frosted floor, baked; the fire and the glass are not', async () => {
    const scene = gltf.scene.clone(true);
    convertMaterials(scene, (m) => proceduralMaterial(m));
    const maps = await loadLightmaps({ ...gltf, scene } as GLTF);
    expect([...maps.keys()]).toEqual(['A0_lightmap']);
    applyLightmaps(scene, maps);
    const materialsOf = (name: string): THREE.Material[] => {
      const out: THREE.Material[] = [];
      scene.traverse((o) => {
        let p: THREE.Object3D | null = o;
        while (p && p.userData.name !== name) p = p.parent;
        const mesh = o as THREE.Mesh;
        if (p && mesh.isMesh) out.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
      });
      return out;
    };
    const floor = materialsOf(WORKSHOP_OBJECTS.floor.name);
    expect(floor).toHaveLength(1);
    expect(floor[0]).toBeInstanceOf(BakedStandardNodeMaterial);
    // the code's tiles: a colour node made from the floor's extras
    expect((floor[0] as BakedStandardNodeMaterial).colorNode).not.toBeNull();
    const furnace = materialsOf(WORKSHOP_OBJECTS.furnace.name);
    expect(furnace.some((m) => m instanceof BakedStandardNodeMaterial && m.name === 'A0_kiln')).toBe(true);
    expect(
      furnace.filter((m) => m.name === 'A0_fire').every((m) => !(m instanceof BakedStandardNodeMaterial)),
    ).toBe(true);
    for (const m of materialsOf(WORKSHOP_OBJECTS.shelfClear.name))
      expect(m).not.toBeInstanceOf(BakedStandardNodeMaterial);
  });

  it('records how it was baked (only what decides the light: the same bake writes the same glb)', () => {
    expect(bake.size).toBeGreaterThanOrEqual(1024);
    expect(bake.samples).toBeGreaterThanOrEqual(128);
    expect(Object.keys(bake)).not.toContain('seconds');
    expect(Object.keys(bake)).not.toContain('device');
    expect(bake.world.name).toBe('A0_dawn');
    expect(bake.images.map((i) => i.name)).toEqual(['A0_lightmap']);
    expect(bake.images[0]?.excluded_materials).toEqual(
      expect.arrayContaining(['A0_fire', 'A0_ember', 'glass_clear']),
    );
  });

  it('baked the dawn the game lights with (room-art.ts WORKSHOP_LIGHTS): the sun, the skylight’s blue, the fire', () => {
    const byType = (name: string) => bake.lights.find((l) => l.name === name);
    const sun = byType('bake_sun');
    const { sun: s, skylight: k, fire: f } = WORKSHOP_LIGHTS;
    if (!sun) throw new Error('no sun baked');
    // the direction it travels: from the sun toward its target
    expect(close(sun.direction, unit(s.target.map((t, i) => t - (s.at[i] ?? 0))), 1e-3)).toBe(true);
    expect(close(sun.color, linear(s.color), 1e-3)).toBe(true);
    // a three directional light's intensity is its illuminance: Blender's sun strength
    expect(sun.energy).toBeCloseTo(s.intensity, 4);

    const sky = byType('bake_skylight');
    if (!sky) throw new Error('no skylight baked');
    expect(close(sky.position, k.at, 1e-3)).toBe(true);
    expect(close(sky.direction, unit(k.target.map((t, i) => t - (k.at[i] ?? 0))), 1e-3)).toBe(true);
    expect(close(sky.color, k.color, 1e-3)).toBe(true);
    // three's decay of 1.4 has no match in Blender: the same light where it lands on the vidro (4π × cd × d^(2 − decay))
    const reach = Math.hypot(...k.target.map((t, i) => t - (k.at[i] ?? 0)));
    expect(sky.energy).toBeCloseTo(4 * Math.PI * k.intensity * reach ** (2 - k.decay), 1);
    expect(sky.spot_size).toBeCloseTo(2 * k.angle, 4);
    expect(spotMismatch(k.angle, k.penumbra, sky.spot_blend ?? 0)).toBeLessThan(1e-3);

    const fire = byType('bake_fire');
    if (!fire) throw new Error('no fire baked');
    expect(close(fire.position, f.at, 1e-3)).toBe(true);
    expect(close(fire.direction, unit(f.target.map((t, i) => t - (f.at[i] ?? 0))), 1e-3)).toBe(true);
    expect(close(fire.color, linear(f.color), 1e-3)).toBe(true);
    // a point or spot light's candela × 4π: Blender's watts
    expect(fire.energy).toBeCloseTo(4 * Math.PI * f.intensity, 2);
    expect(fire.spot_size).toBeCloseTo(2 * f.angle, 4);
    expect(spotMismatch(f.angle, f.penumbra, fire.spot_blend ?? 0)).toBeLessThan(1e-3);
    for (const l of bake.lights) expect(l.shadow, l.name).toBe(true);
  });

  it('baked the sky the game mirrors and the hemisphere light it fills the room with (in the world of the bake)', () => {
    const { sky, hemisphere } = WORKSHOP_LIGHTS;
    const w = bake.world;
    expect(close(w.sky.zenith, sky.zenith, 1e-5)).toBe(true);
    expect(close(w.sky.horizon_cool, sky.horizonCool, 1e-5)).toBe(true);
    expect(close(w.sky.horizon_warm, sky.horizonWarm, 1e-5)).toBe(true);
    expect(close(w.sky.dawn, sky.dawn, 1e-5)).toBe(true);
    expect(Number.parseInt(w.hemisphere.sky, 16)).toBe(hemisphere.sky);
    expect(Number.parseInt(w.hemisphere.ground, 16)).toBe(hemisphere.ground);
    expect(w.hemisphere.intensity).toBeCloseTo(hemisphere.intensity, 6);
  });
});
