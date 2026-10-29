/**
 * Quality presets from the design doc (技術設計 > 品質プリセット).
 * Pure data: scenes and systems read these values, nothing here touches the GPU.
 */
export type QualityLevel = 'low' | 'mid' | 'high';

export interface QualityPreset {
  /** Render resolution scale relative to the canvas size × devicePixelRatio. */
  renderScale: number;
  /**
   * Resolution of the transmission background buffer relative to the render size (design value).
   * Has no effect on three r186 (S-10): the backdrop is always copied at the size of the render target, so only
   * renderScale and dynamic resolution change it. Kept for the design table and a future three option.
   */
  transmissionScale: number;
  /** Resolution of the back-layer target while peeking. */
  peekScale: number;
  /** Where chromatic dispersion is allowed. */
  dispersion: 'none' | 'orb' | 'showcase';
  /** Shadow map size for moving objects. 0 = baked only. */
  dynamicShadowSize: 0 | 1024 | 2048;
  /** Far glass uses the cheap env-reflection + haze path unless this is true. */
  farGlassTransmission: boolean;
  antialias: 'fxaa' | 'smaa';
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, Readonly<QualityPreset>>> = {
  low: {
    renderScale: 0.67,
    transmissionScale: 0.25,
    peekScale: 0.5,
    dispersion: 'none',
    dynamicShadowSize: 0,
    farGlassTransmission: false,
    antialias: 'fxaa',
  },
  mid: {
    renderScale: 0.85,
    transmissionScale: 0.5,
    peekScale: 0.6,
    dispersion: 'orb',
    dynamicShadowSize: 1024,
    farGlassTransmission: false,
    antialias: 'smaa',
  },
  high: {
    renderScale: 1.0,
    transmissionScale: 1.0,
    peekScale: 0.75,
    dispersion: 'showcase',
    dynamicShadowSize: 2048,
    farGlassTransmission: true,
    antialias: 'smaa',
  },
};

export function isQualityLevel(value: unknown): value is QualityLevel {
  return value === 'low' || value === 'mid' || value === 'high';
}

/**
 * What a player can choose (設定 > 画質: 自動・低・中・高). 自動 measures the frame times and picks a preset
 * (技術設計 > 品質プリセット: 推奨プリセットを自動で選びます).
 */
export const QUALITY_CHOICES = ['auto', 'low', 'mid', 'high'] as const;
export type QualityChoice = (typeof QUALITY_CHOICES)[number];

export function isQualityChoice(value: unknown): value is QualityChoice {
  return value === 'auto' || isQualityLevel(value);
}

/** The preset the shell starts with, whether 自動 then measures, and where that came from. */
export interface StartQuality {
  level: QualityLevel;
  auto: boolean;
  /** The URL's `?quality`, the player's saved choice, or neither (S-48: 自動, the first time). */
  origin: 'url' | 'saved' | 'default';
  /** S-48: the level is the one 自動 picked on an earlier visit (kept by the shell: `keepsAutoPick`). */
  picked: boolean;
}

/**
 * Which preset the shell creates the scene with (S-43, S-48): the URL's `?quality` when it is there (a dev and sensor
 * switch: it wins, as it always did); else, for a measurement (`bench`: 計測は固定のプリセットで), mid; else the player's
 * saved preset; else 自動 — chosen and kept, or never chosen (技術設計 > 品質プリセット: 初回起動時に最初の10秒間のフレーム時間を
 * 測り、推奨プリセットを自動で選びます) — built from the preset it picked the last time (`pick`), or from mid, and measured again.
 */
export function startQuality(opts: {
  url: { level: QualityLevel; auto: boolean } | null;
  saved: QualityChoice | null;
  /** S-48: what 自動 picked on an earlier visit, if anything. */
  pick?: QualityLevel | null;
  /** S-48: a measurement (?bench): neither the saved choice nor the pick is read. */
  bench?: boolean;
}): StartQuality {
  if (opts.url) return { level: opts.url.level, auto: opts.url.auto, origin: 'url', picked: false };
  if (opts.bench) return { level: 'mid', auto: false, origin: 'default', picked: false };
  if (opts.saved && opts.saved !== 'auto')
    return { level: opts.saved, auto: false, origin: 'saved', picked: false };
  const pick = opts.pick ?? null;
  return {
    level: pick ?? 'mid',
    auto: true,
    origin: opts.saved === 'auto' ? 'saved' : 'default',
    picked: pick !== null,
  };
}

/**
 * S-48: whether 自動 runs, once the scene is made. The first time (nothing chosen) only for the game itself (`game`: a scene
 * that takes presets in place and says it is the game, `QualityScene.game`): a dev scene keeps the preset it was made with,
 * as before S-48. 自動 asked for — the URL's, or the player's kept — runs either way.
 */
export function governorAuto(start: StartQuality, game: boolean): boolean {
  return start.auto && (start.origin !== 'default' || game);
}

/**
 * S-48: whether a frame (and its GPU time) goes to the governor. Not while the picture stands still (S-43: the pause holds
 * it). While the player's 自動 measures (or verifies its pick), only the frames of the game itself (`drawsGame`): 推奨は
 * ゲームの絵を描いている間の計測で決める, not from the light home orb. Once it has measured, every frame that moves goes on
 * to dynamic resolution, as before; the URL's `?quality=auto` measures as it always did (M0's path).
 */
export function governorTakesFrame(o: {
  idle: boolean;
  drawsGame: boolean;
  /** The governor measures or verifies (not steady). */
  measuring: boolean;
  /** The governor is the player's (the settings, a kept choice, the first time's 自動), not the URL's. */
  player: boolean;
}): boolean {
  return !o.idle && (o.drawsGame || !o.measuring || !o.player);
}

/**
 * S-48: whether the shell keeps what 自動 picked, for the next visit to be built from it (選ばれたプリセットを保存して次は
 * そこから作る): the player's 自動 only — not a preset the player chose, not the URL's (a dev switch), never a measurement —
 * and only as measured in the game (`game`: `QualityScene.game`; 推奨はゲームの絵を描いている間の計測で決める), not in a dev
 * scene (its load is not the game's).
 */
export function keepsAutoPick(o: {
  player: boolean;
  choice: QualityChoice;
  bench: boolean;
  game: boolean;
}): boolean {
  return o.player && o.choice === 'auto' && !o.bench && o.game;
}

/**
 * S-48: whether part of `inUse` waits until the scene is made again, the scene having been made with `made`. Switched in
 * place, the render scale (and dynamic resolution's range), the peek image's scale and the finishing's anti-aliasing change
 * at once (発案者 2026-10-28); the shadow map's size and the glass's way of drawing (dispersion, far glass transmission) are
 * built into the scene's lights and materials and wait.
 */
export function waitsForRebuild(made: Readonly<QualityPreset>, inUse: Readonly<QualityPreset>): boolean {
  return (
    made.dynamicShadowSize !== inUse.dynamicShadowSize ||
    made.dispersion !== inUse.dispersion ||
    made.farGlassTransmission !== inUse.farGlassTransmission
  );
}

/**
 * The shell's quality, as a scene's settings see it (S-43). The shell (main.ts) hands it to the scene on its context
 * (`SceneContext.qualityPort`, S-48). A scene that can take another preset in place attaches itself (`attach`); a request
 * then changes the preset in use without making the scene again (品質を変えてもゲームの状態を失わない): the render scale at
 * once, the scene what it can (`QualityScene.applyQuality`), the governor anew (自動 measures again, during play). A scene
 * that has not attached is made again, as before.
 */
export interface QualityPort {
  /** What is chosen now: a preset, or 自動. */
  readonly choice: QualityChoice;
  /** The preset in use (自動's pick, once it has measured). */
  readonly level: QualityLevel;
  /**
   * The preset the scene was made with. Switched in place, a scene changes what it can (the shell: the render scale) and
   * keeps the rest as it was made until it is made again; while `level` differs from this, part of the preset waits
   * (`waitsForRebuild`).
   */
  readonly sceneLevel: QualityLevel;
  request(choice: QualityChoice): void;
  /** The scene takes presets in place, and says when its picture stands still. Returns the detach. */
  attach(scene: QualityScene): () => void;
}

/** A scene's side of the port (S-43). */
export interface QualityScene {
  /**
   * Another preset, without being made again. The shell has set the render scale before it calls; the scene changes
   * what else it can, and keeps the rest of what it was built with.
   */
  applyQuality(level: QualityLevel, preset: Readonly<QualityPreset>): void;
  /**
   * The picture stands still (the pause holds it): the shell gives none of these frames, nor their GPU time, to the
   * governor (S-42's 提案4: no new render scale while nothing moves).
   */
  readonly idle: boolean;
  /**
   * S-48: the picture is the game itself (standing in it), not a screen around it (the loading, the home's orb, the dive):
   * the player's 自動 measures these frames only (`governorTakesFrame`). Left out: every frame is the game's.
   */
  readonly drawsGame?: boolean;
  /**
   * S-48: the scene is the game (not a dev scene that takes presets in place too, as S-04's placeholder city does): the
   * first time's 自動 runs, and its pick is kept, only for it (`governorAuto`, `keepsAutoPick`). Read when it attaches and
   * when 自動 is chosen. Left out: not the game.
   */
  readonly game?: boolean;
}
