"""工房の内装のスクリプト（make_workshop.py、S-24、S-27）。Blender の中でだけ走る（bpy がなければ飛ばす）。

書き出した glb の側（位置・材質・アトラス・当たり判定の正直さ）はゲームの単体テスト（src/game/assets/workshop-asset.test.ts、
src/game/prologue/physics.test.ts）が見る。ここでは作った .blend が書き出しの検査を通る形かを確かめる。S-27 の見た目のうち
形で確かめられること（物の密度、S-24 の後に足した家具の当たり判定の正直さ、棚の作品の後ろが空でないこと）もここで見る。
"""
from __future__ import annotations

import math
import unittest

try:
    import bpy
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
except ImportError:  # Blender の外
    bpy = np = Vector = BVHTree = None


@unittest.skipIf(bpy is None, 'needs Blender (bpy)')
class Workshop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import make_workshop
        cls.mw = make_workshop
        make_workshop.build_all()
        bpy.context.view_layer.update()  # matrix_world of the new objects (read by the S-27 checks)
        # what the pipeline exports: everything but the reference collection (floor and dome to look at, kept out of
        # the view layer when the .blend is saved)
        cls.objects = [o for o in bpy.context.scene.objects
                       if o.type == 'MESH' and all(c.name != 'reference' for c in o.users_collection)]

    def test_names_pass_the_lint_of_the_pipeline(self):
        from vidro import naming
        entries = [{'name': o.name, 'parent': o.parent.name if o.parent else None, 'extras': {},
                    'materials': [s.material.name for s in o.material_slots if s.material]} for o in self.objects]
        self.assertEqual(naming.lint(entries), [])
        for o in self.objects:
            self.assertEqual(naming.parse_name(o.name)['value']['area'], 'A0', o.name)

    def test_props_keep_to_the_budget_of_small_props(self):
        from common import stats
        from vidro import budget, naming
        rows = [{'name': o.name, 'parsed': naming.parse_name(o.name)['value'], 'triangles': stats.triangle_count(o)}
                for o in self.objects]
        report = budget.check(rows)
        for row in report['objects']:
            with self.subTest(name=row['name']):
                self.assertEqual(row['category'], 'prop')
                self.assertGreaterEqual(row['triangles'], 500)
                self.assertFalse(row['over'])

    def test_furniture_has_a_collider_and_colliders_draw_nothing(self):
        names = {o.name for o in self.objects}
        for base in ('A0_bnch_work01', 'A0_frn_furnace01', 'A0_pipe_rack01', 'A0_mrv_marver01', 'A0_tub_water01',
                     'A0_anl_annealer01', 'A0_shlf_works01', 'A0_chr_stool01'):
            self.assertIn(f'{base}_col', names)
        for o in self.objects:
            if o.name.endswith('_col'):
                self.assertEqual(len(o.material_slots), 0, o.name)
                self.assertTrue(o.hide_render, o.name)

    def test_glass_is_marked_and_the_rest_is_opaque_on_one_atlas(self):
        from pipeline import is_transmissive
        from vidro import naming
        used = {s.material for o in self.objects for s in o.material_slots if s.material}
        kinds = set()
        for m in used:
            mark = naming.parse_glass_mark(m.name)
            if mark is None:
                self.assertFalse(is_transmissive(m), m.name)  # glass is always marked: the game makes it
            else:
                self.assertTrue(mark['ok'], m.name)
                kinds.add(mark['value']['kind'])
        self.assertEqual(kinds, {'clear', 'frosted', 'bubble', 'milky'})  # 色の進行: 序章はほぼ無色
        images = {n.image.name for m in used if m.node_tree for n in m.node_tree.nodes
                  if n.type == 'TEX_IMAGE' and n.image}
        self.assertEqual(len(images), 1)  # 小物はアトラスを共有

    def test_opaque_uvs_stay_inside_their_atlas_tile(self):
        cols, rows = getattr(self.mw, 'ATLAS_GRID', (2, 2))
        for o in self.objects:
            if o.name.endswith('_col'):
                continue
            uv = o.data.uv_layers['UVMap'].data
            for poly in o.data.polygons:
                name = o.material_slots[poly.material_index].material.name
                tile = self.mw.TILES.get(name)
                if tile is None:
                    continue
                for li in poly.loop_indices:
                    u, v = uv[li].uv
                    with self.subTest(object=o.name, material=name):
                        self.assertTrue(tile[0] / cols < u < (tile[0] + 1) / cols)
                        self.assertTrue(tile[1] / rows < v < (tile[1] + 1) / rows)

    # ── S-27: the look (炉らしい炉、棚の作品が見える、物の密度) ─────────────────────────────────────────

    def test_things_are_left_about_the_bench_the_marver_and_the_annealer(self):
        """世界観 > 語り口: まだそこで暮らしている気配。Around each of the three work places, at least 6 separate things (tools put
        down, works in progress, works waiting: objects of kind tool or ware), at least 3 cm across. A thing is a group of parts
        within 2 cm of each other's surface (a pair of tweezers, a stack of bowls, a work on its stand); grains under 5 cm
        within 10 cm of each other are one pile. S-24 had 2, 1 and 3"""
        mw = self.mw
        stations = {
            'bench': lambda x, z: _rect_distance(x, z, mw.BENCH['center'], mw.BENCH['size'][0], mw.BENCH['size'][2],
                                                 None),
            'marver': lambda x, z: _rect_distance(x, z, mw.MARVER['center'], mw.MARVER['size'][0],
                                                  mw.MARVER['size'][2], mw.Frame(*mw.MARVER['center'])),
            'annealer': lambda x, z: max(0.0, math.hypot(x - mw.ANNEALER['center'][0], z - mw.ANNEALER['center'][1])
                                         - mw.ANNEALER['radius']),
        }
        parts = []
        for o in self.objects:
            parsed = _parse(o.name)
            if parsed['role'] == 'col' or parsed['kind'] not in ('tool', 'ware'):
                continue
            parts.extend(_island_meshes(o))
        things = [b for b in _things(parts) if float(np.linalg.norm(b[1] - b[0])) >= 0.03]
        for name, near in stations.items():
            count = sum(1 for lo, hi in things if near((lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2) <= 0.9)
            with self.subTest(station=name):
                self.assertGreaterEqual(count, 6, f'{name}: {count} things about it')

    def test_new_furniture_shuts_no_floor_off(self):
        """柱2「迷わずに彷徨える」: furniture added after S-24 takes the floor it stands on and no more. Every bit of floor the
        body reaches from where you wake with S-24's furniture, and where it still fits, is still reachable (no pocket shut by
        a gap that looks wide enough but is not). The body: 0.3 m radius, 1.75 m tall, under the leaning dome (5 cm grid)"""
        mw = self.mw
        cols = [o for o in self.objects if o.name.endswith('_col')]
        before = _bvh_union([o for o in cols if o.name[:-4] in S24_FURNITURE])
        after = _bvh_union(cols)
        start = mw.VIEWS['wake'][0]
        reach_before = _reachable(mw, before, start)
        free_after = _free_cells(mw, after)
        reach_after = _reachable(mw, after, start)
        shut = [c for c in reach_before if c in free_after and c not in reach_after]
        area = len(shut) * GRID ** 2
        where = sorted({(round(i * GRID, 1), round(k * GRID, 1)) for i, k in shut})[:12]
        self.assertLess(area, 0.03, f'{area:.2f} m2 of floor shut off, e.g. {where}')

    def test_new_furniture_colliders_are_honest_both_ways(self):
        """空間の可読性と導線 4 for furniture added after S-24 (the eight pieces of S-24 are checked in the game's Rapier test,
        src/game/prologue/physics.test.ts; since S-30 that test also takes these, with rays toward one point of each, while
        this one aims at every 8-degree slice of a long piece): horizontal rays at body heights from all around. Where a ray meets the piece it
        meets the collider no more than 5 cm later; where it meets the collider, the piece no more than 10 cm later. A long piece
        (the shelf's board) is looked at from all around each of its 8-degree slices"""
        checked_in_game = S24_FURNITURE
        by_name = {o.name: o for o in self.objects}
        pieces = [o for o in self.objects if not o.name.endswith('_col') and f'{o.name}_col' in by_name
                  and o.name not in checked_in_game]
        misses, walls = [], []
        for o in pieces:
            seen_bvh = _bvh_world(o)
            felt_bvh = _bvh_world(by_name[f'{o.name}_col'])
            for t, at in enumerate(_ray_targets(o)):
                for h in (0.25, 0.6, 1.0, 1.5):
                    for i in range(24):
                        a = (i + 0.37) / 24 * 2 * math.pi
                        origin = Vector(B((at[0] + math.cos(a) * 3, h, at[1] + math.sin(a) * 3)))
                        d = Vector(B((-math.cos(a), 0.0, -math.sin(a))))
                        # from where a body could stand (a long, curved piece can come round to the ray's start)
                        if any(b.find_nearest(origin, BODY_RADIUS)[0] is not None for b in (seen_bvh, felt_bvh)):
                            continue
                        seen = seen_bvh.ray_cast(origin, d, 6.0)[3]
                        felt = felt_bvh.ray_cast(origin, d, 6.0)[3]
                        if seen is not None and (felt is None or felt > seen + 0.05):
                            misses.append(f'{o.name} t{t} h{h} a{i}: seen {seen:.2f} felt {felt}')
                        if felt is not None and (seen is None or seen > felt + 0.1):
                            walls.append(f'{o.name} t{t} h{h} a{i}: felt {felt:.2f} seen {seen}')
        self.assertEqual(misses, [])
        self.assertEqual(walls, [])

    def test_behind_the_works_on_the_shelf_is_the_shelf_not_the_sky(self):
        """棚が空に見えない: from where you stand before the shelf (S-24's view), the line of sight through each work on the
        shelf meets an opaque surface of the shelf behind it (within 0.6 m), not the dome and the sky"""
        mw = self.mw
        feet, _, _ = mw.VIEWS['shelf']
        eye = Vector((feet[0], mw.EYE, feet[1]))
        # the opaque faces of everything but the works themselves (an opal work must not count as its own back)
        opaque = _opaque_bvh([o for o in self.objects if not o.name.endswith('_col') and _parse(o.name)['kind'] != 'ware'])
        works = []
        for o in self.objects:
            parsed = _parse(o.name)
            if parsed['role'] == 'col' or parsed['kind'] != 'ware':
                continue
            for pts in _islands_world(o):
                lo, hi = pts.min(axis=0), pts.max(axis=0)
                if float(np.linalg.norm(hi - lo)) < 0.05:
                    continue
                c = (lo + hi) / 2
                deg = math.degrees(math.atan2(c[2], c[0]))
                if mw.SHELF['from_deg'] - 3 <= deg <= mw.SHELF['to_deg'] + 3 and math.hypot(c[0], c[2]) > 3.0:
                    works.append((o.name, Vector((float(c[0]), float(c[1]), float(c[2])))))
        self.assertGreater(len(works), 10)
        open_sky = []
        for name, c in works:
            d = (c - eye).normalized()
            # from the work's middle on along the line of sight
            hit = opaque.ray_cast(Vector(B(tuple(c))), Vector(B(tuple(d))), 0.6)[0]
            if hit is None:
                open_sky.append(f'{name} at {tuple(round(x, 2) for x in c)}')
        self.assertEqual(open_sky, [])

    # ── S-31: the furnace made again (徐冷炉と同じ低く広い泡のドーム) ─────────────────────────────────────────

    def test_the_fire_core_blooms_a_little_and_its_walls_stay_red(self):
        """画面の仕上げ (ブルームは控えめにし、強い光源だけが滲む) and AGENTS.md「何が光るかは美術で決める」「AgX は明るい赤を桃色へ
        寄せる」: the hottest colour the furnace's fire shows (the atlas at its UVs × FIRE_GLOW, linear) is above the bloom's
        threshold (linear luminance 0.9, src/game/orb/peek-pipeline.ts) but not far (a little: under 1.6); every other corner
        of the fire is a red wall, each channel under 0.5 (none in between: a corner under the threshold but brighter than that
        turns salmon). S-30 found the core at 0.24 (the tile's margin kept the hot end of the atlas from being used); review
        round 1 of S-31 found a ring of the walls at 0.65"""
        mw = self.mw
        furnace = next(o for o in self.objects if o.name == 'A0_frn_furnace01')
        atlas = mw.atlas_pixels()
        rows_px, cols_px = atlas.shape[:2]
        uv = furnace.data.uv_layers['UVMap'].data
        colours = []
        for poly in furnace.data.polygons:
            if furnace.material_slots[poly.material_index].material.name != 'A0_fire':
                continue
            for li in poly.loop_indices:
                u, v = uv[li].uv
                px = min(cols_px - 1, max(0, int(u * cols_px)))
                py = min(rows_px - 1, max(0, int(v * rows_px)))
                colours.append(atlas[py, px] * mw.FIRE_GLOW)
        self.assertGreater(len(colours), 0)
        lum = [0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] for c in colours]
        self.assertGreater(max(lum), 0.9)
        self.assertLess(max(lum), 1.6)
        pink = sorted({round(float(max(c)), 2) for c, l in zip(colours, lum) if l <= 0.9 and max(c) >= 0.5})
        self.assertEqual(pink, [], 'corners of the fire under the threshold but brighter than a deep red')


