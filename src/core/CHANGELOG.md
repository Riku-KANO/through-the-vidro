# src/core 変更記録

`src/core/` は姉妹作「泡沫回廊」と共通の部品です。ディレクトリをまたいで参照せず、先に変更した側から
もう一方へまとめてコピーします。コピーしたら、受け取った側の VERSION をこの版に合わせます。

## 0.14.0 — 2026-10-28（S-43 設定パネル: 系統ごとの絞りの段、UI の系統、品質の切り替えの口）

足しただけ。既存の呼び方の振る舞いは変えていない（音の配線に利得 1 の節点が 1 段ずつ入る。`snapshot().volumes` は今までどおり
プレイヤーの 4 つの音量）。

- `audio/engine.ts`:
  - **絞りの段（duck）**: 各系統（master / music / sfx / ambience）の音量の節点の後ろに、利得 1 の節点を 1 段ずつ足した
    （`bus ▶ duck ─┬▶ master`、`└▶ send ▶ 残響` なので、絞ると残響に送る量も減る。master は `master ▶ duck ▶ limiter`）。
    `setDuck(owner, channel, value)` は持ち主（例 `'pause'`）ごとに音量と同じ 0〜1（利得は value²）で絞り、持ち主どうしは
    掛け合わせる。1 で外れる。`getDuck(owner, channel)`、`mixVolume(channel)`（音量 × すべての絞り。いま鳴っている大きさを
    音量の目盛りで）。プレイヤーの音量（`setVolume`）には触らないので、設定とポーズの絞りが同じ音量を取り合わない
  - `duckStage(engine, owner)`: 持ち主の絞りの段を、4 つの音量と同じ形（`getVolume` / `setVolume`）で見せる。音量の形で書かれた
    ミックス（案1 の `PauseMix`、S-42）をそのまま絞りの段に向けられる
  - **追加の系統（extra bus）**: `addBus(name, { volume, reverbSend })` で music / sfx / ambience の横に系統を足す（master と
    部屋の残響へ）。同じ名前は同じ系統。`setBusVolume` / `getBusVolume`。声は `startVoice({ extraBus: name })` で入れる
    （足していない名前は例外。聞こえない所へ鳴らさない）。案1 では UI の音（`ui`）に使う
  - スピーカーへの線は今までどおりリミッターの 1 本
- `quality.ts`:
  - `QUALITY_CHOICES`（自動・低・中・高）、`QualityChoice`、`isQualityChoice`
  - `startQuality({ url, saved })`: 殻が最初のプリセットを決める（URL の `?quality` が勝つ。なければプレイヤーの保存した選択、
    自動は中から測る。どちらもなければ中）
  - `QualityPort`（`choice`・`level`・`sceneLevel`〈シーンを作ったときのプリセット。その場の切り替えの後は `level` と違い、
    違う間はプリセットの一部が次に作るときまで待つ〉・`request`・`attach`）と `QualityScene`（`applyQuality`・`idle`）、`qualityPortOf(ctx)`:
    殻（main.ts）がシーンの文脈に `qualityPort` として渡す口。作り直さずにプリセットを受けられるシーンは `attach` し、遊ぶ途中の
    品質の切り替えで状態を失わない。`idle`（絵が止まっている: ポーズ）の間、殻は governor にフレームも GPU 時間も渡さない
- 泡沫回廊へ写すとき: `SceneContext` に `qualityPort` を正式に足す（案1 は `core/scene.ts` を S-43 で変えられなかったので
  `qualityPortOf` で形から見ている。提案）。泡沫回廊の main.ts が口を渡さなければ、シーンは今までどおり作り直される
- 単体テスト `audio/engine.test.ts`（新規 13 件: 絞りの段、持ち主ごとの掛け合わせ、mixVolume、残響への送り、master、
  duckStage、snapshot、追加の系統の音量・残響・同じ名前・声・知らない名前・スピーカーへの線）、`quality.test.ts`（新規 5 件）

