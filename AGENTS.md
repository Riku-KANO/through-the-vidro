# ビードロの向こう（Through the Vidro）— エージェント向けの地図

ガラス玉を覗いて裏の層を見つけ、置いて実体化させる、ブラウザ向け一人称3D探索パズル。
設計の正本は claude.ai の設計書（https://claude.ai/code/artifact/df581ffa-0fea-4dfc-acc8-b0b5831abbee）、
オフライン用の写しは `docs/design-snapshot.md`。仕様で迷ったら写しの該当節を読み、それでも決まらなければ止めて発案者に聞く。

## 今の段階

**M1 垂直スライス**（目安4週、2026-10-21 開始）。序章とエリア1を完成品質で作り、読み込み・ホーム・ポーズ・設定の主要画面を仕上げ、
Blender の命名検査・焼き込み・書き出しを自動化する。ゲート: 20分通して遊べ、テストプレイで迷子と詰まりが許容範囲。
M0 は条件付きで通過（`process/slices/S-07.md`）。推奨環境（M1 / Iris Xe）の実機での60fps の確認は、M1 のテストプレイで行う。
M0は姉妹作「泡沫回廊」（`~/develop/bubble-corridor`）と共通。`src/core/` は両作品の共通部品で、
ディレクトリをまたいで参照せずコピーで共有する（版は `src/core/VERSION`、変更は `src/core/CHANGELOG.md`）。

## 設計の柱（すべての判断の基準）

1. ガラスは飾りではなく仕組み（透ける・屈折する・転がる・鳴る を遊びのルールに）
2. 迷わずに彷徨える（どこを歩けるか分からないストレスは消す）
3. 画面と世界の境目がないUI（UIもガラス、黒い画面の切り替えなし）
4. どの瞬間を切り取っても一枚絵になる

## コマンド

| 目的 | コマンド |
|---|---|
| 開発サーバー | `pnpm dev` → http://localhost:5173/ （シーン一覧）、`/?scene=<名前>&stats=1` |
| 速い検査（型・lint・単体・ビルド） | `scripts/check.sh` |
| 全検査（＋ブラウザセンサー） | `scripts/check.sh --full`、対象を絞るなら `SCENES=a,b scripts/check.sh --full` |
| 計測結果の表 | `node scripts/bench-report.mjs` |
| URL を指定して1回測る | `node scripts/bench-probe.mjs '?scene=stress&bench=3'`（`HEADED=1`、`UNCAPPED=1`、`FPS=<n>` はその速さの画面のようにフレームを出す） |
| 実機ベンチ（ヘッドあり、垂直同期なし、1080p） | `node scripts/bench-headed.mjs` → `artifacts/bench-headed.md` |
| three の不具合の再現（版を比べる） | `node tools/three-repro/run.mjs`（`THREE=0.186.1,dev`、ネットが要る） |
| 整形 | `pnpm format` |
| アセットの書き出し | `pnpm assets`（Blender の .blend → 命名・ポリゴン数の検査、2つ目の UV、エリアごとの glb、meshopt と KTX2 → `public/assets/<job>/`。`BLENDER=<path>`、`-- --job <name>`、`KEEP=1`）。KTX2 は KTX-Software の `ktx`（4.4 以上）が PATH にあるときだけ |
| 見本の .blend を作り直す / パイプラインの検査 | `pnpm assets:sample` / `pnpm assets:test`（check.sh には入れない。Blender がなくても check.sh は緑） |
| 工房の .blend を作り直す | `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 --python blender/scripts/make_workshop.py -- --out blender/scenes/workshop.blend`（`--preview <dir>`、`--only <関数>`）→ `pnpm assets -- --job workshop` |

URLスイッチ: `scene` `bench=<秒>` `warmup=<秒>` `quality=low|mid|high|auto` `autoWindow=<秒>` `autoFrom=low|mid|high`
`dynres=0|1` `webgl=1`（WebGL2経路の強制） `stats=1`。試験・調査用: `dynresTarget=<ms>` `autoForce=low|mid|high`（推奨を固定）
`gpuTrust=1`（信用していない GPU でもタイムスタンプで判断する） `gpuSpan=0`（自前の span を測らない） `gpuPasses=0`（three のパスごとのタイムスタンプを使わない）
`dynresResponse=0`（手応えの検査を切る。配線だけを確かめる試験用） `debug=1`（`window.__vidroDebug` に renderer・setScale・backdropRisks を出し、描いた根を記録するため `renderer.render` と `compileAsync` を
インスタンスの上で包む。`status` が `running` になってから使う。さらに包むコードは元の関数を `apply(renderer, args)` で呼ぶ）。 `finish=0|aa`（PeekPipeline を使うシーンの仕上げを分けて比べる。
`0` = AgX だけ、`aa` = ブルームなし。S-17）。
`quality=auto` と `bench` を一緒に使うと計測の途中でプリセットが変わるので、計測は固定のプリセットで行う。
シーン固有のスイッチ（例: stress の `peek=0`）は各シーンの先頭のコメントに書く。

