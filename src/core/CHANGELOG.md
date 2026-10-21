# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 0.7.0 — 2026-10-21（S-13 動的解像度の揺れへの強さ）

版番号（`VERSION`）は統合のときに親が決める。

- `perf/dynamic-resolution.ts`:
  - 手応えの検査（`requireResponse`）は、手応えなし（3段で直近5サンプルの中央値が1割下がらない）が **2回続いてから** 止める
    （`RESPONSE_MISSES`）。以前は1回で止めていた。反応しない負荷では止まるまでに1段（シミュレーションで1〜2秒）多くかかる
  - **下限に着いたときにも1回判定する**。下限では次の段がないので、その段の列の全体（最初の段の直前から下限まで）で、3段あたり1割の
    割合で下がったかを見る。足りなければその1回で止める。止めた理由（`stoppedAtFloor`）を残す
  - `responded`: 判定のどれかが手応えありだったか（governor が「無駄だった再開」を数えるのに使う）
  - `ResumeWatch`: 止めた水準を「止めた時点の EMA・止めた時点の直近5サンプルの中央値・止めた直後15サンプルの中央値」の**真ん中**に
    した（以前は EMA と止めた直後の中央値の低い方で、揺れのある負荷では低めに偏って揺れで再開した）。再開の閾値に**揺れ幅**を入れた:
    `max(水準 × 1.3, 水準 × 揺れ, 目標の8割)`（揺れの余白 `RESUME_SWING_MARGIN` は 1.0。受け入れ条件の例は 1.1 だったが、レビュー1巡目で
    控えめな新しい重さが残るので 1.0 にした）。揺れは15サンプルの「90パーセンタイル ÷ 中央値」を、上側の四分位から対数正規として
    読んだ値（`(p75 ÷ 中央値)^(z90 ÷ z75)`。実機の span は1サンプルだけ3〜10倍に跳ねることがあり、15個に2個あれば90パーセンタイルそのものに
    なるため）で、窓の実際の「90パーセンタイル ÷ 中央値」は超えない（二つの周波数を行き来する揺れで伸びすぎないため）。止める直前と直後で
    取った小さい方を使う（直後の窓に新しい重さが入ったとき、止める前の段で負荷が下がっていたときに、片方だけが膨らむため）。
    **振る舞いの変更**: 止めた水準の 1.35〜1.45倍しか重くならない新しい重さでは、再開が減り遅くなる（シミュレーション: 実際の目標・1.35倍で
    170/183 → 135/174、7.4秒 → 11.2秒）
  - 定数 `RESPONSE_STEPS`・`RESPONSE_MIN`・`RESPONSE_MISSES`・`RESUME_RISE`・`RESUME_SWING_MARGIN` を export（理由の文字列を組み立てるため）
  - 中央値の窓を `perf/rolling.ts` の `RollingWindow` に置き換えた（振る舞いは同じ）
- `perf/governor.ts`:
  - **再開の上限に数えるのは「無駄だった再開」だけ**（再開した制御が手応えの判定に一度も通らずに再び止まった）。その上限は
    `DYNRES_MAX_WASTED_RESUMES`（3）。ほかに**再開の合計**を1セッション `DYNRES_MAX_RESUMES`（10）回までにした（揺れる比例しない負荷では、
    再開した後の判定がたまたま通って無駄に数えられないことがあるため）。`dynresWastedResumes` を追加（`dynresResumes` は全部の回数のまま）。
    **注意**: `DYNRES_MAX_RESUMES` は 0.5.0 でも「全部の再開の上限」で、意味は同じ。値が 3→10 に変わった。3回で打ち止めにする役は
    `DYNRES_MAX_WASTED_RESUMES`（無駄だった再開だけを数える）に移った
  - 止めた・再開した理由の文字列を定数から組み立てる（以前は「30%」「three steps」「10%」を直に書いていた）。下限で止めたときは
    「the steps down to the floor ...」、上限に達したときは「resumed N times (at most 10), W of them in vain (at most 3), off for the session」
  - 品質の切り替え（`switchTo`・`sceneFailed`）で、止まって見張っている状態なら見張りを捨てて新しい制御で始める（今は steady より前にしか
    切り替えないので起きない。状態の食い違いをなくすため）
  - 内部の `Rolling` を `perf/rolling.ts` の `RollingWindow` に置き換えた（振る舞いは同じ）
- `perf/rolling.ts`（新規）: 直近 N サンプルの窓。確保なしの `median`・`quantile`（`bench.ts` の `percentile` と同じ順位）・`mean`
- `perf/load-sim.ts`（新規、試験用。アプリからは使わない）: governor をアプリと同じ取り方（8フレームごと・2フレーム遅れ・垂直同期）で
  動かす `driveLikeApp`、種を固定した対数正規 AR(1) の揺れ `logNormalAr1`、1フレームだけ長くなる跳ね `spikes`、`vsyncFrame`。
  単体テストと `scripts/sim/` が共有する