## 0.13.0 — 2026-10-23（S-37 光を分けて焼く: ライトマップを重ねる受け口）

足しただけ。分けて焼いた光（extras の `lightmap_layers`）のない glb と `lightmaps: true` の呼び方の振る舞いは変えていない
（焼いた材質の光は 0.11.0 と同じ節点: `materialLightMap` だけ）。S-37 の作業中は 0.12.0 の案だったが、main で S-38 が 0.12.0 になった。

- `assets/lightmap.ts`:
  - glb の書き方: 焼いた物の extras に `lightmap_layers`（`{ <層>: { lightmap: <glb の中のテクスチャの名前>, lightmap_scale } }`）。
    ゲームが走りながら強さを変える光（揺らぐ炉の火）を、いつものライトマップと同じ 2つ目の UV に別の画像として焼いたもの
    （`blender/scripts/common/bake.py` 0.2.4（案）の `BakePass`）。`lightmapLayersOf(extras)`（層の名前の順）
  - `BakedStandardNodeMaterial.lightMapLayers`（`BakedLightLayer`: 層、画像、強さ π × scale、`gain`。gain は数か節点。uniform を
    渡せば毎フレーム変えられ、材質を作り直さない）。焼いた光の放射照度 = ライトマップ ＋ Σ 層の画像 × 強さ × gain を、
    `setupLightMap` が `IrradianceNode` にして、同じ節点を `BakedLightingModel` が「焼いた光」として読む（場面のほかの放射照度
    〈半球光〉と見分けるため）。節点は組み立てごと（node builder ごと、WeakMap）に 1 つで、`setupLightMap` と `setupLightingModel`
    のどちらが先に呼ばれても同じ節点になる（`lightmap.test.ts` が逆の順で確かめる）。three の内側に頼る: r186 は
    `setupLightingModel(builder)` に builder を渡す（型には書いていない）。渡さない three では、同じ値の別の節点で組む
    （差し引きは数として打ち消し合う。画像を 2 回読むだけ）。描画呼び出しは増えない（同じ材質で 1 回多く読むだけ）
  - `BakedStandardNodeMaterial.customProgramCacheKey` に層（名前・画像の id・強さ・gain の値か節点の id）を足す。three r186 は
    鍵が同じ材質の間で組んだシェーダを共有し（`RenderObject.getMaterialCacheKey` は材質の配列の欄を中身で見ない）、層の画像・
    強さ・gain はシェーダの中に固定される（lightMap のように材質ごとに引かない）ので、層の違う材質が同じシェーダで描かれないように
    （レビュー1巡目 P2-1。工房の焼いた材質はすべて同じ層なので共有される）
  - `BakedLightingModel(baked = materialLightMap)`: 焼いた光の節点を受け取る
  - `BakedStandardNodeMaterial.copy`（と `clone`）は層を写す（`LayerField` は 2 つ目の種類の層に切る材質を `clone()` で作る。
    three の copy は知らない欄を写さない）
  - `toBakedMaterial(source, lightMap, scale, layers = [])`、`applyLightmaps(root, maps, { gain })`: 物の extras の層の画像を
    足す。`gain(layer)` は層ごとに 1 回だけ聞き、同じ層の材質は同じ値（節点）を共有する。既定は 1。層の画像がファイルにない
    ときは層を外し、`missing` に `<物> (<層>)` で知らせる
  - `loadLightmaps`: 層の画像も名前で読む（2つ目の UV、sRGB）
- `assets/loader.ts`: `load(url, { lightmaps: { gain } })`（`true` も今までどおり）
- 泡沫回廊へ写すとき: 層の画像は glb の中のテクスチャ（案1）。焼く側は `blender/scripts/common` 0.2.4（案）と一緒に
- 単体テスト `assets/lightmap.test.ts`（24 件。S-37 で 9 件足した）

