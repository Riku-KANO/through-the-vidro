import { isQualityLevel, type QualityLevel } from './quality';

/**
 * URL switches shared by every scene.
 *   ?scene=<name>     which sandbox scene to load (none = scene list)
 *   ?bench=<seconds>  measure frame times after warm-up, then expose results on window.__vidro
 *   ?quality=low|mid|high
 *   ?webgl=1          force the WebGL2 backend (to test the fallback path)
 *   ?stats=1          show the perf overlay
 */
export interface AppParams {
  scene: string | null;
  benchSeconds: number | null;
  warmupSeconds: number;
  quality: QualityLevel;
  forceWebGL: boolean;
  stats: boolean;
  raw: URLSearchParams;
}

const SCENE_NAME = /^[a-z0-9-]+$/;

export function parseParams(search: string): AppParams {
  const raw = new URLSearchParams(search);
  const scene = raw.get('scene');
  const bench = Number(raw.get('bench'));
  const warmup = Number(raw.get('warmup'));
  const quality = raw.get('quality');
  return {
    scene: scene && SCENE_NAME.test(scene) ? scene : null,
    benchSeconds: Number.isFinite(bench) && bench > 0 ? Math.min(bench, 120) : null,
    warmupSeconds: Number.isFinite(warmup) && warmup >= 0 && raw.has('warmup') ? Math.min(warmup, 30) : 1,
    quality: isQualityLevel(quality) ? quality : 'mid',
    forceWebGL: raw.get('webgl') === '1',
    stats: raw.get('stats') === '1',
    raw,
  };
}