## センサー（ループが自分の仕事を確かめる手段）

- **型・lint・単体テスト**: 純粋なロジック（数式、状態遷移、判定）は `src/**/*.test.ts` に Vitest で書く。
- **ブラウザセンサー**: `tests/e2e/scenes.spec.ts` が `src/scenes/*.scene.ts` をすべて WebGPU と WebGL2 の両経路で開き、
  - エラーなく起動するか、描画予算（描画呼び出し300回・三角形150万）を超えないかを判定する
  - `artifacts/screens/<scene>[-webgl].png` にスクリーンショット、`artifacts/bench/<scene>[-webgl].json` に計測値を残す
- **見た目の確認**: スクリーンショットは必ず Read で開いて目で見る。数値が緑でも絵が設計の柱に反していれば未完了。
- **シーン固有の検証**: シーンは `window.__vidro.sceneProbe` に状態（例: 覗いているか、実体化半径、プレイヤー位置）を公開できる。
  入力を送って状態を確かめるテストは `tests/e2e/<slice-id>.spec.ts` に書く。
- **並列時の注意**: ブラウザセンサーのポートは worktree のパスから決まる（`SENSOR_PORT` で上書き可）。複数のセッションが同時に計測すると GPU を取り合うため、性能の数値は比べない。`scripts/bench-headed.mjs` は前後にほかの Playwright ブラウザを数え、いれば結果に「混雑」と書く。比較や判定に使う計測は `QUIET=1`（混雑なら中止）で、並列のセッションが止まっているときに取る。
- **警告もセンサーの対象（S-11、S-13）**: `tests/e2e/scenes.spec.ts` は console の error と warning を集め、`KNOWN_CONSOLE`（パターン、理由、担当スライス、シーン、経路、例文。
  正規表現の g/y フラグは禁止）にないものが1つでもあれば落ちる。警告を許すときは、理由と担当スライスを書いて一覧に足す。センサーが見るのは各シーンの約5秒だけなので、時間がたってから出る警告は見逃しうる。
- **ノードのない透過の材質のセンサー（S-14）**: `tests/e2e/backdrop-risks.spec.ts` が全シーンを `?debug=1` で開き、起動の約1秒後と5秒後に
  `window.__vidroDebug.backdropRisks()`（`src/dev/backdrop-risks.ts`、判定は core の `missesBackdropResize`）を呼んで、シーンと、シーンが描いた・
  コンパイルした根の全材質を調べる。1つでもあれば落ちる。既定は WebGPU だけ（`BACKENDS` で WebGL2 も）。限界: 描いた後にノードを足した材質は安全と
  判定する（見逃す）、5秒までに描きもコンパイルもしない世界は見えない。home-dive と prologue-proto では、先頭（sandbox.scene）以外の
  場面に透過を読む材質（core の `readsBackdrop`、安全なものも含む）があることで、玉の中の世界を見ていると判断する（`roots` の根ごとの
  `backdropReaders`、S-15）。世界でない場面が透過を持つと偽の緑、世界から透過がなくなると偽の赤になる。
- **コミットした glb を Node で読むセンサー（S-24）**: `src/game/assets/node-glb.ts`（GLTFLoader ＋ meshopt、KTX2 は空のテクスチャ）で、単体テストが
  ゲームと同じ物・名前・形の位置（`workshop-asset.test.ts`）と当たり判定（Rapier、`physics.test.ts`）を確かめる。当たり判定の正直さは両向きの光線で
  確かめる（見えている物には 5cm 以内で当たる、当たり判定に止められる所には 10cm 以内に見た目がある。体が入れない窪みは名前と理由を挙げて外す）。
- **fpsの扱い**: ヘッドレスのfpsは垂直同期で60に張り付く参考値。重さの比較は `scripts/bench-headed.mjs`（垂直同期なしのフレーム時間）で行い、ゲートの判定は推奨環境の実機での計測（S-07）で行う。

## コードの配置と書き込み範囲

