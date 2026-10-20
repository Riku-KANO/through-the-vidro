/**
 * `?pause=<id>:<t>,<t>/<id>:<t>` — checkpoints (seconds into a transition) where the autoplay script
 * stops so a test can take a screenshot of that exact pose. Example:
 *   ?autoplay=1&pause=loading-home:0,0.75,1.5/home-game:0,0.5,1,1.5,2
 */
export function parsePauseSpec(spec: string | null): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!spec) return out;
  for (const part of spec.split('/')) {
    const [id, list] = part.split(':');
    if (!id || !list) continue;
    const times = list
      .split(',')
      .map((s) => (s.trim() === '' ? Number.NaN : Number(s)))
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);
    if (times.length) out.set(id, times);
  }
  return out;
}

/** Autoplay script timings (seconds). Presentation only; not design values. */
export const AUTOPLAY = {
  /** How long 「はじめる」 stays on screen before the script presses it. */
  loadingDwell: 1.2,
  /** How long the script looks at the home screen before choosing 「はじめる」. */
  homeDwell: 1.4,
} as const;
