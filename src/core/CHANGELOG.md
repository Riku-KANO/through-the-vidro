# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 未リリース（S-09）

版は統合時に親が付ける（`src/core/VERSION` は変えていない）。すべて Web Audio API だけで作り、依存パッケージは足していない。
`src/core/audio/` は**音の仕組みと型だけ**を持ち、ゲーム固有の規則も調整値も持たない。音階・大きさ→音程の規則・部屋・ガラスの鳴り方・
ぽぺんの音型と声の付け方・音量の初期値・残響への送りは、すべて呼び出し側が引数で渡す（ビードロの向こうでは `src/audio/` にある。
泡沫回廊は自分の値を渡して使う）。core に残る定数は仕組みのもの（なめらかさ、再開の猶予、フェードの長さ、薄い殻のモード比など）だけ。

- `audio/scale.ts`: 音階の計算（平均律 A4=440Hz、`Scale` 型と検証つきの `makeScale`、`MAJOR_PENTATONIC` の音程、最寄りの音への吸着、
  音階の度数での移動）と、大きさから音程を選ぶ規則 `pitchForSize(size, rule)`（f ∝ 1/大きさ、範囲に収めて必ず音階の音）。
  有限でない入力・0 以下の大きさ・空の音階は RangeError、探索は1オクターブ（12回）で打ち切る
- `audio/mix.ts`: 音量の4系統（全体 / 音楽 / 効果音 / 環境音）と、スライダー位置→ゲインの曲線（2乗）
- `audio/engine.ts`: `AudioEngine.create({ room, volumes?, reverbSend?, maxVoices?, maxVoicesPerEmitter?, context? })`
  - `room` は必須、`volumes`・`reverbSend` は省略時 1（中立）
  - 自分で作った AudioContext は作成時に止め、最初のユーザー操作（pointerdown / pointerup / click / keydown / touchend）で開始、中断後の操作で再開。
    `resume()` を頼むかは純粋関数 `mayRequestResume`（ユーザー操作の最中でなければ頼まない。Chrome では保留のまま残るため）
  - `context` に既存のコンテキスト（OfflineAudioContext も可）を渡せる。その場合は suspend も close もしない。オフラインなら unlock 不要
  - バス → 全体 → リミッター、各バスから残響への送り、HRTF の `Emitter`（PannerNode → フェード用ゲイン → バス）、聞き手の姿勢
  - `startVoice`: 受け付け（走っている / オフライン / unlock 直後 0.25 秒のみ）と、上限（全体・Emitter ごと）で最も小さい音を横取り。
    奪う音は新しい音と同じ時刻（`now()`）から今の値で連続に絞る
  - `Emitter.dispose` は 15ms で絞って切り離し、その Emitter の声を発音の管理から外す（`releaseGroup`）
  - `fadeOutAll(at)`: 全体を連続に絞る。`dispose` は鳴っている途中なら約20ms 絞ってから切り離す。自分で作ったコンテキストだけ close
- `audio/voices.ts`: 発音の受け付け・横取り・Emitter ごとの解放の判定（純粋なクラス `VoiceAllocator`）、`mayRequestResume`、`ScheduledVoice` の型
- `audio/reverb.ts`: 合成インパルス応答（指数減衰するステレオのノイズ、高域が先に減衰、初期反射、プリディレイ、エネルギー正規化）と
  `RoomReverb`（部屋ごとに ConvolverNode を1つ、buffer は一度だけ、切り替えはゲインのクロスフェード、フェード後の部屋は入力から外す）。
  部屋の同一性は `roomKey`（id だけでなく全パラメータ）。部屋のプリセットは持たない（`RoomPreset` 型だけ）
- `audio/glass.ts`: ガラスの音のモード合成（Rayleigh の薄い殻の式による非整数倍の倍音 1 : 2.83 : 5.42 : 8.77、基音の対の分裂）。
  `designGlassVoice(params, rng, tuning: GlassTuning)` — 強さ3段階の表、鳴りの長さの規則、高いモードの減衰、打撃のノイズ、揺らぎの幅はすべて tuning から。
  書き出しは `ScheduledVoice`（終わる時刻と、クリックなしで止める `fadeOut`）を返す
- `audio/pop.ts`: 薄いガラスの膜がはじける音の合成。`designPops(pattern, rng, tuning: PopTuning)` — 「ぽ」「ぺん」と単独の声の付け方、揺らぎは tuning から
- `audio/play.ts`: 生演奏の補助（`playGlass(engine, strike, { tuning, ... })` / `playPops(engine, pattern, { tuning, ... })`）
- `audio/offline.ts`: OfflineAudioContext での書き出し（build は非同期でもよく、描画中は組んだグラフへの参照を保持する）
- `audio/analysis.ts`: 書き出した音の計測（RMS、ピーク、FFT による基音推定、Schroeder 積分による T60、スペクトル重心、相関）
- 注意（Chrome）: JS から参照の切れた経路は、音源が鳴り終わった後の GC で切り離され、残響の尾が途中で切れることがある。
  尾を持つ経路全体（ConvolverNode とその下流）は鳴り終わるまで JS から参照すること（`AudioEngine` と `renderOffline` は保持している）

## 0.1.0 — 2026-10-21（S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）