| 場所 | 中身 | 持ち主 |
|---|---|---|
| `src/core/` | 共通部品（描画の初期化、品質プリセット、計測、ガラス材質、遷移の曲線、音の仕組み `core/audio`）。案2と共有。ゲーム固有の規則や調整値は持たない | 変更は CHANGELOG に記録 |
| `src/layers/` | 表と裏の層、実体化 | S-02 |
| `src/game/` | 手の玉、プレイヤー、入力、ギミック、進行、セーブ | S-02, S-03 |
| `src/ui/` | DOMの画面と言語ファイル、AudioGate（ページの音のエンジンの持ち主） | S-04, S-18 |
| `src/audio/` | このゲームの音の規則と調整値（音階、大きさ→音程、部屋の残響、ガラスの鳴り、ぽぺん、音量の初期値）、エンジンの作り方（`createVidroEngine`）、足音と環境音の合成のレシピ・予定表・調整値。生成音楽は M1以降 | S-09, S-21, S-22 |
| `src/scenes/<name>.scene.ts` | M0の検証用シーン。ファイルを足すだけで一覧とセンサーに載る | 各スライス |
| `src/core/assets/` | glb の読み込み（GLTFLoader ＋ meshopt ＋ KTX2、材質をノードの材質へ）。案2と共有 | 変更は CHANGELOG に記録 |
| `src/game/assets/` | 命名規則と extras から層・当たり判定・台座を組み立てる、印のついたガラス | S-23 |
| `blender/` | `scenes/`（.blend）、`scripts/common/`（案2と共有。VERSION と CHANGELOG）、`scripts/vidro/`（案1だけの規則）、`scripts/tests/` | S-23 ほか |
| `public/assets/` | `pnpm assets` が書いた glb。**コミットする**（check.sh とセンサーはこれを読む。.blend を直したら glb も書き出してコミット） | S-23 ほか |
| `scripts/assets/` | パイプラインの入口（Node） | S-23 |
| `src/dev/` | 開発用ツール（性能表示など） | 共通 |
| `process/` | ループの台帳（スパイン）とスライスごとの記録 | — |

シーンの契約は `src/core/scene.ts`（`SceneFactory` を default export、`title` を named export）。
シーンは描画器やアニメーションループを自分で作らない。

## 並列開発のルール

- スライスは **worktree とブランチ `slice/<ID>-<短い名前>`** で進める。main の checkout では機能を直接編集しない。
- 各スライスは spine の `paths` に書かれた範囲だけを編集する。範囲外（特に `src/main.ts`、`src/core/scene.ts`、`package.json`、
  `AGENTS.md`、`process/spine.yaml`）を変えたくなったら、自分の記録ファイルに「提案」として書き、変更はしない。
- 依存パッケージの追加は発案者の判断。必要なら記録ファイルに理由を書いて止める。
- 進捗は `process/slices/<ID>.md` に書く（spine.yaml の status は統合時に親が更新する）。
- 統合（main へのマージ）は発案者の指示があったときだけ。push・デプロイはしない。

## ループの宣言

スライス1つの進め方は `.claude/skills/slice/SKILL.md`（`/slice <ID>`）。目標・上限・停止条件・エスカレーション先は
`process/loop.md`。台帳は `process/spine.yaml`。

## 技術の決まりごと

- Three.js は `three/webgpu`（WebGPURenderer、非対応環境は WebGL2 に自動切替）。シェーダは TSL（`three/tsl`）で書き、両経路で動かす。
- 物理は Rapier（`@dimforge/rapier3d-compat`）。
- トーンマッピングは AgX。モーションブラーは使わない。黒い画面での切り替えはしない。
- 数値は設計書の値をそのまま定数にし、出典の節名をコメントに書く（例: 実体化半径4m、覗く遷移0.25秒、歩行1.4m/s）。
- 単体テストは振る舞いを書く。実装の細部を固定するテストは書かない。
- **画面と違う大きさの RenderTarget に透過（transmission）の材質を描かない。** WebGPU 経路（r186）では、そのフレームで背景用のテクスチャが
  途中で破棄され、「Destroyed texture used in a submit」が毎フレーム出て描画が捨てられる（WebGL2 では出ない。ただし S-05 当時は warning を数えていなかったので要再確認、S-12 参照）。覗くパスの裏の層や
  ホームの玉の中の縮図は、iridescence・透明度・発光など透過以外で表現し、玉の屈折は `texture(rt, screenUV + 屈折オフセット)` の自前合成で描く。
  画面と同じ大きさの描画先（`pass()` による仕上げのパスなど）に透過を描くのは問題ない。（S-05 で発見、2026-10-21）
  原因は three の #34932（描画先ごとの背景画像が `Source` を共有し、大きさの違う描画先を描くたびに作り直される）とみられ、r187 の #34636 で
  直っている（`tools/three-repro/` で確かめた。0.186.1 は毎フレーム2回作り直し、開発版は0回）。three を上げたら外せるかを確かめる。
