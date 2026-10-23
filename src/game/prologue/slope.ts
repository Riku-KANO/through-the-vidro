import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  clamp,
  cos,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createBrassMaterial, createGlass } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import type { MeshData } from '../player/walk-lab-field';
import {
  GATE,
  GATE_OPEN_DEG,
  GATE_SPRINGS,
  LAMP_HEIGHT,
  LAMP_POST_RADIUS,
  MEMBRANE,
  SLOPE,
  slopeHeight,
} from './layout';
import { stoneMaterial } from './room-art';

/**
 * 坂道 (S-35; 進行構造とエリア設計 > 街の配置と序章の締め): the way on from the gate, down about 80 m to the central plaza. Its
 * stone deck, the brass railings along both edges that stop the body softly (足場の縁はやわらかい柵で止める: 落下なし), its lamps,
 * and 光の膜 — the film of light in the gate's arch that will not let you out onto the slope without the vidro in hand
 * (発案者 2026-10-23). Built from code (仮: Blender takes it over with the area's art), from the same numbers as its
 * colliders (physics.ts): what is drawn is what stops you (空間の可読性と導線 4).
 * アートディレクション > 形のルール: straight and thin lines only as brass (the railings, the lips), the rest round.
 */

/** The deck runs a little into the road's slab and into the plaza's floor, so there is no seam to catch on at either end. */
export const DECK_FROM = SLOPE.fromZ + 0.4;
export const DECK_TO = SLOPE.toZ - 0.8;
/** Samples of the slope's curve along the deck (1 m apart: the chord strays under 2 mm from the curve). */
const DECK_STEPS = Math.round(DECK_FROM - DECK_TO);

/**
 * 柵 (仮): the brass railings along both edges, on a line `inset` inside the deck's edge, `height` tall over the stone. They
 * start just past where the gate's open leaves lie along the road's edges (S-34: GATE_OPEN_DEG) and end at the plaza's rim.
 * They collide as a thin wall in their plane, up to their top rail (the S-34 railing did the same).
 */
export const SLOPE_RAIL = {
  inset: 0.08,
  height: 1.0,
  thickness: 0.06,
  fromZ: GATE.z - GATE.halfWidth * Math.sin((GATE_OPEN_DEG * Math.PI) / 180) - 0.3,
  toZ: SLOPE.toZ - 0.05,
} as const;
/** x of the railings' line on either side. */
export const SLOPE_RAIL_X = SLOPE.maxX - SLOPE_RAIL.inset;

/** 街灯 on the railings, alternating sides on the way down (乳白ガラス, like the way's: LAMPS). z of each, and its side. */
export const SLOPE_LAMPS: readonly { z: number; side: 1 | -1 }[] = [-33, -48, -63, -78, -93].map((z, i) => ({
  z,
  side: i % 2 === 0 ? 1 : -1,
}));

/**
 * A slab swept along z from z0 to z1 between x0 and x1, its top at top(z) and its bottom at bottom(z), closed at both ends
 * (the slope's deck, a railing's wall). `steps` samples of the curve.
 */
