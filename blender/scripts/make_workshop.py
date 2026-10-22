"""序章「工房」の内装を作る（S-24）。職人がついさっきまで仕事をしていた吹きガラス工房。

    blender -b --factory-startup --python-exit-code 1 -P blender/scripts/make_workshop.py -- --out blender/scenes/workshop.blend
    （確かめ用の絵も描くなら -- --out ... --preview <dir>。Workbench で目覚め・炉の前・作品の棚・扉から振り返る・真上）

その後 `pnpm assets -- --job workshop` が public/assets/workshop/a0.glb に書き出す（命名・ポリゴン数の検査、2つ目の UV、
KTX2・meshopt）。ゲームは src/game/prologue/room.ts で読み、名前と _col から層と当たり判定を組み立てる。

設計書: 進行構造とエリア設計（序章「工房」: 街外れの吹きガラス工房、夜明け前の青）、世界観とストーリー（寂しさではなく
見つける喜び、まだそこで暮らしている気配）、アートディレクション（ガラスの種類、形のルール: 角を作らない・直線と細い線は
真鍮の枠だけ・泡の集合、色の進行: 序章はほぼ無色と真鍮の鈍い金）、空間の可読性と導線（1 歩ける面は透明にしない、
4 当たり判定は見た目に正直に）、Blenderアセットパイプライン（造形: 回転・泡・管、命名、予算: 小物 500〜3000 三角形で
アトラスを共有）。発案者が承認した配置（2026-10-22）。

位置と寸法は three の座標（Y が上、扉は -Z、ドームの床の中心が原点、m）で、src/game/prologue/layout.ts と同じ値。
ずれると src/game/assets/workshop-asset.test.ts が落ちる。形は three の座標で組み、最後に Blender の座標へ回す。

作る物（名前は設計書の命名規則。A0 = 序章）:
- A0_bnch_work01(+_col)    作業台（曇りガラスの天板、真鍮の枠、玉の受け輪、ジャック）
- A0_ware_bench01          作業台の上の器（透明・気泡入り）、寝かせた作りかけのぽぺん、ガラス棒の束、眼鏡のレンズ（S-27）
- A0_ware_bench02          作業台の下の棚の器（曇りガラスの重ねた鉢、透明の瓶、盆の上のかけら。S-27）
- A0_tool_bench01          作業台に置いたままの道具（鋏、ピンセット、キャリパー、眼鏡の縁、下の棚の盆とへら。S-27）
- A0_cup_tea01             飲みかけの湯のみ（曇りガラス、お茶）
- A0_chr_stool01(+_col)    椅子（曇りガラスの座面、真鍮の脚）
- A0_frn_furnace01(+_col)  炉（S-27: 熱で煤けた厚いガラスの泡の集まりに真鍮の帯、口の奥の火の洞、覗き窓（熾火と乳白ガラスの輪）、
                           真鍮の煙道、口に差したままの吹き竿と受け）
- A0_grt_floor01           炉の前の真鍮の格子（床。当たり判定なし）
- A0_pipe_rack01(+_col)    吹き竿の立て掛け（真鍮）
- A0_mrv_marver01(+_col)   マーバー台（真鍮の板、曇りガラスの脚）
- A0_ware_marver01         作りかけの器（気泡入り、竿の先）、冷ましている杯とかけら（S-27）
- A0_tool_marver01         マーバー台の上の道具（ピンセット、ブロック、へら）と左の端に掛けたジャック（S-27）
- A0_bkt_marver01(+_col)   マーバー台の前の竿の桶（真鍮の桶に水、ポンテ 3 本。S-27）
- A0_tub_water01(+_col)    水桶（曇りガラス、真鍮のたが、水、柄杓）
- A0_anl_annealer01(+_col) 徐冷炉（曇りガラスの泡、口は中心へ、中がほのかに暖かい）
- A0_ware_anneal01         冷ましている作品（透明）
- A0_cart_anneal01(+_col)  徐冷炉の横の台車（真鍮の枠、曇りガラスの 2 段。S-27）
- A0_tool_anneal01         台車の上の道具（トング、へら、受け輪。S-27）
- A0_ware_cart01           台車の上で入る順を待つ作品（透明・乳白。S-27）
- A0_shlf_works01(+_col)   作品の棚（壁に沿う弧の三段、曇りガラスの板、真鍮の縁と柱）
- A0_shlf_board01(+_col)   作品の棚の背板（傾く壁に沿う暗い不透明の板、四隅を丸め、縁を一周する真鍮の枠。S-27）
- A0_ware_clear01 / A0_ware_bubble01 / A0_ware_frost01 / A0_ware_opal01  棚の瓶・器・ビードロ（材質ごとに一つ。乳白は S-27）
- A0_chim_door01           扉の上の風鈴（透明ガラス、真鍮の吊り金具、曇りガラスの短冊）

材質: ガラスは印（glass_clear / glass_frosted / glass_bubble / glass_milky）でゲームが作り直す。不透明な物（真鍮・曇りガラスの
天板・炉の体・乳白の作品・棚の背板・水・火・熾火）は 1 枚のアトラス（A0_atlas、512×256px の 4×2 区画）を共有する。泡は A0_air。
乳白ガラスの印（内側から光る灯りの器）は炉の覗き窓だけ。棚の乳白の作品は光らない不透明のオパール（A0_opal）。
当たり判定（_col）は見た目から作る: 部品ごとの凸包（頭より上 2.2m は除く）、弧の部品は 8 度ごとに分けて包む。
"""
from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common.cli import script_args  # noqa: E402
from common.coords import three_to_blender as B  # noqa: E402

# ── 部屋（layout.ts の WORKSHOP） ──────────────────────────────────────────
DOME_CY = -0.8
DOME_R = 4.7
OCULUS = 0.8
DOOR = {'half_width': 0.85, 'height': 2.4}
FLOOR_R = math.sqrt(DOME_R ** 2 - DOME_CY ** 2)
#: 床の円盤の上面（room-art.ts: 円柱の中心 -0.096、高さ 0.2）
FLOOR_TOP = 0.004


def wall_r(y: float) -> float:
    """高さ y でのドームの壁の半径（壁は上ほど内へ傾く）"""
    return math.sqrt(max(0.0, DOME_R ** 2 - (y - DOME_CY) ** 2))


# ── 家具（layout.ts と同じ値） ─────────────────────────────────────────────
BENCH = {'center': (-1.55, -2.45), 'size': (2.1, 0.9, 0.8)}
BENCH_ORB = (-1.55, 0.99, -2.28)
FURNACE = {'center': (2.35, -1.4), 'radius': 0.95}
MOUTH_REACH = 0.62
MOUTH_Y = 0.46
GRATE = {'near': 0.9, 'depth': 1.0, 'width': 1.3}
MOUTH_PIPE_REACH = 1.75
RACK = {'center': (3.45, 0.55), 'from_deg': -3.0, 'to_deg': 19.0}
MARVER = {'center': (2.3, 1.6), 'size': (0.9, 0.85, 0.5)}
TUB = {'center': (1.45, 1.85), 'radius': 0.33, 'height': 0.46, 'water': 0.36}
ANNEALER = {'center': (0.3, 3.4), 'radius': 0.66, 'height': 1.0, 'mouth_half_deg': 36.0, 'mouth_height': 0.6}
SHELF = {'from_deg': 115.0, 'to_deg': 165.0, 'tiers': (0.42, 0.88, 1.34), 'depth': 0.3, 'wall_gap': 0.06}
CHAIR = {'center': (-3.0, -1.4), 'radius': 0.24, 'seat': 0.46}
TEA_CUP = (-2.38, 0.9, -2.2)
WIND_CHIME = (0.0, 2.22, -3.22)

#: 当たり判定に入れる高さの上限（体の高さ 1.75m の上。頭より上の煙道などは包まない）
COL_MAX_Y = 2.2
#: 弧の部品を分けて包む角度（度）。弧のまま包むと弦の内側まで埋まる
COL_ARC_DEG = 8.0

#: 視点（layout.ts の SPAWNS。目の高さ 1.6m、視野角 70 度）
EYE = 1.6
VIEWS = {
    'wake': ((-1.55, -1.05), 0.0, -0.3),
    'furnace': (None, None, -0.3),  # 炉の向きから計算
    'shelf': ((-0.9, 0.75), 2.27, -0.23),
    'door': ((0.0, -3.75), math.pi, -0.12),
}

ROT = Matrix(((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)))  # three (x, y, z) → Blender (x, -z, y)
ROT_INV = ROT.transposed()


def toward_centre(cx: float, cz: float) -> tuple[float, float]:
    l = math.hypot(cx, cz)
    return (-cx / l, -cz / l)


FACING = toward_centre(*FURNACE['center'])


def shelf_front(y: float) -> float:
    return wall_r(y) - SHELF['wall_gap'] - SHELF['depth']


class Frame:
    """置き場所の向き。a = facing の向き（既定は部屋の中心へ）、s = その右（facing を見て右）、y = 上。three の座標を返す"""

    def __init__(self, cx: float, cz: float, facing: tuple[float, float] | None = None):
        self.c = (cx, cz)
        self.f = facing or toward_centre(cx, cz)
        self.r = (-self.f[1], self.f[0])

    def __call__(self, a: float, y: float, s: float = 0.0) -> tuple[float, float, float]:
        return (self.c[0] + self.f[0] * a + self.r[0] * s, y, self.c[1] + self.f[1] * a + self.r[1] * s)

    @property
    def yaw(self) -> float:
        """局所の +x を右（self.r）へ、+z を facing の逆へ回す y 軸周りの角（three の Ry）"""
        return math.atan2(-self.r[1], self.r[0])


# ── 形を組む（three の座標。材質は面ごと） ───────────────────────────────────
class Part:
    """1 つの物の形。three の座標で組み、finish で Blender の物にする"""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats: list = []
        #: 材質の名前 → (three の座標の点 → 区画の中の (u, v)、0〜1)。なければ高さと位置の三角波（atlas_uv）
        self.uv_rules: dict = {}

    def slot(self, mat) -> int:
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def tag(self, faces, mat, smooth: bool = True):
        i = self.slot(mat)
        for f in faces:
            f.material_index = i
            f.smooth = smooth
        return faces

    def merge(self, src: bmesh.types.BMesh, mat, matrix: Matrix | None = None, smooth: bool = True):
        """src の形を写す（matrix で動かして）"""
        vmap = {}
        for v in src.verts:
            vmap[v] = self.bm.verts.new(matrix @ v.co if matrix is not None else v.co.copy())
        faces = []
        for f in src.faces:
            try:
                faces.append(self.bm.faces.new([vmap[v] for v in f.verts]))
            except ValueError:  # 重なった面
                pass
        return self.tag(faces, mat, smooth)


def ry(angle: float) -> Matrix:
    """three の y 軸周りの回転（Ry）"""
    c, s = math.cos(angle), math.sin(angle)
    return Matrix(((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c)))


def place(at, yaw: float = 0.0, axis: Vector | None = None) -> Matrix:
    """y 軸周りに yaw 回して at へ（axis を与えると、局所の +y を axis へ向ける）"""
    m = ry(yaw).to_4x4()
    if axis is not None:
        m = Vector((0.0, 1.0, 0.0)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()
    m.translation = Vector(at)
    return m


def lathe_bm(profile, segments: int) -> bmesh.types.BMesh:
    """(半径, 高さ) の列を y 軸の周りに回す。下（軸）→ 外 → 上の順にたどると面は外を向く。半径 0 の点は軸の 1 点"""
    bm = bmesh.new()
    rings = []
    for r, y in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0.0, y, 0.0))])
            continue
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / segments), y,
                                    -r * math.sin(2 * math.pi * i / segments))) for i in range(segments)])
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
    return bm


def shell_profile(profile, thickness: float):
    """回転の輪郭に厚みをつけた閉じた輪郭（外側 → 縁 → 内側）。内側は逆にたどるので面は空洞を向く。

    口が上（下が軸）でも下（上が軸）でもよい。口の縁は輪郭の上で閉じる。
    """
    pts = [Vector((r, y)) for r, y in profile]
    normals = []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        d = (b - a).normalized()
        normals.append(Vector((d.y, -d.x)))  # 進む向きの右 = 外
    inner = []
    for p, n in zip(pts, normals):
        q = p - n * thickness
        inner.append((max(0.0, q.x) if p.x > 1e-6 else 0.0, q.y))
    out = [(p.x, p.y) for p in pts] + inner[::-1]
    if pts[0].x > 1e-6:  # 口が下: 下の縁を閉じる
        out.append((pts[0].x, pts[0].y))
    return out