- **影のカメラの layers を明示する。** 影マップは1フレームに1回、最初にそれを使う描画で作られる。影のカメラが既定（layer 0 だけ）のままだと、
  three はその時点のカメラの layers を写すので、覗くパス（共通＋裏）が先に走ると表の層の物が影を落とさなくなる。
  `light.shadow.camera.layers.enable(<表の層>)` のように、影を落とす層を必ず指定する。（S-05 のレビューで発見）
- **GPU 時間は自前の span で測る。** three の `resolveTimestampsAsync` は描画パスごとの時間の合計で、Apple/Metal では
  重なって約10倍に膨らむ（S-05）。`src/core/perf/gpu-span.ts` が描画の前後に自前のタイムスタンプを置き、その差（span）を GPU 時間にする（S-08）。
  GPU が律速する負荷では垂直同期なしのフレーム時間と0〜7%で一致した。ほぼ空のシーンを毎秒数千フレームで回すと長く出る（既知の例外）。
  2つの印が three のパスを確実に挟む保証はないので、span は実測で確かめた値として扱う。GPU への submit は `render()` の中で行う（`scene.ts` の約束）。
  動的解像度は、3段下げても GPU 時間が1割以上下がらなければプリセットの倍率へ戻して止まる（S-08）。性能の比較そのものは、
  垂直同期を外したフレーム時間（`scripts/bench-headed.mjs`、`QUIET=1`）で行う。
  止めるのは手応えなしが2回続いたとき（下限に着いたときも、段の列の全体で1回判定する）。止めた後も、GPU 時間が止めた水準の1.3倍・揺れ幅・縮める閾値の
  高い方を2秒続けて上回ったら再開する（S-11、S-13）。上限は「無駄だった再開」3回と、再開の合計10回（1セッション）。揺れへの強さは
  `node scripts/sim/dynres-noise.mjs`（種固定、直す前と比べる表）で確かめる。実機の揺れ（σ・τ）は S-07 で測る（σ0.4 以上なら S-13 の判断待ち5を先に直す）。
- **three のタイムスタンプは描画の外で読む（S-11、S-20）。** パスごとのタイムスタンプが有効な間は、使う人がいなくても main.ts が描画の外で
  読み出す（8フレームごと。WebGL2 ではプールの4分の1が埋まったら早めに）。読まないとプール（r186 の WebGL2 は描画 1024 回分）が埋まって描画の
  途中でリセットされ、WebGL2 で `beginQuery: a query is already active` が出る。WebGL2 では読み出しを始めた時点から終わるまでパスごとの
  タイムスタンプを止める（垂直同期なしでは読み出しが 100 ms〜1.7 秒かかり、その間に溢れた）。`backend.trackTimestamp` の切り替えと
  `resolveTimestampsAsync` の呼び出しは main.ts の `PassTimestampDrain`（`src/dev/timestamp-drain.ts`）だけが行う。シーン側で読み出したり
  切り替えたりしない（読み出し中に別の読み出しが来ると three は前回の値を返し、古い値が governor に混ざる）。three を上げたら
  `tests/e2e/S-20-timestamp-drain.spec.ts`（垂直同期なし）で、プールの大きさと読み出しの振る舞いが変わっていないかを確かめる。
- **透過の背景画像の解像度は品質で変えられない（three r186、S-10）。** 背景は描画先と同じ大きさで写されるので、
  品質プリセットの `transmissionScale` は効かない。効くのは描画解像度（renderScale）と動的解像度だけ。
- **Web Audio の音の経路は、鳴り終わるまで JS から参照する（S-09）。** 参照の切れた ConvolverNode とその下流の GainNode は、
  鳴っている途中でも GC で切り離され、残響の尾が切れる。
- **ゲームの AudioContext は最初のユーザー操作の中で作る（S-16）。** 操作の前に作ると、実機の Chrome は自動再生の警告を出しうる。ヘッドレスの
  Chromium は `--autoplay-policy` を渡しても操作の前から running で始まり警告も出ないので、センサーでは見えない。作りで防ぎ、e2e は操作の前に
  コンテキストがないことで確かめる。操作の前に作る試験用のシーン（audio-lab）は、作った直後に止めて最初の操作で再開する。
