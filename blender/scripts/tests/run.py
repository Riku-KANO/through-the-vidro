"""blender/scripts の単体テストを走らせる（`pnpm assets:test` から、Blender の中で）。

    blender -b --factory-startup --python-exit-code 1 --python blender/scripts/tests/run.py

失敗があれば終了コード 1。bpy を使わないテスト（vidro/）は Blender の外の python3 でも走る:
    python3 -m unittest discover -s blender/scripts/tests -t blender/scripts
"""
import os
import sys
import unittest

sys.dont_write_bytecode = True  # __pycache__ を作らない（リポジトリを汚さない）
SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

suite = unittest.defaultTestLoader.discover(os.path.join(SCRIPTS, 'tests'), top_level_dir=SCRIPTS)
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    sys.exit(1)
