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

## 未リリース（S-10）

- S-10 で調べた結果、r186 では透過の背景画像を縮小して写せず、読み出し側の近似（低いミップから読む）は効果が小さいので採らない
  （姉妹作も同じ）。0.3.0 の既知の制約「`transmissionScale` は効かない」はそのまま有効。`quality.ts` はコメントだけ足した。

## 0.3.0 — 2026-10-21（M0 統合: S-01 ガラス材質、S-04 遷移）

### S-01 ガラス材質

- `glass/` を追加（ガラス材質ライブラリ）。`import { … } from '../core/glass'` で使う
  - `kinds.ts`: ガラスの種類（透明・曇り・琥珀・瑠璃・翡翠・気泡入り・虹色・乳白）の数値。屈折率1.5、透明の粗さ0、曇りの粗さ0.45（範囲0.4〜0.6）。
    設計書にない値（色ガラスの吸収色と距離、分散の強さ、薄膜の厚みなど）は「仮」と注記
  - `policy.ts`: 描画の経路（透過 / 遠景の安価な表現 / 不透明）と、分散・薄膜干渉の有効無効を、置き場所
    （near / far / behind-glass）・役割（scenery / orb / drop / showcase）・品質プリセットから決める純粋関数。
    behind-glass は品質に関係なく安価な表現（設計の対策1「重なる場所は遠景側を安価な表現に切り替える」）
  - `materials.ts`: `createGlass(kind, preset, options)` → `{ material, features }`。近景は MeshPhysicalNodeMaterial の透過。
    厚みは `thicknessMap`（glTF の厚みテクスチャ、G）か、なければ場所ごとのムラ（ノイズ）に、視線の角度の係数を掛ける
    （殻は縁ほど厚く＝縁が緑、塊は縁ほど薄い）。遠景は透過なしの半透明（フレネル＋環境の反射＋自前の線形の霞、`fog: false`。
    霞はシーンの Fog と同じ値を渡す）。乳白は不透明＋内側からの発光。虹色の安価な代わりは、近景では反射の色づけ、
    遠景では縁（フレネル）に寄せた色で、どちらも光らない。発光は役割 drop（光の雫）だけ。ほかに `createFrostedFloorMaterial`（不透明の曇りガラスの床＋真鍮の目地、遠くでは目地を薄める）、
    `createBrassMaterial`、`createInnerBubbleMaterial`
  - `optics.ts`: フレネル（Schlick、正面4%）、吸収（Beer–Lambert）、視線の角度による光路の係数 `viewPathFactor` の純粋関数
  - `fused-bubbles.ts`: 泡が溶け合った形（球のなめらかな和集合を中心から光線で包む）、その境界球 `fusedBubbleSilhouette`、
    気泡入りガラスの内部の泡の配置（種つき）
  - `meshes.ts`: 上の形の three.js 化（BufferGeometry、表面に沿った線＝真鍮の枠の芯、内部の泡の InstancedMesh）
  - `overlap.ts`: 「透過ガラスの奥に透過ガラス」が画面上で重なる組を見つけるセンサー（境界球を視線からの円錐として比べる）

既知の制約（three r186。姉妹作でも同じ）:

- 透過の背景画像は1回の描画につき1度、最初の透過物の直前に写される。奥の透過物は映らないので、床・内部の泡・乳白は不透明で描く。
  半透明の合成で描く遠景の安価なガラスは、奥から順に描かれて透過物より先に載るため、近景の透過越しにも見える
- 品質プリセットの `transmissionScale` は効かない（背景画像は描画バッファと同じ大きさで写される）
- 曇りのぼかしは画面上で一様（ミップの段数 = log2(幅) × 粗さ）。ガラスのすぐ後ろの小さな物も消える

### S-04 遷移

- `transition/curve.ts`（新規）: 全遷移で共通の動きの曲線 `glassEase`（ゆっくり始まり、粘りながら止まる。
  `cubic-bezier(0.55, 0, 0.2, 1)`、行き過ぎなし）。同じ曲線を DOM 用に `GLASS_EASE_CSS` として出す。
  任意の制御点の `cubicBezier(x1, y1, x2, y2)` と、曲線上の位置からその時刻を求める `glassEaseInverse(y)` も公開。
- `transition/transition.ts`（新規）: 遷移1本の進行 `Transition`（線形の `progress` と曲線上の `value`、
  `reverse()` で同じ動きを逆再生、`holdAt` + `isReady` で次の場面の準備が間に合わないとき途中の姿勢で待つ、
  `startAtEnd` で終点から戻る）。`acceptsEscape(spec)`（0.5秒を超える遷移は Esc を受け付ける）、
  部分区間を 0..1 に写す `segment(p, from, to)`。
- `transition/index.ts`: 上の再輸出。
- 既存のファイルは変更なし。案2へは `src/core/transition/` をそのままコピーすればよい（three への依存なし）。

## 0.2.0 — 2026-10-21（S-05）

- `perf/governor.ts`（新規）: 品質の自動選択 → 選んだプリセットへの切り替え → 測り直し → 動的解像度、をまとめた状態機械。
  GPU のタイムスタンプは Apple/Metal では判断に使わず、それ以外でも平均フレーム時間を超えたら信用しない。そのとき動的解像度は止め、
  品質の検証はフレーム時間（取りこぼしとジッタ）で行う。シーンの作り直しが失敗したら前のプリセットへ戻す（`sceneFailed`）
- `perf/quality-select.ts`（新規）: 推奨プリセットの判定。段ごとのコスト係数（low 0.85 / mid 1 / high 1.7）、CPU 律速と
  フレームレートの上限（30fps の省電力など）の見分け
- `perf/dynamic-resolution.ts`（新規）: GPU 時間による動的解像度（5個の中央値＋EMA、ヒステリシス、待ち時間、上げすぎの抑制と、
  落ち着いたらその抑制を戻す）
- `bench.ts`: `GpuStats` と `summarizeGpuTimes` を追加
- `renderer.ts`: `trackTimestamp` を有効化。戻り値に `baseDpr`、`gpuName`、`gpuTiming`、`gpuTimingTrusted`（Apple/Metal は false）を追加
- `params.ts`: `quality=auto`、`autoWindow`、`autoFrom`、`autoForce`、`dynres`、`dynresTarget`、`gpuTrust` を追加
- 注意（案2にも関係）: WebGPU（r186）では、画面と違う大きさの RenderTarget に transmission の材質を描くとフレームが捨てられる。
  Apple/Metal では GPU のタイムスタンプの合計が約10倍に膨らむ。影のカメラの layers は明示する

## 0.1.0 — 2026-10-21（S-00）

- `renderer.ts`: WebGPURenderer の生成（WebGL2 への自動切替、AgX、sRGB、描画解像度の倍率）
- `quality.ts`: 品質プリセット 低・中・高（設計書「品質プリセット」の表）
- `bench.ts`: フレーム時間の統計（平均・p50/p95/p99・最大）と描画予算の判定
- `params.ts`: URL スイッチ（scene / bench / warmup / quality / webgl / stats）
- `scene.ts`: 検証用シーンの契約（SceneFactory / SandboxScene / SceneContext）