## 0.12.0 — 2026-10-23（S-38 透過のガラスを読み込みで温める）

足しただけ。既存の部品の振る舞いは変えていない。

- `glass/warm.ts`（新規）: `withGlassUnculled(root, draw)` と `drawsGlass(object)`。**読み込みの温めの描画で、視界の外の透過の
  ガラスのパイプラインも作る。**
  - 何のため: three は物を初めて描くフレームの中で、その物のシェーダと描画のパイプラインを作る。透過のガラスは重い（S-38 の計測、
    M 系の GPU で、振り返って初めて見えた工房の 5 つが WebGPU で 36〜52 ms、WebGL2 で 53〜64 ms のフレームを作った。ほかは 18〜20 ms。
    毎回新しいブラウザで 3 回ずつ、`process/slices/S-38.md` の「計測」）。
    読み込みの温めの描画は、その姿勢で見える物しか作らない（three は描く前に視錐台で間引く。`compileAsync` も同じ）
  - 振る舞い: `draw` の間だけ、`root` の下で背景を読む材質（`readsBackdrop`）を持つ物と、その下の物すべて（ガラスを別のパスで描く
    安い写し。序章では覗く像の代わりの物）の `frustumCulled` を false にし、`draw` が返るか例外を投げたら戻す。もともと false の物には
    触らない。隠れている物は隠れたまま（three はその物と子を描かない）。なので温まらないのは、その時に隠れている物: LOD の
    温めの姿勢から選ばれない段、隠れた親の下のガラス（描く間だけ見せるか、段ごとに描く。S-38 レビュー 2 巡目 P3-1）
  - 使い方: ゲームの実際の描画（同じ描画先・透過の背景・層のマスク）で 1 回描く。r186 では、`compileAsync` で別の描画先
    （同じ形式 rgba16float / depth24plus / 1 サンプル）に作ったパイプラインを、実際の描画は使わずに作り直した（理由は未確定。S-38）
  - ガラスだけにする理由: 全部の間引きを外すと、その 1 フレームで影を落とす物すべてが影の地図に、裏の層すべてが覗く像にも描かれ、
    序章では描画呼び出しが 345 回になった（予算 300、S-06 のセンサーは読み込み中のフレームにもかける）。不透明の物は、焼いた材質など
    少数の材質を共有していて、視界にある物で作られる。それでもそのフレームの描画呼び出しは、ガラスの物の数で増える
- 単体テスト `glass/warm.test.ts`（5 件: ガラスの見分け、描く間だけガラスとその下の物を間引かない、戻す、例外でも戻す、
  隠れた物は隠れたまま）

## 0.11.0 — 2026-10-23（S-26 焼いた光の受け口）

足しただけ。`load()` の既定の振る舞いは変えていない（焼いた光は `lightmaps: true` のときだけ）。