export function sweptSlab(
  z0: number,
  z1: number,
  steps: number,
  x0: number,
  x1: number,
  top: (z: number) => number,
  bottom: (z: number) => number,
): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const zs = Array.from({ length: steps + 1 }, (_, i) => z0 + ((z1 - z0) * i) / steps);
  const vertex = (x: number, y: number, z: number, n: readonly [number, number, number]): number => {
    positions.push(x, y, z);
    normals.push(n[0], n[1], n[2]);
    return positions.length / 3 - 1;
  };
  const slopeOf = (f: (z: number) => number, z: number): number => (f(z + 1e-3) - f(z - 1e-3)) / 2e-3;
  const up =
    (f: (z: number) => number, sign: 1 | -1) =>
    (z: number): [number, number, number] => {
      const k = slopeOf(f, z);
      const l = Math.hypot(1, k);
      return [0, sign / l, (-k * sign) / l];
    };
  // one strip along z between two edges, wound so that it faces along its normal
  const strip = (
    a: (z: number) => [number, number, number],
    b: (z: number) => [number, number, number],
    normal: (z: number) => [number, number, number],
  ) => {
    const ia = zs.map((z) => vertex(...a(z), normal(z)));
    const ib = zs.map((z) => vertex(...b(z), normal(z)));
    for (let i = 0; i < steps; i++) {
      const [a0, a1, b0, b1] = [ia[i] ?? 0, ia[i + 1] ?? 0, ib[i] ?? 0, ib[i + 1] ?? 0];
      const p = (k: number): [number, number, number] => [
        positions[k * 3] ?? 0,
        positions[k * 3 + 1] ?? 0,
        positions[k * 3 + 2] ?? 0,
      ];
      const [pa, pb, pc] = [p(a0), p(b0), p(a1)];
      const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const cross = [
        (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
        (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
        (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
      ];
      const n = normals.slice(a0 * 3, a0 * 3 + 3);
      const front =
        (cross[0] ?? 0) * (n[0] ?? 0) + (cross[1] ?? 0) * (n[1] ?? 0) + (cross[2] ?? 0) * (n[2] ?? 0) > 0;
      if (front) indices.push(a0, b0, a1, b0, b1, a1);
      else indices.push(a0, a1, b0, b0, a1, b1);
    }
  };
  strip(
    (z) => [x0, top(z), z],
    (z) => [x1, top(z), z],
    up(top, 1),
  );
  strip(
    (z) => [x1, bottom(z), z],
    (z) => [x0, bottom(z), z],
    up(bottom, -1),
  );
  strip(
    (z) => [x0, bottom(z), z],
    (z) => [x0, top(z), z],
    () => [-1, 0, 0],
  );
  strip(
    (z) => [x1, top(z), z],
    (z) => [x1, bottom(z), z],
    () => [1, 0, 0],
  );
  for (const [z, sign] of [
    [z0, Math.sign(z0 - z1)],
    [z1, Math.sign(z1 - z0)],
  ] as const) {
    const n: [number, number, number] = [0, 0, sign];
    const a = vertex(x0, top(z), z, n);
    const b = vertex(x1, top(z), z, n);
    const c = vertex(x1, bottom(z), z, n);
    const d = vertex(x0, bottom(z), z, n);
    if (sign > 0) indices.push(a, d, b, b, d, c);
    else indices.push(a, b, d, b, c, d);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

/**
 * The slope's walkable deck as it collides: a slab 1 m deep under the stone the deck draws (the drawn one goes 7 m down into
 * the mist, 3 mm lower so it does not flicker against the road's slab and the plaza's floor where they overlap).
 */
export function slopeDeckShape(depth = 1, lift = 0): MeshData {
  return sweptSlab(
    DECK_FROM,
    DECK_TO,
    DECK_STEPS,
    SLOPE.minX,
    SLOPE.maxX,
    (z) => slopeHeight(z) + lift,
    (z) => slopeHeight(z) + lift - depth,
  );
}

/** A railing's wall as it collides (side +1: the right edge going down, +X; −1: the left): thin, up to its top rail. */
export function slopeRailShape(side: 1 | -1): MeshData {
  const x = side * SLOPE_RAIL_X;
  const half = SLOPE_RAIL.thickness / 2;
  const steps = Math.round(SLOPE_RAIL.fromZ - SLOPE_RAIL.toZ);
  return sweptSlab(
    SLOPE_RAIL.fromZ,
    SLOPE_RAIL.toZ,
    steps,
    x - half,
    x + half,
    (z) => slopeHeight(z) + SLOPE_RAIL.height,
    (z) => slopeHeight(z) - 0.1,
  );
}

/**
 * slopeHeight as a shader node of the fragment's world z: where the ground of the way and the slope lies under it (the
 * mist lies under that: room-art.ts `mistFloor`, so the plaza 12 m down does not sink into the valley's mist).
 */
export function slopeGroundNode(): THREE.Node<'float'> {
  const t = clamp(
    float(SLOPE.fromZ)
      .sub(positionWorld.z)
      .div(SLOPE.fromZ - SLOPE.toZ),
    0,
    1,
  );
  return float(-SLOPE.drop / 2).mul(float(1).sub(cos(t.mul(Math.PI)))) as unknown as THREE.Node<'float'>;
}

/** The arch's underside at |x| in the gate (finale.ts draws the arch from the same numbers). */
function archAt(x: number): number {
  const hw = GATE.halfWidth;
  return GATE_SPRINGS + 0.6 * Math.sqrt(Math.max(0, hw * hw - x * x));
}

/* ---------- the drawing ---------- */

/** 仮: how bright the film is at its frame and across it, and how much brighter while it holds someone (linear, additive). */
const FILM_RIM = 0.26;
const FILM_FACE = 0.05;
const FILM_PRESS = 0.7;

export interface SlopeArt {
  /** 0..1: how much the film in the gate's arch shows (session.film). */
  setFilm(shown: number): void;
  /** 0..1: the film brightens a little while it holds someone (session.call). */
  setPress(press: number): void;
  /** The film's slow swirl (scene clock, seconds). */
  animate(t: number): void;
  dispose(): void;
}

function meshDataGeometry(data: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** Builds the slope (deck, lips, railings, lamps) and the film in the gate into `scene`, all on the shared layer. */
export function buildSlope(quality: QualityPreset, field: LayerField, scene: THREE.Object3D): SlopeArt {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!g) throw new Error('mergeGeometries failed');
    return keep(g);
  };
  const put = (o: THREE.Object3D): void => {
    field.assign(o, 'shared');
    scene.add(o);
  };
  const brass = keep(createBrassMaterial());
  // the same 石畳 as the way and the road (room-art.ts), the rock of its sides going down into the mist
  const stone = keep(stoneMaterial(0.62));
  const lampMilk = keep(
    createGlass('milky', quality, { glow: { color: 0xffbf80, intensity: 1.5 } }).material,
  );

  // ---- the deck: stone on top, rock down its sides ----------------------------------------------------------------
  {
    const deck = new THREE.Mesh(keep(meshDataGeometry(slopeDeckShape(7, -0.003))), stone);
    deck.receiveShadow = true;
    put(deck);
  }

  // ---- brass: the lips along the deck's edges, the railings (posts, rails, rings) and the lamps' posts --------------
  const globes: THREE.BufferGeometry[] = [];
  {
    const parts: THREE.BufferGeometry[] = [];
    const along = (x: number, lift: number, from: number, to: number): THREE.CatmullRomCurve3 => {
      const n = Math.max(2, Math.round((from - to) / 2));
      return new THREE.CatmullRomCurve3(
        Array.from({ length: n + 1 }, (_, i) => {
          const z = from + ((to - from) * i) / n;
          return new THREE.Vector3(x, slopeHeight(z) + lift, z);
        }),
      );
    };
    const tube = (curve: THREE.Curve<THREE.Vector3>, r: number, radial = 6): void => {
      const segments = Math.max(8, Math.round(curve.getLength() * 1.2));
      parts.push(new THREE.TubeGeometry(curve, segments, r, radial, false));
    };
    for (const side of [1, -1] as const) {
      // 形は縁で伝える: a brass lip along the stone's edge, on from the road's
      tube(along(side * (SLOPE.maxX + 0.01), 0, SLOPE.fromZ + 0.05, SLOPE.toZ), 0.018);
      const x = side * SLOPE_RAIL_X;
      const { fromZ, toZ, height } = SLOPE_RAIL;
      tube(along(x, height, fromZ, toZ), 0.026, 8);
      tube(along(x, 0.55, fromZ, toZ), 0.013);
      tube(along(x, 0.12, fromZ, toZ), 0.013);
      // posts every 2.4 m or so, a ring in every other bay between the rails (the S-34 railing's motif)
      const bays = Math.round((fromZ - toZ) / 2.4);
      for (let i = 0; i <= bays; i++) {
        const z = fromZ + ((toZ - fromZ) * i) / bays;
        const h = slopeHeight(z);
        if (SLOPE_LAMPS.some((l) => l.side === side && Math.abs(l.z - z) < 1.2)) continue;
        parts.push(new THREE.CylinderGeometry(0.02, 0.026, height, 8).translate(x, h + height / 2, z));
        if (i < bays && i % 2 === 0) {
          const mid = z + (toZ - fromZ) / bays / 2;
          parts.push(
            new THREE.TorusGeometry(0.15, 0.01, 6, 28)
              .rotateY(Math.PI / 2)
              .translate(x, slopeHeight(mid) + (height + 0.55) / 2, mid),
          );
        }
      }
    }
    // 街灯: a lamp's post stands in the railing's line, its milky globe over the stone
    for (const l of SLOPE_LAMPS) {
      const x = l.side * SLOPE_RAIL_X;
      const h = slopeHeight(l.z);
      parts.push(
        new THREE.CylinderGeometry(LAMP_POST_RADIUS, LAMP_POST_RADIUS * 1.5, LAMP_HEIGHT, 8).translate(
          x,
          h + LAMP_HEIGHT / 2,
          l.z,
        ),
      );
      parts.push(
        new THREE.TorusGeometry(0.11, 0.012, 6, 24)
          .rotateX(Math.PI / 2)
          .translate(x, h + LAMP_HEIGHT - 0.06, l.z),
      );
      globes.push(new THREE.SphereGeometry(0.12, 24, 12).translate(x, h + LAMP_HEIGHT + 0.04, l.z));
    }
    put(new THREE.Mesh(merged(parts), brass));
    put(new THREE.Mesh(merged(globes), lampMilk));
  }

  // ---- 光の膜: a film of light filling the gate's arch, like a soap film in a ring (泡と真鍮の枠) -----------------------
  const film = uniform(0);
  const press = uniform(0);
  const clock = uniform(0);
  {
    const hw = GATE.halfWidth - 0.07;
    const shape = new THREE.Shape();
    shape.moveTo(-hw, 0.01);
    shape.lineTo(hw, 0.01);
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const x = hw - (2 * hw * i) / steps;
      shape.lineTo(x, archAt(x) - 0.05);
    }
    shape.lineTo(-hw, 0.01);
    const geometry = keep(new THREE.ShapeGeometry(shape, 1));
    const m = keep(
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    m.fog = false;
    const p = positionLocal;
    // how far (m) from the frame: the posts, the floor, the arch
    const ax = abs(p.x);
    const top = float(GATE_SPRINGS).add(sqrt(max(float(0), float(hw * hw).sub(p.x.mul(p.x)))).mul(0.6));
    const edge = min(min(float(hw).sub(ax), top.sub(p.y)), p.y);
    const rim = exp(edge.div(0.14).pow(2).negate());
    // the film's colours drift slowly like a soap film's (thin-film colours: 虹色, the back layer's light)
    const swirl = mx_noise_float(vec3(p.x.mul(1.1), p.y.mul(1.1), clock.mul(0.12)));
    const hue = swirl.mul(0.9).add(p.y.mul(0.22)).add(clock.mul(0.02));
    const rainbow = cos(hue.add(vec3(0, 0.33, 0.67)).mul(Math.PI * 2))
      .mul(0.5)
      .add(0.5);
    const grazing = float(1)
      .sub(abs(dot(normalView, positionViewDirection)))
      .pow(2);
    const bright = float(FILM_FACE)
      .add(rim.mul(FILM_RIM))
      .add(grazing.mul(0.08))
      .mul(film)
      .mul(press.mul(FILM_PRESS).add(1));
    // gone right at the eye, like the sphere's film (画面をうるさくしない)
    const near = smoothstep(0.3, 1.3, positionView.length());
    m.colorNode = vec4(
      mix(vec3(1.0, 0.86, 0.62), rainbow, 0.6)
        .mul(bright)
        .mul(near),
      1,
    );
    const mesh = new THREE.Mesh(geometry, m);
    mesh.name = 'slope-film';
    mesh.position.set(0, 0, MEMBRANE.z);
    mesh.renderOrder = 5;
    put(mesh);
  }

  return {
    setFilm(shown) {
      film.value = Math.min(1, Math.max(0, shown));
    },
    setPress(v) {
      press.value = Math.min(1, Math.max(0, v));
    },
    animate(t) {
      clock.value = t;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
