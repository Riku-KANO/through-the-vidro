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
        down, works in progress, works waiting: objects of kind tool or ware). A thing is a group of parts that touch (a pair
        of tweezers, a stack of bowls, chips on a tray), at least 3 cm across — S-24 had 2, 1 and 3"""
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
            parts.extend(_islands_world(o))
        things = [b for b in _touching_groups(parts, 0.005) if float(np.linalg.norm(b[1] - b[0])) >= 0.03]
        for name, near in stations.items():
            count = sum(1 for lo, hi in things if near((lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2) <= 0.9)
            with self.subTest(station=name):
                self.assertGreaterEqual(count, 6, f'{name}: {count} things about it')

    def test_new_furniture_colliders_are_honest_both_ways(self):
        """空間の可読性と導線 4 for furniture added after S-24 (the eight pieces of S-24 are checked in the game's Rapier test,
        src/game/prologue/physics.test.ts): horizontal rays at body heights from all around. Where a ray meets the piece it
        meets the collider no more than 5 cm later; where it meets the collider, the piece no more than 10 cm later"""
        checked_in_game = {'A0_bnch_work01', 'A0_frn_furnace01', 'A0_pipe_rack01', 'A0_mrv_marver01', 'A0_tub_water01',
                           'A0_anl_annealer01', 'A0_shlf_works01', 'A0_chr_stool01'}
        by_name = {o.name: o for o in self.objects}
        pieces = [o for o in self.objects if not o.name.endswith('_col') and f'{o.name}_col' in by_name
                  and o.name not in checked_in_game]
        misses, walls = [], []
        for o in pieces:
            seen_bvh = _bvh_world(o)
            felt_bvh = _bvh_world(by_name[f'{o.name}_col'])
            at = _three(o.matrix_world.translation)
            for h in (0.25, 0.6, 1.0, 1.5):
                for i in range(24):
                    a = (i + 0.37) / 24 * 2 * math.pi
                    origin = Vector(B((at[0] + math.cos(a) * 3, h, at[2] + math.sin(a) * 3)))
                    d = Vector(B((-math.cos(a), 0.0, -math.sin(a))))
                    seen = seen_bvh.ray_cast(origin, d, 6.0)[3]
                    felt = felt_bvh.ray_cast(origin, d, 6.0)[3]
                    if seen is not None and (felt is None or felt > seen + 0.05):
                        misses.append(f'{o.name} h{h} a{i}: seen {seen:.2f} felt {felt}')
                    if felt is not None and (seen is None or seen > felt + 0.1):
                        walls.append(f'{o.name} h{h} a{i}: felt {felt:.2f} seen {seen}')
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


# ── helpers (three's coordinates: y up, the door at -Z) ──────────────────────────────────────────────────
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


def _touching_groups(parts, gap):
    """Parts (arrays of points) grouped where they come within gap of each other; the box (lo, hi) of each group"""
    from mathutils.kdtree import KDTree
    owner = [i for i, pts in enumerate(parts) for _ in range(len(pts))]
    tree = KDTree(len(owner))
    k = 0
    for pts in parts:
        for q in pts:
            tree.insert(Vector((float(q[0]), float(q[1]), float(q[2]))), k)
            k += 1
    tree.balance()
    parent = list(range(len(parts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, pts in enumerate(parts):
        for q in pts:
            for _, j, _ in tree.find_range(Vector((float(q[0]), float(q[1]), float(q[2]))), gap):
                a, b = find(i), find(owner[j])
                if a != b:
                    parent[a] = b
    groups: dict = {}
    for i, pts in enumerate(parts):
        lo, hi = pts.min(axis=0), pts.max(axis=0)
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
