"""パイプラインの見本の .blend を作る（S-23）。床・真鍮の枠・台座・ガラスと、当たり判定・詳細度・共通の物。

    pnpm assets:sample     （= blender -b --factory-startup -P blender/scripts/make_sample.py -- --out blender/scenes/asset-lab.blend）

作るもの（three の座標で書く。Y が上、-Z が奥。Blender へは common.coords.three_to_blender で直す）:
- A0_flr_floor01        石のタイルの床（色と法線のテクスチャ。蝋を引いた石: スペキュラー 0.35・屈折率 1.45）。両方の層
- A0_flr_floor01_col    床の当たり判定（上面が y = 0）
- A0_frm_arch01         真鍮の枠（ドームの上の細い管）。両方の層
- A0_sock_01            台座（原点 = 置いた玉の中心）。実体化半径 2m（小玉）。真鍮の輪は子の部品
- A0_sock_01_col        台座の当たり判定
- A0_bld_dome01_front   透明ガラスのドーム（glass_clear）。表の層だけ。台座の球に一部が入り、そこは描かれない
- A0_brg_bridge01_back  虹色ガラスの橋（glass_iridescent）。裏の層だけ。台座の球の中でだけ見える
- A0_brg_bridge01_col   橋の当たり判定（裏の足場）
- A0_vas_vase01         印のない透過の材質の花瓶（ゲームは glTF の値のまま読む）
- CM_lmp_lamp01_LOD0/1  共通の街灯（真鍮の柱と乳白ガラス glass_milky）。詳細度 2 段

人が開いて形や材質を直してよい。作り直すと上書きする（直した分は消える）。
"""
from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common.cli import script_args  # noqa: E402
from common.coords import three_to_blender as B  # noqa: E402

# ── 配置（three の座標、m） ────────────────────────────────────────────────
FLOOR = {'center': (0.0, 0.0, -0.6), 'radius': 3.6, 'depth': 0.12, 'bevel': 0.05}
#: 1 枚のテクスチャに 4×4 枚のタイル（タイル 0.6m）
TILE = 0.6
TEX_TILES = 4
TEX_SIZE = 512
SOCKET = {'base': (1.25, 0.0, -0.35), 'height': 0.9, 'orb': 0.11, 'radius': 0.2}
#: コアメカニクス > ガラス玉の性質の成長: 小玉(実体化半径2m)
SOCKET_RADIUS = 2.0
DOME = {'center': (-0.95, 0.0, -1.3), 'radius': 0.85}
BRIDGE = {'from_x': 0.35, 'to_x': 2.15, 'z': -1.5, 'width': 0.6, 'deck': 0.07, 'rise': 0.3, 'rail': 0.42}
VASE = {'base': (-0.75, 0.0, 0.75)}
LAMP = {'base': (2.4, 0.0, -2.3), 'post': 2.05, 'globe': 0.19}
CAMERA = {'position': (0.45, 1.4, 2.9), 'target': (0.35, 0.55, -1.0), 'fov_deg': 70}

#: アートディレクション: ほぼ無色。白、薄い青灰、ガラスの縁の緑、真鍮の鈍い金（線形 RGB）
STONE = (0.42, 0.40, 0.37)
STONE_PALE = (0.62, 0.61, 0.58)
BRASS = (0.62, 0.45, 0.22)


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_object(name: str, me) -> bpy.types.Object:
    return link(bpy.data.objects.new(name, me))


def smooth(me, sharp_deg: float | None = 50.0) -> None:
    me.shade_smooth()
    if sharp_deg is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp_deg))


