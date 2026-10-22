"""焼き込みの段（S-26: pipeline.py の bake_stage と common/bake.py の exclude_materials・density）。Blender の中でだけ走る。

小さな場面（床・真鍮とガラスの面を持つ箱・ガラスだけの器・当たり判定・光る面）を 64px、4 サンプルで焼き、
焼く物の選び方、焼かない面の UV、画素の細かさ、焼く間だけ変えた材質が元に戻ること、物と scene の記録を確かめる。
"""
from __future__ import annotations

import os
import tempfile
import unittest

try:
    import bmesh
    import bpy
except ImportError:  # Blender の外
    bpy = bmesh = None


def _principled(name: str, **inputs):
    m = bpy.data.materials.new(name)
    p = m.node_tree.nodes['Principled BSDF']
    for key, value in inputs.items():
        p.inputs[key].default_value = value
    return m


def _glass(name: str):
    m = _principled(name, **{'Transmission Weight': 1.0, 'Roughness': 0.0})
    vol = m.node_tree.nodes.new('ShaderNodeVolumeAbsorption')
    m.node_tree.links.new(vol.outputs['Volume'], m.node_tree.nodes['Material Output'].inputs['Volume'])
    return m


def _mesh(name: str, make, materials, faces_material=None, location=(0.0, 0.0, 0.0)):
    bm = bmesh.new()
    make(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    if faces_material is not None:
        for i, p in enumerate(me.polygons):
            p.material_index = faces_material(i)
    me.uv_layers.new(name='UVMap')
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.location = location
    return o


@unittest.skipIf(bpy is None, 'needs Blender (bpy)')
class BakeStage(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.brass = _principled('A0_brass', Metallic=1.0)
        self.floor_mat = _principled('A0_floor')
        self.clear = _glass('glass_clear')
        self.fire = _principled('A0_fire', **{'Emission Strength': 4.0})
        self.fire['bake'] = False
        self.floor = _mesh('A0_flr_floor01', lambda bm: bmesh.ops.create_grid(bm, x_segments=2, y_segments=2, size=2.0),
                           [self.floor_mat])
        # a box with brass faces, two glass faces and one burning face
        self.box = _mesh('A0_box_01', lambda bm: bmesh.ops.create_cube(bm, size=0.5),
                         [self.brass, self.clear, self.fire], lambda i: 1 if i in (0, 1) else (2 if i == 2 else 0),
                         location=(0.0, 0.0, 0.3))
        self.ware = _mesh('A0_ware_clear01', lambda bm: bmesh.ops.create_cube(bm, size=0.2), [self.clear],
                          location=(0.8, 0.0, 0.2))
        self.col = _mesh('A0_box_01_col', lambda bm: bmesh.ops.create_cube(bm, size=0.5), [], location=(0.0, 0.0, 0.3))
        self.col.hide_render = True
        sun = bpy.data.objects.new('bake_sun', bpy.data.lights.new('bake_sun', 'SUN'))
        bpy.context.scene.collection.objects.link(sun)
        bpy.context.view_layer.update()

    def named(self):
        from vidro import naming
        return {o.name: naming.parse_name(o.name)['value'] for o in bpy.context.scene.objects
                if o.type == 'MESH' and naming.parse_name(o.name)['ok']}

    def test_bakes_what_is_opaque_and_leaves_out_glass_colliders_and_what_burns(self):
        import pipeline
        self.assertTrue(pipeline.bakeable_material(self.brass))
        self.assertFalse(pipeline.bakeable_material(self.clear))
        self.assertFalse(pipeline.bakeable_material(self.fire))
        milky = _principled('glass_milky', **{'Emission Strength': 1.0})
        self.assertFalse(pipeline.bakeable_material(milky))  # the game's glass (the mark), though opaque in Blender
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        targets = {o.name for o in pipeline.bake_targets(objects, self.named())}
        self.assertEqual(targets, {'A0_flr_floor01', 'A0_box_01'})

    def test_bakes_one_lightmap_and_puts_the_scene_back(self):
        import pipeline
        from common import bake
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        cycles = bpy.context.scene.cycles
        caustics = cycles.caustics_refractive
        with tempfile.TemporaryDirectory() as out:
            record = pipeline.bake_stage(objects, self.named(), out,
                                         {'size': 64, 'samples': 4, 'margin': 2, 'density': {'A0_flr_floor01': 2}})
            image = record['images'][0]
            self.assertTrue(os.path.exists(image['png']))
            self.assertEqual(bake.png_info(image['png'])['depth'], 8)
        self.assertEqual(image['name'], 'A0_lightmap')
        self.assertEqual(sorted(image['objects']), ['A0_box_01', 'A0_flr_floor01'])
        self.assertEqual(sorted(image['excluded_materials']), ['A0_fire', 'glass_clear'])
        for o in (self.floor, self.box):
            self.assertEqual(o[bake.PROP], 'A0_lightmap')
            self.assertGreater(o[bake.PROP_SCALE], 0)
            self.assertEqual([u.name for u in o.data.uv_layers], ['UVMap', bake.UV_NAME])
            self.assertTrue(o.data.uv_layers['UVMap'].active_render)
        self.assertNotIn(bake.PROP, self.ware)
        # the faces it does not bake take no room: their second UV is one point
        lm = self.box.data.uv_layers[bake.UV_NAME].data
        for p in self.box.data.polygons:
            uvs = {tuple(round(c, 6) for c in lm[i].uv) for i in p.loop_indices}
            if p.material_index in (1, 2):
                self.assertEqual(uvs, {(0.0, 0.0)})
            else:
                self.assertGreater(len(uvs), 1)
        # what the bake changed for itself is back: the brass is metal, the glass refracts and absorbs, caustics as they were
        self.assertEqual(self.brass.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value, 1.0)
        types = {n.type for n in self.clear.node_tree.nodes}
        self.assertNotIn('LIGHT_PATH', types)
        self.assertNotIn('MIX_SHADER', types)
        out_node = self.clear.node_tree.nodes['Material Output']
        self.assertEqual(out_node.inputs['Surface'].links[0].from_node.type, 'BSDF_PRINCIPLED')
        self.assertTrue(out_node.inputs['Volume'].is_linked)
        self.assertEqual(cycles.caustics_refractive, caustics)
        for m in (self.brass, self.clear, self.fire, self.floor_mat):
            self.assertNotIn('TEX_IMAGE', {n.type for n in m.node_tree.nodes}, m.name)
        # the scene's record (glb scene extras): how, and with which lights
        rec = bpy.context.scene['bake']
        self.assertEqual(rec['size'], 64)
        self.assertEqual(rec['samples'], 4)
        self.assertEqual([lt['name'] for lt in rec['lights']], ['bake_sun'])

    def test_glass_and_the_air_in_it_cast_no_shadow_in_the_bake(self):
        """ゲームのガラスは影を落とさず光を通す（src/game/assets/area.ts）: 真上からの日で、ガラスの箱とその中の不透明な泡（焼かない
        光らない材質）の真下の床は、何もない所と同じ明るさ（±5%）。S-26 のレビュー1巡目: 泡入りの瓶の下が暗いしみになっていた"""
        import pipeline
        from mathutils import Vector
        from mathutils.geometry import barycentric_transform, intersect_point_tri_2d
        for o in (self.box, self.ware, self.col):
            bpy.data.objects.remove(o)
        air = _principled('A0_air', Metallic=1.0, Roughness=0.1)
        air['bake'] = False
        _mesh('A0_ware_clear02', lambda bm: bmesh.ops.create_cube(bm, size=0.6), [self.clear], location=(0.0, 0.0, 0.6))
        _mesh('A0_ware_air01', lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.2), [air],
              location=(0.0, 0.0, 0.6))
        bpy.context.view_layer.update()
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        with tempfile.TemporaryDirectory() as out:
            record = pipeline.bake_stage(objects, self.named(), out, {'size': 64, 'samples': 16, 'margin': 2})
            img = bpy.data.images.load(record['images'][0]['png'])
            w, h = img.size
            px = list(img.pixels)
            me = self.floor.data
            me.calc_loop_triangles()
            lm = me.uv_layers['Lightmap'].data

            def lum_at(x, y):
                p = Vector((x, y, 0.0))
                for t in me.loop_triangles:
                    v = [me.vertices[i].co for i in t.vertices]
                    if intersect_point_tri_2d(p.to_2d(), v[0].to_2d(), v[1].to_2d(), v[2].to_2d()):
                        uv = [Vector((*lm[li].uv, 0.0)) for li in t.loops]
                        u = barycentric_transform(p, v[0], v[1], v[2], uv[0], uv[1], uv[2])
                        i = (min(h - 1, int(u.y * h)) * w + min(w - 1, int(u.x * w))) * 4
                        return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
                raise AssertionError(f'no floor at {x}, {y}')

            under, open_floor = lum_at(0.0, 0.0), lum_at(1.2, 1.2)
        self.assertGreater(open_floor, 0.1)
        self.assertAlmostEqual(under / open_floor, 1.0, delta=0.05)
        # and nothing of the bake is left in the materials
        for m in (self.clear, air):
            self.assertNotIn('BSDF_TRANSPARENT', {n.type for n in m.node_tree.nodes}, m.name)

    def test_glass_lets_the_sky_through_in_the_bake(self):
        """空だけの光（一様な空）で、ガラスの箱の真下の床は開けた床と同じ明るさ（±5%）。拡散の光線もガラスを抜ける（影の光線だけ
        透明にしても、コースティクスを切った屈折の先の空は数えられず、ガラスの下が暗くなる）"""
        import pipeline
        from mathutils import Vector
        from mathutils.geometry import barycentric_transform, intersect_point_tri_2d
        for o in (self.box, self.ware, self.col, bpy.data.objects['bake_sun']):
            bpy.data.objects.remove(o)
        world = bpy.data.worlds.new('sky')
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (1.0, 1.0, 1.0, 1.0)
        bpy.context.scene.world = world
        _mesh('A0_ware_clear03', lambda bm: bmesh.ops.create_cube(bm, size=0.8), [self.clear], location=(0.0, 0.0, 0.45))
        bpy.context.view_layer.update()
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        with tempfile.TemporaryDirectory() as out:
            record = pipeline.bake_stage(objects, self.named(), out, {'size': 64, 'samples': 64, 'margin': 2})
            img = bpy.data.images.load(record['images'][0]['png'])
            w, h = img.size
            px = list(img.pixels)
            me = self.floor.data
            me.calc_loop_triangles()
            lm = me.uv_layers['Lightmap'].data

            def lum_at(x, y):
                p = Vector((x, y, 0.0))
                for t in me.loop_triangles:
                    v = [me.vertices[i].co for i in t.vertices]
                    if intersect_point_tri_2d(p.to_2d(), v[0].to_2d(), v[1].to_2d(), v[2].to_2d()):
                        uv = [Vector((*lm[li].uv, 0.0)) for li in t.loops]
                        u = barycentric_transform(p, v[0], v[1], v[2], uv[0], uv[1], uv[2])
                        i = (min(h - 1, int(u.y * h)) * w + min(w - 1, int(u.x * w))) * 4
                        return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
                raise AssertionError(f'no floor at {x}, {y}')

            # the open floor sampled as far from the box as its middle is from the floor's edge (the same sky)
            under, open_floor = lum_at(0.0, 0.0), lum_at(-1.0, 1.0)
        self.assertGreater(open_floor, 0.1)
        self.assertAlmostEqual(under / open_floor, 1.0, delta=0.05)

    def test_the_atlas_reads_its_own_uv_during_the_bake_and_the_nodes_come_back(self):
        """焼く間は Lightmap が描画用の UV になる: UV のノードのない画像のノードには元の UV をつなぎ、終わったら外す"""
        import pipeline
        from common import bake
        img = bpy.data.images.new('atlas', 4, 4)
        tex = self.brass.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = img
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        during = {}
        real = bake._bake

        def spy(margin):
            link = tex.inputs['Vector'].links
            during['uv'] = link[0].from_node.uv_map if link and link[0].from_node.type == 'UVMAP' else None
            during['render'] = next(u.name for u in self.box.data.uv_layers if u.active_render)
            return real(margin)

        bake._bake = spy
        try:
            with tempfile.TemporaryDirectory() as out:
                pipeline.bake_stage(objects, self.named(), out, {'size': 32, 'samples': 2, 'margin': 1})
        finally:
            bake._bake = real
        # while it bakes the UV that renders is the lightmap's, and the atlas reads its own (the first) all the same
        self.assertEqual(during, {'uv': 'UVMap', 'render': bake.UV_NAME})
        self.assertFalse(tex.inputs['Vector'].is_linked)
        self.assertNotIn('UVMAP', {n.type for n in self.brass.node_tree.nodes})

    def test_fills_what_is_not_baked_with_the_colour_of_the_islands(self):
        """島の間の焼いていない画素を、近くの島の色で埋める（ミップの粗い段で黒が島へ混ざらない）"""
        import numpy as np
        from common import bake
        rgb = np.zeros((8, 8, 3), np.float32)
        mask = np.zeros((8, 8), bool)
        rgb[1:3, 1:3] = (1.0, 0.5, 0.25)
        mask[1:3, 1:3] = True
        rgb[5:7, 5:7] = (0.2, 0.2, 0.2)
        mask[5:7, 5:7] = True
        bake._fill_gutters(rgb, mask)
        self.assertTrue(np.all(rgb.max(axis=2) > 0))
        self.assertEqual(tuple(rgb[1, 1]), (1.0, 0.5, 0.25))  # what is baked stays
        self.assertEqual(tuple(rgb[6, 6]), (0.2, 0.2, 0.2))
        self.assertAlmostEqual(float(rgb[0, 0, 0]), 1.0, places=5)  # next to the warm island, its colour

    def test_hides_colliders_and_coarser_levels_while_it_bakes(self):
        import pipeline
        lod = _mesh('A0_box_01_LOD1', lambda bm: bmesh.ops.create_cube(bm, size=2.0), [self.brass], location=(0, 0, 0.3))
        self.col.hide_render = False
        objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        seen = {}
        real = pipeline.bake.bake_lightmaps

        def spy(objs, *args, **kwargs):
            seen.update({o.name: o.hide_render for o in (self.col, lod)})
            return real(objs, *args, **kwargs)

        pipeline.bake.bake_lightmaps = spy
        try:
            with tempfile.TemporaryDirectory() as out:
                pipeline.bake_stage(objects, self.named(), out, {'size': 32, 'samples': 2, 'margin': 1})
        finally:
            pipeline.bake.bake_lightmaps = real
        self.assertEqual(seen, {self.col.name: True, lod.name: True})
        self.assertFalse(self.col.hide_render)
        self.assertFalse(lod.hide_render)

    def test_density_makes_a_piece_finer_than_the_rest(self):
        from common import bake, uv
        a = _mesh('A0_pan_a01', lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0), [self.brass])
        b = _mesh('A0_pan_b01', lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0), [self.brass],
                  location=(3.0, 0.0, 0.0))
        bake._prepare_uv([a, b], True, 0.004, frozenset(), {'A0_pan_a01': 2.0})
        ratio = uv.uv_area(a, bake.UV_NAME) / uv.uv_area(b, bake.UV_NAME)
        self.assertAlmostEqual(ratio, 4.0, delta=0.2)  # twice the texels each way


if __name__ == '__main__':
    unittest.main()
