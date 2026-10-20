# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 0.1.0 — 2026-10-21（S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）

## 未リリース（S-01、版は統合時に親が付ける）

`VERSION` は S-01 の書き込み範囲の外なので上げていない。統合のときに版を決めて `VERSION` と見出しを合わせる。

- `glass/` を追加（ガラス材質ライブラリ）。`import { … } from '../core/glass'` で使う
  - `kinds.ts`: ガラスの種類（透明・曇り・琥珀・瑠璃・翡翠・気泡入り・虹色・乳白）の数値。屈折率1.5、透明の粗さ0、曇りの粗さ0.5（0.4〜0.6）。
    設計書にない値（色ガラスの吸収色と距離、分散の強さ、薄膜の厚み）は「仮」と注記
  - `policy.ts`: 描画の経路（透過 / 遠景の安価な表現 / 不透明）と、分散・薄膜干渉の有効無効を、置き場所（near/far）・役割
    （scenery/orb/drop/showcase）・品質プリセットから決める純粋関数
  - `materials.ts`: `createGlass(kind, preset, options)` → `{ material, features }`。近景は MeshPhysicalNodeMaterial の透過で、
    厚みに場所ごとのムラと視線の角度（殻は縁ほど厚く＝縁が緑、塊は縁ほど薄い）を入れる。遠景は透過なしの半透明
    （フレネル＋環境の反射＋自前の霞、`fog: false`）。乳白は不透明＋内側からの発光。
    ほかに `createFrostedFloorMaterial`（不透明の曇りガラスの床＋真鍮の目地）、`createBrassMaterial`、`createInnerBubbleMaterial`
  - `optics.ts`: フレネル（Schlick、正面4%）と吸収（Beer–Lambert）の純粋関数
  - `fused-bubbles.ts`: 泡が溶け合った形（球のなめらかな和集合を中心から光線で包む）と、気泡入りガラスの内部の泡の配置（種つき）
  - `meshes.ts`: 上の形の three.js 化（BufferGeometry、表面に沿った線＝真鍮の枠の芯、内部の泡の InstancedMesh）
  - `overlap.ts`: 「透過ガラスの奥に透過ガラス」が画面上で重なる組を見つけるセンサー（境界球を視線に投影）