# ── helpers (three's coordinates: y up, the door at -Z) ──────────────────────────────────────────────────
#: The furniture of S-24, whose colliders the game's Rapier test checks (src/game/prologue/physics.test.ts)
S24_FURNITURE = {'A0_bnch_work01', 'A0_frn_furnace01', 'A0_pipe_rack01', 'A0_mrv_marver01', 'A0_tub_water01',
                 'A0_anl_annealer01', 'A0_shlf_works01', 'A0_chr_stool01'}
#: The body (src/game/player/constants.ts BODY_RADIUS, BODY_HEIGHT) and the floor grid of the reachability check
BODY_RADIUS, BODY_HEIGHT = 0.3, 1.75
GRID = 0.05


def _ray_targets(o):
    """Where the rays of the both-ways check aim (x, z): the object's origin, or for a long piece along the room (a span of
    more than 12 degrees round the centre, e.g. the shelf's board) the middle of each 8-degree slice of it"""
    verts, _, _ = _world_mesh(o)
    angles = np.degrees(np.arctan2(verts[:, 2], verts[:, 0]))
    a0, a1 = float(angles.min()), float(angles.max())
    if a1 - a0 <= 12.0:
        at = _three(o.matrix_world.translation)
        return [(at[0], at[2])]
    out = []
    n = max(1, round((a1 - a0) / 8.0))
    for k in range(n):
        sel = verts[(angles >= a0 + (a1 - a0) * k / n) & (angles <= a0 + (a1 - a0) * (k + 1) / n)]
        if len(sel):
            out.append((float(sel[:, 0].mean()), float(sel[:, 2].mean())))
    return out


