"""工房の内装のスクリプト（make_workshop.py、S-24）。Blender の中でだけ走る（bpy がなければ飛ばす）。

書き出した glb の側（位置・材質・アトラス・当たり判定の正直さ）はゲームの単体テスト（src/game/assets/workshop-asset.test.ts、
src/game/prologue/physics.test.ts）が見る。ここでは作った .blend が書き出しの検査を通る形かを確かめる。
"""
from __future__ import annotations

import unittest

try:
    import bpy
except ImportError:  # Blender の外
    bpy = None


@unittest.skipIf(bpy is None, 'needs Blender (bpy)')
class Workshop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import make_workshop
        cls.mw = make_workshop
        make_workshop.build_all()
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

    def test_materials_are_the_glass_kinds_brass_and_the_atlas(self):
        used = {s.material.name for o in self.objects for s in o.material_slots if s.material}
        self.assertEqual(used, {'glass_clear', 'glass_frosted', 'glass_bubble', 'glass_milky', 'A0_brass', 'A0_frost',
                                'A0_water', 'A0_fire', 'A0_ember', 'A0_air'})
        images = {n.image.name for m in bpy.data.materials if m.node_tree for n in m.node_tree.nodes
                  if n.type == 'TEX_IMAGE' and n.image}
        self.assertEqual(images, {'A0_atlas'})

    def test_opaque_uvs_stay_inside_their_atlas_tile(self):
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
                        self.assertTrue(tile[0] / 2 < u < (tile[0] + 1) / 2)
                        self.assertTrue(tile[1] / 2 < v < (tile[1] + 1) / 2)
