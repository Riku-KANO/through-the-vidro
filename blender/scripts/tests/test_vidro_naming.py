"""命名規則の検査（設計書 Blenderアセットパイプライン > 命名規則とゲーム情報）。

例は vidro/naming_cases.json をゲーム（src/game/assets/naming.test.ts、plan.test.ts）と共有する。
Blender の中でも外でも走る（bpy を使わない）。
"""
from __future__ import annotations

import json
import os
import unittest

from vidro import naming

CASES = json.load(open(os.path.join(os.path.dirname(naming.__file__), 'naming_cases.json'), encoding='utf-8'))


class GlassKinds(unittest.TestCase):
    def test_are_the_libraries_kinds_and_roles(self):
        # the game checks the same lists against src/core/glass (GLASS_KINDS, GlassRole)
        self.assertEqual(list(naming.GLASS_KINDS), CASES['glassKinds'])
        self.assertEqual(list(naming.GLASS_ROLES), CASES['glassRoles'])


class ParseName(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['names']:
            with self.subTest(name=c['name']):
                r = naming.parse_name(c['name'])
                if 'error' in c:
                    self.assertEqual(r, {'ok': False, 'error': c['error']})
                else:
                    self.assertEqual(r, {'ok': True, 'value': c['expect']})


class ParseGlassMark(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['glass']:
            with self.subTest(name=c['name']):
                r = naming.parse_glass_mark(c['name'])
                if 'error' in c:
                    self.assertEqual(r, {'ok': False, 'error': c['error']})
                elif c['expect'] is None:
                    self.assertIsNone(r)
                else:
                    self.assertEqual(r, {'ok': True, 'value': c['expect']})


class ObjectProblems(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['extras']:
            with self.subTest(name=c['name'], extras=c['extras']):
                self.assertEqual(naming.object_problems(c['name'], c['extras']), c['problems'])


class UnmarkedGlass(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['unmarked']:
            with self.subTest(case=c):
                self.assertEqual(naming.unmarked_glass_level(c['material'], c['transmissive'], c['placement']), c['level'])


class SetProblems(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['sets']:
            with self.subTest(about=c['about']):
                objects = [{'name': o['name'], 'extras': o.get('extras', {})} for o in c['objects']]
                got = [{'object': p['object'], 'code': p['code']} for p in naming.set_problems(objects)]
                self.assertEqual(got, c['problems'])


class Lint(unittest.TestCase):
    def obj(self, name, parent=None, extras=None, materials=()):
        return {'name': name, 'parent': parent, 'extras': extras or {}, 'materials': list(materials)}

    def codes(self, objects):
        return [(p['object'], p['code']) for p in naming.lint(objects)]

    def test_a_valid_set_has_no_problems(self):
        self.assertEqual(self.codes([
            self.obj('A0_flr_floor01', materials=['A0_floor']),
            self.obj('A0_flr_floor01_col'),
            self.obj('A0_sock_01', extras={'materialize_radius': 2}),
            self.obj('A0_bld_dome01_front', materials=['glass_clear']),
        ]), [])

    def test_reports_a_name_against_the_rules(self):
        self.assertEqual(self.codes([self.obj('Cube.001'), self.obj('A1_bld_dome03_left')]),
                         [('Cube.001', 'blender-duplicate'), ('A1_bld_dome03_left', 'suffix')])

    def test_lets_a_part_take_the_name_of_its_named_parent(self):
        self.assertEqual(self.codes([self.obj('CM_lmp_lamp01_LOD0'), self.obj('Sphere.002', parent='CM_lmp_lamp01_LOD0')]), [])

    def test_reports_a_part_whose_parents_have_no_valid_name(self):
        self.assertEqual(self.codes([self.obj('Empty'), self.obj('Sphere.002', parent='Empty')]),
                         [('Empty', 'format'), ('Sphere.002', 'blender-duplicate')])

    def test_reports_the_extras_and_the_sets(self):
        self.assertEqual(self.codes([self.obj('A1_sock_02'), self.obj('A1_bld_x_front_LOD1')]),
                         [('A1_sock_02', 'socket-radius'), ('A1_bld_x_front', 'lod0-missing')])

    def test_reports_a_bad_glass_mark_on_a_material(self):
        self.assertEqual(self.codes([self.obj('A1_bld_dome03_front', materials=['glass_ruby'])]),
                         [('A1_bld_dome03_front', 'glass-kind')])

    def test_every_problem_says_what_to_do(self):
        for p in naming.lint([self.obj('Cube'), self.obj('A1_sock_02')]):
            self.assertTrue(p['message'])


if __name__ == '__main__':
    unittest.main()