def tube_bm(points, radius: float, sides: int = 8, caps: bool = True, closed: bool = False,
            radii=None, profile=None) -> bmesh.types.BMesh:
    """点の列に沿う管（平行移動の枠で捩れない）。profile を与えるとその断面（(n, b) の反時計回り）で掃く"""
    pts = [Vector(p) for p in points]
    n = len(pts)
    tangents = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[i - 1]
        else:
            t = pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]
        tangents.append(t.normalized())
    t0 = tangents[0]
    helper = Vector((0.0, 1.0, 0.0)) if abs(t0.y) < 0.9 else Vector((1.0, 0.0, 0.0))
    nrm = (helper - t0 * helper.dot(t0)).normalized()
    frames = []
    for i in range(n):
        t = tangents[i]
        nrm = (nrm - t * nrm.dot(t)).normalized()
        frames.append((nrm.copy(), t.cross(nrm)))
    if profile is None:
        profile = [(math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    m = len(profile)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        nn, bb = frames[i]
        r = radii[i] if radii is not None else radius
        rings.append([bm.verts.new(p + nn * (u * r) + bb * (v * r)) for u, v in profile])
    pairs = list(zip(rings, rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for r0, r1 in pairs:
        for k in range(m):
            k1 = (k + 1) % m
            bm.faces.new((r0[k], r0[k1], r1[k1], r1[k]))
    if caps and not closed:
        c0 = bm.verts.new(pts[0])
        c1 = bm.verts.new(pts[-1])
        for k in range(m):
            k1 = (k + 1) % m
            bm.faces.new((c0, rings[0][k1], rings[0][k]))
            bm.faces.new((c1, rings[-1][k], rings[-1][k1]))
    return bm


def fillet(points, radius: float, steps: int = 4, closed: bool = False):
    """折れ線の角を丸める（形のルール: 角を作らない）"""
    pts = [Vector(p) for p in points]
    n = len(pts)
    out = []
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            out.append(pts[i])
            continue
        p, a, c = pts[i], pts[i - 1], pts[(i + 1) % n]
        u1, u2 = (p - a), (c - p)
        d = min(radius, u1.length / 2, u2.length / 2)
        s0 = p - u1.normalized() * d
        s1 = p + u2.normalized() * d
        for k in range(steps + 1):
            t = k / steps
            out.append(s0 * (1 - t) ** 2 + p * 2 * (1 - t) * t + s1 * t * t)
    return [tuple(v) for v in out]


def arc(radius: float, y: float, from_deg: float, to_deg: float, step_deg: float = 2.0, center=(0.0, 0.0)):
    """部屋の中心（方位は +X から +Z へ）の周りの弧の点"""
    n = max(1, round(abs(to_deg - from_deg) / step_deg))
    return [(center[0] + radius * math.cos(math.radians(from_deg + (to_deg - from_deg) * i / n)), y,
             center[1] + radius * math.sin(math.radians(from_deg + (to_deg - from_deg) * i / n))) for i in range(n + 1)]


def circle(center, radius: float, segments: int, axis=(0.0, 1.0, 0.0)):
    """axis に垂直な円（閉じた点の列）"""
    ax = Vector(axis).normalized()
    helper = Vector((1.0, 0.0, 0.0)) if abs(ax.x) < 0.9 else Vector((0.0, 0.0, 1.0))
    u = (helper - ax * helper.dot(ax)).normalized()
    v = ax.cross(u)
    c = Vector(center)
    return [tuple(c + (u * math.cos(2 * math.pi * k / segments) + v * math.sin(2 * math.pi * k / segments)) * radius)
            for k in range(segments)]


def rounded_box_bm(size, bevel: float, segments: int = 3) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=bevel, offset_type='OFFSET',
                    segments=segments, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def sphere_bm(radius: float, u: int = 12, v: int = 8, scale=(1.0, 1.0, 1.0)) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    for vert in bm.verts:
        vert.co = Vector((vert.co.x * scale[0], vert.co.y * scale[1], vert.co.z * scale[2]))
    return bm


def ico_bm(radius: float) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius)
    return bm


def air_bubbles(part: Part, mat, center, radius: float, count: int, seed: int, height: float | None = None):
    """気泡入りガラスの中の泡（設計書: 泡は内部の別の小さな形状として入れる）。center の周り、radius の球（height で縦長に）"""
    rng = np.random.default_rng(seed)
    c = Vector(center)
    for _ in range(count):
        while True:
            p = rng.uniform(-1, 1, 3)
            if p @ p <= 1:
                break
        off = Vector((p[0] * radius, p[1] * (height if height is not None else radius), p[2] * radius))
        part.merge(ico_bm(float(rng.uniform(0.0025, 0.006))), mat, place(c + off), smooth=True)


# ── アトラス（不透明な物が共有する 1 枚） ─────────────────────────────────────
#: 区画の数（列, 行）。1 区画は 128px
ATLAS_GRID = (4, 2)
TILE_PX = 128
#: 区画（列, 行）。行 0 が下
TILES = {'A0_brass': (0, 0), 'A0_frost': (1, 0), 'A0_kiln': (2, 0), 'A0_opal': (3, 0),
         'A0_water': (0, 1), 'A0_fire': (1, 1), 'A0_ember': (1, 1), 'A0_shade': (2, 1)}
TILE_MARGIN = 0.12


def to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def atlas_pixels(seed: int = 24) -> np.ndarray:
    """線形の色で描く。真鍮: 下ほど緑青がかって暗く、手の触れる上ほど明るい（真鍮の鈍い金）。曇りガラスの天板: 薄い青灰。
    炉の体（S-27）: 熱で煤けた厚いガラスの暗い青灰（u は口からの近さ: 0 が口の際の煤、v は高さ）。乳白の作品（S-27）: 光らない
    乳白（オパール）。棚の背板（S-27）: 影の青灰。水: 暗い青灰に細い波紋。火: v = 0 の口の縁の深い赤から、v = 1 の奥の橙へ"""
    cols, rows = ATLAS_GRID
    h = TILE_PX
    rng = np.random.default_rng(seed)
    v = np.linspace(0, 1, h)[:, None, None]
    u = np.linspace(0, 1, h)[None, :, None]
    # a smooth, low variation (no blocks: the UV's u runs along long pieces such as the blowpipes, which would show
    # every step of a blocky noise as a bead)
    phase = rng.uniform(0, 2 * np.pi, 2)
    soft = np.sin(u * 2 * np.pi * 1.3 + phase[0]) * np.cos(v * 2 * np.pi * 1.1 + phase[1])

    def lerp(a, b, t):
        return np.asarray(a) + (np.asarray(b) - np.asarray(a)) * t

    def smooth(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)

    dark, mid, bright = (0.16, 0.12, 0.05), (0.434, 0.266, 0.095), (0.56, 0.38, 0.15)
    brass = np.where(v < 0.45, lerp(dark, mid, v / 0.45), lerp(mid, bright, (v - 0.45) / 0.55))
    frost = np.broadcast_to(np.array((0.3, 0.34, 0.4)), (h, h, 3)) * (1 + 0.04 * soft)
    base = lerp((0.055, 0.062, 0.078), (0.1, 0.11, 0.13), v) * (1 + 0.05 * soft)
    soot = smooth(0.4, 0.0, u)
    kiln = lerp(base, (0.03, 0.028, 0.03), soot * 0.85)
    opal = lerp((0.62, 0.63, 0.62), (0.8, 0.8, 0.78), v) * (1 + 0.025 * soft)
    shade = lerp((0.022, 0.03, 0.046), (0.04, 0.05, 0.072), v) * (1 + 0.04 * soft)
    ripple = 0.5 + 0.5 * np.sin(np.hypot(u - 0.5, v - 0.5) * 70)
    water = lerp((0.02, 0.032, 0.045), (0.045, 0.065, 0.085), ripple * 0.6 + 0.2 * soft)
    # 火（発光の色。強さ FIRE_GLOW を材質が掛ける）: v = 0 の暗い深い赤 → 赤 → 橙 → v = 1 の熱い所（炉では奥の壁の輪 HOT_RING）。
    # AgX は明るい赤を桃色へ寄せるので、赤く見せる所は暗く（線形 0.15〜0.45）、光源として滲む（しきい値 0.9 を超える）のは熱い所だけ
    fire = np.where(v < 0.55, lerp((0.025, 0.002, 0.0), (0.075, 0.007, 0.001), v / 0.55),
                    np.where(v < 0.85, lerp((0.075, 0.007, 0.001), (0.12, 0.02, 0.002), (v - 0.55) / 0.3),
                             lerp((0.12, 0.02, 0.002), (0.4, 0.15, 0.025), (v - 0.85) / 0.15)))
    fire = fire * (1 + 0.05 * soft)
    img = np.zeros((rows * h, cols * h, 3))
    for (col, row), tile in (((0, 0), brass), ((1, 0), frost), ((2, 0), kiln), ((3, 0), opal), ((0, 1), water),
                             ((1, 1), fire), ((2, 1), shade), ((3, 1), frost)):
        img[row * h:(row + 1) * h, col * h:(col + 1) * h] = np.broadcast_to(tile, (h, h, 3))
    return img


def atlas_image() -> bpy.types.Image:
    rgb = to_srgb(atlas_pixels())
    hgt, wid = rgb.shape[:2]
    img = bpy.data.images.new('A0_atlas', wid, hgt, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    rgba = np.concatenate([rgb, np.ones((hgt, wid, 1))], axis=-1).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'PNG'
    img.pack()
    return img


def atlas_uv(part: Part) -> None:
    """不透明な面の UV をその材質の区画へ。既定は v = 物の中の高さ（真鍮は下が暗い）、u = 位置の三角波（継ぎ目なし）。
    part.uv_rules に材質の規則があればそれに従う"""
    bm = part.bm
    uv = bm.loops.layers.uv.new('UVMap')
    ys = [v.co.y for v in bm.verts] or [0.0]
    y0, y1 = min(ys), max(ys)
    span = max(y1 - y0, 1e-3)
    cols, rows = ATLAS_GRID
    for f in bm.faces:
        name = part.mats[f.material_index].name if part.mats else ''
        tile = TILES.get(name)
        rule = part.uv_rules.get(name)
        for loop in f.loops:
            if tile is None:
                loop[uv].uv = (0.0, 0.0)
                continue
            co = loop.vert.co
            if rule is not None:
                uu, vv = rule(co)
                uu, vv = min(1.0, max(0.0, uu)), min(1.0, max(0.0, vv))
            else:
                uu = abs(((co.x + co.z) * 0.9) % 2.0 - 1.0)
                vv = (co.y - y0) / span
            loop[uv].uv = ((tile[0] + TILE_MARGIN + (1 - 2 * TILE_MARGIN) * uu) / cols,
                           (tile[1] + TILE_MARGIN + (1 - 2 * TILE_MARGIN) * vv) / rows)


# ── 材質 ──────────────────────────────────────────────────────────────────
def principled(name: str):
    m = bpy.data.materials.new(name)
    m.use_backface_culling = True
    return m, m.node_tree.nodes['Principled BSDF']


def gltf_output(m, thickness: float):
    """glTF Material Output（厚み → KHR_materials_volume の thicknessFactor）"""
    from io_scene_gltf2.blender.com.material_helpers import create_settings_group, get_gltf_node_name
    group = bpy.data.node_groups.get(get_gltf_node_name()) or create_settings_group(get_gltf_node_name())
    node = m.node_tree.nodes.new('ShaderNodeGroup')
    node.node_tree = group
    node.inputs['Thickness'].default_value = thickness
    node.location = (300, -300)


def textured(name: str, atlas, *, metallic: float = 0.0, roughness: float = 0.5, emission: float = 0.0,
             base_black: bool = False):
    m, p = principled(name)
    tex = m.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = atlas
    tex.location = (-400, 200)
    if base_black:
        p.inputs['Base Color'].default_value = (0.0, 0.0, 0.0, 1.0)
    else:
        m.node_tree.links.new(tex.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    if emission > 0:
        m.node_tree.links.new(tex.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = emission
    return m


def glass(name: str, *, thickness: float, absorption, distance: float, roughness: float = 0.0):
    """透過・屈折率・吸収・厚み。ゲームは印（名前）から作り直すので、ここの値は Blender の中での見た目のため"""
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


def materials() -> dict:
    atlas = atlas_image()
    milky, p = principled('glass_milky')
    p.inputs['Base Color'].default_value = (0.95, 0.93, 0.88, 1)
    p.inputs['Roughness'].default_value = 0.55
    # 乳白ガラス: 内側から発光。ゲームはこの発光（色 × 強さ）を乳白ガラスの内側の灯りにする（src/game/assets/glass.ts）
    p.inputs['Emission Color'].default_value = (1.0, 0.42, 0.13, 1)
    p.inputs['Emission Strength'].default_value = MILKY_GLOW
    air, q = principled('A0_air')
    q.inputs['Base Color'].default_value = (0.9, 0.93, 0.95, 1)
    q.inputs['Metallic'].default_value = 1.0
    q.inputs['Roughness'].default_value = 0.12
    out = {
        'brass': textured('A0_brass', atlas, metallic=1.0, roughness=0.38),
        'frost': textured('A0_frost', atlas, roughness=0.5),
        # S-27: the furnace's body (thick, heat-darkened glass: glossy, so it mirrors the dawn), the unlit milky works of the
        # shelf (opal), the shelf's back
        'kiln': textured('A0_kiln', atlas, roughness=0.26),
        'opal': textured('A0_opal', atlas, roughness=0.22),
        'shade': textured('A0_shade', atlas, roughness=0.85),
        'water': textured('A0_water', atlas, roughness=0.06),
        'fire': textured('A0_fire', atlas, roughness=1.0, emission=FIRE_GLOW, base_black=True),
        'ember': textured('A0_ember', atlas, roughness=1.0, emission=EMBER_GLOW, base_black=True),
        'air': air,
        # 空間の可読性と導線 2 (形は縁で伝える): walls thick enough that the green of the edge shows where the view grazes them
        # (S-24 had 6 mm, and the works on the shelf vanished against the sky)
        'clear': glass('glass_clear', thickness=0.05, absorption=(0.6, 0.86, 0.72), distance=0.3),
        'frosted': glass('glass_frosted', thickness=0.012, absorption=(0.86, 0.9, 0.93), distance=1.0,
                         roughness=0.45),
        'bubble': glass('glass_bubble', thickness=0.05, absorption=(0.8, 0.93, 0.86), distance=0.9),
        'milky': milky,
    }
    # ビューポート（と確かめ用の Workbench）での色。書き出しには関わらない
    for key, color in (('brass', (0.69, 0.55, 0.34, 1)), ('frost', (0.66, 0.7, 0.74, 1)),
                       ('kiln', (0.3, 0.32, 0.36, 1)), ('opal', (0.9, 0.9, 0.88, 1)), ('shade', (0.36, 0.39, 0.44, 1)),
                       ('water', (0.12, 0.16, 0.2, 1)), ('fire', (1.0, 0.45, 0.1, 1)),
                       ('ember', (0.9, 0.35, 0.1, 1)), ('air', (1, 1, 1, 1)), ('clear', (0.75, 0.9, 0.86, 0.35)),
                       ('frosted', (0.8, 0.85, 0.9, 0.7)), ('bubble', (0.7, 0.88, 0.8, 0.45)),
                       ('milky', (0.98, 0.86, 0.72, 1))):
        out[key].diffuse_color = color
    return out


#: 発光の強さ（仮。発案者の判断待ち）。炉の口の奥の火はブルームのしきい値（線形 0.9）を超えて滲む光源（S-27: 奥ほど橙、縁は
#: 深い赤）。炉の覗き窓の乳白ガラスはしきい値の下（S-24 は炉の全体が乳白 2.2 で、クリーム色に滲んだ）。徐冷炉の熾火は「ほのか」
FIRE_GLOW = 6.0
MILKY_GLOW = 1.2
EMBER_GLOW = 1.4


# ── 当たり判定（見た目から） ───────────────────────────────────────────────
def islands(bm: bmesh.types.BMesh):
    seen = set()
    out = []
    for v in bm.verts:
        if v in seen:
            continue
        stack = [v]
        group = []
        seen.add(v)
        while stack:
            w = stack.pop()
            group.append(w.co.copy())
            for e in w.link_edges:
                o = e.other_vert(w)
                if o not in seen:
                    seen.add(o)
                    stack.append(o)
        out.append(group)
    return out


def hull_into(dst: bmesh.types.BMesh, points) -> None:
    pts = [p for p in points]
    if len(pts) < 4:
        return
    tmp = bmesh.new()
    verts = [tmp.verts.new(p) for p in pts]
    bmesh.ops.remove_doubles(tmp, verts=verts, dist=1e-4)
    if len(tmp.verts) < 4:
        tmp.free()
        return
    res = bmesh.ops.convex_hull(tmp, input=list(tmp.verts))
    tmp.verts.index_update()
    # in index order: a set of BMVerts iterates by address, which would change the hull's vertex order run to run
    unused = sorted({*res['geom_interior'], *res['geom_unused']}, key=lambda v: v.index)
    if unused:
        bmesh.ops.delete(tmp, geom=unused, context='VERTS')
    bmesh.ops.recalc_face_normals(tmp, faces=list(tmp.faces))
    vmap = {v: dst.verts.new(v.co) for v in tmp.verts}
    for f in tmp.faces:
        try:
            dst.faces.new([vmap[v] for v in f.verts])
        except ValueError:
            pass
    tmp.free()


def angular_slices(points, center=(0.0, 0.0), step_deg: float = COL_ARC_DEG, overlap_deg: float = 1.1):
    """center（x, z）の周りの方位で点を分ける（隣と少し重ねる: 包んだ形の間に隙間を残さない）。弧の部品を弦まで埋めないため"""
    angles = [math.degrees(math.atan2(p.z - center[1], p.x - center[0])) for p in points]
    if max(angles) - min(angles) > 300:  # 一周する輪: -180/180 の継ぎ目をまたぐ
        angles = [a % 360 for a in angles]
    a0, a1 = min(angles), max(angles)
    n = max(1, round((a1 - a0) / step_deg))
    return [[p for p, a in zip(points, angles)
             if a0 + (a1 - a0) * k / n - overlap_deg <= a <= a0 + (a1 - a0) * (k + 1) / n + overlap_deg]
            for k in range(n)]


def collider(part: Part, arcs: bool = False) -> bmesh.types.BMesh:
    """部品（つながった形）ごとの凸包。頭より上（COL_MAX_Y）の点は除く。arcs: 部屋の中心の周りに長い部品は
    COL_ARC_DEG ごとに分けて包む（棚の板、レールなど）。凹んだ形（炉の泡）は呼ぶ側が分けて hull_into で包む"""
    out = bmesh.new()
    for group in islands(part.bm):
        low = [p for p in group if p.y <= COL_MAX_Y]
        if len(low) < 4:
            continue
        angles = [math.degrees(math.atan2(p.z, p.x)) for p in low]
        for g in angular_slices(low) if arcs and max(angles) - min(angles) > COL_ARC_DEG * 1.5 else [low]:
            hull_into(out, g)
    return out


# ── 物にする ────────────────────────────────────────────────────────────────
def deselect_all() -> None:
    """演算子の前に選択を外す。物を消した直後の view_layer.objects は None を返すことがある（--only furnace で落ちた）"""
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def finish(part: Part, name: str, origin, sharp_deg: float = 60.0, uv: bool = True) -> bpy.types.Object:
    """three の座標の形を Blender の物にする（原点は origin、three の座標）"""
    if uv:
        atlas_uv(part)
    o = Vector(origin)
    for v in part.bm.verts:
        v.co = ROT @ (v.co - o)
    me = bpy.data.meshes.new(name)
    part.bm.to_mesh(me)
    part.bm.free()
    for m in part.mats:
        me.materials.append(m)
    if sharp_deg:
        me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    obj = link(bpy.data.objects.new(name, me))
    obj.location = B(origin)
    return obj


def finish_collider(bm: bmesh.types.BMesh, name: str, origin) -> bpy.types.Object:
    part = Part()
    part.bm.free()
    part.bm = bm
    obj = finish(part, f'{name}_col', origin, sharp_deg=0, uv=False)
    obj.display_type = 'WIRE'
    obj.hide_render = True  # 描かない（書き出しには入る）
    return obj


def build(part: Part, name: str, origin, col: bool = False, arcs: bool = False, sharp_deg: float = 60.0,
          hull: bmesh.types.BMesh | None = None) -> None:
    """hull: 当たり判定を呼ぶ側が作ったとき（炉）。なければ col のとき collider(part) で作る"""
    if hull is None and col:
        hull = collider(part, arcs=arcs)
    finish(part, name, origin, sharp_deg=sharp_deg)
    if hull is not None:
        finish_collider(hull, name, origin)


# ── 作業台 ─────────────────────────────────────────────────────────────────
def bench(m) -> None:
    (cx, cz), (w, h, d) = BENCH['center'], BENCH['size']
    p = Part()
    # 曇りガラスの天板（歩ける面ではないが、玉を載せる面なので透明にしない）と下の棚
    p.merge(rounded_box_bm((w, 0.07, d), 0.03), m['frost'], place((cx, h - 0.035, cz)))
    p.merge(rounded_box_bm((w - 0.34, 0.04, d - 0.18), 0.018), m['frost'], place((cx, 0.28, cz)))
    # 両端の真鍮の枠（角を丸めた矩形）、天板の下と棚の下の桟
    for sx in (-1, 1):
        x = cx + sx * (w / 2 - 0.12)
        z0, z1 = cz - d / 2 + 0.07, cz + d / 2 - 0.07
        loop = fillet([(x, 0.024, z0), (x, h - 0.072, z0), (x, h - 0.072, z1), (x, 0.024, z1)], 0.09, 4, closed=True)
        p.merge(tube_bm(loop, 0.022, 8, closed=True), m['brass'])
    for sz in (-1, 1):
        z = cz + sz * (d / 2 - 0.07)
        p.merge(tube_bm([(cx - w / 2 + 0.12, h - 0.1, z), (cx + w / 2 - 0.12, h - 0.1, z)], 0.015, 8), m['brass'])
        p.merge(tube_bm([(cx - w / 2 + 0.12, 0.25, z), (cx + w / 2 - 0.12, 0.25, z)], 0.014, 8), m['brass'])
    # ビードロの受け輪（玉はゲームが置く: layout.ts の BENCH_ORB）
    p.merge(tube_bm(circle((BENCH_ORB[0], h + 0.012, BENCH_ORB[2]), 0.05, 24), 0.008, 6, closed=True), m['brass'])
    # 道具: ジャック（吹きガラスの鋏）。右の端に置いたまま
    x0, z0 = cx + 0.62, cz - 0.24
    for side in (-1, 1):
        arm = fillet([(x0, h + 0.008, z0), (x0 + 0.12, h + 0.01, z0 + side * 0.012),
                      (x0 + 0.34, h + 0.009, z0 + side * 0.035)], 0.05, 3)
        p.merge(tube_bm(arm, 0.006, 6), m['brass'])
    p.merge(tube_bm(circle((x0 - 0.02, h + 0.02, z0), 0.022, 16, axis=(0, 0, 1)), 0.005, 6, closed=True), m['brass'])
    build(p, 'A0_bnch_work01', (cx, 0.0, cz), col=True)


def tea_cup(m) -> None:
    x, y, z = TEA_CUP
    p = Part()
    cup = [(0.0, 0.0), (0.03, 0.0), (0.038, 0.008), (0.042, 0.04), (0.044, 0.075), (0.045, 0.085)]
    p.merge(lathe_bm(shell_profile(cup, 0.004), 28), m['frosted'], place((x, y, z)))
    # 飲みかけ: 半分ほどのお茶
    p.merge(lathe_bm([(0.0, 0.0), (0.039, 0.0)], 28), m['water'], place((x, y + 0.045, z)))
    build(p, 'A0_cup_tea01', (x, y, z))


def stool(m) -> None:
    cx, cz = CHAIR['center']
    seat = CHAIR['seat']
    p = Part()
    p.merge(lathe_bm([(0.0, seat - 0.045), (0.17, seat - 0.045), (0.2, seat - 0.035), (0.212, seat - 0.02),
                      (0.205, seat - 0.006), (0.18, seat), (0.0, seat)], 28), m['frost'], place((cx, 0.0, cz)))
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.4
        dx, dz = math.cos(a), math.sin(a)
        leg = [(cx + dx * r, y, cz + dz * r) for r, y in
               ((0.1, seat - 0.045), (0.13, seat - 0.12), (0.17, 0.25), (0.205, 0.08), (0.215, 0.012))]
        p.merge(tube_bm(leg, 0.016, 8), m['brass'])
    p.merge(tube_bm(circle((cx, 0.17, cz), 0.185, 28), 0.011, 6, closed=True), m['brass'])
    build(p, 'A0_chr_stool01', (cx, 0.0, cz), col=True)


# ── 炉 ─────────────────────────────────────────────────────────────────────
#: メタボールの硬さとしきい値。見える半径 ÷ 要素の半径 = sqrt(1 - (しきい値 / 硬さ)^(1/3))（場は 硬さ・(1 - r²/R²)³）。
#: 硬いほど隣の泡と溶け合う首が細く、泡の一つひとつが読める
METABALL_STIFFNESS = 4.0
METABALL_THRESHOLD = 0.6
METABALL_K = math.sqrt(1 - (METABALL_THRESHOLD / METABALL_STIFFNESS) ** (1 / 3))


def metaball_mesh(balls, resolution: float) -> bmesh.types.BMesh:
    """泡が溶け合った形（設計書: 泡の集合）。balls: (中心 three, 見える半径, 負か)。three の座標の bmesh を返す"""
    mb = bpy.data.metaballs.new('blob')
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = METABALL_THRESHOLD
    for c, r, negative in balls:
        e = mb.elements.new()
        e.co = B(c)
        e.radius = r / METABALL_K
        e.stiffness = METABALL_STIFFNESS
        e.use_negative = negative
    ob = link(bpy.data.objects.new('blob', mb))
    deselect_all()
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.convert(target='MESH')
    mesh_obj = bpy.context.view_layer.objects.active
    bm = bmesh.new()
    bm.from_mesh(mesh_obj.data)
    for v in bm.verts:
        v.co = ROT_INV @ v.co
    for o in [o for o in bpy.data.objects if o.name.startswith('blob')]:
        bpy.data.objects.remove(o)
    for me in [me for me in bpy.data.meshes if me.users == 0]:
        bpy.data.meshes.remove(me)
    for mball in [x for x in bpy.data.metaballs if x.users == 0]:
        bpy.data.metaballs.remove(mball)
    return bm


def decimate(bm: bmesh.types.BMesh, triangles: int) -> None:
    """三角形の数を目安まで減らす（折り畳み）"""
    me = bpy.data.meshes.new('tmp_decimate')
    bm.to_mesh(me)
    ob = link(bpy.data.objects.new('tmp_decimate', me))
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    mod = ob.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = min(1.0, triangles / max(tris, 1))
    deselect_all()
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bm.clear()
    bm.from_mesh(ob.data)
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)


#: 炉（S-27）: 泡の形の三角形の目安、口の窪みの大きさ、火の洞の深さ（口の奥の椀。中心が FURNACE_MOUTH）
FURNACE_BLOB_TRIANGLES = 1100
FURNACE_RECESS = 0.32
CAVE_DEPTH = 0.26
#: 口の真鍮の筒の内の半径と、体に開ける穴の半径（筒の外の半径 0.2 より小さく、筒が穴の縁を隠す）
COLLAR_INNER = 0.17
MOUTH_HOLE = 0.19
#: 火の洞のいちばん熱い所: 奥の芯からこの距離の輪（m）
HOT_RING = 0.09


def boolean_difference(bm: bmesh.types.BMesh, cutter: bmesh.types.BMesh) -> None:
    """bm から cutter（閉じた形）をくり抜く（Blender のブーリアン、EXACT）。座標はどちらも同じ空間"""
    meshes, objs = [], []
    for name, src in (('tmp_a', bm), ('tmp_b', cutter)):
        me = bpy.data.meshes.new(name)
        src.to_mesh(me)
        meshes.append(me)
        objs.append(link(bpy.data.objects.new(name, me)))
    a, b = objs
    mod = a.modifiers.new('cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = b
    deselect_all()
    a.select_set(True)
    bpy.context.view_layer.objects.active = a
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bm.clear()
    bm.from_mesh(a.data)
    for o in objs:
        bpy.data.objects.remove(o)
    for me in meshes:
        if me.users == 0:
            bpy.data.meshes.remove(me)


def raycast(bvh: BVHTree, origin, direction):
    hit = bvh.ray_cast(Vector(origin), Vector(direction).normalized())
    return hit[0]


def furnace(m) -> None:
    """吹きガラスの炉（S-27 で作り直した。S-24 は乳白ガラスの泡で、雲のように見えた）。熱で煤けた厚いガラスの泡の集まり（形のルール:
    建物は泡の集合）に真鍮の帯を締め、口は部屋の中心へ向く。口の奥は火の洞（奥の壁の輪 HOT_RING ほど橙、縁は暗い深い赤）、口の左右に
    中の火が赤く透ける覗き窓（熾火の材質に、縁の細い乳白ガラスの輪）。口には吹き竿が 1 本差したまま、その先を格子の上の真鍮の受けが
    支える。煙道は真鍮の管で、曲がってドームの壁を抜ける"""
    cx, cz = FURNACE['center']
    f = Frame(cx, cz, FACING)
    p = Part()
    rest = Part()  # 泡の形と帯と裾の輪のほかの部品（当たり判定は部品ごとに包む）

    def add(bm, mat, matrix=None):
        p.merge(bm, mat, matrix)
        rest.merge(bm, mat, matrix)

    balls = [
        (f(0.0, 0.4, 0.0), 0.74, False),  # 大きな泡（口がある）
        (f(-0.42, 0.32, 0.5), 0.46, False),  # 奥の右の肩
        (f(-0.36, 0.3, -0.54), 0.43, False),  # 奥の左の肩
        (f(-0.1, 1.3, 0.0), 0.3, False),  # 上の泡（煙道の根）
        (f(0.95, MOUTH_Y, 0.0), FURNACE_RECESS, True),  # 口の窪み
    ]
    blob = metaball_mesh(balls, 0.065)
    decimate(blob, FURNACE_BLOB_TRIANGLES)
    # 口の穴: 口の軸に沿う円柱で体をくり抜く（火の洞が体の中に見える。穴の縁は口の真鍮の筒が隠す）
    axis = Vector((FACING[0], 0.0, FACING[1]))
    cutter = bmesh.new()
    bmesh.ops.create_cone(cutter, cap_ends=True, segments=16, radius1=MOUTH_HOLE, radius2=MOUTH_HOLE, depth=0.9)
    # create_cone は z に沿う: z を口の軸へ向け、口の奥 0.4m から外へ
    turn = Vector((0.0, 0.0, 1.0)).rotation_difference(axis).to_matrix().to_4x4()
    turn.translation = Vector(f(0.4 + 0.45, MOUTH_Y))
    bmesh.ops.transform(cutter, matrix=turn, verts=list(cutter.verts))
    boolean_difference(blob, cutter)
    cutter.free()
    # 床の下は描かない（床の円盤が隠す）
    bmesh.ops.delete(blob, geom=[v for v in blob.verts if v.co.y < -0.03], context='VERTS')
    bvh = BVHTree.FromBMesh(blob)
    p.merge(blob, m['kiln'])
    # 体の色: 口の際ほど煤ける（u）、上ほど明るい（v）
    soot_c = Vector(f(MOUTH_REACH + 0.25, MOUTH_Y))
    p.uv_rules['A0_kiln'] = lambda co: ((co - soot_c).length / 1.0, co.y / 1.6)
    # 火の洞: 口の奥の椀。面は内（口）を向く。奥の壁の輪がいちばん熱く（橙）、縁ほど暗い深い赤。中心が FURNACE_MOUTH（S-25 の音源）。
    # 縁は真鍮の筒の内側に 2cm 入る（隙間から体の中が見えない）
    back = MOUTH_REACH - 0.12
    rim = COLLAR_INNER + 0.002
    cave = [(rim, CAVE_DEPTH), (rim - 0.007, CAVE_DEPTH * 0.6), (rim - 0.022, CAVE_DEPTH * 0.3),
            (rim - 0.072, CAVE_DEPTH * 0.08), (0.0, 0.0)]
    add(lathe_bm(cave, 20), m['fire'], place(f(back, MOUTH_Y), axis=tuple(axis)))
    back_c = Vector(f(back, MOUTH_Y))
    reach = math.hypot(CAVE_DEPTH, rim)
    # 熱い所は奥の壁の輪（芯からの距離 HOT_RING）: 口に差した竿が奥の真ん中を隠すので。ただ立った目の高さからは筒の上の縁に隠れ、
    # 輪の大半は見えない（開きの上の端に橙の帯として見える。レビュー2巡目）
    p.uv_rules['A0_fire'] = lambda co: (0.5, 1.0 - abs((co - back_c).length - HOT_RING) / (reach - HOT_RING))
    # 口（グローリーホール）: 体の中から突き出す真鍮の筒（穴の縁と洞の縁を隠す）。外の端は少し開く。開き（0.955m、外の半径 0.2m）は
    # tests/e2e/S-27-workshop-look.spec.ts の mouthRegion が画面に写す範囲と同じ数。変えたらそちらも
    start = MOUTH_REACH
    length = 0.955 - start
    collar = shell_profile([(0.2, 0.0), (0.2, length - 0.055), (0.228, length)], 0.2 - COLLAR_INNER)
    add(lathe_bm(collar, 20), m['brass'], place(f(start, MOUTH_Y), axis=tuple(axis)))
    # 覗き窓: 口の左右の、中の火が赤く透ける小さな窓（熾火の材質）、縁に細い乳白ガラスの輪、外に真鍮の輪。工房で乳白ガラスの印を
    # 持つのはこの輪だけ（乳白の窓の面は、口の前の灯りを受けてクリーム色の点に見えた: レビュー1巡目）
    for side in (-1, 1):
        a = math.radians(50.0) * side
        d = Vector((FACING[0] * math.cos(a) + f.r[0] * math.sin(a), 0.0, FACING[1] * math.cos(a) + f.r[1] * math.sin(a)))
        y = 0.62
        hit = bvh.ray_cast(Vector((cx, y, cz)) + d * 2.0, -d)
        if hit[0] is None:
            continue
        at, normal = Vector(hit[0]), Vector(hit[1]).normalized()
        add(tube_bm(circle(tuple(at + normal * 0.006), 0.062, 12, axis=tuple(normal)), 0.012, 4, closed=True),
            m['brass'])
        window = [(0.052, 0.0), (0.03, 0.005), (0.0, 0.007)]  # 外 → 軸（上）: 面は外を向く
        add(lathe_bm(window, 12), m['ember'], place(at + normal * 0.001, axis=tuple(normal)))
        add(tube_bm(circle(tuple(at + normal * 0.004), 0.053, 12, axis=tuple(normal)), 0.005, 4, closed=True),
            m['milky'])
    p.uv_rules['A0_ember'] = lambda co: (0.5, 0.88)  # 火の区画の赤橙
    # 足元の真鍮の輪と、体を締める 2 本の帯（口の窪みの上と、上の泡の首）: 泡の面に沿う
    def band(y, segments, lift, radius, sides):
        pts = []
        for k in range(segments):
            a = 2 * math.pi * k / segments
            d = Vector((math.cos(a), 0.0, math.sin(a)))
            hit = raycast(bvh, Vector((cx, y, cz)) + d * 2.0, -d)
            r = (Vector(hit) - Vector((cx, y, cz))).length if hit else FURNACE['radius']
            pts.append((cx + d.x * (r + lift), y, cz + d.z * (r + lift)))
        return tube_bm(pts, radius, sides, closed=True)

    rings = [band(0.035, 32, 0.012, 0.02, 4), band(0.94, 30, 0.01, 0.017, 4), band(1.12, 24, 0.01, 0.015, 4)]
    for ring in rings:
        p.merge(ring, m['brass'])
    # 煙道: 上の泡の頂から、曲がって壁へ
    top = raycast(bvh, f(-0.1, 3.0, 0.0), (0.0, -1.0, 0.0)) or Vector(f(-0.1, 1.6, 0.0))
    out = Vector((-FACING[0], 0.0, -FACING[1]))
    base = Vector(top) - Vector((0.0, 0.05, 0.0))
    y_wall = 2.8
    wall = out * (wall_r(y_wall) + 0.25) + Vector((0.0, y_wall, 0.0))
    flue = fillet([tuple(base), tuple(base + Vector((0.0, 0.5, 0.0))), tuple(wall)], 0.35, 5)
    add(tube_bm(flue, 0.075, 8), m['brass'])
    # 口に差したままの吹き竿と、その受け（格子の上）
    pipe_y = lambda a: MOUTH_Y + 0.02 + (a - 0.55) / (MOUTH_PIPE_REACH - 0.55) * 0.18  # noqa: E731
    add(tube_bm([f(0.55, pipe_y(0.55)), f(MOUTH_PIPE_REACH, pipe_y(MOUTH_PIPE_REACH))], 0.016, 8), m['brass'])
    add(tube_bm(circle(f(MOUTH_PIPE_REACH - 0.02, pipe_y(MOUTH_PIPE_REACH)), 0.02, 12, axis=tuple(axis)), 0.006, 4,
                closed=True), m['brass'])
    yoke_a = 1.5
    yy = pipe_y(yoke_a) - 0.02
    add(tube_bm([f(yoke_a, FLOOR_TOP + 0.02), f(yoke_a, yy - 0.035)], 0.014, 8), m['brass'])
    add(lathe_bm([(0.0, 0.0), (0.09, 0.0), (0.1, 0.012), (0.0, 0.02)], 16), m['brass'], place(f(yoke_a, FLOOR_TOP)))
    u_pts = [f(yoke_a, yy + 0.035 - 0.035 * math.sin(math.pi * k / 8), 0.035 * math.cos(math.pi * k / 8))
             for k in range(9)]
    add(tube_bm(u_pts, 0.008, 6), m['brass'])
    # 当たり判定: 泡の形は泡ごとに包む（一つの凸包では泡と泡のくびれが埋まり、歩ける床から見えない壁になる）。各頂点を
    # いちばん近い泡へ（見える半径で割った距離）、境は 14% 重ねて隙間を残さない。輪と帯は炉の周りに 12 度ずつ、ほかは部品ごと
    hull = collider(rest)
    bubbles = [(Vector(c), r) for c, r, negative in balls if not negative]
    shape = [v.co.copy() for v in blob.verts if v.co.y <= COL_MAX_Y]
    dists = [[(q - c).length / r for c, r in bubbles] for q in shape]
    for i in range(len(bubbles)):
        hull_into(hull, [q for q, d in zip(shape, dists) if d[i] <= min(d) * 1.14])
    for ring in rings:
        for g in angular_slices([v.co.copy() for v in ring.verts], (cx, cz), 12.0, 1.0):
            hull_into(hull, g)
    build(p, 'A0_frn_furnace01', (cx, 0.0, cz), sharp_deg=80.0, hull=hull)


def grate(m) -> None:
    """炉の前の真鍮の格子（床。空間の可読性と導線 1: 床と道は曇りガラス・石畳・真鍮の格子）。直線は真鍮だけに許す"""
    cx, cz = FURNACE['center']
    f = Frame(cx, cz, FACING)
    near, depth, half = GRATE['near'], GRATE['depth'], GRATE['width'] / 2
    y = FLOOR_TOP + 0.016
    p = Part()
    frame = fillet([f(near, y, -half), f(near + depth, y, -half), f(near + depth, y, half), f(near, y, half)],
                   0.07, 4, closed=True)
    p.merge(tube_bm([(a, y - 0.0005, b) for a, _, b in frame], 0.016, 8, closed=True), m['brass'])
    bar = [(-0.012, -0.004), (0.012, -0.004), (0.012, 0.004), (-0.012, 0.004)]  # 縦に立てた平たい棒（u = 上）
    k = 1
    while -half + 0.1 * k < half - 0.05:
        s = -half + 0.1 * k
        p.merge(tube_bm([f(near + 0.015, y, s), f(near + depth - 0.015, y, s)], 1.0, profile=bar), m['brass'],
                smooth=False)
        k += 1
    for a in (near + 0.25, near + 0.5, near + 0.75):
        p.merge(tube_bm([f(a, y - 0.004, -half + 0.015), f(a, y - 0.004, half - 0.015)], 1.0,
                        profile=[(-0.008, -0.005), (0.008, -0.005), (0.008, 0.005), (-0.008, 0.005)]),
                m['brass'], smooth=False)
    build(p, 'A0_grt_floor01', f(near + depth / 2, 0.0, 0.0))


def blowpipe_rack(m) -> None:
    """吹き竿の立て掛け: 床の受けと壁際の手すり、そこに寄りかかる 4 本の竿（真鍮）"""
    a0, a1 = RACK['from_deg'], RACK['to_deg']
    p = Part()
    p.merge(tube_bm(arc(3.03, FLOOR_TOP + 0.03, a0, a1), 0.028, 8), m['brass'])
    rail_y, rail_r = 1.42, 3.88
    p.merge(tube_bm(arc(rail_r, rail_y, a0, a1), 0.02, 8), m['brass'])
    for deg in (a0 + 2.0, a1 - 2.0):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        p.merge(tube_bm([(rail_r * c, FLOOR_TOP, rail_r * s), (rail_r * c, rail_y, rail_r * s)], 0.018, 8), m['brass'])
        p.merge(lathe_bm([(0.0, 0.0), (0.07, 0.0), (0.075, 0.01), (0.0, 0.016)], 16), m['brass'],
                place((rail_r * c, FLOOR_TOP, rail_r * s)))
    # 竿は床の受けから手すりの内側に寄りかかる（手すりの高さで半径 rail_r - 0.035）
    for deg, lift in ((a0 + 4.5, 0.0), (a0 + 9.0, 0.03), (a0 + 13.5, -0.02), (a0 + 18.0, 0.02)):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        lo = Vector((3.05 * c, FLOOR_TOP + 0.05, 3.05 * s))
        top_y = rail_y + 0.13 + lift
        top_r = 3.05 + (rail_r - 0.035 - 3.05) * (top_y - 0.05) / (rail_y - 0.05)
        hi = Vector((top_r * c, top_y, top_r * s))
        p.merge(tube_bm([tuple(lo), tuple(hi)], 0.016, 8), m['brass'])
        p.merge(tube_bm([tuple(lo), tuple(lo + (hi - lo).normalized() * 0.12)], 0.019, 8), m['brass'])
        p.merge(tube_bm(circle(tuple(hi - (hi - lo).normalized() * 0.01), 0.017, 12, axis=tuple(hi - lo)), 0.005, 4,
                        closed=True), m['brass'])
    mid = math.radians((a0 + a1) / 2)
    build(p, 'A0_pipe_rack01', (3.5 * math.cos(mid), 0.0, 3.5 * math.sin(mid)), col=True, arcs=True)


def marver(m) -> None:
    """マーバー台: 真鍮の板（直線は真鍮だけ）を、泡のようにふくらんだ曇りガラスの脚 2 本が支える。長い辺は壁に沿う"""
    cx, cz = MARVER['center']
    length, height, depth = MARVER['size']
    f = Frame(cx, cz)
    p = Part()
    p.merge(rounded_box_bm((length, 0.06, depth), 0.025), m['brass'], place(f(0.0, height - 0.03), f.yaw))
    leg = [(0.0, 0.0), (0.12, 0.0), (0.14, 0.04), (0.09, 0.2), (0.125, 0.42), (0.075, 0.64), (0.11, height - 0.06),
           (0.0, height - 0.06)]
    for s in (-0.29, 0.29):
        p.merge(lathe_bm(leg, 20), m['frost'], place(f(0.0, 0.0, s)))
    build(p, 'A0_mrv_marver01', (cx, 0.0, cz), col=True)


def water_tub(m) -> None:
    """水桶: 曇りガラスの桶に真鍮のたが 2 本、水面、縁に掛けた柄杓"""
    cx, cz = TUB['center']
    r, h, water = TUB['radius'], TUB['height'], TUB['water']
    p = Part()
    outer = [(0.0, 0.0), (r - 0.05, 0.0), (r - 0.02, 0.03), (r - 0.01, 0.25), (r, h)]
    p.merge(lathe_bm(shell_profile(outer, 0.02), 32), m['frosted'], place((cx, FLOOR_TOP, cz)))
    for y, rr in ((0.07, r - 0.012), (0.38, r - 0.002)):
        p.merge(tube_bm(circle((cx, FLOOR_TOP + y, cz), rr + 0.01, 32), 0.011, 5, closed=True), m['brass'])
    p.merge(lathe_bm([(0.0, 0.0), (r - 0.026, 0.0)], 32), m['water'], place((cx, FLOOR_TOP + water, cz)))
    # 柄杓: 小さな真鍮の椀と、縁に渡した柄
    f = Frame(cx, cz)
    handle = [f(-0.36, h + 0.02, 0.06), f(-0.1, h + 0.025, 0.04), f(0.05, h - 0.02, 0.03)]
    p.merge(tube_bm(handle, 0.007, 6), m['brass'])
    p.merge(lathe_bm(shell_profile([(0.0, 0.0), (0.03, 0.002), (0.045, 0.025), (0.048, 0.05)], 0.003), 16),
            m['brass'], place(Vector(f(0.08, h - 0.07, 0.03))))
    build(p, 'A0_tub_water01', (cx, 0.0, cz), col=True)


# ── 徐冷炉 ──────────────────────────────────────────────────────────────────
def annealer(m) -> None:
    """徐冷炉: 曇りガラスの泡。口は部屋の中心へ向いたアーチ。中は熾火でほのかに暖かく、曇りガラス越しに滲んで見える"""
    cx, cz = ANNEALER['center']
    radius, height = ANNEALER['radius'], ANNEALER['height']
    f = Frame(cx, cz)
    profile = [(radius - 0.05, 0.0), (radius - 0.01, 0.05)]
    for k in range(1, 12):
        t = k / 11
        y = 0.05 + (height - 0.05) * t
        profile.append(((radius - 0.01) * math.sqrt(max(0.0, 1 - (t * 0.97) ** 2.2)) + 0.0, y))
    profile.append((0.0, height))
    shell = lathe_bm([(0.0, 0.0)] + profile[:], 36)
    # 口: 中心へ向くアーチ（幅 ±36 度、高さ 0.6m）
    face_deg = math.degrees(math.atan2(f.f[1], f.f[0]))
    open_deg, open_h = ANNEALER['mouth_half_deg'], ANNEALER['mouth_height']
    gone = []
    for face in shell.faces:
        c = face.calc_center_median()
        if c.y < 0.005:  # 底は描かない（床が隠す）
            gone.append(face)
            continue
        d = math.degrees(math.atan2(-c.z, c.x))  # lathe_bm の向き: x = cos, z = -sin
        diff = (d - (-face_deg) + 180) % 360 - 180
        if abs(diff) < open_deg and c.y < open_h * math.sqrt(max(0.0, 1 - (diff / open_deg) ** 2)) + 0.04:
            gone.append(face)
    bmesh.ops.delete(shell, geom=gone, context='FACES')
    bmesh.ops.solidify(shell, geom=list(shell.faces), thickness=0.03)
    p = Part()
    p.merge(shell, m['frosted'], place((cx, FLOOR_TOP, cz), -math.radians(0.0)))
    # 口の縁の真鍮（アーチ）と、足元の輪
    def surface_r(y):
        for (r0, y0), (r1, y1) in zip(profile, profile[1:]):
            if y0 <= y <= y1:
                return r0 + (r1 - r0) * (y - y0) / max(y1 - y0, 1e-6)
        return profile[-1][0]

    arch = []
    for k in range(-12, 13):
        dd = open_deg * k / 12
        y = open_h * math.sqrt(max(0.0, 1 - (dd / open_deg) ** 2)) + 0.03
        a = math.radians(face_deg + dd)
        rr = surface_r(y) + 0.012
        arch.append((cx + rr * math.cos(a), FLOOR_TOP + y, cz + rr * math.sin(a)))
    p.merge(tube_bm(arch, 0.016, 8), m['brass'])
    p.merge(tube_bm(circle((cx, FLOOR_TOP + 0.03, cz), radius - 0.025, 36), 0.018, 5, closed=True), m['brass'])
    # 熾火: 床と奥の壁（中心から見て奥）。曇りガラス越しにも口からも見える
    p.merge(lathe_bm([(0.0, 0.0), (radius - 0.12, 0.0)], 24), m['ember'], place((cx, FLOOR_TOP + 0.03, cz)))
    back = Vector((-f.f[0], 0.0, -f.f[1]))
    hearth = []
    for k in range(9):
        a = math.radians(face_deg + 180 - 70 + 140 * k / 8)
        hearth.append((cx + 0.46 * math.cos(a), cz + 0.46 * math.sin(a)))
    hb = bmesh.new()
    lo = [hb.verts.new((x, FLOOR_TOP + 0.04, z)) for x, z in hearth]
    hi = [hb.verts.new((x, FLOOR_TOP + 0.55, z)) for x, z in hearth]
    for i in range(len(hearth) - 1):
        hb.faces.new((lo[i], hi[i], hi[i + 1], lo[i + 1]))
    bmesh.ops.recalc_face_normals(hb, faces=list(hb.faces))
    for face in hb.faces:  # 内（口の方）へ向ける
        if face.normal.dot(back) > 0:
            face.normal_flip()
    p.merge(hb, m['ember'])
    # 中の真鍮の棚（作品を載せる）
    p.merge(tube_bm(circle((cx, FLOOR_TOP + 0.22, cz), 0.36, 28), 0.01, 5, closed=True), m['brass'])
    for s in (-0.18, 0.0, 0.18):
        p.merge(tube_bm([f(-math.sqrt(0.36 ** 2 - s * s), FLOOR_TOP + 0.22, s),
                         f(math.sqrt(0.36 ** 2 - s * s), FLOOR_TOP + 0.22, s)], 0.008, 6), m['brass'])
    # 熾火は火の区画の赤から橙の間（S-27 で火の区画の縁を暗い深い赤にした。熾火は弱い発光のまま見えるように）
    p.uv_rules['A0_ember'] = lambda co: (0.5, 0.62 + 0.26 * min(1.0, max(0.0, (co.y - FLOOR_TOP) / 0.55)))
    build(p, 'A0_anl_annealer01', (cx, 0.0, cz), col=True)


# ── 置いたままの道具と作りかけ（S-27: 世界観 > まだそこで暮らしている気配） ─────────────────────────────────
# 作業台・マーバー台・徐冷炉の周りに、手を止めたばかりの道具と作りかけ、出番を待つ作品を置く。歩く線と天窓の下の中央には置かない。
# 台の上の小物は当たり判定を持たない（台の当たり判定の上）。床に立つ物（マーバー台の横の竿の桶、徐冷炉の横の台車）は _col を持つ。
def xf(matrix: Matrix, pts):
    """three の点の列を matrix で動かす"""
    return [tuple(matrix @ Vector(q)) for q in pts]


def tweezers(p: Part, mat, at, yaw: float, length: float = 0.26) -> None:
    """ピンセット（長い鉗子）: 根で合わさった 2 本の細い腕。寝かせて置く。局所の +x が先"""
    M = place(at, yaw)
    for side in (-1, 1):
        arm = fillet([(0.0, 0.005, 0.0), (length * 0.35, 0.005, side * 0.016), (length, 0.0045, side * 0.005)], 0.05, 3)
        p.merge(tube_bm(xf(M, arm), 0.0045, 6), mat)
    p.merge(tube_bm(xf(M, circle((-0.006, 0.006, 0.0), 0.009, 10)), 0.0035, 4, closed=True), mat)


def shears(p: Part, mat, at, yaw: float) -> None:
    """鋏: 要で交わる 2 枚の刃と指の輪。寝かせて置く"""
    M = place(at, yaw)
    for side in (-1, 1):
        blade = fillet([(-0.085, 0.006, side * 0.024), (0.0, 0.006, 0.0), (0.12, 0.005, -side * 0.012)], 0.03, 3)
        p.merge(tube_bm(xf(M, blade), 0.005, 6, radii=None), mat)
        p.merge(tube_bm(xf(M, circle((-0.105, 0.006, side * 0.03), 0.019, 12)), 0.0045, 4, closed=True), mat)


def calipers(p: Part, mat, at, yaw: float) -> None:
    """キャリパー（厚みを測る）: 要の輪から弓なりの 2 本の脚"""
    M = place(at, yaw)
    for side in (-1, 1):
        leg = fillet([(0.0, 0.005, 0.0), (0.06, 0.005, side * 0.04), (0.14, 0.005, side * 0.034),
                      (0.18, 0.005, side * 0.008)], 0.05, 3)
        p.merge(tube_bm(xf(M, leg), 0.004, 6), mat)
    p.merge(tube_bm(xf(M, circle((0.0, 0.006, 0.0), 0.012, 10)), 0.004, 4, closed=True), mat)


def paddle(p: Part, mat, at, yaw: float, blade=(0.15, 0.09), handle: float = 0.22) -> None:
    """真鍮のへら（器の底を平らにする）: 角の丸い平らな板と丸い柄"""
    M = place(at, yaw)
    p.merge(rounded_box_bm((blade[0], 0.01, blade[1]), 0.004, 2), mat, M @ place((blade[0] / 2, 0.005, 0.0)))
    p.merge(tube_bm(xf(M, [(blade[0] - 0.01, 0.008, 0.0), (blade[0] + handle, 0.012, 0.0)]), 0.01, 8), mat)


def block(p: Part, mat, at, yaw: float) -> None:
    """ブロック（熱いガラスを丸める椀）: 真鍮の小さな椀と柄。椀を伏せて置く"""
    M = place(at, yaw)
    cup = shell_profile([(0.0, 0.05), (0.03, 0.045), (0.048, 0.025), (0.052, 0.0)], 0.005)
    p.merge(lathe_bm(cup, 14), mat, M)
    p.merge(tube_bm(xf(M, [(0.045, 0.02, 0.0), (0.2, 0.03, 0.0)]), 0.009, 8), mat)


#: 作業台の上の畳んだ眼鏡（S-27）: 作業台の中心からの (x, z) と向き。縁は道具（真鍮）、レンズは器（透明ガラス）の物に入る
SPECTACLES = ((-0.86, -0.14), 0.5)


def spectacles(frame: Part | None, mat, lens: Part | None, glass_mat, at, yaw: float) -> None:
    """眼鏡（つるを畳んで伏せた）: 真鍮の丸い縁（frame に）と、透明のガラスのレンズ（lens に）"""
    M = place(at, yaw)
    for side in (-1, 1):
        c = (side * 0.031, 0.005, 0.0)
        if lens is not None:
            lens.merge(lathe_bm([(0.022, 0.0), (0.012, 0.0015), (0.0, 0.002)], 12), glass_mat,
                       M @ place((c[0], 0.004, 0.0)))
        if frame is None:
            continue
        frame.merge(tube_bm(xf(M, circle(c, 0.024, 16)), 0.0028, 4, closed=True), mat)
        frame.merge(tube_bm(xf(M, [(side * 0.055, 0.006, -0.004), (side * 0.06, 0.007, -0.03),
                                   (-side * 0.03, 0.008, -0.034)]), 0.0022, 4), mat)
    if frame is not None:
        frame.merge(tube_bm(xf(M, [(-0.008, 0.006, 0.0), (0.0, 0.009, 0.004), (0.008, 0.006, 0.0)]), 0.0025, 4), mat)


def tray(p: Part, mat, at, yaw: float, size=(0.26, 0.18)) -> None:
    """真鍮の盆: 角の丸い薄い板と縁"""
    M = place(at, yaw)
    p.merge(rounded_box_bm((size[0], 0.006, size[1]), 0.002, 1), mat, M @ place((0.0, 0.003, 0.0)))
    hx, hz = size[0] / 2 - 0.006, size[1] / 2 - 0.006
    rim = fillet([(-hx, 0.012, -hz), (hx, 0.012, -hz), (hx, 0.012, hz), (-hx, 0.012, hz)], 0.03, 3, closed=True)
    p.merge(tube_bm(xf(M, rim), 0.005, 4, closed=True), mat)


def chips(p: Part, mat, at, count: int, spread: float, seed: int) -> None:
    """ガラスのかけら（カレット）: 小さな角のない粒"""
    rng = np.random.default_rng(seed)
    for _ in range(count):
        dx, dz = rng.uniform(-spread, spread, 2)
        r = float(rng.uniform(0.008, 0.014))
        bm = ico_bm(r)
        for v in bm.verts:
            v.co = Vector((v.co.x, v.co.y * 0.6, v.co.z))
        p.merge(bm, mat, place((at[0] + dx, at[1] + r * 0.5, at[2] + dz), float(rng.uniform(0, math.pi))))


def bench_tools(m) -> None:
    """作業台に置いたままの道具: 鋏、ピンセット、キャリパー、畳んだ眼鏡（レンズは作業台の器の側の透明ガラス）、下の棚の真鍮の
    盆とへら。玉の周り（天窓の光の丸）は空ける"""
    (cx, cz), (w, h, d) = BENCH['center'], BENCH['size']
    p = Part()
    shears(p, m['brass'], (cx + 0.36, h, cz + 0.27), 0.35)
    tweezers(p, m['brass'], (cx - 0.56, h, cz + 0.3), -0.12, 0.28)
    calipers(p, m['brass'], (cx - 0.48, h, cz - 0.3), 2.6)
    (sx, sz), yaw = SPECTACLES
    spectacles(p, m['brass'], None, None, (cx + sx, h, cz + sz), yaw)
    shelf_y = 0.3
    tray(p, m['brass'], (cx + 0.48, shelf_y, cz + 0.02), 0.1)
    paddle(p, m['brass'], (cx + 0.3, shelf_y + 0.012, cz + 0.06), 0.15, blade=(0.12, 0.08), handle=0.16)
    build(p, 'A0_tool_bench01', (cx, h, cz))


def bench_wares(m) -> None:
    """作業台の上の器（room-art.ts にあった 2 つ。玉への視線を遮らない位置）。S-27: 寝かせた作りかけのぽぺん、透明のガラス棒の
    束、眼鏡のレンズ、下の棚に重ねた曇りガラスの鉢と透明の瓶、盆の上のかけら"""
    (cx, cz), (_, h, _) = BENCH['center'], BENCH['size']
    p = Part()
    flask = [(0.0, 0.0), (0.1, 0.01), (0.13, 0.1), (0.1, 0.2), (0.04, 0.26), (0.036, 0.36), (0.05, 0.38)]
    vase = [(0.0, 0.0), (0.07, 0.005), (0.085, 0.11), (0.055, 0.26), (0.07, 0.42), (0.085, 0.45)]
    p.merge(lathe_bm(shell_profile(flask, 0.005), 28), m['clear'], place((cx - 0.62, h, cz - 0.1)))
    p.merge(lathe_bm(shell_profile(vase, 0.006), 24), m['bubble'], place((cx + 0.62, h, cz + 0.12)))
    air_bubbles(p, m['air'], (cx + 0.62, h + 0.2, cz + 0.12), 0.05, 12, seed=3, height=0.14)
    # 作りかけのぽぺん: 首の先を折ったまま横に寝かせる（首は右、作業台の奥へ）
    axis = Vector((math.cos(-0.5), 0.0, math.sin(-0.5)))
    body = Vector((cx + 0.32, h + 0.062, cz - 0.24))
    p.merge(lathe_bm(SHAPES['poppen'], 18), m['bubble'], place(body - axis * 0.05, axis=tuple(axis)))
    air_bubbles(p, m['air'], tuple(body), 0.035, 4, seed=5, height=0.02)
    # 透明のガラス棒の束（4 本、並べて）
    for i in range(4):
        z = cz + 0.36 - i * 0.013
        p.merge(tube_bm([(cx - 0.95, h + 0.0065, z), (cx - 0.5, h + 0.0065, z + 0.02)], 0.0065, 6), m['clear'])
    (sx, sz), yaw = SPECTACLES
    spectacles(None, None, p, m['clear'], (cx + sx, h, cz + sz), yaw)
    build(p, 'A0_ware_bench01', (cx, h, cz))


def bench_shelf_wares(m) -> None:
    """作業台の下の棚（S-27）: 重ねた曇りガラスの鉢、透明の瓶 2 つ、真鍮の盆（道具の側）の上のかけら"""
    (cx, cz), _ = BENCH['center'], BENCH['size']
    p = Part()
    shelf_y = 0.3
    bowl = shell_profile([(0.0, 0.0), (0.045, 0.0), (0.08, 0.025), (0.1, 0.06), (0.105, 0.075)], 0.004)
    for i in range(3):
        p.merge(lathe_bm(bowl, 20), m['frosted'], place((cx - 0.6, shelf_y + i * 0.022, cz - 0.02)))
    jar = shell_profile([(0.0, 0.0), (0.05, 0.0), (0.06, 0.02), (0.062, 0.13), (0.045, 0.16), (0.048, 0.17)], 0.004)
    p.merge(lathe_bm(jar, 18), m['clear'], place((cx - 0.25, shelf_y, cz - 0.1)))
    p.merge(lathe_bm(jar, 18), m['clear'], place((cx - 0.1, shelf_y, cz + 0.08), 0.0))
    chips(p, m['clear'], (cx + 0.43, shelf_y + 0.009, cz + 0.0), 7, 0.06, seed=8)
    build(p, 'A0_ware_bench02', (cx, shelf_y, cz))


def marver_tools(m) -> None:
    """マーバー台の上に置いたままの道具: ピンセット、へら、ブロック（作りかけの竿は台の真ん中を斜めに横切る）、左の端に掛けたジャック"""
    cx, cz = MARVER['center']
    _, height, _ = MARVER['size']
    f = Frame(cx, cz)
    p = Part()
    y = height
    # 手前の帯（a 0.15〜0.25）にピンセットとブロック、奥の帯にへら。作りかけの竿は真ん中を斜めに横切る
    tweezers(p, m['brass'], f(0.19, y, -0.42), f.yaw, 0.27)
    block(p, m['brass'], f(0.19, y, 0.16), f.yaw)
    paddle(p, m['brass'], f(-0.18, y, 0.02), f.yaw, blade=(0.14, 0.085), handle=0.2)
    # 台の左の端の真鍮の鉤に掛けたジャック（鋏の形の道具）: 2 本の腕が下へ
    hook = [f(0.08, y - 0.03, -0.45), f(0.08, y - 0.03, -0.49), f(0.08, y - 0.07, -0.5)]
    p.merge(tube_bm(fillet(hook, 0.02, 3), 0.005, 6), m['brass'])
    for side in (-1, 1):
        arm = fillet([f(0.08, y - 0.07, -0.5), f(0.08 + side * 0.03, y - 0.16, -0.505),
                      f(0.08 + side * 0.012, y - 0.36, -0.51)], 0.05, 3)
        p.merge(tube_bm(arm, 0.006, 6), m['brass'])
    build(p, 'A0_tool_marver01', (cx, y, cz))


#: マーバー台の前の竿の桶（S-27）: 台の枠での位置（a = 中心へ、s = 右）、半径、高さ。台の前の縁に寄せる（隙間 9cm）。最初は台の
#: 左の奥（水桶と台車の間）に置いたが、水桶と台の裏の床へ入る道を、通れそうで通れない幅に狭めていた（レビュー1巡目）
PIPE_BUCKET = {'a': 0.5, 's': 0.25, 'radius': 0.16, 'height': 0.3}


def pipe_bucket(m) -> None:
    """竿の桶: マーバー台の前の、水を張った真鍮の桶。ポンテ（竿）3 本を立てて冷ましたまま。竿の頭は桶の縁の内"""
    cx, cz = MARVER['center']
    f = Frame(cx, cz)
    bx, _, bz = f(PIPE_BUCKET['a'], 0.0, PIPE_BUCKET['s'])
    r, hgt = PIPE_BUCKET['radius'], PIPE_BUCKET['height']
    p = Part()
    rest = Part()  # 当たり判定に入れる部品（水面は入れない）
    shell = shell_profile([(0.0, 0.0), (r - 0.03, 0.0), (r - 0.012, 0.02), (r - 0.006, hgt - 0.02), (r, hgt)], 0.008)
    for q in (p, rest):
        q.merge(lathe_bm(shell, 24), m['brass'], place((bx, FLOOR_TOP, bz)))
    p.merge(lathe_bm([(0.0, 0.0), (r - 0.012, 0.0)], 24), m['water'], place((bx, FLOOR_TOP + hgt - 0.06, bz)))
    for k, (ang, lean) in enumerate(((0.3, 0.05), (2.4, 0.07), (4.3, 0.04))):
        foot = Vector((bx + 0.06 * math.cos(ang), FLOOR_TOP + 0.03, bz + 0.06 * math.sin(ang)))
        head = Vector((bx + (0.06 + lean) * math.cos(ang), 1.0 + 0.04 * k, bz + (0.06 + lean) * math.sin(ang)))
        for q in (p, rest):
            q.merge(tube_bm([tuple(foot), tuple(head)], 0.009, 8), m['brass'])
            q.merge(tube_bm(circle(tuple(head - (head - foot).normalized() * 0.012), 0.011, 10,
                                   axis=tuple(head - foot)), 0.004, 4, closed=True), m['brass'])
    build(p, 'A0_bkt_marver01', (bx, 0.0, bz), hull=collider(rest))


def marver_ware(m) -> None:
    """作りかけの器: マーバー台の上、竿（ポンテ）の先についたままの気泡入りガラス。S-27: 台の隅に冷ましている小さな杯と、
    かけらの小山"""
    cx, cz = MARVER['center']
    length, height, depth = MARVER['size']
    f = Frame(cx, cz)
    p = Part()
    y = height + 0.012
    start = Vector(f(-0.04, y + 0.075, -0.24))
    end = Vector(f(0.12, y + 0.012, 0.42))
    p.merge(tube_bm([tuple(start), tuple(end)], 0.015, 8), m['brass'])
    axis = (start - end).normalized()
    bulb = [(0.0, 0.0), (0.05, 0.008), (0.082, 0.05), (0.088, 0.1), (0.068, 0.15), (0.03, 0.185), (0.016, 0.2)]
    centre = start + axis * 0.0
    base = centre - axis * 0.2
    p.merge(lathe_bm(bulb, 28), m['bubble'], place(base + Vector((0.0, 0.0, 0.0)), axis=tuple(axis)))
    air_bubbles(p, m['air'], tuple(base + axis * 0.1), 0.05, 8, seed=11)
    cup = shell_profile([(0.0, 0.0), (0.03, 0.0), (0.042, 0.012), (0.046, 0.07), (0.05, 0.09)], 0.005)
    p.merge(lathe_bm(cup, 18), m['bubble'], place(f(-0.17, height, -0.1)))
    air_bubbles(p, m['air'], f(-0.17, height + 0.045, -0.1), 0.025, 4, seed=12, height=0.025)
    chips(p, m['bubble'], f(0.2, height, 0.0), 5, 0.035, seed=13)
    build(p, 'A0_ware_marver01', (cx, height, cz))


#: 徐冷炉の横の台車（S-27）: 徐冷炉の枠での位置（a = 中心へ、s = 右）、長さ（s に沿う）・奥行き、2 段の高さ
ANNEAL_CART = {'a': 0.06, 's': 1.12, 'size': (0.62, 0.36), 'shelves': (0.22, 0.62)}


def cart_frame(at_s: float, at_a: float):
    cx, cz = ANNEALER['center']
    f = Frame(cx, cz)
    return f, (lambda a, y, s: f(at_a + a, y, at_s + s))


def anneal_cart(m) -> None:
    """徐冷炉の横の台車: 真鍮の枠に曇りガラスの 2 段の板、小さな車輪、押し手。徐冷炉へ入れる順を待つ作品を載せる"""
    f, at = cart_frame(ANNEAL_CART['s'], ANNEAL_CART['a'])
    length, depth = ANNEAL_CART['size']
    low, top = ANNEAL_CART['shelves']
    p = Part()
    for y in (low, top):
        p.merge(rounded_box_bm((length, 0.025, depth), 0.01, 2), m['frost'], place(at(0.0, y, 0.0), f.yaw))
    hs, ha = length / 2 - 0.03, depth / 2 - 0.03
    for sa in (-1, 1):
        for ss in (-1, 1):
            p.merge(tube_bm([at(sa * ha, FLOOR_TOP + 0.06, ss * hs), at(sa * ha, top + 0.07, ss * hs)], 0.013, 8),
                    m['brass'])
            wheel = circle(at(sa * ha, FLOOR_TOP + 0.035, ss * hs), 0.026, 12, axis=(f.f[0], 0.0, f.f[1]))
            p.merge(tube_bm(wheel, 0.009, 4, closed=True), m['brass'])
    rim = fillet([at(-ha, top + 0.045, -hs), at(-ha, top + 0.045, hs), at(ha, top + 0.045, hs),
                  at(ha, top + 0.045, -hs)], 0.05, 3, closed=True)
    p.merge(tube_bm(rim, 0.008, 5, closed=True), m['brass'])
    # 押し手: 右の端の上に渡した横棒（柱の頭の上）
    p.merge(tube_bm([at(-ha, top + 0.2, hs + 0.04), at(ha, top + 0.2, hs + 0.04)], 0.012, 8), m['brass'])
    for sa in (-1, 1):
        p.merge(tube_bm([at(sa * ha, top + 0.06, hs), at(sa * ha, top + 0.2, hs + 0.04)], 0.011, 8), m['brass'])
    origin = at(0.0, 0.0, 0.0)
    build(p, 'A0_cart_anneal01', origin, col=True)


#: 台車の上の段で作品を立てる受け輪の位置（s）
CART_STANDS = (0.13, 0.25)


def anneal_tools(m) -> None:
    """台車の上の道具: 長いトング、作品を徐冷炉へ運ぶ平らなへら、作品を立てる真鍮の受け輪 2 つ"""
    f, at = cart_frame(ANNEAL_CART['s'], ANNEAL_CART['a'])
    low, top = ANNEAL_CART['shelves']
    y = top + 0.0125
    p = Part()
    # 台車の上の段の手前の半分（s < 0）に道具、奥の半分に作品
    M = place(at(0.08, y, -0.3), f.yaw)
    for side in (-1, 1):
        arm = fillet([(0.0, 0.006, 0.0), (0.1, 0.006, side * 0.018), (0.3, 0.006, side * 0.011),
                      (0.36, 0.006, side * 0.02)], 0.05, 3)
        p.merge(tube_bm(xf(M, arm), 0.006, 8), m['brass'])
    p.merge(tube_bm(xf(M, circle((-0.008, 0.008, 0.0), 0.012, 10)), 0.005, 4, closed=True), m['brass'])
    paddle(p, m['brass'], at(-0.1, y, -0.3), f.yaw, blade=(0.15, 0.1), handle=0.12)
    for s in CART_STANDS:
        p.merge(tube_bm(circle(at(-0.07, y + 0.006, s), 0.032, 14), 0.006, 4, closed=True), m['brass'])
    build(p, 'A0_tool_anneal01', at(0.0, y, 0.0))


def annealer_wares(m) -> None:
    """冷ましている作品（透明）: 中の棚の上の 3 つ。S-27: 横の台車の上で入る順を待つ作品（透明と乳白）"""
    cx, cz = ANNEALER['center']
    f = Frame(cx, cz)
    p = Part()
    y = FLOOR_TOP + 0.23
    bowl = [(0.0, 0.0), (0.05, 0.0), (0.085, 0.03), (0.105, 0.075), (0.11, 0.09)]
    bottle = [(0.0, 0.0), (0.04, 0.0), (0.05, 0.02), (0.052, 0.13), (0.03, 0.17), (0.014, 0.2), (0.013, 0.26),
              (0.018, 0.27)]
    vase = [(0.0, 0.0), (0.045, 0.0), (0.07, 0.06), (0.06, 0.15), (0.035, 0.2), (0.045, 0.23)]
    for prof, (a, s), t in ((bowl, (-0.02, -0.2), 0.004), (bottle, (-0.12, 0.0), 0.004), (vase, (-0.02, 0.2), 0.005)):
        p.merge(lathe_bm(shell_profile(prof, t), 20), m['clear'], place(f(a, y, s)))
    build(p, 'A0_ware_anneal01', (cx, y, cz))


def cart_wares(m) -> None:
    """徐冷炉の横の台車の上で入る順を待つ作品（S-27）: 上の段に受け輪に立てた透明の瓶と花瓶、乳白の壺。下の段に乳白の鉢を
    2 つ重ねて、透明の鉢"""
    bowl = [(0.0, 0.0), (0.05, 0.0), (0.085, 0.03), (0.105, 0.075), (0.11, 0.09)]
    bottle = [(0.0, 0.0), (0.04, 0.0), (0.05, 0.02), (0.052, 0.13), (0.03, 0.17), (0.014, 0.2), (0.013, 0.26),
              (0.018, 0.27)]
    vase = [(0.0, 0.0), (0.045, 0.0), (0.07, 0.06), (0.06, 0.15), (0.035, 0.2), (0.045, 0.23)]
    p = Part()
    _, at = cart_frame(ANNEAL_CART['s'], ANNEAL_CART['a'])
    low, top = ANNEAL_CART['shelves']
    ty, ly = top + 0.0125, low + 0.0125
    p.merge(lathe_bm(shell_profile(bottle, 0.004), 18), m['clear'], place(at(-0.07, ty + 0.006, CART_STANDS[0])))
    p.merge(lathe_bm(shell_profile(vase, 0.005), 18), m['clear'], place(at(-0.07, ty + 0.006, CART_STANDS[1])))
    jar = shell_profile([(0.0, 0.0), (0.05, 0.0), (0.066, 0.03), (0.07, 0.1), (0.05, 0.15), (0.052, 0.16)], 0.005)
    p.merge(lathe_bm(jar, 18), m['opal'], place(at(0.09, ty, 0.22)))
    obowl = shell_profile([(0.0, 0.0), (0.055, 0.0), (0.09, 0.03), (0.11, 0.07), (0.115, 0.08)], 0.005)
    for i in range(2):
        p.merge(lathe_bm(obowl, 18), m['opal'], place(at(0.0, ly + i * 0.025, -0.12)))
    p.merge(lathe_bm(shell_profile(bowl, 0.004), 18), m['clear'], place(at(0.02, ly, 0.16)))
    build(p, 'A0_ware_cart01', at(0.0, ty, 0.0))


# ── 作品の棚 ────────────────────────────────────────────────────────────────
def shelf(m) -> None:
    """作品の棚: 左の壁から奥へ、壁に沿う弧の三段。段は傾く壁に沿って上ほど内へ（形のルール: 曲面と真鍮の枠）"""
    a0, a1 = SHELF['from_deg'], SHELF['to_deg']
    depth = SHELF['depth']
    p = Part()
    thick, corner = 0.035, 0.012
    plank = []
    # tube_bm の断面は (u = 枠の n、v = 枠の b)。水平な弧では n = 上、b = 内向きの半径
    for (u, v), (cu, cv) in (((thick / 2, depth / 2), (-1, -1)), ((-thick / 2, depth / 2), (1, -1)),
                             ((-thick / 2, -depth / 2), (1, 1)), ((thick / 2, -depth / 2), (-1, 1))):
        for k in range(3):
            t = math.pi / 2 * k / 2
            plank.append((u + cu * corner * (1 - math.cos(t)), v + cv * corner * (1 - math.sin(t))))
    plank = sorted(plank, key=lambda q: math.atan2(q[1], q[0]))  # 反時計回り（面が外を向く）
    for y in SHELF['tiers']:
        front = shelf_front(y)
        mid = front + depth / 2
        p.merge(tube_bm(arc(mid, y, a0, a1), 1.0, profile=plank), m['frost'])
        p.merge(tube_bm(arc(front - 0.006, y + thick / 2 + 0.006, a0, a1), 0.01, 6), m['brass'])
    top = SHELF['tiers'][-1] + 0.1
    for deg in (a0 + 1.0, (a0 + a1) / 2, a1 - 1.0):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        for r0, r1 in ((shelf_front(0.0) - 0.01, shelf_front(top) - 0.01),
                       (shelf_front(0.0) + depth - 0.02, shelf_front(top) + depth - 0.02)):
            p.merge(tube_bm([(r0 * c, FLOOR_TOP, r0 * s), (r1 * c, top, r1 * s)], 0.016, 8), m['brass'])
    mid_deg = math.radians((a0 + a1) / 2)
    r = shelf_front(SHELF['tiers'][0]) + depth / 2
    build(p, 'A0_shlf_works01', (r * math.cos(mid_deg), 0.0, r * math.sin(mid_deg)), col=True, arcs=True)


#: 棚の作品: (段, 方位の度, 形, 材質)。瓶・器・ビードロ（ぽぺん形と丸い玉）。S-27: 透明だけでは空を背にして消えるので、気泡入り・
#: 曇り・乳白（光らないオパール。乳白ガラスの印は灯りの器で、内側から光る）を混ぜ、透明の作品は乳白や気泡入りの間に置く
SHELF_ITEMS = [
    (0, 118.5, 'jar', 'frosted'), (0, 124.0, 'bowl', 'clear'), (0, 129.5, 'vase', 'opal'),
    (0, 135.5, 'bottle', 'clear'), (0, 141.0, 'vidro', 'bubble'), (0, 147.0, 'jar', 'opal'),
    (0, 152.5, 'flask', 'clear'), (0, 158.5, 'vase', 'frosted'), (0, 162.5, 'cup', 'frosted'),
    (1, 118.0, 'bottle', 'clear'), (1, 122.5, 'poppen', 'bubble'), (1, 127.5, 'bowl', 'opal'),
    (1, 133.0, 'flask', 'clear'), (1, 138.5, 'cup', 'frosted'), (1, 143.5, 'vidro', 'bubble'),
    (1, 148.5, 'bottle', 'opal'), (1, 154.0, 'bowl', 'clear'), (1, 159.5, 'poppen', 'bubble'),
    (2, 119.0, 'vidro', 'bubble'), (2, 125.0, 'jar', 'opal'), (2, 131.0, 'bottle', 'clear'),
    (2, 137.0, 'poppen', 'bubble'), (2, 143.5, 'flask', 'clear'), (2, 150.0, 'vase', 'opal'),
    (2, 156.0, 'vidro', 'bubble'), (2, 161.5, 'cup', 'frosted'),
]
#: 棚の作品の大きさ（S-24 の輪郭に掛ける。4m 先から形が読めるように）
SHELF_WARE_SCALE = 1.35
SHAPES = {
    'jar': [(0.0, 0.0), (0.05, 0.0), (0.062, 0.02), (0.065, 0.11), (0.05, 0.14), (0.045, 0.16), (0.05, 0.17)],
    'bowl': [(0.0, 0.0), (0.04, 0.0), (0.075, 0.025), (0.095, 0.06), (0.1, 0.075)],
    'vase': [(0.0, 0.0), (0.045, 0.0), (0.07, 0.06), (0.058, 0.17), (0.035, 0.24), (0.045, 0.27)],
    'bottle': [(0.0, 0.0), (0.035, 0.0), (0.042, 0.015), (0.043, 0.13), (0.028, 0.17), (0.012, 0.19), (0.011, 0.25),
               (0.015, 0.26)],
    'flask': [(0.0, 0.0), (0.05, 0.005), (0.07, 0.05), (0.06, 0.1), (0.02, 0.14), (0.016, 0.22), (0.022, 0.23)],
    'cup': [(0.0, 0.0), (0.032, 0.0), (0.04, 0.01), (0.045, 0.07), (0.047, 0.085)],
    'poppen': [(0.0, 0.0), (0.035, 0.005), (0.058, 0.03), (0.062, 0.05), (0.055, 0.075), (0.03, 0.095),
               (0.007, 0.105), (0.006, 0.25), (0.008, 0.26)],
}


def scaled(profile, k: float):
    return [(r * k, y * k) for r, y in profile]


def shelf_wares(m) -> None:
    """棚の瓶・器・ビードロ。材質ごとに 1 つの物にまとめる（描画の呼び出しを減らす。1 つは 500〜3000 三角形）"""
    parts = {'clear': Part(), 'bubble': Part(), 'frosted': Part(), 'opal': Part()}
    seed = 40
    k = SHELF_WARE_SCALE
    for tier, deg, shape, kind in SHELF_ITEMS:
        y = SHELF['tiers'][tier] + 0.035 / 2
        r = shelf_front(SHELF['tiers'][tier]) + SHELF['depth'] / 2 + 0.02
        at = (r * math.cos(math.radians(deg)), y, r * math.sin(math.radians(deg)))
        part = parts[kind]
        if shape == 'vidro':
            ball = 0.05 * k
            part.merge(sphere_bm(ball, 12, 8), m['bubble'], place((at[0], y + 0.012 + ball * 0.92, at[2])))
            part.merge(tube_bm(circle((at[0], y + 0.008, at[2]), ball * 0.6, 12), 0.005, 4, closed=True), m['brass'])
            air_bubbles(part, m['air'], (at[0], y + 0.012 + ball * 0.92, at[2]), ball * 0.7, 5, seed=seed)
        elif shape == 'poppen':
            part.merge(lathe_bm(scaled(SHAPES[shape], k), 16), m['bubble'], place((at[0], y + 0.01, at[2])))
            part.merge(tube_bm(circle((at[0], y + 0.008, at[2]), 0.036 * k, 12), 0.005, 4, closed=True), m['brass'])
            air_bubbles(part, m['air'], (at[0], y + 0.06 * k, at[2]), 0.035 * k, 4, seed=seed, height=0.02)
        elif kind in ('opal', 'clear', 'frosted'):
            # 二重の壁（S-27）: 乳白は不透明なので内が抜けて見えないように、透明と曇りは内と外の 2 つの縁が見えるように
            segments = 15 if kind == 'clear' else 16  # 透明の作品 8 点で 3,000 三角形の内
            part.merge(lathe_bm(shell_profile(scaled(SHAPES[shape], k), 0.005), segments), m[kind], place(at))
        else:
            part.merge(lathe_bm(scaled(SHAPES[shape], k), 16), m[kind], place(at))
            if kind == 'bubble':
                air_bubbles(part, m['air'], (at[0], y + 0.1, at[2]), 0.04, 6, seed=seed, height=0.08)
        seed += 1
    mid = math.radians((SHELF['from_deg'] + SHELF['to_deg']) / 2)
    r = shelf_front(SHELF['tiers'][0]) + SHELF['depth'] / 2
    origin = (r * math.cos(mid), SHELF['tiers'][0], r * math.sin(mid))
    build(parts['clear'], 'A0_ware_clear01', origin)
    build(parts['bubble'], 'A0_ware_bubble01', origin)
    build(parts['frosted'], 'A0_ware_frost01', origin)
    build(parts['opal'], 'A0_ware_opal01', origin)


#: 棚の背板（S-27）: 壁のガラスからの隙間、厚み、下と上の縁の高さ、四隅の丸みの半径（m）
SHELF_BOARD = {'gap': 0.008, 'thick': 0.02, 'from_y': 0.3, 'to_y': SHELF['tiers'][-1] + 0.44, 'corner': 0.14}


def shelf_board(m) -> None:
    """作品の棚の背板（S-27）: 段の後ろで傾く壁に沿う、暗い不透明の板（A0_shade）。透過のガラスは不透明な物しか屈折しないので、
    透明の作品はこの面を背にして縁と屈折が読める。形のルール: 四隅は大きく丸め（半径 0.14m）、縁は一周を真鍮の枠で包む（直線と細い線は
    真鍮の枠だけ）。棚が空に見えないように"""
    a0, a1 = SHELF['from_deg'] - 1.5, SHELF['to_deg'] + 1.5
    gap, t, corner = SHELF_BOARD['gap'], SHELF_BOARD['thick'], SHELF_BOARD['corner']
    y0, y1 = SHELF_BOARD['from_y'], SHELF_BOARD['to_y']
    # 行（高さ）: 丸めた隅のところは細かく
    edge = [corner * (1 - math.cos(math.pi / 2 * k / 4)) for k in range(5)]
    inner_rows = [y0 + corner + (y1 - y0 - 2 * corner) * k / 7 for k in range(1, 7)]
    rows = sorted({round(y0 + e, 6) for e in edge} | {round(y1 - e, 6) for e in edge} | {round(y, 6) for y in inner_rows})

    def inset_deg(y: float) -> float:
        """隅の丸み: 上と下の縁から corner の内では、端を弧に沿って内へ寄せる（m を方位の度へ）"""
        d = min(y - y0, y1 - y)
        if d >= corner:
            return 0.0
        metres = corner - math.sqrt(max(0.0, corner * corner - (corner - d) ** 2))
        return math.degrees(metres / (wall_r(y) - gap - t / 2))

    cols = max(2, round((a1 - a0) / 2.5))

    def point(y: float, u: float, w: float) -> tuple[float, float, float]:
        """高さ y、端から端への割合 u、壁からの距離 w"""
        lo, hi = a0 + inset_deg(y), a1 - inset_deg(y)
        a = math.radians(lo + (hi - lo) * u)
        r = wall_r(y) - w
        return (r * math.cos(a), y, r * math.sin(a))

    bm = bmesh.new()
    faces_w = {'room': gap + t, 'wall': gap}
    grid = {side: [[bm.verts.new(point(y, i / cols, w)) for i in range(cols + 1)] for y in rows]
            for side, w in faces_w.items()}
    for side in grid:
        g = grid[side]
        for j in range(len(rows) - 1):
            for i in range(cols):
                bm.faces.new((g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]))
    # 縁（厚み）の帯: 外周を一周（下の行 → 右の列 → 上の行 → 左の列）
    loop = ([(0, i) for i in range(cols + 1)] + [(j, cols) for j in range(1, len(rows))]
            + [(len(rows) - 1, i) for i in range(cols - 1, -1, -1)] + [(j, 0) for j in range(len(rows) - 2, 0, -1)])
    for (ja, ia), (jb, ib) in zip(loop, loop[1:] + loop[:1]):
        bm.faces.new((grid['room'][ja][ia], grid['room'][jb][ib], grid['wall'][jb][ib], grid['wall'][ja][ia]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    p = Part()
    p.merge(bm, m['shade'])
    p.uv_rules['A0_shade'] = lambda co: (abs(((co.x + co.z) * 0.9) % 2.0 - 1.0), (co.y - y0) / (y1 - y0))
    # 真鍮の枠: 外周を一周、板の厚みの真ん中（管の太さが板の厚みより太く、縁を包む）
    frame = [point(rows[j], i / cols, gap + t / 2) for j, i in loop]
    p.merge(tube_bm(frame, t / 2 + 0.004, 5, closed=True), m['brass'])
    # 当たり判定: 8 度ずつと、高さで 3 つの帯に分けて包む（背板は球の壁に沿って縦にも曲がるので、高さごと包むと膨らみが部屋の側へ
    # 見えない壁になる）
    edges = [y0 - 0.02, y0 + (y1 - y0) / 3, y0 + 2 * (y1 - y0) / 3, y1 + 0.05]
    hull = bmesh.new()
    pts = [v.co.copy() for v in p.bm.verts]
    for lo, hi in zip(edges, edges[1:]):
        band = [q for q in pts if lo - 0.03 <= q.y <= hi + 0.03]
        for g in angular_slices(band):
            hull_into(hull, g)
    mid = math.radians((a0 + a1) / 2)
    r = wall_r(1.0) - gap - t / 2
    build(p, 'A0_shlf_board01', (r * math.cos(mid), 0.0, r * math.sin(mid)), hull=hull)


# ── 風鈴 ────────────────────────────────────────────────────────────────────
def wind_chime(m) -> None:
    """扉の上の風鈴（江戸風鈴の形）: 透明ガラスの鈴、ガラスの舌、曇りガラスの短冊、扉の枠から出た真鍮の吊り金具"""
    x, y, z = WIND_CHIME
    p = Part()
    top = y + 0.035
    hook = wall_r(DOOR['height'] + 0.02) - 0.02
    p.merge(tube_bm(fillet([(x, DOOR['height'] + 0.02, -hook), (x, y + 0.16, z - 0.12), (x, y + 0.14, z)], 0.06, 5),
                    0.007, 6), m['brass'])
    p.merge(tube_bm([(x, y + 0.14, z), (x, top, z)], 0.0025, 4), m['brass'])
    bell = [(0.04, 0.0), (0.0415, 0.012), (0.04, 0.03), (0.034, 0.048), (0.023, 0.062), (0.009, 0.069), (0.0, 0.07)]
    p.merge(lathe_bm(shell_profile(bell, 0.0025), 20), m['clear'], place((x, y - 0.035, z)))
    p.merge(tube_bm([(x, top, z), (x, y - 0.075, z)], 0.0012, 4), m['brass'])
    p.merge(ico_bm(0.006), m['clear'], place((x, y - 0.03, z)))
    p.merge(rounded_box_bm((0.045, 0.11, 0.003), 0.0012, 1), m['frosted'], place((x, y - 0.13, z)))
    build(p, 'A0_chim_door01', (x, y, z))


# ── 確かめ用（書き出さない） ─────────────────────────────────────────────────
def reference(collection) -> None:
    """床の円盤とドーム（ゲームはコードで描く）。見るためだけ。ビューレイヤーから外して書き出さない"""
    floor = lathe_bm([(0.0, -0.2), (FLOOR_R + 0.05, -0.2), (FLOOR_R + 0.05, FLOOR_TOP), (0.0, FLOOR_TOP)], 72)
    dome = []
    theta0 = math.asin(OCULUS / DOME_R)
    theta1 = math.acos(-DOME_CY / DOME_R)
    for k in range(17):
        t = theta1 + (theta0 - theta1) * k / 16
        dome.append((DOME_R * math.sin(t), DOME_CY + DOME_R * math.cos(t)))
    shell = lathe_bm(dome, 72)
    for name, bm, color in (('ref_floor', floor, (0.4, 0.44, 0.5, 1)), ('ref_dome', shell, (0.7, 0.8, 0.85, 1))):
        for v in bm.verts:
            v.co = ROT @ v.co
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = color
        me.materials.append(mat)
        link(bpy.data.objects.new(name, me), collection)


def preview_cameras() -> dict:
    cams = {}
    for name, (feet, yaw, pitch) in VIEWS.items():
        if name == 'furnace':
            cx, cz = FURNACE['center']
            feet = (cx + FACING[0] * 2.55, cz + FACING[1] * 2.55)
            yaw = math.atan2(FACING[0], FACING[1])
        cam = bpy.data.cameras.new(f'view_{name}')
        cam.sensor_fit = 'VERTICAL'
        cam.angle_y = math.radians(70)  # 操作とカメラ > カメラ: 視野角70度
        cam.clip_start = 0.05
        o = link(bpy.data.objects.new(f'view_{name}', cam))
        o.location = B((feet[0], EYE, feet[1]))
        look = Vector((-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)))
        o.rotation_euler = (ROT @ look).to_track_quat('-Z', 'Y').to_euler()
        cams[name] = o
    cam = bpy.data.cameras.new('view_top')
    cam.type = 'ORTHO'
    cam.ortho_scale = 10.0
    top = link(bpy.data.objects.new('view_top', cam))
    top.location = (0.0, 0.0, 12.0)
    cams['top'] = top
    return cams


def render_previews(out_dir: str, cams: dict, ref_layer) -> None:
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_cavity = True
    scene.display.shading.show_backface_culling = True
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.image_settings.file_format = 'PNG'
    ref_layer.exclude = False
    os.makedirs(out_dir, exist_ok=True)
    dome = bpy.data.objects['ref_dome']
    for name, cam in cams.items():
        scene.camera = cam
        dome.hide_render = name == 'top'
        scene.render.filepath = os.path.join(out_dir, f'{name}.png')
        bpy.ops.render.render(write_still=True)
    dome.hide_render = False
    ref_layer.exclude = True


PIECES = (bench, bench_wares, tea_cup, stool, furnace, grate, blowpipe_rack, marver, marver_ware, water_tub, annealer,
          annealer_wares, shelf, shelf_wares, wind_chime,
          # S-27
          shelf_board, bench_shelf_wares, bench_tools, marver_tools, pipe_bucket, anneal_cart, anneal_tools, cart_wares)


def build_all(only: list[str] | None = None) -> None:
    """only: 確かめるために一部だけ作る（関数の名前）。書き出す .blend は全部で作ること"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m = materials()
    for piece in PIECES:
        if only is None or piece.__name__ in only:
            piece(m)
    # 見るための物（書き出さない: ビューレイヤーから外す）
    ref = bpy.data.collections.new('reference')
    bpy.context.scene.collection.children.link(ref)
    reference(ref)


def main() -> None:
    args = script_args()
    out = args[args.index('--out') + 1] if '--out' in args else 'blender/scenes/workshop.blend'
    build_all(args[args.index('--only') + 1].split(',') if '--only' in args else None)
    cams = preview_cameras()
    view_layer = bpy.context.view_layer
    ref_layer = view_layer.layer_collection.children['reference']
    ref_layer.exclude = True
    if '--preview' in args:
        render_previews(os.path.abspath(args[args.index('--preview') + 1]), cams, ref_layer)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.context.scene.camera = cams['wake']
    bpy.context.preferences.filepaths.save_version = 0  # .blend1 を作らない
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
    print(f'[vidro] wrote {out}')


if __name__ == '__main__':
    main()
