# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 0.2.0 — 2026-10-21（S-05）

- `perf/governor.ts`（新規）: 品質の自動選択 → 選んだプリセットへの切り替え → 測り直し → 動的解像度、をまとめた状態機械。
  GPU のタイムスタンプが実際のフレーム時間を超えたら信用せず、フレーム時間に切り替える
- `perf/quality-select.ts`（新規）: 推奨プリセットの判定。段ごとのコスト係数（low 0.85 / mid 1 / high 1.7）、CPU 律速と
  フレームレートの上限（30fps の省電力など）の見分け
- `perf/dynamic-resolution.ts`（新規）: 動的解像度（5個の中央値＋EMA、ヒステリシス、待ち時間、効かなければ戻す、上げすぎの抑制）
- `bench.ts`: `GpuStats` と `summarizeGpuTimes` を追加
- `renderer.ts`: `trackTimestamp` を有効化。戻り値に `baseDpr` と `gpuTiming` を追加
- `params.ts`: `quality=auto`、`autoWindow`、`autoFrom`、`dynres`、`dynresTarget` を追加
- 注意（案2にも関係）: WebGPU（r186）では、画面と違う大きさの RenderTarget に transmission の材質を描くとフレームが捨てられる。
  Apple/Metal では GPU のタイムスタンプの合計が約10倍に膨らむ。影のカメラの layers は明示する

## 0.1.0 — 2026-10-21（S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）
