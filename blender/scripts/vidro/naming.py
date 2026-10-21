"""「ビードロの向こう」の命名規則とゲーム情報（設計書 Blenderアセットパイプライン > 命名規則とゲーム情報）。bpy を使わない。

    <エリア>_<種類>_<番号>[_front|_back|_col][_LOD0|_LOD1|_LOD2]
    例: A1_bld_dome03_front（表の層）、A1_brg_bridge02_back（裏の層）、A1_bld_dome03_col（当たり判定）、
        A1_sock_02（台座）、A3_bell_D4（共鳴器）、CM_lmp_lamp01_LOD1（共通の物の詳細度1）

- エリア: A0〜A9 か CM（共通）。書き出すファイルを分ける（A1 → a1.glb、CM → common.glb）。
  A0 = 序章、A4 = 終章 は仮（設計書の表は A1・A3 の例だけ）
- 種類: 英小文字 2〜8 字（bld 建物、brg 橋、sock 台座、bell 共鳴器、flr 床、frm 真鍮の枠、lmp 街灯 など）
- 役割: _front は表の層だけ、_back は裏の層だけ、なしは両方、_col は見た目とは別の当たり判定（描かない）
- 名前つきの物の子は、名前が規則に合わなくてよい（親の部品になる）

物のカスタムプロパティ（glTF の extras になる）:
- 台座（sock）: materialize_radius（実体化半径、m）。必須
- 共鳴器（bell）: pitch（音程。例 D4、F#5）。必須
- ガラスの置き場所: placement = near | far | behind-glass（なければ near。技術設計 > ガラスの描画 > 対策1）
- 当たり判定: layer = surface | back | shared（同じ名前の見た目が表と裏の両方にあるときは必須）
- origin: 台座と共鳴器の原点（three の座標）。書き出しの前にパイプラインが書く（人は書かない）

材質の印（ガラス）: glass_<種類>[_<役割>]。種類はゲームのガラスの種類（src/core/glass/kinds.ts）、
役割は scenery | orb | drop | showcase（なければ scenery）。分散と薄膜干渉は Blender の値ではなく、
この印と品質プリセットからゲームが決める（技術設計 > ガラスの描画: 手の玉・光の雫・見せ場に限って使う）。

例はゲームと共有する（naming_cases.json。src/game/assets/naming.ts と同じ結果になること）。
"""
from __future__ import annotations

import math
import re

AREA = re.compile(r'^(A[0-9]|CM)$')
KIND = re.compile(r'^[a-z]{2,8}$')
IDENT = re.compile(r'^[A-Za-z0-9]+$')
LOD = re.compile(r'^LOD([0-9]+)$')
DUPLICATE = re.compile(r'\.[0-9]{3,}$')
PITCH = re.compile(r'^[A-G](#|b)?[0-8]$')

ROLES = ('front', 'back', 'col')
MAX_LOD = 2
COMMON_AREA = 'CM'

#: src/core/glass/kinds.ts の GLASS_KINDS と同じ並び（naming_cases.json で両方を確かめる）
GLASS_KINDS = ('clear', 'frosted', 'amber', 'lapis', 'jade', 'bubble', 'iridescent', 'milky')
#: src/core/glass/policy.ts の GlassRole
GLASS_ROLES = ('scenery', 'orb', 'drop', 'showcase')
PLACEMENTS = ('near', 'far', 'behind-glass')
LAYERS = ('surface', 'back', 'shared')

SOCKET = 'sock'
BELL = 'bell'