- 案2で使うときは、`PerfGovernor` の使い方は変わらない。`DYNRES_MAX_RESUMES` を「3回で打ち止め」の前提で参照していたら
  `DYNRES_MAX_WASTED_RESUMES` に直す（`DYNRES_MAX_RESUMES` は値が 10 になった）。
  プローブに無駄だった再開の回数を出すならアプリ側で `dynresWastedResumes` を写す

## 0.6.0 — 2026-10-21（S-12 描画倍率を変えた後の Destroyed texture）

- `glass/backdrop.ts`（新規）: 透過の背景画像（three の FramebufferTexture）が描画の大きさの変更で作り直された後も、透過の材質の物が
  古いテクスチャを使い続けないようにする。
  - three r186 は、ノードを1つも持たない材質の物について、位置・材質・描画先の大きさが前回描いた時と同じなら、バインドの更新を飛ばす
    （`NodeMaterialObserver`）。背景画像はこの比較に入っていない。そのため、大きさが A → B → A と変わる間に画面外にいた物が視界に戻ると、
    破棄済みの背景画像のまま描かれる（WebGPU: `Destroyed texture … used in a submit` が毎フレーム出て、その submit が丸ごと捨てられる。
    WebGL2: `bindTexture: attempt to use a deleted object`）。動的解像度が倍率を変えるので、プレイ中に起きる
  - `followBackdropResize(material)`: ノードを持たない透過の材質に `thicknessNode = materialThickness`（three が null のときに使う値と同じ。
    見た目は変わらない）を入れ、three が毎フレーム更新するようにする。transmission を決めた後、最初に描く前に呼ぶ（描いた後なら
    `material.needsUpdate = true` も要る）。ノードを持つ材質と透過でない材質には何もしない
  - `missesBackdropResize(material)`（危ない材質の判定）、`readsBackdrop(material)`（three の `useTransmission` があればそれ）、`hasNodeProperty(material)`
  - 単体テストは three の `NodeMaterialObserver.needsRefresh()` を直接呼んで、回避策を通した材質が毎フレーム `FULL` になることを確かめる。
    three を上げたらこのテストと、`process/slices/S-12.md` の最小の再現で回避策がまだ要るかを確かめる
  - `createGlass()` の透過のガラスは、もともと `thicknessNode` を持つので対象外（単体テストで全種類・全品質・全配置・全役割を確かめている）。
    手で `MeshPhysicalNodeMaterial({ transmission })` を作るときは `followBackdropResize()` を通すか、`createGlass()` を使う
  - 代償: その材質の物は毎フレーム three のノードとバインドの更新を通る（`createGlass()` のガラスと同じ扱いになる）
- 案2で使うときは、`glass/backdrop.ts` をコピーし、手で作った透過の材質に `followBackdropResize()` を通す

## 0.5.0 — 2026-10-21（S-11 動的解像度の止めっぱなしの解消、WebGL2 のタイムスタンプの読み出し、警告も数えるセンサー）

- `perf/dynamic-resolution.ts`:
  - `ResumeWatch`（新規）: 手応えの検査で止まった後の GPU 時間を見て、新しい重さが来たら知らせる。止めた水準は「止めた時点の平滑した
    GPU 時間（EMA）」と「止めた直後の15サンプルの中央値」の低い方（後者は1回だけ下げる方向に使う）。直近5サンプルの中央値と平滑した値の
    両方が、その3割増し（かつ縮める閾値＝目標の8割）以上で2秒続いたら `update()` が true を返す
  - `DynamicResolution`: `stoppedAtMs`（止めた時点の EMA）と `resumeWatch()` を追加。中央値の窓を内部の `MedianWindow` に切り出した
    （振る舞いは同じ。既存のテストは変えていない）
- `perf/governor.ts`: 手応えの検査で止めたら `ResumeWatch` で見張り、新しい重さが来たら新しい `DynamicResolution` で再開する。
  再開は1セッション `DYNRES_MAX_RESUMES`（3）回まで。止めるたびに水準を取り直すので、判定済みの重さに戻っても再開しない。
  GPU 時間を信用しなくなったとき（妥当性の検査）は再開しない（見張りも止める）。公開するもの: `dynresStops`・`dynresResumes`（回数）、
  `dynresResumeReason`（最後に再開した理由）、`dynresResumeAtMs`（見張っている間、再開する GPU 時間）。`dynresStopReason` は
  「今止まっている理由」になった（再開すると null）。**振る舞いの変更**: 以前は手応えの検査で止めるとそのセッションの間止めたままだった
- 案2で使うときは、`PerfGovernor` の使い方は変わらない（`gpu()` と `frame()` を呼ぶだけ）。プローブに回数と理由を出すならアプリ側で
  上の4つを写す（このリポジトリでは `src/main.ts`）
