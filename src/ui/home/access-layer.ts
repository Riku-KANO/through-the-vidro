/**
 * S-45: two things the home → dive host draws over every screen for the player's settings.
 *  - 簡易トランジション (遷移のルール 1: 0.3秒の白いフェード): one sheet of white over everything (the panel, the pause, the
 *    world's own prompt), as white as the whitest fade running now. Never black: the sheet is white and only ever brightens
 *  - 視点の基準の点 (操作とカメラ > 3D酔い対策: 画面中央の小さな点を表示できる): a small glass bead in the middle of the screen,
 *    only while playing — not on the home, under the pause or the settings, nor during a transition
 * Its probe (window.__vidro.sceneProbe.access) keeps every fade there was, by source, with when it started, was white and
 * ended (tests/e2e/S-45-access.spec.ts measures the 0.3 s from them); `hold` is the only field a test writes.
 */

/** A fade as it ran: performance.now() of its first white frame, its full white, its last; `reversed` if it played back. */
export interface FadeRecord {
  source: string;
  start: number;
  peak: number | null;
  end: number | null;
  reversed: boolean;
}

export interface AccessProbe {
  /** The dot is shown now. */
  reticle: boolean;
  /** How white the screen is now (0..1). */
  white: number;
  /** 簡易トランジション is on. */
  simple: boolean;
  /** The latest fades (at most 40). */
  fades: FadeRecord[];
  /** Dev hold (screenshots): a simple fade of the screens (読み込み→ホーム, 潜る) stands at this point of its time (0..1). */
  hold: number | null;
  /** performance.now() of each time the screen came to full white (the latest 60). */
  peaks: number[];
  /**
   * performance.now() of each top of the screen's white (the latest 60): the frame where it stopped rising and then fell, at any
   * height — the full whites and the fades turned back below them. Every flash.
   */
  tops: number[];
}

/** A white this full is the full white (settings/fade.ts FULL_WHITE). */
const FULL = 0.999;
const MAX_PEAKS = 60;

export interface FadeSource {
  source: string;
  white: number;
  /** The fade plays back (Esc, or the way back). */
  reversed?: boolean;
}

const MAX_FADES = 40;

export interface AccessLayer {
  readonly probe: AccessProbe;
  /** Every frame: the fades running (each source's white), whether the dot belongs on the screen. */
  update(fades: readonly FadeSource[], reticle: boolean, simple: boolean): void;
  dispose(): void;
}

export function createAccessLayer(root: HTMLElement): AccessLayer {
  const sheet = document.createElement('div');
  sheet.className = 'vd-fade';
  sheet.dataset.ui = 'white-fade';
  sheet.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('div');
  dot.className = 'vd-reticle';
  dot.dataset.ui = 'reticle';
  dot.setAttribute('aria-hidden', 'true');
  // the dot under the white (the white covers all)
  root.append(dot, sheet);
  const probe: AccessProbe = {
    reticle: false,
    white: 0,
    simple: false,
    fades: [],
    hold: null,
    peaks: [],
    tops: [],
  };
  const running = new Map<string, FadeRecord>();
  let shownWhite = -1;
  let shownDot = false;
  let wasFull = false;
  let was = 0;
  let wasAt = 0;
  let rising = false;
  return {
    probe,
    update(fades, reticle, simple) {
      const now = performance.now();
      let white = 0;
      for (const f of fades) {
        white = Math.max(white, f.white);
        let r = running.get(f.source);
        if (f.white > 0 && !r) {
          r = { source: f.source, start: now, peak: null, end: null, reversed: false };
          running.set(f.source, r);
          probe.fades.push(r);
          if (probe.fades.length > MAX_FADES) probe.fades.shift();
        }
        if (!r) continue;
        if (f.reversed) r.reversed = true;
        if (f.white >= FULL) r.peak ??= now;
        if (f.white <= 0) {
          r.end = now;
          running.delete(f.source);
        }
      }
      const w = Math.round(white * 1000) / 1000;
      if (w !== shownWhite) {
        shownWhite = w;
        sheet.style.opacity = String(w);
        sheet.classList.toggle('is-on', w > 0);
      }
      if (reticle !== shownDot) {
        shownDot = reticle;
        dot.classList.toggle('is-on', reticle);
      }
      // each coming to full white (from below it) is a flash
      const full = white >= FULL;
      if (full && !wasFull) {
        probe.peaks.push(now);
        if (probe.peaks.length > MAX_PEAKS) probe.peaks.shift();
      }
      wasFull = full;
      if (white < was && rising) {
        probe.tops.push(wasAt);
        if (probe.tops.length > MAX_PEAKS) probe.tops.shift();
      }
      if (white !== was) rising = white > was;
      was = white;
      wasAt = now;
      probe.white = white;
      probe.reticle = reticle;
      probe.simple = simple;
    },
    dispose() {
      sheet.remove();
      dot.remove();
    },
  };
}
