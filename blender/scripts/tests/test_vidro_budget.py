"""ポリゴン数の予算（設計書 Blenderアセットパイプライン > ポリゴンとテクスチャの予算）。bpy を使わない。"""
from __future__ import annotations

import unittest

from vidro import budget, naming


def row(name, triangles):
    return {'name': name, 'parsed': naming.parse_name(name)['value'], 'triangles': triangles}


class Budget(unittest.TestCase):
    def test_limits_are_the_design_table(self):
        self.assertEqual(budget.TRIANGLE_BUDGETS, {
            'orb': 8000,
            'near-building': 40000,
            'far-building': 5000,
            'prop': 3000,
        })
        self.assertEqual(budget.AREA_TRIANGLES, 1_000_000)

    def test_classifies_by_kind_and_level_of_detail(self):
        cat = lambda n: budget.category(naming.parse_name(n)['value'])  # noqa: E731
        self.assertEqual(cat('A1_orb_hand01'), 'orb')
        self.assertEqual(cat('A1_bld_dome03_front'), 'near-building')
        self.assertEqual(cat('A1_bld_dome03_front_LOD0'), 'near-building')
        self.assertEqual(cat('A1_bld_dome03_front_LOD2'), 'far-building')
        self.assertEqual(cat('A1_brg_bridge02_back'), 'near-building')
        self.assertEqual(cat('A1_sock_02'), 'prop')

    def test_flags_an_object_over_its_limit(self):
        r = budget.check([row('A1_sock_02', 3001), row('A1_bld_dome03_front', 40000)])
        self.assertEqual([(o['name'], o['limit'], o['over']) for o in r['objects']],
                         [('A1_sock_02', 3000, True), ('A1_bld_dome03_front', 40000, False)])

    def test_leaves_colliders_out(self):
        r = budget.check([row('A1_bld_dome03_col', 90000)])
        self.assertEqual(r['objects'], [])
        self.assertEqual(r['areas'], [])

    def test_sums_an_area_with_only_the_nearest_level_of_detail(self):
        r = budget.check([
            row('A1_bld_dome03_front_LOD0', 600000),
            row('A1_bld_dome03_front_LOD1', 300000),
            row('A1_bld_dome04_front', 500000),
            row('CM_lmp_lamp01_LOD0', 2000),
        ])
        self.assertEqual(r['areas'], [
            {'group': 'a1', 'triangles': 1_100_000, 'limit': 1_000_000, 'over': True},
            {'group': 'common', 'triangles': 2000, 'limit': 1_000_000, 'over': False},
        ])


if __name__ == '__main__':
    unittest.main()
