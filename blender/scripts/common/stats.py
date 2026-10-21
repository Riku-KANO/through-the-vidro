"""物の大きさの数え方（ポリゴン数の報告）。

数えるのは書き出される形: モディファイア（サブディビジョンなど）を適用した後の三角形（`export_apply=True` と同じ）。
予算の表（どの種類の物に何個まで）は案ごとに違うので、ここには置かない。
"""
from __future__ import annotations

import bpy

#: 形を持つ物の種類（書き出しでメッシュになる）
GEOMETRY_TYPES = frozenset({'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'})


def triangle_count(obj, depsgraph=None) -> int:
    """モディファイアを適用した後の三角形の数。形を持たない物（空の物体など）は 0"""
    if obj.type not in GEOMETRY_TYPES:
        return 0
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        if mesh is None:
            return 0
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    finally:
        evaluated.to_mesh_clear()