def _bvh_union(objects):
    verts, polys = [], []
    for o in objects:
        v, p, _ = _world_mesh(o)
        base = len(verts)
        verts.extend(B(q) for q in v)
        polys.extend([base + i for i in poly] for poly in p)
    return BVHTree.FromPolygons(verts, polys)


def _fits(mw, bvh, x, z) -> bool:
    """The body standing at (x, z): its capsule clear of the colliders and inside the dome (the head meets the leaning wall)"""
    if math.hypot(x, z) > mw.FLOOR_R:
        return False
    lo, hi = BODY_RADIUS, BODY_HEIGHT - BODY_RADIUS
    for k in range(6):
        y = lo + (hi - lo) * k / 5
        if math.sqrt(x * x + (y - mw.DOME_CY) ** 2 + z * z) > mw.DOME_R - BODY_RADIUS:
            return False
        if bvh.find_nearest(Vector(B((x, y, z))), BODY_RADIUS)[0] is not None:
            return False
    return True


def _free_cells(mw, bvh):
    n = int(mw.FLOOR_R / GRID) + 1
    return {(i, k) for i in range(-n, n + 1) for k in range(-n, n + 1) if _fits(mw, bvh, i * GRID, k * GRID)}


def _reachable(mw, bvh, start):
    free = _free_cells(mw, bvh)
    first = (round(start[0] / GRID), round(start[1] / GRID))
    assert first in free, 'where you wake is not free'
    seen = {first}
    todo = [first]
    while todo:
        i, k = todo.pop()
        for c in ((i + 1, k), (i - 1, k), (i, k + 1), (i, k - 1)):
            if c in free and c not in seen:
                seen.add(c)
                todo.append(c)
    return seen


