# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 未リリース（S-09）

版は統合時に親が付ける（`src/core/VERSION` は変えていない）。すべて Web Audio API だけで作り、依存パッケージは足していない。
`src/core/audio/` は汎用の部品だけを持ち、音階・大きさ→音程の規則・ぽぺんの音型などゲーム固有の規則は持たない
（ビードロの向こうでは `src/audio/` にある。泡沫回廊は自分の音階と規則を渡して使う）。

- `audio/scale.ts`: 音階の計算（平均律 A4=440Hz、`Scale` 型と検証つきの `makeScale`、`MAJOR_PENTATONIC` の音程、最寄りの音への吸着、
  音階の度数での移動）と、大きさから音程を選ぶ規則 `pitchForSize(size, rule)`（f ∝ 1/大きさ、範囲に収めて必ず音階の音）。
  どの関数も音階・規則を引数で受け取り、既定値を持たない。有限でない入力・0 以下の大きさ・空の音階は RangeError、探索は1オクターブ（12回）で打ち切る
- `audio/mix.ts`: 音量の4系統（全体 / 音楽 / 効果音 / 環境音）と、スライダー位置→ゲインの曲線（2乗。半分で約 -12dB）
- `audio/engine.ts`: `AudioEngine`
  - 自分で作った AudioContext は作成時に止め、最初のユーザー操作（pointerdown / pointerup / click / keydown / touchend）で開始、中断後の操作で再開。
    ユーザー操作の最中でない（`navigator.userActivation.isActive` が偽）ときは `resume()` を呼ばない（Chrome では保留のまま残るため）
  - `context` に既存のコンテキスト（OfflineAudioContext も可）を渡せる。その場合は suspend も close もしない。オフラインなら unlock 不要で、ミックス全体を書き出して測れる
  - バス（音楽/効果音/環境音）→ 全体 → リミッター、各バスから残響への送り、HRTF の `Emitter`（PannerNode → フェード用ゲイン → バス）、聞き手の姿勢
  - `startVoice`: 発音の受け付け（走っている / オフライン / unlock 直後 0.25 秒の猶予のみ）と、上限（全体 48、Emitter ごと 8）での最も小さい音の横取り（10ms で絞る）
  - 止まっている間は位置の自動化を積まずに最新値だけ保持し再開時に反映。値が変わらなければ何もしない（毎フレーム呼んでも確保なし）
  - `Emitter.dispose` は 15ms で絞ってから切り離す。`dispose` は全 Emitter・バス・残響を切り離し、自分で作ったコンテキストだけ close
- `audio/voices.ts`: 発音の受け付けと横取りの判定（純粋なクラス `VoiceAllocator`、Web Audio に依存しない）と `ScheduledVoice` の型
- `audio/reverb.ts`: 合成インパルス応答（指数減衰するステレオのノイズ、時間とともに高域が先に減衰、初期反射、プリディレイ、エネルギー正規化）と
  `RoomReverb`（部屋ごとに ConvolverNode を1つ、buffer は一度だけ設定し、切り替えはゲインのクロスフェード。フェードが終わった部屋は入力から外して CPU を使わない）。
  汎用のプリセット `smallRoom`（T60 0.6秒）/ `largeDome`（T60 4.2秒）。IR のキャッシュのキーは全パラメータ（初期反射を含む）
- `audio/glass.ts`: ガラスの音のモード合成（Rayleigh の薄い殻の式による非整数倍の倍音 1 : 2.83 : 5.42 : 8.77、基音の対の分裂によるうなり）。
  強さ3段階（触れる/叩く/玉が当たる）× 大きさ（大きいほど長く鳴る）、毎回の揺らぎ。純粋な設計関数とノードへの書き出しを分離。
  書き出しは `ScheduledVoice`（終わる時刻と、クリックなしで止める `fadeOut`）を返す
- `audio/pop.ts`: 薄いガラスの膜がはじける音の汎用の合成（`designPops` / `schedulePops`）。音程が少し高く始まって音へ落ちる正弦波＋薄い殻の倍音＋クリック。
  `pair` で1音目を控えめで短い「ぽ」、2音目を明るく尾の長い「ぺん」にする
- `audio/play.ts`: 生演奏の補助（`playGlass` / `playPops`。毎回新しい乱数の種で設計 → `startVoice` → Emitter かバスへ）
- `audio/offline.ts`: OfflineAudioContext での書き出し（センサー用・将来の焼き込み用）。build は非同期でもよく、描画中は組んだグラフへの参照を保持する
- `audio/analysis.ts`: 書き出した音の計測（RMS、ピーク、FFT による基音推定、Schroeder 積分による T60、スペクトル重心、相関）
- 注意（Chrome）: JS から参照の切れた経路は、音源が鳴り終わった後の GC で切り離され、残響の尾が途中で切れることがある。
  尾を持つ経路全体（ConvolverNode とその下流）は鳴り終わるまで JS から参照すること（`AudioEngine` と `renderOffline` は保持している）

## 0.1.0 — 2026-10-21（S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）