- `assets/lightmap.ts`（新規）: Blender の焼き込み（`blender/scripts/common/bake.py`）の受け口。
  - glb の書き方: 焼いた物の extras に `lightmap`（glb の中のテクスチャの名前）と `lightmap_scale`（焼いた値を割った倍率）。
    ライトマップは**どの材質も使わない glb のテクスチャ**（案1は KTX2。名前で探す）。泡沫回廊の「glb の外の PNG（extras の
    lightmap が場所）」とは置き場所が違う。泡沫回廊で使うなら `loadLightmaps` を外の画像の読み込みに替えるか、glb に入れる
  - `lightmapOf(extras)`、`lightmapIntensity(scale, gain)`（π × scale × gain。焼いた値は白い拡散面の放射輝度で、three の lightMap は
    放射照度として足され Lambert で π で割られる）
  - `loadLightmaps(gltf)`: 焼いた物が名指すテクスチャを `parser.getDependency('texture', i)` で読み、2つ目の UV（`channel = 1`）、
    sRGB に（KTX2 は自分で sRGB と言う。PNG はここで印をつける。最初に GPU へ上げる前）
  - `applyLightmaps(root, maps)`: 焼いた物（extras のある物かその下のメッシュ。GLTFLoader が材質ごとに分けた子も）の焼いた材質を
    `BakedStandardNodeMaterial` にする（元の材質・光の画像・倍率ごとに 1 つ、共有）。焼いた材質 = `bakesMaterial`: 光を受ける
    材質（standard か physical）で、材質の extras の `bake` が false でない（パイプラインが焼いた物の焼かなかった材質に書く:
    ガラス、光る火・熾火、ガラスの中の泡）、ゲームのガラスの印（`userData.mark`）がない、透過・透明でない。physical の材質
    （clearcoat など）は焼いた版を作れないので実時間のまま残し、`unsupported`（物/材質）で知らせる（ゲームは問題に挙げる）
  - `toBakedMaterial`: 値（Color・Vector）は写し、userData は浅い写し、ノードとテクスチャは共有。aoMap があると焼いた遮蔽に
    もう一度かかる（パイプラインの材質は持たない）
  - `BakedStandardNodeMaterial`（型 `BakedStandardNodeMaterial`: 同じ材質の実時間の版と three が別にコンパイルする）と
    `BakedLightingModel`（`PhysicalLightingModel` の子）: 拡散の光はライトマップだけ。実時間の光は拡散を足さず鏡面（ハイライト）だけ、
    場面のほかの放射照度（半球光）と環境画像の拡散も足さない（焼いた光が持っている）。環境画像の映り込みは、金属でない面では
    焼いた光が開けた空より暗い所で暗くする（作業台の下の棚は空を映さない）。金属は拡散がないので焼いた光は見た目を変えない
    （映り込みを暗くすると、細い管の画素の足りない所が黒い斑になった）。three の内側に頼る: `indirectDiffuse`・`indirectSpecular` が
    `builder.context` の `irradiance`・`radiance`・`iblIrradiance`・`reflectedLight` だけを読むこと、`indirectSpecular` が環境の
    拡散の取り分を `reflectedLight.indirectDiffuse` に足すこと、`direct` が引数の `reflectedLight` に書くこと、材質の光の節点
    （ライトマップ・半球光・環境）が `indirect` より前に組まれること。1つ目が崩れれば例外、ほかは黙って二重や欠けになる。
    three を上げたら `src/core/assets/lightmap.test.ts`（three の PhysicalLightingModel の上で、実時間の光は鏡面だけ・拡散は
    ライトマップだけ・環境は映り込みだけに足されることを、足された節点が何から作られているかで確かめる）と S-26 の e2e
    （実時間の光と環境を消しても焼いた天板の明るさが 9 割以上残る、開けた床の明るさが焼く前の 0.8〜1.25 倍）で確かめる
- `assets/loader.ts`: `load(url, { lightmaps: true })` で、材質の変換の後に上の 2 つを行う。`LoadedAsset.lightmaps`（焼いたメッシュ・
  材質・光の画像・ファイルにない光の画像の物・描けない材質）。光の画像は `textures` にも入り、`dispose()` で放す
- 色の進行への口はまだない: 強さ（`lightMapIntensity`）はスカラーなので、設計書の「色が戻る前後の差は焼き込みではなくゲーム側の
  色の調整で」を焼いた面に出すなら、焼いた光に色を掛ける uniform を足す（エリア1から）
- 単体テスト `assets/lightmap.test.ts`（14 件）

## 0.10.0 — 2026-10-22（S-29 描画先ごとの背景画像）

足しただけで、既存の部品の振る舞いは変えていない。