- **ページの AudioContext は1つ（S-18）。** ホーム経由では、読み込み画面の「はじめる」の押下の中で `AudioGate`（`src/ui/audio-gate.ts`）が
  コンテキストとエンジンを作り、UI の音もゲームの音もそれを使う。ゲームの音は `whenReady` でエンジンを受け取り、開始・再開・片付けは AudioGate に
  任せる（自分では作らない・閉じない）。自分で作るのは単独で開くシーン（試作部屋の `?direct=1`、audio-lab）だけ。e2e は `window.AudioContext` を
  `addInitScript` で包み、数・作った瞬間の活性化・エンジンの数・スピーカーへの線の数を確かめる（`tests/e2e/S-18-*.spec.ts`）。
  このゲームのエンジンは `createVidroEngine(context, room)`（`src/audio/engine.ts`）で作る。`context` に `undefined` を渡すのは audio-lab だけ（S-21）。
- **何が光るかは、ブルームのしきい値ではなく美術で決める（S-17）。** しきい値は線形の輝度 0.9（`PeekPipeline`、負荷シーン）。光として滲ませたい物
  （光源、光の雫）は合成の後でこれを超える明るさで描き、照らされた面と空はこれより下に置く。
- **ブルームの明るい所を取り出すパスを画面の半分より小さくするときは、1画素が代表するブロック全体を読む（S-17）。** 4点のバイリニアなど。
  1点だけだと、小さい光が視点の動きでブルームに出入りしてちらつく。
- **音の素材は `src/core/audio/bank.ts` の `SoundSource` で持つ（S-22）。** 合成は `synth(id, render)`、録音は `recording(id, ...urls)`（形式違いを
  使いたい順に）。どちらも `loadBank` で AudioBuffer になり、`scheduleBuffer`・`startLoop` の同じ道で鳴るので、合成の仮置きを録音に替えるのは表の
  1行（手順は `process/slices/S-22.md`）。JS で合成する音は、読み込みで主スレッドを長く止めない（音源ごとに間を置く）。
- **環境音はエンジンの声の割り当て（`startVoice`）を通さない（S-22）。** 持続する床は声にせず、風鈴・水滴は環境音の予定表が数を抑える。
  環境音の系統の Emitter に入れるので、音量と部屋の残響には従う。試作部屋の音の観測口の `voicesStarted` は出来事の音の声の数、全体は `engineVoices`。
- **glTF の物の名前は `userData.name` から読む（S-23）。** three の GLTFLoader は `name` を重ならないように書き換える（メッシュと節点が同じ名前なら
  節点が勝ち、メッシュに `_1`）。
- **量子化した glb では、節点の位置と拡大率は形の大きさ（S-23）。** gltf-transform の meshopt はメッシュを [-1, 1] に詰める。位置が要る物（台座、
  共鳴器）は、パイプラインが書き出しの前に原点を extras の `origin` に書く。メートルで厚みを決めるガラスは拡大率で割る。
- **層を使うシーンのカメラは `camera.layers.mask = viewMask('main')`（S-23）。** PeekPipeline を使うシーンはそれが設定する。使わないシーンで既定
  （channel 0 だけ）のままだと、表だけ・裏だけの物と透過のガラスが描かれない。
- **工房の家具の当たり判定は glb の `_col`（S-24）。** 作業台・炉を physics.ts の箱や球で持たない。`_col` は見た目の部品ごとの凸包
  （頭より上の 2.2m は除く、弧の部品は 8 度ずつ、炉は泡ごと）を `make_workshop.py` が作る。
- **GPU を使う検査の間は、同じ機械で CPU を多く使う仕事（Blender、KTX2 の書き出し）を走らせない（S-24）。** S-06 の「最長フレーム 200ms」が
  376ms で落ちた。
- **透過の材質は、最初に描く前にノードを1つ持たせる（three r186、S-12）。** ノードのない透過の材質（`MeshPhysicalNodeMaterial({ transmission })` だけ）の物は、
  描画の大きさが A → B → A と変わる間に画面外にいると、視界に戻ったときに破棄済みの背景画像のまま描かれる（WebGPU は毎フレーム
  「Destroyed texture used in a submit」で描画が捨てられ、WebGL2 は warning の「attempt to use a deleted object」）。動的解像度がプレイ中に倍率を
  変えるので、どのシーンでも起きうる。ガラスは `createGlass()` で作るか、手で作った透過の材質を `followBackdropResize()`（`src/core/glass/backdrop.ts`）
  に通す。ノードの有無はシェーダを組むときに決まるので、最初に描く前に通す。three の開発版（2026-10-21）でもまだ起きる。three を上げたら
  `node tools/three-repro/run.mjs`（S-12 の最小の再現）で確かめ、直っていれば外す。

