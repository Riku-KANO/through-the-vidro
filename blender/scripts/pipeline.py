"""書き出しのパイプライン（S-23。設計書 Blenderアセットパイプライン > 自動化）。Blender の中で走る。

    blender -b <file.blend> --python-exit-code 1 -P blender/scripts/pipeline.py -- --out <dir> --report <report.json>
        [--bake <JSON: blender/pipeline.json の job の bake>]

`pnpm assets`（scripts/assets/pipeline.mjs）が呼び、その後に gltf-transform で圧縮する。順に:
1. 命名規則の検査（vidro/naming.py。名前・カスタムプロパティ・ガラスの材質の印・詳細度・当たり判定の層）
2. ポリゴン数の報告（モディファイアを適用した三角形の数を、vidro/budget.py の予算の表と照らす。超えても止めない）
3. 1 に問題があれば、ここで止める（何も書き出さない。終了コード 2）
4. 台座と共鳴器の原点を extras の origin に書く（圧縮の量子化で物の位置が形の中心へ動くため）
5. 2つ目の UV（common/uv.py。透過でない材質を持つ見た目の物だけ。ガラスと当たり判定には作らない）
6. 焼き込み（S-26。--bake があるとき）: エリアごとに、焼ける材質（bakeable_material）を持つ見た目の物の光と影を、1 枚の
   ライトマップに Cycles で焼く（common/bake.py。2つ目の UV はそこで詰め直す。焼けない材質の面は UV を潰す）。
   物の extras に lightmap（画像の名前 `<エリア>_lightmap`）と lightmap_scale、scene の extras に bake（大きさ・サンプル数・
   かかった秒・焼いた光と空）を書く。画像は --out の lightmaps/ に PNG で置き、scripts/assets が glb の中へ KTX2 で入れる
7. エリアごとに glb を書く（A1 → a1.glb、CM → common.glb）。透過・屈折率・吸収（ボリューム）・スペキュラーの拡張は
   材質が使っていれば Blender の glTF 書き出しが書く。画像は glb に埋め込む（圧縮で KTX2 にするため）

.blend は保存しない（2つ目の UV も origin も焼き込みも、書き出しのためだけに作る）。結果は --report の JSON に書く。
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from common import bake, stats, uv  # noqa: E402
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


# ── 焼き込み（S-26。設計書 Blenderアセットパイプライン > 焼き込み: 不透明な物に2つ目のUVを作り、Cyclesで間接光込みの陰影を焼く） ──
#: ライトマップの画像の名前（物の extras の lightmap と、glb の中の画像の名前）
LIGHTMAP_NAME = '{area}_lightmap'
#: 焼いた画像を置く --out の下の場所
LIGHTMAP_DIR = 'lightmaps'
#: 焼く間の Cycles の設定: 光の模様（コースティクス）は焼かない（S-32 で別に描く。ガラスの器の下に雲のような粒が出た）、
#: 間接光のまれな強い標本を切る（ちらつく点）、透明の面をいくつ抜けても止めない（棚の作品の二重の壁: BakeScene はガラスを透明にする）
CYCLES_BAKE = {'caustics_reflective': False, 'caustics_refractive': False, 'sample_clamp_indirect': 4.0,
               'transparent_max_bounces': 64}


def bakeable_material(material) -> bool:
    """光を焼く材質: 不透明で、ガラスの印がなく（印のガラスはゲームが作り直す: 乳白の灯りの器も）、`bake` が False でない
    （光る火・熾火、ガラスの中の泡）。ゲームの src/core/assets/lightmap.ts と同じ規則"""
    if material is None:
        return False
    if is_transmissive(material) or naming.parse_glass_mark(material.name) is not None:
        return False
    return bool(material.get('bake', True))


def bake_targets(objects: list, named: dict) -> list:
    """焼く物: 名前のある見た目の物（当たり判定でも、詳細度 1 以上でもない）のメッシュで、焼ける材質の面を持つもの。
    詳細度 1 以上（_LOD1・_LOD2）は同じ所に重なる粗い形で、細かい形と一緒には焼けないので、今は焼かずに実時間で照らす
    （まだ詳細度のある物はない。焼くなら段ごとにほかの段を隠して焼く）"""
    out = []
    for o in objects:
        owner = owner_of(o, named)
        if o.type != 'MESH' or owner is None or named[owner.name]['role'] == 'col':
            continue
        if (named[owner.name]['lod'] or 0) >= 1:
            continue
        if any(bakeable_material(s.material) for s in o.material_slots):
            out.append(o)
    return out


def emits(material) -> bool:
    """光る材質か（Principled の発光が 0 でない: 火・熾火・乳白の灯りの器）"""
    if material is None or material.node_tree is None:
        return False
    for n in material.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            strength = n.inputs['Emission Strength']
            colour = n.inputs['Emission Color']
            lit = colour.is_linked or any(c > 0 for c in colour.default_value[:3])
            if lit and (strength.is_linked or strength.default_value > 0):
                return True
    return False


def clear_in_bake(material) -> bool:
    """焼く間は光をそのまま通す材質: 透過のガラスと、焼かない光らない材質（ガラスの中の泡）。ゲームのガラスは影を落とさず
    光を通す（src/game/assets/area.ts）。光る物（火、熾火、乳白の灯りの器）は場面の光として残す"""
    if material is None:
        return False
    return is_transmissive(material) or (not bakeable_material(material) and not emits(material))


class BakeScene:
    """焼く間だけ場面を焼き込み用に変え、終わったら元に戻す（.blend は保存しないが、書き出しは元の材質で行う）。

    - ガラス（透過の材質）とガラスの中の泡（焼かない光らない材質）は、すべての光線に透明（Transparent BSDF）。ゲームのガラスは
      影を落とさず光を通す。影の光線だけ透明にした版（S-26 のレビュー1巡目まで）では、拡散の光線がガラスで屈折し、コースティクスを
      切っているので先の空が数えられず、泡入りの瓶やガラス棒の下が暗いしみになった。吸収（ボリューム）も外す
    - 焼く材質の金属を 0 にする: 拡散の焼き込み（色を含めない）は金属の面では 0 になる。真鍮の面にも、そこに届く光を焼く
      （ゲームは金属の見た目に使わないが、跳ね返りは真鍮の色の拡散になる）
    - 当たり判定（_col）と詳細度 1 以上（_LOD1・_LOD2）は焼く間だけ隠す（描かれない物・同じ所にある粗い形が光を遮らない。
      工房の _col は make_workshop.py が hide_render にしてあるが、手で作る .blend でも同じになるように）
    """

    def __init__(self, materials, hidden=()):
        self.materials = [m for m in materials if m is not None and m.node_tree is not None]
        self.hidden = list(hidden)
        self.undo = []

    def __enter__(self):
        # no caustics (light through the glass onto the pieces: S-32's, drawn on its own), the rare very bright indirect
        # sample clamped (fireflies), and room for a ray through many clear surfaces (the double walls of the works on the
        # shelf)
        cycles = bpy.context.scene.cycles
        for key, value in CYCLES_BAKE.items():
            was = getattr(cycles, key)
            setattr(cycles, key, value)
            self.undo.append(lambda key=key, was=was: setattr(cycles, key, was))
        for o in self.hidden:
            if not o.hide_render:
                o.hide_render = True
                self.undo.append(lambda o=o: setattr(o, 'hide_render', False))
        for m in self.materials:
            nt = m.node_tree
            out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
            if out is None:
                continue
            if clear_in_bake(m):
                surface = out.inputs['Surface']
                was = surface.links[0].from_socket if surface.is_linked else None
                clear = nt.nodes.new('ShaderNodeBsdfTransparent')
                nt.links.new(clear.outputs['BSDF'], surface)

                def back(nt=nt, was=was, surface=surface, clear=clear):
                    nt.nodes.remove(clear)
                    if was is not None:
                        nt.links.new(was, surface)

                self.undo.append(back)
                volume = out.inputs['Volume']
                if volume.is_linked:
                    vsrc = volume.links[0].from_socket
                    nt.links.remove(volume.links[0])
                    self.undo.append(lambda nt=nt, vsrc=vsrc, volume=volume: nt.links.new(vsrc, volume))
            elif bakeable_material(m):
                for n in nt.nodes:
                    if n.type == 'BSDF_PRINCIPLED':
                        metal = n.inputs['Metallic']
                        if not metal.is_linked and metal.default_value > 0:
                            was = metal.default_value
                            metal.default_value = 0.0
                            self.undo.append(lambda metal=metal, was=was: setattr(metal, 'default_value', was))
        return self

    def __exit__(self, *exc):
        for step in reversed(self.undo):
            step()
        self.undo.clear()
        return False


def light_record(obj) -> dict:
    """焼いた光（three の座標）。ゲームの単体テストが room-art.ts の実時間の光と照らし合わせる"""
    data = obj.data
    forward = obj.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))
    rec = {
        'name': obj.name,
        'type': data.type,
        'color': [round(c, 5) for c in data.color],
        'energy': round(data.energy, 5),
        'position': [round(c, 5) for c in blender_to_three(obj.matrix_world.translation)],
        'direction': [round(c, 5) for c in blender_to_three(forward.normalized())],
        'shadow': bool(data.use_shadow),
    }
    if data.type == 'SPOT':
        rec['spot_size'] = round(data.spot_size, 5)
        rec['spot_blend'] = round(data.spot_blend, 5)
    if data.type == 'SUN':
        rec['angle'] = round(data.angle, 5)
    return rec


def bake_stage(objects: list, named: dict, out_dir: str, settings: dict) -> dict:
    """エリアごとに 1 枚のライトマップを焼き、物と scene に記録を書く。焼いた画像・物・倍率・かかった秒を返す。

    settings（blender/pipeline.json の job の bake）: size（画素）、samples（Cycles のサンプル数）、percentile（正規化の百分位、
    既定 common/bake.py の 99.99）、margin（島の外へ伸ばす画素。島の間はその倍）、density（物の名前 → 画素の細かさの倍率）
    """
    size, samples = int(settings['size']), int(settings['samples'])
    percentile = float(settings.get('percentile', bake.PERCENTILE))
    margin = settings.get('margin')
    density = {str(k): float(v) for k, v in (settings.get('density') or {}).items()}
    scene = bpy.context.scene
    targets = bake_targets(objects, named)
    by_group: dict = {}
    for o in targets:
        by_group.setdefault(named[owner_of(o, named).name]['group'], []).append(o)
    unknown = sorted(set(density) - {o.name for o in targets})
    if unknown:
        print(f'WARNING: bake density names objects that are not baked here (renamed?): {", ".join(unknown)}')
    used = {s.material for o in bpy.context.view_layer.objects if o.type == 'MESH' for s in o.material_slots}
    lights = [o for o in bpy.context.view_layer.objects if o.type == 'LIGHT' and not o.hide_render]
    hidden = []
    for o in objects:
        owner = owner_of(o, named)
        if owner is not None and (named[owner.name]['role'] == 'col' or (named[owner.name]['lod'] or 0) >= 1):
            hidden.append(o)
    # the game reads which materials of a baked object were left out from their extras (src/core/assets/lightmap.ts)
    for o in targets:
        for slot in o.material_slots:
            if slot.material is not None and not bakeable_material(slot.material):
                slot.material['bake'] = False
    started = time.monotonic()
    images = []
    with BakeScene(used, hidden):
        for group, objs in sorted(by_group.items()):
            name = LIGHTMAP_NAME.format(area=group.upper())
            excluded = sorted({s.material.name for o in objs for s in o.material_slots
                               if s.material is not None and not bakeable_material(s.material)})
            t0 = time.monotonic()
            results = bake.bake_lightmaps(objs, os.path.join(out_dir, LIGHTMAP_DIR), size, samples, name=name,
                                          percentile=percentile, exclude_materials=excluded, density=density,
                                          margin=None if margin is None else int(margin))
            seconds = time.monotonic() - t0
            for o in objs:
                o[bake.PROP] = name
            first = results[0] if results else {}
            images.append({'group': group, 'name': name, 'png': first.get('image'), 'scale': first.get('scale'),
                           'max_over_scale': first.get('max_over_scale'), 'clipped_frac': first.get('clipped_frac'),
                           'device': first.get('device'), 'seconds': round(seconds, 1),
                           'objects': sorted(o.name for o in objs), 'excluded_materials': excluded})
    seconds = time.monotonic() - started
    # what was baked, into the glb (scene extras): only what decides the light, so the same bake writes the same glb
    record = {
        'size': size,
        'samples': samples,
        'percentile': percentile,
        'margin': margin,
        'density': density,
        'world': {'name': scene.world.name, **{k: plain(v) for k, v in scene.world.items() if k != 'about'}}
        if scene.world else None,
        'lights': [light_record(o) for o in sorted(lights, key=lambda o: o.name)],
        'images': [{k: v for k, v in i.items() if k not in ('png', 'seconds', 'device')} for i in images],
    }
    scene['bake'] = record
    # and for the report: how long it took, on what
    return {**record, 'images': images, 'seconds': round(seconds, 1),
            'device': ', '.join(sorted({str(i['device']) for i in images}))}


def run(out_dir: str, report_path: str, bake_settings: dict | None = None) -> int:
    """bake_settings: {'size', 'samples', 'percentile'} で焼き込みの段を行う（None なら焼かない）"""
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
        'bake': None,
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
    if bake_settings is not None:
        report['bake'] = bake_stage(objects, named, out_dir, bake_settings)
        for image in report['bake']['images']:
            for name in image['objects']:
                report['uv2'][name] = 'baked'

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

    bake_settings = json.loads(arg('--bake')) if '--bake' in args else None
    code = run(os.path.abspath(arg('--out')), os.path.abspath(arg('--report')), bake_settings)
    if code:
        sys.exit(code)


if __name__ == '__main__':
    main()