def B(p):
    return (float(p[0]), -float(p[2]), float(p[1]))


def _three(p):
    return (float(p[0]), float(p[2]), -float(p[1]))


def _parse(name: str) -> dict:
    from vidro import naming
    r = naming.parse_name(name)
    return r['value'] if r['ok'] else {'role': None, 'kind': ''}


def _world_mesh(o):
    """(vertices in three's coordinates as an (n, 3) array, polygons as index lists, material names per polygon)"""
    me = o.data
    m = o.matrix_world
    verts = np.array([_three(m @ v.co) for v in me.vertices]) if len(me.vertices) else np.zeros((0, 3))
    polys = [list(p.vertices) for p in me.polygons]
    mats = [o.material_slots[p.material_index].material.name if o.material_slots else '' for p in me.polygons]
    return verts, polys, mats


def _islands_world(o):
    """Connected parts of an object's mesh, each as its vertices (three's coordinates)"""
    verts, _, _ = _world_mesh(o)
    n = len(verts)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in o.data.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    groups: dict = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [verts[idx] for idx in groups.values()]


def _island_meshes(o):
    """Connected parts of an object's mesh, each as (its vertices, its faces as index lists into them), three's coordinates.
    The air bubbles inside bubble glass (A0_air) are part of their glass, not things of their own: left out"""
    verts, polys, mats = _world_mesh(o)
    n = len(verts)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in o.data.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            parent[a] = b
    groups: dict = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    for idx in groups.values():
        local = {g: k for k, g in enumerate(idx)}
        mine = [(poly, mat) for poly, mat in zip(polys, mats) if poly[0] in local]
        if mine and all(mat == 'A0_air' for _, mat in mine):
            continue
        out.append((verts[idx], [[local[v] for v in poly] for poly, _ in mine]))
    return out


