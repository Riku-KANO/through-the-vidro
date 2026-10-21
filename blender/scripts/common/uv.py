"""2つ目の UV（ライトマップ用）を用意する。

焼き込み（bake.py）と同じ名前 `Lightmap` の UV を、glb の TEXCOORD_1 になるよう2つ目に作る。
- UV が2つ以上ある物はそのまま（人が作った2つ目の UV を消さない）。`repack=True` で `Lightmap` を作り直す
- UV が1つもない物には、先に1つ目（UVMap）を作る（Lightmap を必ず2つ目にするため）
- 物ごとに 0〜1 の正方形の中へ、重ならないよう展開する（smart project ＋ pack islands）。
  複数の物で1枚のライトマップを分けるなら、焼き込みの側で詰め直す（bake.py の repack）
- 終わったら、編集用と描画用の UV を1つ目に戻す（色のテクスチャは1つ目の UV を使う）
"""
from __future__ import annotations

import math

import bpy

from .bake import UV_NAME

#: smart project の角度の上限（bake.py と同じ）
ANGLE_LIMIT_DEG = 66.0
#: 島の間の余白（0〜1 の UV の中の割合）
ISLAND_MARGIN = 0.02


def _select_only(obj) -> None:
    view_layer = bpy.context.view_layer
    for o in view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    view_layer.objects.active = obj


def ensure_lightmap_uv(objects, *, repack: bool = False, island_margin: float = ISLAND_MARGIN) -> dict:
    """objects（メッシュ）に2つ目の UV を用意する。物の名前 → 'generated' | 'kept' を返す"""
    result: dict = {}
    view_layer = bpy.context.view_layer
    was_active = view_layer.objects.active
    was_selected = [o for o in view_layer.objects if o.select_get()]
    try:
        for obj in objects:
            if obj.type != 'MESH':
                continue
            me = obj.data
            if UV_NAME in me.uv_layers and repack:
                me.uv_layers.remove(me.uv_layers[UV_NAME])
            if len(me.uv_layers) >= 2:
                result[obj.name] = 'kept'
                continue
            if len(me.uv_layers) == 0:
                me.uv_layers.new(name='UVMap')
            first = me.uv_layers[0].name
            lightmap = me.uv_layers.new(name=UV_NAME)
            me.uv_layers.active = lightmap
            _select_only(obj)
            bpy.ops.object.mode_set(mode='EDIT')
            try:
                bpy.context.tool_settings.use_uv_select_sync = True
                bpy.ops.mesh.select_all(action='SELECT')
                bpy.ops.uv.smart_project(angle_limit=math.radians(ANGLE_LIMIT_DEG), island_margin=island_margin)
                bpy.ops.uv.pack_islands(margin=island_margin)
            finally:
                bpy.ops.object.mode_set(mode='OBJECT')
            me.uv_layers.active = me.uv_layers[first]
            me.uv_layers[first].active_render = True
            result[obj.name] = 'generated'
    finally:
        for o in view_layer.objects:
            o.select_set(False)
        for o in was_selected:
            o.select_set(True)
        view_layer.objects.active = was_active
    return result


def uv_area(obj, name: str = UV_NAME) -> float:
    """UV の面積の合計（島が重ならなければ 1 以下）。確かめるため"""
    me = obj.data
    layer = me.uv_layers[name].data
    total = 0.0
    for poly in me.polygons:
        pts = [layer[i].uv for i in poly.loop_indices]
        s = 0.0
        for a, b in zip(pts, pts[1:] + pts[:1]):
            s += a.x * b.y - b.x * a.y
        total += abs(s) / 2
    return total
