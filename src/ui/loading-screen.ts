import { glassEase, segment } from '../core/transition';
import type { StringKey } from './lang';

const SVG = 'http://www.w3.org/2000/svg';
/** Vessel geometry in its 120×150 viewBox: a round-bottomed flask (body r=40 at y=96, neck x 50..70). */
const BRIM_Y = 16;
const BOTTOM_Y = 136;
const OUTLINE = 'M50 14 L50 57.3 A40 40 0 1 0 70 57.3 L70 14';
/** How fast the shown light may rise (fraction per second), so a quick load still reads as filling. */
const FILL_RATE = 1.1;
/** 「はじめる」 floats up over this many seconds once the vessel is full. */
const START_APPEAR_SECONDS = 0.6;

export interface LoadingState {
  /** Real loading progress 0..1. */
  progress: number;
  ready: boolean;
  /** Opening transition: the vessel brims over and fades (0..1). */
  overflow: number;
  /** Whether the start drop may be pressed (loading screen, no transition). */
  interactive: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * 読み込み画面 (UI/UX設計 > 画面ごとの設計): 白い霧の中に小さなガラスの器があり、読み込みに合わせて光で満ちていく。
 * 満ちたら「はじめる」が浮かぶ。The fog itself is the 3D mist; `backdrop` only covers the first frames.
 */
export class LoadingScreen {
  readonly el: HTMLElement;
  readonly startButton: HTMLButtonElement;
  private readonly backdrop: HTMLElement;
  private readonly vessel: HTMLElement;
  private readonly glow: HTMLElement;
  private readonly light: SVGRectElement;
  private readonly surfaceLine: SVGPathElement;
  private shownFill = 0;
  private startAppear = 0;
  private focused = false;
  private time = 0;

