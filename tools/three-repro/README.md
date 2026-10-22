# three.js の不具合の再現ページ

three だけで動く1枚の HTML で、このゲームで見つけた three の不具合を再現する。three は jsDelivr から読むので、ビルドは要らない。
URL の `three=` で版を切り替えられる（`0.186.1`、`dev`、コミットの sha）。three を上げるときや、本家に報告するときに使う。

| ページ | 何を見るか | 記録 |
|---|---|---|
| `s12-backdrop-resize.html` | ノードのない透過の材質の物が、描画の大きさ A → B → A の間に隠れていると、戻ったときに捨てられた背景画像で描かれる | `process/slices/S-12.md` |
| `s05-transmission-rt-size.html` | 透過の材質を画面と違う大きさの描画先にも描くと、背景画像が毎フレーム作り直される（S-05 の決まりの原因の候補） | `process/slices/S-05.md`、`S-10.md` |
| `s29-backdrop-shared-size.html` | 2つの描画先に透過を描き、両方の大きさが変わると、後から描いた方の背景画像が古い大きさのまま残る（潜った後の黒い画面） | `process/slices/S-29.md` |

## 実行

```bash
node tools/three-repro/run.mjs
```

WebGPU と WebGL2 の両方を、ヘッドレスの Chromium で開いて表にする。`THREE=0.186.1,dev,<sha>` で版を、`CASES=S-12` で対象を絞れる。
ページを手で開くなら、`tools/three-repro/` を静的なサーバーで配って、ブラウザで開く（例: `npx vite tools/three-repro`）。

## 結果（2026-10-21、Apple M5 Pro、macOS 26.6.2、Chromium 156.0.8078.4 ヘッドレス）

### S-12: 隠れていた物が捨てられた背景画像で描かれる

| three | 経路 | 回避策なし | 回避策あり（`thicknessNode`） |
|---|---|---|---|
| 0.186.1 | WebGPU | `Destroyed texture … used in a submit` 30回（戻った後の30フレームすべて） | 0 |
| 0.186.1 | WebGL2 | `bindTexture: attempt to use a deleted object` 30回 | 0 |
| dev（r187dev、2026-10-21 のビルド） | WebGPU | 30回 | 0 |
| dev | WebGL2 | 30回 | 0 |

- **開発版でも直っていない。** 本家に同じ報告は見つからなかった。近いもの:
  - #34324: 同じ仕組みの報告だが、題材は影のテクスチャ。影の場合だけ直された（#34360）。
  - #34612: 大きさが変わったら全部更新する直し。比べる相手が「その物を前回描いたときの大きさ」なので、隠れている間の A → B → A はすり抜ける。
  - #34968: 描画先が変わったら全部更新する直し。描画先が同じこの場合には効かない。
- 本家への報告の下書き: `issue-s12.md`。jsfiddle の3つの欄（HTML・CSS・JavaScript）に貼る中身は `jsfiddle-s12/`（jsfiddle と同じ組み立てで、開発版でエラー60件・回避策で0件を確かめた）。

### S-05: 違う大きさの描画先に透過を描くと、背景画像が毎フレーム作り直される

59フレームの間に `backend.destroyTexture()` が呼ばれた回数（＝背景画像の作り直し）。エラーの数はどの組み合わせも0。

| three | 半分の大きさの描画先あり（順に描く／仕上げのパス／反射のノード） | 同じ大きさ（対照） |
|---|---|---|
| 0.186.1 | 118回（毎フレーム2回）。WebGPU・WebGL2 とも | 0 |
| dev | 0 | 0 |

- 原因は S-10 の記録と本家の #34932 のとおり、描画先ごとの背景画像が `clone()` で `Source` を共有し、大きさを書き換え合うこと。
  #34636（r187）で直っている。0.186.1 には入っていない（`FramebufferTexture` に `copy()` の上書きがない）。
- この小さなページではエラーにならず、作り直しだけが起きる。ゲーム（S-02・S-04・S-05）では同じ作り直しが描画の途中に起き、
  `Destroyed texture … used in a submit` になったと考えられる（未確認）。
- r187 に上げたら、AGENTS.md の「画面と違う大きさの RenderTarget に透過の材質を描かない」と、それに合わせた回避策
  （覗くパスに透過の物を入れない S-02、ホームのシーンに透過を置かない S-04）を外せるかを確かめる。

### S-29: 描画先ごとの背景画像が大きさの記録を共有し、後から描いた方が古い大きさのまま残る

（2026-10-22、Apple M5 Pro、macOS 26.6.2、Chromium ヘッドレス。`CASES=S-29 node tools/three-repro/run.mjs`）

描画先 A と B に同じ透過の玉を描く: A → B を大きさ 1 で、A と B を大きさ 2 にして B を 10 フレーム、その後 A を 30 フレーム。
`stale` は古い大きさの背景画像へのコピーの数（ページが three の公開の値〈テクスチャの version と image〉で数える）。
`console copy` は WebGPU の `Texture copy range … touches outside of [Texture …]`（error と warning で 1 フレーム 2 件）と
WebGL2 の `GL_INVALID_VALUE: glCopyTexSubImage2D: Offset overflows texture dimensions`。

| three | 向き | 経路 | 回避策なし | 回避策あり（`ownBackdropImage` と同じ） |
|---|---|---|---|---|
| 0.186.1 | 大きくなる（up） | WebGPU | stale 30、console copy 60 | 0 |
| 0.186.1 | up | WebGL2 | stale 30、console copy 30、gl.getError 30 | 0 |
| 0.186.1 | 小さくなる（down） | WebGPU・WebGL2 | stale 30（メッセージなし） | 0 |
| dev（r187dev、2026-10-22 のビルド） | up・down | WebGPU・WebGL2 | 0 | 0 |

- **開発版では直っている**（#34636。`FramebufferTexture.copy()` が image を写した新しい `TextureSource` を持つ）。S-05 と同じ根
  （描画先ごとの背景画像が `clone()` で `Source` を共有する）で、S-05 は「違う大きさが交互に描くと毎フレーム作り直し」、
  S-29 は「同じ大きさへ変わったとき、後から描いた方が作り直されない」。本家に報告する必要はない。
- ゲームでは `src/core/glass/backdrop.ts` の `ownBackdropImage(target)` が、透過を描く描画先（ホームの玉の中の像、序章の仕上げの
  パス）に r187 と同じく自分の `TextureSource` を持たせる。three を r187 以上に上げたら、単体テスト
  （`backdrop.test.ts` の「three r186: the targets share …」）が落ちるので、そのときに外す。