MESSAGES = {
    'blender-duplicate': 'Blender が重なった名前に付ける .001 などが残っています。番号を名前の中に入れてください（例 A1_bld_dome04_front）',
    'format': '名前が <エリア>_<種類>_<番号>[_front|_back|_col][_LOD0-2] の形になっていません',
    'area': 'エリアは A0〜A9 か CM（共通）です',
    'kind': '種類は英小文字 2〜8 字です（bld、brg、sock、bell など）',
    'id': '番号は英数字だけです（dome03、02、D4 など）',
    'suffix': '名前の後ろは _front / _back / _col と、その後の _LOD0〜_LOD2 だけです',
    'lod': '詳細度は _LOD0 / _LOD1 / _LOD2 です',
    'collider-lod': '当たり判定（_col）に詳細度はつけません',
    'socket-radius': '台座には実体化半径のカスタムプロパティ materialize_radius（m、正の数）が要ります',
    'bell-pitch': '共鳴器には音程のカスタムプロパティ pitch（例 D4、F#5）が要ります',
    'placement': 'placement は near / far / behind-glass のどれかです',
    'collider-layer': '当たり判定の layer は surface / back / shared のどれかです。同じ名前の見た目が表と裏の両方にあるときは layer で決めてください',
    'origin': 'origin は 3 つの数です（パイプラインが書くので、手で書かないでください）',
    'lod0-missing': '_LOD1 / _LOD2 があるのに _LOD0 がありません',
    'lod-mixed': '同じ物に詳細度のない物と _LODn の物が両方あります',
    'glass-kind': f'ガラスの材質の印は glass_<種類>[_<役割>] で、種類は {" / ".join(GLASS_KINDS)} です',
    'glass-role': f'ガラスの役割は {" / ".join(GLASS_ROLES)} です',
    'glass-format': 'ガラスの材質の印は glass_<種類>[_<役割>]（小文字）です',
    'glass-unmarked': '透過の材質に glass_<種類> の印がありません。ゲームは glTF の値のまま描き、品質プリセットの遠景の切り替えに'
                      '乗りません（置き場所が far / behind-glass なら止めます）',
}


def parse_name(name: str) -> dict:
    """{'ok': True, 'value': {...}} か {'ok': False, 'error': 理由}"""
    if DUPLICATE.search(name):
        return {'ok': False, 'error': 'blender-duplicate'}
    tokens = name.split('_')
    if len(tokens) < 3 or any(t == '' for t in tokens):
        return {'ok': False, 'error': 'format'}
    area, kind, ident, rest = tokens[0], tokens[1], tokens[2], tokens[3:]
    if not AREA.match(area):
        return {'ok': False, 'error': 'area'}
    if not KIND.match(kind):
        return {'ok': False, 'error': 'kind'}
    if not IDENT.match(ident):
        return {'ok': False, 'error': 'id'}
    role = None
    lod = None
    i = 0
    if i < len(rest) and rest[i] in ROLES:
        role = rest[i]
        i += 1
    if i < len(rest):
        m = LOD.match(rest[i])
        if m:
            lod = int(m.group(1))
            if lod > MAX_LOD:
                return {'ok': False, 'error': 'lod'}
            i += 1
    if i < len(rest):
        return {'ok': False, 'error': 'suffix'}
    if role == 'col' and lod is not None:
        return {'ok': False, 'error': 'collider-lod'}
    return {'ok': True, 'value': {
        'area': area,
        'kind': kind,
        'id': ident,
        'role': role,
        'lod': lod,
        'base': f'{area}_{kind}_{ident}',
        'group': 'common' if area == COMMON_AREA else area.lower(),
    }}


def parse_glass_mark(name: str):
    """材質の名前のガラスの印。印でなければ None、印なら {'ok': ..., 'value' | 'error'}"""
    stripped = DUPLICATE.sub('', name)
    tokens = stripped.split('_')
    if tokens[0].lower() != 'glass':
        return None
    if stripped != name:
        return {'ok': False, 'error': 'blender-duplicate'}
    if tokens[0] != 'glass' or len(tokens) > 3:
        return {'ok': False, 'error': 'glass-format'}
    if len(tokens) < 2 or tokens[1] not in GLASS_KINDS:
        return {'ok': False, 'error': 'glass-kind'}
    role = tokens[2] if len(tokens) == 3 else 'scenery'
    if role not in GLASS_ROLES:
        return {'ok': False, 'error': 'glass-role'}
    return {'ok': True, 'value': {'kind': tokens[1], 'role': role}}


def unmarked_glass_level(material: str, transmissive: bool, placement: str = 'near'):
    """透過なのに glass_ の印がない材質の重さ。None（問題なし）・'warning'（止めない）・'problem'（止める）。

    印のない透過はゲームが glTF の値のまま描く。遠景の安価な表現（品質プリセット）に乗るのは印のついたガラスだけなので、
    置き場所が near 以外なら止める（ゲームも同じ規則で問題にする。naming_cases.json の unmarked）。
    印の書き間違い（glass_ruby など）は別の問題として出るので、ここでは数えない。
    """
    if not transmissive or parse_glass_mark(material) is not None:
        return None
    return 'warning' if placement == 'near' else 'problem'