- アプリ側（`src/main.ts`、core の外）: three のパスごとのタイムスタンプが有効な間は、値を使う人がいなくても8フレームごとに描画の外で
  `resolveTimestampsAsync('render')` を呼ぶ。WebGL2（three r186）ではプールが満杯（1024 の描画）になると入れ子の描画の途中でも
  リセットされ、`beginQuery: a query is already active` の警告が出るため（Apple の WebGL2 で性能表示もベンチもないときに出ていた）。
  案2でも WebGL2 でタイムスタンプを有効にするなら同じことをする

## 0.4.0 — 2026-10-21（S-08 GPU のフレーム時間、S-09 音の基礎、S-10 透過の背景画像の調査）

### S-08 GPU のフレーム時間

- `perf/gpu-span.ts`（新規）: GPU のフレーム時間 span（フレームの最初のパスの開始から最後のパスの終わりまで）を自前のタイムスタンプで測る
  `GpuSpanTimer`。描画の直前に `begin()`、直後に `end()`（Promise で ms か null）。WebGPU のみ（`GpuSpanTimer.supported(device)`）。
  読み出し待ちは1件まで、querySet・バッファ・パイプラインは起動時に1回だけ作る。印のパスは1ワークグループの空のシェーダを dispatch する
  （Metal では作業のないパスのタイムスタンプが 0 のまま）。前回の読みと同じ値のまま（GPU が書かなかった）の読みは捨てる。
  ほかに `spanMs`（あり得ない値を捨てる）と、governor に渡す GPU 時間を選ぶ
  `chooseGpuTimeSource`（span → three のパスの合計 → なし。span は Apple でも信用、パスの合計は Apple では信用しない）
- `renderer.ts`: 戻り値に `gpuSource`（'span' | 'passes' | 'none'）と `spanDevice` を追加。`gpuTimingTrusted` は `chooseGpuTimeSource` で決める。
  オプション `frameSpan: false` で span を切れる（A/B 用）。**振る舞いの変更（判断）**:
  - Apple の WebGPU で GPU 時間を信用するようになった。動的解像度だけでなく `quality=auto` の推奨と確かめも、フレーム時間ではなく
    GPU 時間（span）で行う。`COST_FACTOR`（`perf/quality-select.ts`）は垂直同期なしのフレーム時間で較正した値で、垂直同期ありの span は
    それより長く出る（M5 Pro の stress で約3倍、理由は未確定）ので、低めの品質を選ぶ側に偏りうる
  - Apple 以外の WebGPU も、three のパスの合計から span に切り替わった（計測の方法を1つに揃えるため）。Iris Xe などで確かめる（S-07）
- `perf/dynamic-resolution.ts`: オプション `requireResponse`（既定 off）。3段続けて下げても GPU 時間が1割以上下がらなければ
  `unresponsive` を立てて止まる（段の間が 2.5 秒を超えるか、上げた時点で数え直す）。比べるのは段を下げる直前の直近5サンプルの中央値
  （EMA は途中から上がった負荷に遅れて追いつくので、基準にすると画素に比例する過負荷でも誤って止まる）。中央値の窓には生の値を入れ、
  スパイクの上限は EMA に入れるときだけ掛ける（EMA の値は以前と同じ）
- `perf/governor.ts`:
  - 動的解像度を `requireResponse` 付きで作る（オプション `dynresRequireResponse`、既定 true）。手応えがなければ、プリセットの倍率へ戻して
    そのセッションの間止める
  - GPU 時間の信用をやめたときも、下げた倍率のまま残さずプリセットの倍率へ戻して止める（以前は下げた倍率のまま残っていた）
  - 止めた理由を `dynresStopReason` に出す
- `params.ts`: `gpuSpan=0`（span を測らない）、`gpuPasses=0`（three のパスごとのタイムスタンプを使わない）、`dynresResponse=0`
  （手応えの検査を切る。配線だけを確かめる試験用）。どれも既定 on で、ほかのスイッチと連動しない
- `scene.ts`: 約束のコメントのみ。GPU への submit は `render()` の中で行い、`update()` では行わない（span は `render()` の前後で測るため）
- 案2で使うときは、アプリ側でフレームごとに `begin()` → 描画 → `end()` を呼び、得た ms を `PerfGovernor.gpu()` に渡す
  （このリポジトリでは `src/main.ts`）。three のパスごとのタイムスタンプ（`renderer.backend.trackTimestamp`）は、span を使う経路では
  ベンチの間だけ有効にしている
- 計測（Apple M5 Pro、垂直同期なし、静か）: 負荷シーンで span は実際のフレーム時間と 0〜7% で一致（パスの合計は6〜14倍）。
  ほぼ空のシーンを毎秒数千フレームで回すと、span がフレームの間隔より長く出る（2〜5倍。前後のフレームが GPU 上で重なるためと推測）。
  2つの印が three のパスを確実に挟むことは保証されない（依存のない作業は重なりうる）ので、span は実測で確かめた値として扱う

### S-09 音の基礎

すべて Web Audio API だけで作り、依存パッケージは足していない。
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

### S-10 透過の背景画像（調査のみ）

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
