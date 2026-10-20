# ビードロの向こう（Through the Vidro）— エージェント向けの地図

ガラス玉を覗いて裏の層を見つけ、置いて実体化させる、ブラウザ向け一人称3D探索パズル。
設計の正本は claude.ai の設計書（https://claude.ai/code/artifact/df581ffa-0fea-4dfc-acc8-b0b5831abbee）、
オフライン用の写しは `docs/design-snapshot.md`。仕様で迷ったら写しの該当節を読み、それでも決まらなければ止めて発案者に聞く。

## 今の段階

**M0 技術検証**（目安2週）。ゲート: 中品質で60fps、覗く操作が気持ちいい。
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
| URL を指定して1回測る | `node scripts/bench-probe.mjs '?scene=stress&bench=3'`（`HEADED=1`、`UNCAPPED=1`） |
| 実機ベンチ（ヘッドあり、垂直同期なし、1080p） | `node scripts/bench-headed.mjs` → `artifacts/bench-headed.md` |
| 整形 | `pnpm format` |

URLスイッチ: `scene` `bench=<秒>` `warmup=<秒>` `quality=low|mid|high|auto` `autoWindow=<秒>` `autoFrom=low|mid|high`
`dynres=0|1` `webgl=1`（WebGL2経路の強制） `stats=1`。試験・調査用: `dynresTarget=<ms>` `autoForce=low|mid|high`（推奨を固定）
`gpuTrust=1`（信用していない GPU でもタイムスタンプで判断する） `debug=1`（`window.__vidroDebug` に renderer と setScale を出す）。
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
- **fpsの扱い**: ヘッドレスのfpsは垂直同期で60に張り付く参考値。重さの比較は `scripts/bench-headed.mjs`（垂直同期なしのフレーム時間）で行い、ゲートの判定は推奨環境の実機での計測（S-07）で行う。

## コードの配置と書き込み範囲

| 場所 | 中身 | 持ち主 |
|---|---|---|
| `src/core/` | 共通部品（描画の初期化、品質プリセット、計測、ガラス材質、遷移の曲線）。案2と共有 | 変更は CHANGELOG に記録 |
| `src/layers/` | 表と裏の層、実体化 | S-02 |
| `src/game/` | 手の玉、プレイヤー、入力、ギミック、進行、セーブ | S-02, S-03 |
| `src/ui/` | DOMの画面と言語ファイル | S-04 |
| `src/audio/` | 音と生成音楽 | M1以降 |
| `src/scenes/<name>.scene.ts` | M0の検証用シーン。ファイルを足すだけで一覧とセンサーに載る | 各スライス |
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
  途中で破棄され、「Destroyed texture used in a submit」が毎フレーム出て描画が捨てられる（WebGL2 では出ない）。覗くパスの裏の層や
  ホームの玉の中の縮図は、iridescence・透明度・発光など透過以外で表現し、玉の屈折は `texture(rt, screenUV + 屈折オフセット)` の自前合成で描く。
  画面と同じ大きさの描画先（`pass()` による仕上げのパスなど）に透過を描くのは問題ない。（S-05 で発見、2026-10-21）
- **影のカメラの layers を明示する。** 影マップは1フレームに1回、最初にそれを使う描画で作られる。影のカメラが既定（layer 0 だけ）のままだと、
  three はその時点のカメラの layers を写すので、覗くパス（共通＋裏）が先に走ると表の層の物が影を落とさなくなる。
  `light.shadow.camera.layers.enable(<表の層>)` のように、影を落とす層を必ず指定する。（S-05 のレビューで発見）
- **GPU のタイムスタンプを GPU 時間として信じない。** three の `resolveTimestampsAsync` は描画パスごとの時間の合計で、
  Apple/Metal では仕上げのパスが多いと重なって約10倍に膨らむ（S-05: 実際 約1ms のフレームが 11〜22ms と出た）。
  性能の判断は垂直同期を外したフレーム時間（`scripts/bench-headed.mjs`）で行う。実行時の制御（`src/core/perf/governor.ts`）は、
  Apple/Metal では GPU 時間を判断に使わず、それ以外でも GPU 時間が平均フレーム時間を超えたら信用しない。そのとき動的解像度は止まり、
  品質の判定と検証はフレーム時間で行う（垂直同期の下ではフレーム時間で上限と過負荷を見分けられないため、解像度は動かさない）。