def lathe(name: str, profile: list, segments: int = 48) -> bpy.types.Mesh:
    """(半径, 高さ) の列を Y 軸（three の上）の周りに回した面。半径 0 の点は軸の上の1点にまとめる。

    輪郭は下から外側を通って上へたどる（面が外を向く）。
    """
    bm = bmesh.new()
    rings = []
    for r, y in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new(B((0.0, y, 0.0)))])
            continue
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            ring.append(bm.verts.new(B((r * math.cos(a), y, -r * math.sin(a)))))
        rings.append(ring)
    for lo, hi in zip(rings, rings[1:]):
        if len(lo) == 1 and len(hi) == 1:
            continue
        for i in range(segments):
            j = (i + 1) % segments
            if len(lo) == 1:
                bm.faces.new((lo[0], hi[j], hi[i]))
            elif len(hi) == 1:
                bm.faces.new((lo[j], hi[0], lo[i]))
            else:
                bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    # 面は外を向く: 輪郭を下の軸 → 外側 → 上の軸の順にたどると、どの面も外向きの巻き方になる（開いた形も同じ。
    # recalc_face_normals は開いた形を内向きにすることがある）
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def move(obj, three_pos) -> None:
    obj.location = B(three_pos)


# ── テクスチャ（numpy で描いて .blend に詰める） ──────────────────────────
def tile_maps(size: int = TEX_SIZE, tiles: int = TEX_TILES, seed: int = 7):
    """石のタイルの色（線形 RGB）と高さ（0〜1）。目地は細い溝"""
    rng = np.random.default_rng(seed)
    v, u = np.mgrid[0:size, 0:size] / size * tiles
    iu, iv = np.floor(u).astype(int), np.floor(v).astype(int)
    fu, fv = u - iu, v - iv
    edge = np.minimum(np.minimum(fu, 1 - fu), np.minimum(fv, 1 - fv))  # タイルの縁までの距離（タイル単位）
    groove = 0.035
    height = np.clip((edge - groove * 0.4) / groove, 0, 1) ** 0.6
    tint = rng.uniform(0.9, 1.1, size=(tiles, tiles))[iv % tiles, iu % tiles]
    noise = rng.normal(0, 1, size=(size // 8, size // 8))
    noise = np.kron(noise, np.ones((8, 8)))
    color = np.stack([np.full_like(u, c) for c in STONE], axis=-1) * (tint * (1 + 0.04 * noise))[..., None]
    grout = (0.55 + 0.45 * height)[..., None]
    return np.clip(color * grout, 0, 1), height


def normal_from_height(height: np.ndarray, strength: float = 6.0) -> np.ndarray:
    """接空間の法線（OpenGL の向き: 緑が上）を 0〜1 に詰めたもの"""
    dy, dx = np.gradient(height)
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def packed_image(name: str, rgb: np.ndarray, color: bool) -> bpy.types.Image:
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    rgba = np.concatenate([rgb, np.ones((h, w, 1))], axis=-1).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'PNG'
    img.pack()
    return img


# ── 材質 ──────────────────────────────────────────────────────────────────
def principled(name: str):
    m = bpy.data.materials.new(name)  # Blender 5 の新しい材質は、はじめから Principled BSDF のノードを持つ
    m.use_backface_culling = True  # 閉じた形と外から見る殻だけ（glTF の doubleSided: false）
    return m, m.node_tree.nodes['Principled BSDF']


def gltf_output(m, thickness: float):
    """glTF Material Output（厚み → KHR_materials_volume の thicknessFactor）"""
    from io_scene_gltf2.blender.com.material_helpers import create_settings_group, get_gltf_node_name
    group = bpy.data.node_groups.get(get_gltf_node_name()) or create_settings_group(get_gltf_node_name())
    node = m.node_tree.nodes.new('ShaderNodeGroup')
    node.node_tree = group
    node.inputs['Thickness'].default_value = thickness
    node.location = (300, -300)
    return node


def glass_material(name: str, *, thickness: float, absorption: tuple, distance: float, roughness: float = 0.0):
    """透過・屈折率・吸収（ボリューム）・厚み。色は表面ではなく内部の吸収で出す（アートディレクション > ガラスの種類）"""
    m, p = principled(name)
    p.inputs['Base Color'].default_value = (1, 1, 1, 1)
    p.inputs['Transmission Weight'].default_value = 1.0
    p.inputs['Roughness'].default_value = roughness
    p.inputs['IOR'].default_value = 1.5  # 技術設計 > ガラスの描画: 屈折率1.5
    vol = m.node_tree.nodes.new('ShaderNodeVolumeAbsorption')
    vol.inputs['Color'].default_value = (*absorption, 1)
    vol.inputs['Density'].default_value = 1.0 / distance
    m.node_tree.links.new(vol.outputs['Volume'], m.node_tree.nodes['Material Output'].inputs['Volume'])
    gltf_output(m, thickness)
    return m


def stone_floor_material():
    m, p = principled('A0_stone_floor')
    color, height = tile_maps()
    nodes, links = m.node_tree.nodes, m.node_tree.links
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = packed_image('A0_stone_color', color ** (1 / 2.2), color=True)  # sRGB に詰める（おおよそ）
    nrm = nodes.new('ShaderNodeTexImage')
    nrm.image = packed_image('A0_stone_normal', normal_from_height(height), color=False)
    nmap = nodes.new('ShaderNodeNormalMap')
    nmap.inputs['Strength'].default_value = 1.0
    links.new(tex.outputs['Color'], p.inputs['Base Color'])
    links.new(nrm.outputs['Color'], nmap.inputs['Color'])
    links.new(nmap.outputs['Normal'], p.inputs['Normal'])
    p.inputs['Roughness'].default_value = 0.62
    p.inputs['Specular IOR Level'].default_value = 0.35  # 蝋を引いた石（→ KHR_materials_specular）
    p.inputs['IOR'].default_value = 1.45  # 蝋（→ KHR_materials_ior）
    return m


def opaque_material(name: str, color: tuple, *, metallic: float = 0.0, roughness: float = 0.5):
    m, p = principled(name)
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    return m


def milky_material():
    m, p = principled('glass_milky')
    p.inputs['Base Color'].default_value = (0.95, 0.93, 0.88, 1)
    p.inputs['Roughness'].default_value = 0.55
    # 内側からの灯り（乳白ガラス: 透過を抑え、内側から発光させる）。ゲームはこの発光を乳白ガラスの glow にする
    # （src/game/assets/glass.ts）。色と強さは src/core/glass の乳白の既定（0xffb46e、2.6）に合わせた（線形の色）
    p.inputs['Emission Color'].default_value = (1.0, 0.456, 0.159, 1)
    p.inputs['Emission Strength'].default_value = 2.6
    return m


# ── 形 ────────────────────────────────────────────────────────────────────
def planar_uv(me, size: float) -> None:
    """上から見た平面の UV（three の x・z を size で割る。Blender では x・y）"""
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (co.x / size, co.y / size)


def floor(materials):
    r, d, b = FLOOR['radius'], FLOOR['depth'], FLOOR['bevel']
    profile = [(0.0, -d)]
    profile += [(r - b + b * math.sin(math.pi / 2 * i / 4), -d + b - b * math.cos(math.pi / 2 * i / 4)) for i in range(5)]
    profile += [(r - b + b * math.cos(math.pi / 2 * i / 4), -b + b * math.sin(math.pi / 2 * i / 4)) for i in range(1, 5)]
    profile += [(r - b - 0.02, 0.0), (r * 0.66, 0.0), (r * 0.33, 0.0), (0.0, 0.0)]
    me = lathe('A0_flr_floor01', profile, segments=96)
    smooth(me)
    planar_uv(me, TILE * TEX_TILES)
    me.materials.append(materials['floor'])
    o = mesh_object('A0_flr_floor01', me)
    move(o, FLOOR['center'])
    col = lathe('A0_flr_floor01_col', [(0.0, -d), (r, -d), (r, 0.0), (0.0, 0.0)], segments=24)
    c = mesh_object('A0_flr_floor01_col', col)
    move(c, FLOOR['center'])
    c.display_type = 'WIRE'


def socket(materials):
    h, orb, rad = SOCKET['height'], SOCKET['orb'], SOCKET['radius']
    seat = h + orb * 0.92  # 玉は輪の上に少し沈んで座る
    # 原点 = 置いた玉の中心。形は原点からの相対で作る
    profile = [(0.0, 0.0), (rad + 0.04, 0.0), (rad + 0.05, 0.03), (rad + 0.02, 0.06), (rad - 0.02, 0.08),
               (rad * 0.72, 0.14), (rad * 0.62, 0.3), (rad * 0.6, h - 0.16), (rad * 0.7, h - 0.08),
               (rad * 0.86, h - 0.03), (rad * 0.8, h), (0.0, h)]
    me = lathe('A0_sock_01', [(r, y - seat) for r, y in profile], segments=48)
    smooth(me, sharp_deg=60)
    me.materials.append(materials['stone_pale'])
    o = mesh_object('A0_sock_01', me)
    move(o, (SOCKET['base'][0], seat, SOCKET['base'][2]))
    o['materialize_radius'] = SOCKET_RADIUS
    # 真鍮の輪（玉の受け）。名前は規則に合わなくてよい（台座の部品）
    bpy.ops.mesh.primitive_torus_add(major_radius=orb * 0.62, minor_radius=0.012, major_segments=48, minor_segments=10)
    ring = bpy.context.active_object
    ring.name = 'sock_ring'
    ring.data.name = 'sock_ring'
    ring.data.materials.append(materials['brass'])
    smooth(ring.data, sharp_deg=None)
    ring.parent = o
    ring.location = B((0.0, h + 0.004 - seat, 0.0))
    col = lathe('A0_sock_01_col', [(0.0, 0.0), (rad + 0.05, 0.0), (rad + 0.05, h), (0.0, h)], segments=16)
    c = mesh_object('A0_sock_01_col', col)
    move(c, SOCKET['base'])
    c.display_type = 'WIRE'


def dome(materials):
    r = DOME['radius']
    profile = [(r * math.cos(math.pi / 2 * i / 24), r * math.sin(math.pi / 2 * i / 24)) for i in range(25)]
    profile[-1] = (0.0, r)
    me = lathe('A0_bld_dome01_front', profile, segments=72)
    smooth(me, sharp_deg=None)
    me.materials.append(materials['glass_clear'])
    o = mesh_object('A0_bld_dome01_front', me)
    move(o, DOME['center'])


def tube_curve(name: str, points: list, radius: float):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius
    cu.bevel_resolution = 2
    cu.use_fill_caps = True
    sp = cu.splines.new('POLY')
    sp.points.add(len(points) - 1)
    for p, xyz in zip(sp.points, points):
        p.co = (*B(xyz), 1.0)
    return link(bpy.data.objects.new(name, cu))


def brass_frame(materials):
    """ドームの面から取った細い管（形のルール: 直線と細い線は真鍮の枠だけ）。4 本の子午線、裾の輪、頂の玉"""
    cx, _, cz = DOME['center']
    r = DOME['radius'] + 0.018
    parts = []
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        pts = []
        for i in range(21):
            t = math.pi / 2 * i / 20
            pts.append((cx + r * math.cos(t) * math.cos(a), r * math.sin(t), cz - r * math.cos(t) * math.sin(a)))
        parts.append(tube_curve(f'rib{k}', pts, 0.011))
    ring = [(cx + r * math.cos(2 * math.pi * i / 64), 0.012, cz - r * math.sin(2 * math.pi * i / 64)) for i in range(65)]
    parts.append(tube_curve('ring', ring, 0.016))
    for o in parts:
        o.data.resolution_u = 2
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.join()
    frame = bpy.context.active_object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, segments=16, ring_count=8, location=B((cx, r + 0.03, cz)))
    knob = bpy.context.active_object
    frame.select_set(True)
    bpy.context.view_layer.objects.active = frame
    bpy.ops.object.join()
    frame.name = 'A0_frm_arch01'
    frame.data.name = 'A0_frm_arch01'
    frame.data.materials.clear()
    frame.data.materials.append(materials['brass'])
    bpy.context.view_layer.objects.active = frame
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    smooth(frame.data, sharp_deg=None)
    del knob


def bridge(materials):
    """裏の層の橋: 角の丸い板を、ゆるいアーチに沿って掃く"""
    x0, x1, z, w, t, rise = (BRIDGE[k] for k in ('from_x', 'to_x', 'z', 'width', 'deck', 'rise'))
    steps, around = 40, 20
    bm = bmesh.new()
    rings = []
    for i in range(steps + 1):
        s = i / steps
        x = x0 + (x1 - x0) * s
        top = rise * math.sin(math.pi * s)
        ring = []
        for j in range(around):
            a = 2 * math.pi * j / around
            # 角の丸い長方形（超楕円）の断面
            cy, cw = math.sin(a), math.cos(a)
            py = math.copysign(abs(cy) ** 0.35, cy) * t / 2
            pw = math.copysign(abs(cw) ** 0.35, cw) * w / 2
            ring.append(bm.verts.new(B((x, top - t / 2 + py, z + pw))))
        rings.append(ring)
    for lo, hi in zip(rings, rings[1:]):
        for j in range(around):
            k = (j + 1) % around
            bm.faces.new((lo[j], lo[k], hi[k], hi[j]))
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('A0_brg_bridge01_back')
    bm.to_mesh(me)
    bm.free()
    smooth(me, sharp_deg=70)
    me.materials.append(materials['glass_iridescent'])
    deck = mesh_object('A0_brg_bridge01_back', me)
    # 真鍮の手すり（形のルール: 直線と細い線は真鍮の枠だけ）。橋と同じ物（裏の層）なので、球の中でだけ見える
    rails = []
    for side in (-1, 1):
        zr = z + side * (w / 2 - 0.035)
        pts = [(x0 + (x1 - x0) * i / 24, rise * math.sin(math.pi * i / 24) + BRIDGE['rail'], zr) for i in range(25)]
        rails.append(tube_curve(f'rail{side}', pts, 0.012))
        for i in (0, 6, 12, 18, 24):
            xp = x0 + (x1 - x0) * i / 24
            top = rise * math.sin(math.pi * i / 24)
            rails.append(tube_curve(f'post{side}{i}', [(xp, top, zr), (xp, top + BRIDGE['rail'], zr)], 0.009))
    bpy.ops.object.select_all(action='DESELECT')
    for o in rails:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rails[0]
    bpy.ops.object.convert(target='MESH')
    for o in rails:
        o.data.materials.clear()
        o.data.materials.append(materials['brass'])
        smooth(o.data, sharp_deg=None)
    deck.select_set(True)
    bpy.context.view_layer.objects.active = deck
    bpy.ops.object.join()
    # 当たり判定: 上面だけのアーチの板（8 区切り）
    bm = bmesh.new()
    prev = None
    for i in range(9):
        s = i / 8
        x = x0 + (x1 - x0) * s
        top = rise * math.sin(math.pi * s)
        pair = (bm.verts.new(B((x, top, z - w / 2))), bm.verts.new(B((x, top, z + w / 2))),
                bm.verts.new(B((x, top - t, z + w / 2))), bm.verts.new(B((x, top - t, z - w / 2))))
        if prev:
            for j in range(4):
                bm.faces.new((prev[j], prev[(j + 1) % 4], pair[(j + 1) % 4], pair[j]))
        prev = pair
    me = bpy.data.meshes.new('A0_brg_bridge01_col')
    bm.to_mesh(me)
    bm.free()
    c = mesh_object('A0_brg_bridge01_col', me)
    c.display_type = 'WIRE'


def vase(materials):
    pts = [(0.0, 0.0), (0.07, 0.0), (0.105, 0.04), (0.12, 0.12), (0.1, 0.22), (0.055, 0.29), (0.05, 0.33), (0.065, 0.36)]
    me = lathe('A0_vas_vase01', pts, segments=48)
    smooth(me, sharp_deg=None)
    me.materials.append(materials['vase'])
    o = mesh_object('A0_vas_vase01', me)
    move(o, VASE['base'])


def lamp(materials, lod: int):
    seg = (24, 8)[lod]
    rings = (16, 6)[lod]
    name = f'CM_lmp_lamp01_LOD{lod}'
    post = lathe(name, [(0.0, 0.0), (0.09, 0.0), (0.09, 0.03), (0.035, 0.06), (0.025, LAMP['post']),
                        (0.06, LAMP['post'] + 0.03), (0.0, LAMP['post'] + 0.03)], segments=seg)
    post.materials.append(materials['brass'])
    post.materials.append(materials['glass_milky'])
    bm = bmesh.new()
    bm.from_mesh(post)
    globe = bmesh.ops.create_uvsphere(bm, u_segments=seg * 2, v_segments=rings, radius=LAMP['globe'])
    bmesh.ops.translate(bm, verts=globe['verts'], vec=B((0.0, LAMP['post'] + 0.03 + LAMP['globe'] * 0.95, 0.0)))
    for f in {f for v in globe['verts'] for f in v.link_faces}:
        f.material_index = 1
    bm.to_mesh(post)
    bm.free()
    smooth(post, sharp_deg=60)
    o = mesh_object(name, post)
    move(o, LAMP['base'])


def preview_rig() -> None:
    """Blender で見るためのカメラと日の光（書き出さない）"""
    cam = bpy.data.cameras.new('preview')
    cam.sensor_fit = 'VERTICAL'
    cam.angle_y = math.radians(CAMERA['fov_deg'])  # 操作とカメラ > カメラ: 視野角70度
    c = link(bpy.data.objects.new('preview_camera', cam))
    c.location = B(CAMERA['position'])
    direction = np.subtract(B(CAMERA['target']), B(CAMERA['position']))
    from mathutils import Vector
    c.rotation_euler = Vector(direction).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = c
    sun = bpy.data.lights.new('preview_sun', 'SUN')
    sun.energy = 3.0
    s = link(bpy.data.objects.new('preview_sun', sun))
    s.rotation_euler = (math.radians(50), 0, math.radians(30))
    bpy.context.scene.render.resolution_x = 1280
    bpy.context.scene.render.resolution_y = 720


def build() -> None:
    clear_scene()
    materials = {
        'floor': stone_floor_material(),
        'stone_pale': opaque_material('A0_stone_pale', STONE_PALE, roughness=0.55),
        'brass': opaque_material('brass', BRASS, metallic=1.0, roughness=0.32),
        # ゲームが印から作り直す（src/game/assets/glass.ts）。Blender の値は、Blender の中での見た目のため
        'glass_clear': glass_material('glass_clear', thickness=0.045, absorption=(0.6, 0.86, 0.72), distance=0.3),
        'glass_iridescent': glass_material('glass_iridescent', thickness=0.07, absorption=(0.95, 0.97, 0.99), distance=1.0),
        'glass_milky': milky_material(),
        # 印のない透過の材質: ゲームは glTF の値（透過・屈折率・吸収・厚み）のまま読む
        'vase': glass_material('A0_vase_glass', thickness=0.05, absorption=(0.55, 0.8, 0.85), distance=0.12, roughness=0.04),
    }
    floor(materials)
    socket(materials)
    dome(materials)
    brass_frame(materials)
    bridge(materials)
    vase(materials)
    lamp(materials, 0)
    lamp(materials, 1)
    preview_rig()


def main() -> None:
    args = script_args()
    out = args[args.index('--out') + 1] if '--out' in args else 'blender/scenes/asset-lab.blend'
    build()
    bpy.context.preferences.filepaths.save_version = 0  # .blend1 を作らない
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
    print(f'[vidro] wrote {out}')


if __name__ == '__main__':
    main()