- `glass/backdrop.ts` に `ownBackdropImage(target)` と `sharesBackdropImage(target)`: **透過を描く描画先に、背景画像の
  大きさの記録を1つずつ持たせる**（three r186 の回避策）。
  - 不具合: three は透過の背景画像を描画先ごとに写す（`ViewportTextureNode` が描画先ごとに `FramebufferTexture` を既定の1枚から
    `clone()` する）。r186 の `Texture.copy` は source を共有するので、全部の描画先が1つの `{ width, height }` を共有する。three は
    コピーの前にその記録と描画先の大きさを比べ、違うときだけ作り直す。そのため2つの描画先が別の時に透過を描き、その間に描画の
    大きさが変わると、先に描いた方が記録を新しい大きさにし、後から描いた方は作り直されず古い大きさのまま残る。
    古い方が小さいと毎フレームのコピーが範囲の外（WebGPU は `Texture copy range … touches outside of [Texture …]` で submit ごと
    捨てられ、画面が黒くなる。WebGL2 は `GL_INVALID_VALUE: glCopyTexSubImage2D`）。大きいとメッセージなしで背景がずれる
  - 直し方: 描画先の背景画像（公開の `ViewportTextureNode.getTextureForReference(target)`、透過の前面が使う
    `viewportOpaqueMipTexture()` の写し）に、image を写した新しい `THREE.TextureSource` を持たせる。r187 の直し
    （mrdoob/three.js#34636、`FramebufferTexture.copy()`）と同じ形。既に分かれていれば何もしない（r187 以上では何もしない）
  - 使う所: 透過を描く描画先が2つ以上あり、別の時に描くとき、なるべく最初に描く前に1回（後から呼んでも、次の描画で背景画像を
    作り直させる）。ゲームではホームの玉の中の像（`src/ui/home/dive-host.ts`）と序章の仕上げの scene pass
    （`src/game/orb/peek-pipeline.ts`）。描画先が1つだけのシーンは要らない
  - 届くのは前面の背景画像だけ。`side: BackSide` の透過と、`forceSinglePass` のない `DoubleSide` の透過（three は先に裏面だけを
    別のパスで描く。RenderList の needsDoublePass）は、three の内側の別の背景画像を読むので、r186 では共有のまま残る。そういう
    ガラスには `forceSinglePass = true` を立てる（前面だけで描く。序章のパネルのガラス `room-art.ts` と同じ）。今のゲームには該当がない
  - 単体テスト（`backdrop.test.ts`）は three 自身の `ViewportTextureNode.updateBefore` を偽の renderer で回し、r186 で後の描画先が
    古い大きさのまま残ること（three を上げて直っていれば落ちる＝回避策を外す合図）と、回避策で上下どちらの変化にも追従することを確かめる
- 最小の再現: `tools/three-repro/s29-backdrop-shared-size.html`（0.186.1 で再現、r187dev で直っている）

## 0.9.0 — 2026-10-22（S-23 glb の読み込み）

追加だけで、既存の部品は変えていない。

- `assets/`（新規）: Blender のパイプラインが書き出した glb を読む（技術設計 > アセット圧縮: glTF ＋ meshopt ＋ KTX2）。
  - `loader.ts` の `createGltfLoader(renderer)`: three の GLTFLoader ＋ MeshoptDecoder（`three/addons/libs/meshopt_decoder.module.js`、
    wasm を内に持つのでバンドルされる）＋ KTX2Loader。WebGPU と WebGL2 の両方で読む（KTX2Loader の `detectSupport` は
    `renderer.init()` の後）。`load(url, { material })` は、読み込んだ材質をすべてノードの材質にして返す（`LoadedAsset`: scene・
    extensionsUsed・gltf・dispose）。`material` は材質の差し替えの口（ゲームが印のついたガラスを自分のガラスにする、など）。
    `loadTranscoder()` は Basis の変換器を今読む（確かめるため。普段は最初の KTX2 のテクスチャで読まれる）
  - Basis の変換器（`basis_transcoder.js`・`.wasm`）は three 自身の写しを使う。three r186 の KTX2Loader は
    `new URL('../libs/basis/…', import.meta.url)` で指していて、Vite は開発サーバーでそのまま配り、ビルドでは `dist/assets/` に
    書き出す（three の版と必ず合う。手で写さない）。別の場所から配るときは `createGltfLoader(renderer, { transcoderPath })`
  - `materials.ts`: `toNodeMaterial`（GLTFLoader が作る従来の材質 → 同じ値のノードの材質。three の `NodeLibrary.fromMaterial` と
    同じく列挙できる値をすべて写し、物理の材質は `followBackdropResize` に通す。S-12 の決まり）、`convertMaterials(root, hook)`
    （同じ材質を共有していた物は変換後も共有する）、`disposeObject(root)`（形・材質・テクスチャを1回ずつ解放）
  - `glb.ts`: `readGlbJson`（.glb の JSON の部分だけを読む。検査や道具のため）