def _positive_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def _vec3(v) -> bool:
    return (isinstance(v, (list, tuple)) and len(v) == 3
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v))


def object_problems(name: str, extras: dict) -> list:
    """1つの物のカスタムプロパティの問題（理由の一覧）。名前が規則に合わない物は空（名前の問題は別に出す）"""
    r = parse_name(name)
    if not r['ok']:
        return []
    n = r['value']
    out = []
    if n['kind'] == SOCKET and n['role'] != 'col' and not _positive_number(extras.get('materialize_radius')):
        out.append('socket-radius')
    if n['kind'] == BELL and n['role'] != 'col':
        pitch = extras.get('pitch')
        if not (isinstance(pitch, str) and PITCH.match(pitch)):
            out.append('bell-pitch')
    if 'placement' in extras and extras['placement'] not in PLACEMENTS:
        out.append('placement')
    if n['role'] == 'col' and 'layer' in extras and extras['layer'] not in LAYERS:
        out.append('collider-layer')
    if 'origin' in extras and not _vec3(extras['origin']):
        out.append('origin')
    return out


def _layer_of(role):
    return {'front': 'surface', 'back': 'back'}.get(role, 'shared')


def set_problems(objects: list) -> list:
    """物どうしの問題（詳細度の抜け・混在、当たり判定の層が決まらない）。objects は {'name', 'extras'} の一覧"""
    parsed = []
    for o in objects:
        r = parse_name(o['name'])
        if r['ok']:
            parsed.append((r['value'], o.get('extras') or {}, o['name']))
    out = []
    # 詳細度: 同じ <base>[_<role>] の _LODn をまとめる
    lods: dict = {}
    plain: set = set()
    order: list = []
    for n, _, _ in parsed:
        if n['role'] == 'col':
            continue
        key = n['base'] + (f"_{n['role']}" if n['role'] else '')
        if n['lod'] is None:
            plain.add(key)
            continue
        if key not in lods:
            lods[key] = set()
            order.append(key)
        lods[key].add(n['lod'])
    for key in order:
        if 0 not in lods[key]:
            out.append({'object': key, 'code': 'lod0-missing'})
        if key in plain:
            out.append({'object': key, 'code': 'lod-mixed'})
    # 当たり判定の層: 同じ base の見た目の層が1つに決まらなければ layer が要る
    visual_layers: dict = {}
    for n, _, _ in parsed:
        if n['role'] != 'col':
            visual_layers.setdefault(n['base'], set()).add(_layer_of(n['role']))
    for n, extras, name in parsed:
        if n['role'] != 'col' or 'layer' in extras:
            continue
        if len(visual_layers.get(n['base'], ())) > 1:
            out.append({'object': name, 'code': 'collider-layer'})
    for p in out:
        p['message'] = MESSAGES[p['code']]
    return out


def lint(objects: list) -> list:
    """書き出す物の検査。objects は {'name', 'parent'（親の名前か None）, 'extras', 'materials'（材質の名前）} の一覧。

    問題 {'object', 'code', 'message'} の一覧を返す（物の順、その後に物どうしの問題）。空なら書き出してよい。
    """
    by_name = {o['name']: o for o in objects}

    def named_ancestor(o) -> bool:
        seen = set()
        p = o.get('parent')
        while p is not None and p not in seen:
            seen.add(p)
            if parse_name(p)['ok']:
                return True
            p = by_name.get(p, {}).get('parent')
        return False

    out = []
    for o in objects:
        r = parse_name(o['name'])
        if not r['ok']:
            if not named_ancestor(o):
                out.append({'object': o['name'], 'code': r['error']})
        else:
            for code in object_problems(o['name'], o.get('extras') or {}):
                out.append({'object': o['name'], 'code': code})
        for m in o.get('materials') or []:
            g = parse_glass_mark(m)
            if g is not None and not g['ok']:
                out.append({'object': o['name'], 'code': g['error'], 'material': m})
    for p in out:
        p['message'] = MESSAGES[p['code']] + (f'（材質 {p["material"]}）' if 'material' in p else '')
    named = [o for o in objects if parse_name(o['name'])['ok']]
    return out + set_problems(named)
