"""common の Blender の部分（三角形の数、2つ目の UV）。Blender の中でだけ走る（bpy がなければ飛ばす）。"""
from __future__ import annotations

import unittest

try:
    import bpy
except ImportError:  # Blender の外
    bpy = None


@unittest.skipIf(bpy is None, 'needs Blender (bpy)')
class BlenderCommon(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)

    def cube(self, name='A0_box_01'):
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
        o.name = name
        return o

    def test_counts_the_triangles_that_are_exported(self):
        from common import stats
        o = self.cube()
        self.assertEqual(stats.triangle_count(o), 12)
        mod = o.modifiers.new('sub', 'SUBSURF')
        mod.levels = 1
        mod.render_levels = 1
        self.assertEqual(stats.triangle_count(o), 48)  # with the modifier applied, as export_apply=True writes it

    def test_makes_a_second_uv_inside_the_unit_square_and_keeps_the_first(self):
        from common import uv
        o = self.cube()
        first = o.data.uv_layers[0].name
        result = uv.ensure_lightmap_uv([o])
        self.assertEqual(result, {o.name: 'generated'})
        layers = [u.name for u in o.data.uv_layers]
        self.assertEqual(layers, [first, uv.UV_NAME])
        coords = [c for d in o.data.uv_layers[uv.UV_NAME].data for c in d.uv]
        self.assertTrue(all(-1e-6 <= c <= 1 + 1e-6 for c in coords))
        # islands do not overlap: the total area of the faces in UV space is at most the unit square
        self.assertLessEqual(uv.uv_area(o, uv.UV_NAME), 1.0 + 1e-6)
        self.assertGreater(uv.uv_area(o, uv.UV_NAME), 0.2)

    def test_keeps_a_second_uv_that_is_already_there(self):
        from common import uv
        o = self.cube()
        o.data.uv_layers.new(name=uv.UV_NAME)
        self.assertEqual(uv.ensure_lightmap_uv([o]), {o.name: 'kept'})

    def test_gives_a_mesh_without_uv_a_first_one_so_the_lightmap_is_the_second(self):
        from common import uv
        o = self.cube()
        while o.data.uv_layers:
            o.data.uv_layers.remove(o.data.uv_layers[0])
        uv.ensure_lightmap_uv([o])
        self.assertEqual(len(o.data.uv_layers), 2)
        self.assertEqual(o.data.uv_layers[1].name, uv.UV_NAME)


if __name__ == '__main__':
    unittest.main()