- 注意: gltf-transform の量子化（KHR_mesh_quantization）は、メッシュを [-1, 1] に詰めて大きさを節点の拡大率に入れる。
  そのため物の位置は形の中心へ動き、拡大率は 1 でなくなる。glTF の厚み（KHR_materials_volume）は gltf-transform が拡大率で割って
  あり、three は透過の厚みに拡大率を掛けるので、glTF の値のままなら正しい。メートルで厚みを決める材質を自分で作るときは、
  拡大率で割る（案1の `src/game/assets/glass.ts`）

## 0.8.0 — 2026-10-21（S-22 音の素材の口と、JS で音を合成する部品）

足しただけで、既存の振る舞いは変えていない。

- `audio/bank.ts`（新規）: **音源の口**。`SoundSource` は「合成」（`synth(id, render, { sampleRate? })`: 標本の配列を返す関数）か
  「録音のファイル」（`recording(id, ...urls)`: 同じ音を形式違いで、使いたい順に）のどちらか。`loadBank(ctx, sources, opts)` が
  どちらも `AudioBuffer` にする（合成は文脈の標本化周波数か、音源が求めた周波数で描く。ファイルは先頭から順に読み、最初に
  デコードできたものを使う。どれも駄目なら null にして `onError`〈既定は console.error〉に知らせ、残りは読み続ける。音源ごとに
  `pause`〈既定は setTimeout 0〉を挟み、主スレッドを長く止めない。`signal`〈AbortSignal〉で途中で止められる。止めた後の音は null で知らせない）。再生は `scheduleBuffer`（一度きり。ScheduledVoice を返すので
  エンジンの `startVoice` に渡せる。`rate` と `gain`）と `startLoop`（ループ。開始位置の折り返し、フェードイン、`stop(at, fade)`）。
  合成の仮置きを録音に替えるときは、ゲームの表の `synth(...)` を `recording(...)` に替えるだけでよい
- `audio/dsp.ts`（新規、純粋）: JS で標本を作る部品。`Biquad`（RBJ の low/high/band-pass、1標本ずつ、鳴らしながら係数を変えられる）、
  `decayPerSample`、`peakOf`・`normalizePeak`、`addPartials`（減衰する正弦の和。回転で Math.sin を使わない）、`crossfadeLoop`
  （等パワーで末尾を先頭に重ね、継ぎ目のないループにする）、`fadeEnds`
- ゲームの規則（どの材質の足音か、風鈴の音、どこに置くか）は持たない（このゲームは `src/audio/footsteps.ts`・`ambience.ts`）

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
  - （S-20 で追記、core の変更なし）8フレームごとに読むだけでは足りなかった。垂直同期なし（約600fps）では読み出しが 100 ms〜1.7 秒かかり、
    その間にプールが溢れた。WebGL2 では、読み出しを始めた時点から終わるまでパスごとのタイムスタンプを止め、プールの4分の1が埋まったら
    8フレームを待たずに読む。案2で WebGL2 のタイムスタンプを使うなら `src/dev/timestamp-drain.ts`（core の外）を写す

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