  constructor(root: HTMLElement, t: (k: StringKey) => string, onStart: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'vd-loading';
    this.el.dataset.ui = 'loading';

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'vd-loading__backdrop';
    this.el.appendChild(this.backdrop);

    this.vessel = document.createElement('div');
    this.vessel.className = 'vd-vessel';
    this.vessel.setAttribute('role', 'progressbar');
    this.vessel.setAttribute('aria-label', t('loadingLabel'));
    this.vessel.setAttribute('aria-valuemin', '0');
    this.vessel.setAttribute('aria-valuemax', '100');
    this.glow = document.createElement('div');
    this.glow.className = 'vd-vessel__glow';
    this.vessel.appendChild(this.glow);

    const s = svg('svg', { viewBox: '0 0 120 150', 'aria-hidden': 'true' });
    const defs = svg('defs', {});
    const clip = svg('clipPath', { id: 'vd-vessel-inside' });
    clip.appendChild(svg('path', { d: `${OUTLINE} Z` }));
    const grad = svg('linearGradient', { id: 'vd-vessel-light', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svg('stop', { offset: '0', 'stop-color': '#fffaf0', 'stop-opacity': 0.98 }));
    grad.appendChild(svg('stop', { offset: '0.5', 'stop-color': '#ffe7bf', 'stop-opacity': 0.9 }));
    grad.appendChild(svg('stop', { offset: '1', 'stop-color': '#f8c98a', 'stop-opacity': 0.85 }));
    defs.append(clip, grad);
    s.appendChild(defs);

    // glass body: faint fill, a blue-grey shadow line so the edge reads on white fog, a green edge, a white line
    s.appendChild(svg('path', { d: `${OUTLINE} Z`, fill: 'rgba(255,255,255,0.10)' }));
    const inside = svg('g', { 'clip-path': 'url(#vd-vessel-inside)' });
    this.light = svg('rect', { x: 0, y: BOTTOM_Y, width: 120, height: 0, fill: 'url(#vd-vessel-light)' });
    this.surfaceLine = svg('path', {
      d: '',
      fill: 'none',
      stroke: '#fffdf6',
      'stroke-width': 1.6,
      opacity: 0.9,
    });
    inside.append(this.light, this.surfaceLine);
    s.appendChild(inside);
    for (const [stroke, width] of [
      ['rgba(70,92,112,0.38)', 3.2],
      ['rgba(160,214,192,0.55)', 2.2],
      ['rgba(255,255,255,0.92)', 1.1],
    ] as const) {
      s.appendChild(
        svg('path', { d: OUTLINE, fill: 'none', stroke, 'stroke-width': width, 'stroke-linejoin': 'round' }),
      );
    }
    s.appendChild(
      svg('ellipse', {
        cx: 60,
        cy: 14,
        rx: 12.5,
        ry: 2.6,
        fill: 'none',
        stroke: 'rgba(255,255,255,0.9)',
        'stroke-width': 1.1,
      }),
    );
    s.appendChild(
      svg('path', {
        d: 'M31 92 A30 30 0 0 1 45 66',
        fill: 'none',
        stroke: 'rgba(255,255,255,0.75)',
        'stroke-width': 2.4,
        'stroke-linecap': 'round',
      }),
    );
    s.appendChild(
      svg('path', {
        d: 'M54 20 L54 50',
        stroke: 'rgba(255,255,255,0.55)',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
      }),
    );
    this.vessel.appendChild(s);
    this.el.appendChild(this.vessel);

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'vd-drop';
    this.startButton.dataset.ui = 'loading-start';
    this.startButton.innerHTML =
      '<span class="vd-drop__bead" data-part="bead"><span class="vd-drop__light"></span></span>' +
      '<span class="vd-drop__label vd-frost vd-frost--on-light"></span>';
    const label = this.startButton.querySelector('.vd-drop__label');
    if (label) label.textContent = t('loadingStart');
    this.startButton.addEventListener('click', () => onStart());
    this.startButton.addEventListener('focus', () => this.startButton.classList.add('is-focus'));
    this.startButton.addEventListener('blur', () => this.startButton.classList.remove('is-focus'));
    this.startButton.addEventListener('pointerenter', () => this.startButton.classList.add('is-hover'));
    this.startButton.addEventListener('pointerleave', () => this.startButton.classList.remove('is-hover'));
    this.el.appendChild(this.startButton);
    root.appendChild(this.el);
  }

  /** Light shown in the vessel (0..1); follows the real progress, never faster than FILL_RATE. */
  get fill(): number {
    return this.shownFill;
  }

  get full(): boolean {
    return this.shownFill >= 1;
  }

  /** The 3D mist is on screen: let it show through. */
  hideBackdrop(): void {
    this.backdrop.classList.add('is-hidden');
  }

  /** Visual press on the start drop (sinks instead of bursting). */
  press(): void {
    this.startButton.classList.add('is-pressed');
  }

  update(dt: number, state: LoadingState): void {
    this.time += dt;
    const target = state.ready ? 1 : Math.min(0.97, state.progress);
    this.shownFill = Math.min(target, this.shownFill + FILL_RATE * dt);
    const fill = Math.max(this.shownFill, state.overflow > 0 ? 1 : 0);

    const level = BOTTOM_Y - fill * (BOTTOM_Y - BRIM_Y);
    this.light.setAttribute('y', level.toFixed(2));
    this.light.setAttribute('height', (150 - level).toFixed(2));
    const w = 1.4 * (1 - state.overflow) * Math.min(1, fill * 8);
    const a = this.time * 2.2;
    this.surfaceLine.setAttribute(
      'd',
      `M8 ${(level + Math.sin(a) * w).toFixed(2)} Q34 ${(level - w).toFixed(2)} 60 ${(level + Math.sin(a + 1.4) * w).toFixed(2)} T112 ${(level + Math.sin(a + 2.6) * w).toFixed(2)}`,
    );
    this.vessel.setAttribute('aria-valuenow', String(Math.round(fill * 100)));

    // overflow: light spills past the brim into the fog, the vessel thins away
    const spill = state.overflow;
    const glowScale = 0.75 + fill * 0.35 + spill * spill * 5.5;
    const glowAlpha = (0.25 + fill * 0.55) * (1 - segment(spill, 0.35, 1));
    this.glow.style.transform = `scale(${glowScale.toFixed(3)})`;
    this.glow.style.opacity = glowAlpha.toFixed(3);
    const fade = 1 - segment(spill, 0.4, 0.95);
    this.vessel.style.opacity = fade.toFixed(3);
    this.vessel.style.transform = `translateY(${(-10 * spill).toFixed(2)}px) scale(${(1 + 0.04 * spill).toFixed(3)})`;

    const wantStart = this.full && state.ready ? 1 : 0;
    const step = dt / START_APPEAR_SECONDS;
    this.startAppear = wantStart
      ? Math.min(1, this.startAppear + step)
      : Math.max(0, this.startAppear - step);
    const appear = glassEase(this.startAppear) * (1 - segment(spill, 0, 0.45));
    this.startButton.style.setProperty('--appear', appear.toFixed(3));
    this.startButton.style.transform = `translate(-50%, ${((1 - appear) * 12).toFixed(2)}px)`;
    const pressable = state.interactive && wantStart === 1;
    this.startButton.style.pointerEvents = pressable ? 'auto' : 'none';
    this.startButton.tabIndex = pressable ? 0 : -1;
    if (pressable && !this.focused) {
      this.focused = true;
      this.startButton.focus({ preventScroll: true });
    }
    if (!pressable) {
      this.focused = false;
      if (spill === 0) this.startButton.classList.remove('is-pressed');
    }
    this.el.style.visibility = fade <= 0 && appear <= 0 && spill >= 1 ? 'hidden' : 'visible';
  }

  dispose(): void {
    this.el.remove();
  }
}