def _things(parts, touch: float = 0.02, grain: float = 0.05, pile: float = 0.1):
    """Parts (vertices, faces) grouped into things: parts within `touch` of the other's surface are one thing; parts under
    `grain` across within `pile` of each other (centre to centre) are one pile. The box (lo, hi) of each thing"""
    n = len(parts)
    boxes = [(v.min(axis=0), v.max(axis=0)) for v, _ in parts]
    trees = [BVHTree.FromPolygons([B(q) for q in v], f) if f else None for v, f in parts]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def near(i, j) -> bool:
        for a, b in ((i, j), (j, i)):
            tree = trees[b]
            if tree is None:
                continue
            for q in parts[a][0]:
                if tree.find_nearest(Vector(B(q)), touch)[0] is not None:
                    return True
        return False

    for i in range(n):
        for j in range(i + 1, n):
            (a0, a1), (b0, b1) = boxes[i], boxes[j]
            small = max(np.linalg.norm(a1 - a0), np.linalg.norm(b1 - b0)) < grain
            reach = pile if small else touch
            if not (np.all(a0 - reach <= b1) and np.all(b0 - reach <= a1)):
                continue
            if small and np.linalg.norm((a0 + a1) / 2 - (b0 + b1) / 2) <= pile or near(i, j):
                parent[find(i)] = find(j)
    groups: dict = {}
    for i in range(n):
        lo, hi = boxes[i]
        g = groups.get(find(i))
        groups[find(i)] = (lo, hi) if g is None else (np.minimum(g[0], lo), np.maximum(g[1], hi))
    return list(groups.values())


def _bvh_world(o):
    verts, polys, _ = _world_mesh(o)
    return BVHTree.FromPolygons([B(v) for v in verts], polys)


def _opaque_bvh(objects):
    """The faces of the given objects whose material is not glass (no glass_ mark) and not the air of bubble glass"""
    from vidro import naming
    all_verts, all_polys = [], []
    for o in objects:
        verts, polys, mats = _world_mesh(o)
        base = len(all_verts)
        all_verts.extend(B(v) for v in verts)
        for p, name in zip(polys, mats):
            if naming.parse_glass_mark(name) is None and name != 'A0_air':
                all_polys.append([base + i for i in p])
    return BVHTree.FromPolygons(all_verts, all_polys)


def _rect_distance(x, z, center, length, depth, frame):
    """Distance on the floor from (x, z) to a rectangle (length along the frame's right, depth along its facing; or along
    x and z when frame is None)"""
    dx, dz = x - center[0], z - center[1]
    if frame is None:
        a, s = dz, dx
        half_a, half_s = depth / 2, length / 2
    else:
        a = dx * frame.f[0] + dz * frame.f[1]
        s = dx * frame.r[0] + dz * frame.r[1]
        half_a, half_s = depth / 2, length / 2
    return math.hypot(max(0.0, abs(a) - half_a), max(0.0, abs(s) - half_s))
