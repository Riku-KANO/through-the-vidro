"""ポリゴン数の予算（設計書 Blenderアセットパイプライン > ポリゴンとテクスチャの予算）。bpy を使わない。

| 種別 | 三角形数の目安 |
|---|---|
| 手の玉 | 8,000 |
| 近景の建物1棟 | 20,000〜40,000（上限 40,000 で照らす） |
| 遠景の建物 | 2,000〜5,000（上限 5,000） |
| 小物 | 500〜3,000（上限 3,000） |
| 1エリア全体 | 100万以下 |

物の種別は名前の種類と詳細度で決める（仮。設計書は種類との対応を決めていない）:
orb → 手の玉、bld・brg の LOD0（か詳細度なし）→ 近景の建物、bld・brg の LOD1 以上 → 遠景の建物、ほか → 小物。
当たり判定（_col）は数えない。エリアの合計は、同じ物の詳細度のうち最も細かい LOD0（か詳細度なし）だけを足す
（同時に描かれるのはどれか1つ）。予算を超えても書き出しは止めない（目安なので WARNING）。
"""
from __future__ import annotations

TRIANGLE_BUDGETS = {
    'orb': 8000,
    'near-building': 40000,
    'far-building': 5000,
    'prop': 3000,
}
AREA_TRIANGLES = 1_000_000

#: 種類 → 種別（仮）
BUILDING_KINDS = ('bld', 'brg')
ORB_KINDS = ('orb',)


def category(parsed: dict) -> str:
    kind = parsed['kind']
    if kind in ORB_KINDS:
        return 'orb'
    if kind in BUILDING_KINDS:
        return 'far-building' if (parsed['lod'] or 0) >= 1 else 'near-building'
    return 'prop'


def check(rows: list) -> dict:
    """rows: {'name', 'parsed'（parse_name の value）, 'triangles'}。

    {'objects': [{name, category, triangles, limit, over}], 'areas': [{group, triangles, limit, over}]} を返す
    （物は渡した順、エリアは初めて出た順）。
    """
    objects = []
    areas: dict = {}
    for r in rows:
        n = r['parsed']
        if n['role'] == 'col':
            continue
        cat = category(n)
        limit = TRIANGLE_BUDGETS[cat]
        objects.append({'name': r['name'], 'category': cat, 'triangles': r['triangles'], 'limit': limit,
                        'over': r['triangles'] > limit})
        if (n['lod'] or 0) == 0:
            areas[n['group']] = areas.get(n['group'], 0) + r['triangles']
    return {
        'objects': objects,
        'areas': [{'group': g, 'triangles': t, 'limit': AREA_TRIANGLES, 'over': t > AREA_TRIANGLES}
                  for g, t in areas.items()],
    }
