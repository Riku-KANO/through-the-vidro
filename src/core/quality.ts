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
  origin: 'url' | 'saved' | 'default';
}

/**
 * Which preset the shell creates the scene with (S-43): the URL's `?quality` when it is there (a dev and sensor switch:
 * it wins, as it always did), else the player's saved choice (自動 measures from mid, as `?quality=auto` does), else mid.
 */
export function startQuality(opts: {
  url: { level: QualityLevel; auto: boolean } | null;
  saved: QualityChoice | null;
}): StartQuality {
  if (opts.url) return { level: opts.url.level, auto: opts.url.auto, origin: 'url' };
  if (opts.saved === 'auto') return { level: 'mid', auto: true, origin: 'saved' };
  if (opts.saved) return { level: opts.saved, auto: false, origin: 'saved' };
  return { level: 'mid', auto: false, origin: 'default' };
}

/**
 * The shell's quality, as a scene's settings see it (S-43). The shell (main.ts) hands it to the scene on its context
 * (`qualityPortOf`). A scene that can take another preset in place attaches itself (`attach`); a request then changes
 * the preset in use without making the scene again (品質を変えてもゲームの状態を失わない): the render scale at once, the
 * governor anew (自動 measures again, during play). A scene that has not attached is made again, as before.
 */
export interface QualityPort {
  /** What is chosen now: a preset, or 自動. */
  readonly choice: QualityChoice;
  /** The preset in use (自動's pick, once it has measured). */
  readonly level: QualityLevel;
  /**
   * The preset the scene was made with. Switched in place, a scene changes what it can (the shell: the render scale) and
   * keeps the rest as it was made until it is made again; while `level` differs from this, part of the preset waits.
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
}

/** The shell's port on a scene's context, if the shell gave it one (`{ ...context, qualityPort }`). */
export function qualityPortOf(ctx: object): QualityPort | null {
  const port = (ctx as { qualityPort?: Partial<QualityPort> }).qualityPort;
  return port &&
    typeof port.request === 'function' &&
    typeof port.attach === 'function' &&
    isQualityChoice(port.choice)
    ? (port as QualityPort)
    : null;
}
