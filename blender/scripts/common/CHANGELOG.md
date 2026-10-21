# Blender 共通スクリプト（blender/scripts/common）の変更記録

案1「ビードロの向こう」（~/develop/through-the-vidro）と案2「泡沫回廊」（このリポジトリ）は、
同じ共通スクリプトをそれぞれのディレクトリに置いて使う。ディレクトリをまたいで参照しない。
`common` の外（previz.py・export_ride.py・render_previz.py・rooms/）を import しない。
案2固有の名前（区間、部屋の一覧、キュー）を持ち込まない。必要なら引数で受け取る。
変更したら VERSION とこの記録を更新し、相手のリポジトリへコピーして揃える（src/core と同じ。ADR-0005）。

版の付け方: 互換を壊す変更は minor を上げる（0.x の間）。追加・修正は patch。

## 0.2.2（案。版は統合のときに親が決める） — 2026-10-21（ビードロの向こう、S-23）

案1が初めて common を受け取った版。泡沫回廊の 0.2.1（コミット 4ee11d1 の `blender/scripts/common`）をそのまま写し、追加だけをした
（既存の関数の振る舞いは変えていない）。**泡沫回廊へ写し戻すまで、両方の 0.2.x は中身が違う**。

- export: `export_glb(..., check=None)`。名前の検査を差し替えられる（物の一覧 → 規則に合わない名前の一覧）。既定（None）は今まで
  どおり `check_names(objs, rooms)`（True も同じ）。案1は書き出しの前に自分の規則（`vidro/naming.py`）で検査を済ませるので `check=False` で切る。
  案1は画像を glb に埋め込む（`options={'export_image_format': 'AUTO'}`。gltf-transform が KTX2 にするため）
- uv（新規）: `ensure_lightmap_uv(objects, repack=False, island_margin=0.02)`。焼き込みと同じ名前 `Lightmap`（`bake.UV_NAME`）の UV を
  2つ目（glb の TEXCOORD_1）に作る。UV が2つ以上ある物はそのまま、UV のない物には先に1つ目（UVMap）を作る。物ごとに 0〜1 へ
  smart project ＋ pack islands。終わったら編集用と描画用の UV を1つ目に戻す。`uv_area(obj, name)`（確かめるため）
- stats（新規）: `triangle_count(obj, depsgraph=None)`。モディファイアを適用した後の三角形の数（`export_apply=True` で書き出される形）。
  `GEOMETRY_TYPES`（書き出しでメッシュになる種類）
- 単体テストは案1の `blender/scripts/tests/test_common_blender.py`（Blender の中で走る。`pnpm assets:test`）

## 0.2.1 — 2026-10-21（泡沫回廊、S-17 レビュー2巡目）

- bake: 正規化の百分位の既定を 99.5 から **99.99** に上げ、引数 `percentile=` にした。99.5 だとアトラスの 0.5% より小さい明るい所（床の 0.35% の日だまりなど）が 1.0 で切れて平らになった（512px・128spp で日だまりの明るさが 21.5% しか残らなかった。99.99 で 99%）。周りの 8 テクセルの最大の 4 倍を超える 1 テクセルだけの突起（ノイズ）は百分位に数えない。
- bake: 切れた画素の割合（`clipped_frac`）と max/scale（`max_over_scale`）を戻り値とログに出し、max/scale > 1.5 かつ切れた画素 > 0.05% なら WARNING。README の「飽和しない」を「全体が白く飽和することはない。小さな明るい所は切れる」に直した。
- bake: 計算を float32 で、符号化を 256 行ごとにして、メモリを抑えた（4096px の保存の最大メモリが約 3.4GB から約 1.2GB に）。
- export: `room_load_report(objects, glb_path, lightmap_dir)` を追加。glb と、`lightmap` が指す PNG の合計を部屋の読み込みの上限と比べる（超えたら WARNING）。

## 0.2.0 — 2026-10-21（泡沫回廊、S-17 レビュー1巡目）

互換を変える変更を含むので minor を上げる。

- bake: ライトマップを **8bit の sRGB PNG（RGB）** で書く（以前は 16bit で容量が約 4 倍だった）。float で焼いて明るい側の 99.5 百分位で割り、倍率を物のカスタムプロパティ `lightmap_scale` に残す（強い光でも飽和しない）。書いた後に 8bit を確かめる。戻り値に `scale`。
- bake: メッシュを共有する物があると止まる（以前は黙って単独のコピーにした）。`split_shared=True` で許す。
- bake: `name` の既定は物の名前の `<部屋>` から作る（`<部屋>.lightmap`）。環境変数は `BLENDER_BAKE_DEVICE`（以前は `UTAKATA_BAKE_DEVICE`）。
- visibility: 光線を通す物の既定を `default_see_through`（`see_through` があればその値、なければ `glass` を持つ物）にした。判定の関数は `see_through=` で差し替えられる。
- export: `MAX_BYTES` は 10進の 15MB（`15 * 1000 * 1000`。以前は 2進）。

## 0.1.0 — 2026-10-21（泡沫回廊）

- 初版。
- coords: three.js（Y が上、-Z が前）と Blender（Z が上、+Y が前）の座標の変換。
- cli: `--` の後ろの引数を取り出す。
- naming: `check_names`。小文字の `<部屋>.<部品>[.<番号>]` に合わない名前の一覧。部屋の一覧は引数で受け取る。
- export: `export_glb`。カスタムプロパティを extras へ、Y が上、画像を埋め込まない、カメラ・ライト・アニメーションは書かない、サイズの上限の検査。
- visibility: `cull_hidden`。レール上の地点（と頭の動く範囲）から見回せる範囲に光線を飛ばし、一度も当たらない面を消す。
- bake: `bake_lightmaps`。Cycles の DIFFUSE（DIRECT+INDIRECT）を 2つ目の UV（Lightmap）へ焼き、PNG と物のカスタムプロパティ `lightmap` に残す。
