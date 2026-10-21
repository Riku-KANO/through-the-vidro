"""書き出しのパイプライン（S-23。設計書 Blenderアセットパイプライン > 自動化）。Blender の中で走る。

    blender -b <file.blend> --python-exit-code 1 -P blender/scripts/pipeline.py -- --out <dir> --report <report.json>

`pnpm assets`（scripts/assets/pipeline.mjs）が呼び、その後に gltf-transform で圧縮する。順に:
1. 命名規則の検査（vidro/naming.py。名前・カスタムプロパティ・ガラスの材質の印・詳細度・当たり判定の層）
2. ポリゴン数の報告（モディファイアを適用した三角形の数を、vidro/budget.py の予算の表と照らす。超えても止めない）
3. 1 に問題があれば、ここで止める（何も書き出さない。終了コード 2）
4. 台座と共鳴器の原点を extras の origin に書く（圧縮の量子化で物の位置が形の中心へ動くため）
5. 2つ目の UV（common/uv.py。透過でない材質を持つ見た目の物だけ。ガラスと当たり判定には作らない）
6. エリアごとに glb を書く（A1 → a1.glb、CM → common.glb）。透過・屈折率・吸収（ボリューム）・スペキュラーの拡張は
   材質が使っていれば Blender の glTF 書き出しが書く。画像は glb に埋め込む（圧縮で KTX2 にするため）

.blend は保存しない（2つ目の UV も origin も、書き出しのためだけに作る）。結果は --report の JSON に書く。
"""
from __future__ import annotations

import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from common import stats, uv  # noqa: E402
from common.cli import script_args  # noqa: E402
from common.coords import blender_to_three  # noqa: E402
from common.export import export_glb  # noqa: E402
from vidro import budget, naming  # noqa: E402

#: 書き出す物の種類（ライトとカメラは書かない。ゲームが自分で置く）
EXPORT_TYPES = stats.GEOMETRY_TYPES | {'EMPTY'}
#: 原点を origin に書く種類
ANCHORED_KINDS = (naming.SOCKET, naming.BELL)
LINT_FAILED = 2

GLTF_OPTIONS = {
    'export_image_format': 'AUTO',  # PNG / JPEG のまま埋め込む（gltf-transform が KTX2 にする）
    'export_texcoords': True,  # すべての UV（2つ目 = TEXCOORD_1）
    'export_normals': True,
    'export_tangents': False,  # three が法線マップの接線を作る
    'export_materials': 'EXPORT',
    'export_extras': True,
    'export_yup': True,
    'export_apply': True,
}


def plain(value):
    """カスタムプロパティを JSON の値に（IDPropertyArray → list、IDPropertyGroup → dict）"""
    if hasattr(value, 'to_dict'):
        return {k: plain(v) for k, v in value.to_dict().items()}
    if hasattr(value, 'to_list'):
        return [plain(v) for v in value.to_list()]
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def extras_of(obj) -> dict:
    return {k: plain(v) for k, v in obj.items() if not k.startswith('_')}


def materials_of(obj) -> list:
    return [s.material.name for s in getattr(obj, 'material_slots', []) if s.material is not None]


def is_transmissive(material) -> bool:
    if material is None or material.node_tree is None:
        return False
    for node in material.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            socket = node.inputs.get('Transmission Weight')
            if socket is not None and (socket.is_linked or socket.default_value > 0):
                return True
    return False


def owner_of(obj, named: dict):
    """名前が規則に合う、いちばん近い自分か祖先"""
    o = obj
    while o is not None:
        if o.name in named:
            return o
        o = o.parent
    return None


def run(out_dir: str, report_path: str) -> int:
    scene = bpy.context.scene
    # the view layer's objects: collections excluded from it (work in progress, references) are not exported
    in_layer = list(bpy.context.view_layer.objects)
    objects = [o for o in in_layer if o.type in EXPORT_TYPES]
    skipped = sorted(o.name for o in in_layer if o.type not in EXPORT_TYPES)
    entries = [{'name': o.name, 'parent': o.parent.name if o.parent else None, 'extras': extras_of(o),
                'materials': materials_of(o)} for o in objects]
    problems = naming.lint(entries)

    named = {}
    for o in objects:
        r = naming.parse_name(o.name)
        if r['ok']:
            named[o.name] = r['value']
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = {name: 0 for name in named}
    for o in objects:
        owner = owner_of(o, named)
        if owner is not None:
            triangles[owner.name] += stats.triangle_count(o, depsgraph)
    rows = [{'name': n, 'parsed': p, 'triangles': triangles[n]} for n, p in named.items()]
    # 透過なのに glass_ の印がない材質（vidro/naming.py の unmarked_glass_level。ゲームと同じ規則）:
    # 置き場所が near なら warning（止めない）、far / behind-glass なら problem（止める）
    warnings = []
    for o in objects:
        owner = owner_of(o, named)
        if owner is None or named[owner.name]['role'] == 'col':
            continue
        placement = plain(owner.get('placement', 'near'))
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if m is None:
                continue
            level = naming.unmarked_glass_level(m.name, is_transmissive(m), placement)
            if level is None:
                continue
            message = naming.MESSAGES['glass-unmarked'] + '（材質 ' + m.name + '、置き場所 ' + str(placement) + '）'
            entry = {'object': owner.name, 'code': 'glass-unmarked', 'material': m.name, 'message': message}
            target = warnings if level == 'warning' else problems
            if entry not in target:
                target.append(entry)
    report = {
        'blend': bpy.data.filepath,
        'problems': problems,
        'warnings': warnings,
        'budget': budget.check(rows),
        'uv2': {},
        'groups': [],
        'skipped': skipped,
    }
    if problems:
        write_report(report_path, report)
        print(f'[vidro] {len(problems)} naming problem(s); nothing exported')
        return LINT_FAILED

    for name, parsed in named.items():
        if parsed['kind'] in ANCHORED_KINDS and parsed['role'] != 'col':
            o = scene.objects[name]
            o['origin'] = [round(c, 6) for c in blender_to_three(o.matrix_world.translation)]

    drawn = []
    for o in objects:
        owner = owner_of(o, named)
        if o.type != 'MESH' or owner is None or named[owner.name]['role'] == 'col':
            continue
        mats = [s.material for s in o.material_slots]
        if not mats or any(not is_transmissive(m) for m in mats):
            drawn.append(o)
    report['uv2'] = uv.ensure_lightmap_uv(drawn)

    groups: dict = {}
    for o in objects:
        owner = owner_of(o, named)
        if owner is not None:
            groups.setdefault(named[owner.name]['group'], []).append(o)
    os.makedirs(out_dir, exist_ok=True)
    for group in sorted(groups):
        path = os.path.join(out_dir, f'{group}.glb')
        size = export_glb(groups[group], path, max_bytes=None, check=False, options=GLTF_OPTIONS)
        report['groups'].append({'group': group, 'file': path, 'bytes': size,
                                 'objects': sorted(o.name for o in groups[group])})
    write_report(report_path, report)
    print(f'[vidro] exported {", ".join(g["group"] for g in report["groups"])}')
    return 0


def write_report(path: str, report: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def main() -> None:
    args = script_args()

    def arg(name: str) -> str:
        if name not in args:
            raise SystemExit(f'pipeline.py: {name} <path> is required')
        return args[args.index(name) + 1]

    code = run(os.path.abspath(arg('--out')), os.path.abspath(arg('--report')))
    if code:
        sys.exit(code)


if __name__ == '__main__':
    main()
