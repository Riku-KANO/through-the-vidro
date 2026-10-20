import { GLASS_EASE_CSS } from '../core/transition';
import { FONT_STACK, type Lang } from './lang';

/**
 * Shared look of the DOM UI (UI/UX設計 > UIの原則, 文字と色):
 *  - text: warm near-white grey, thin Mincho, at least 18px at 1080p
 *  - behind every text: frosted glass (white 10–18% with the background blurred)
 *  - motion: the common glass curve
 */
export const UI_TOKENS = {
  ink: '#f2ede5',
  frost: 'rgba(255, 255, 255, 0.14)',
  frostBlur: '14px',
  ease: GLASS_EASE_CSS,
  /** Scales with the viewport height (20px at 1080p), never below the 18px minimum of 文字と色. */
  fontSize: 'max(18px, 1.85vh)',
} as const;

const CSS = `
.vd-root { position: absolute; inset: 0; pointer-events: none; color: ${UI_TOKENS.ink};
  font-size: ${UI_TOKENS.fontSize}; font-weight: 300; letter-spacing: 0.08em;
  -webkit-font-smoothing: antialiased; user-select: none; }
.vd-root button { font: inherit; color: inherit; letter-spacing: inherit; }

/* frosted glass behind text (UIの原則 5) */
.vd-frost { background: ${UI_TOKENS.frost}; -webkit-backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.86);
  backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.86); border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 6px 24px rgba(20, 30, 45, 0.18); }

/* on white fog a white frost has no contrast: the same frosted glass, smoked */
.vd-frost--on-light { background: rgba(62, 78, 96, 0.2); -webkit-backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.6);
  backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.6); text-shadow: 0 1px 2px rgba(30, 40, 52, 0.35); }

/* ---- loading ---- */
.vd-loading { position: absolute; inset: 0; }
.vd-loading__backdrop { position: absolute; inset: 0; opacity: 1; transition: opacity 0.5s ${UI_TOKENS.ease};
  background: radial-gradient(120% 90% at 50% 45%, #eef2f5 0%, #dde4ea 55%, #c6d0d8 100%); }
.vd-loading__backdrop.is-hidden { opacity: 0; }
.vd-vessel { position: absolute; left: 50%; top: 44%; width: 120px; height: 150px; margin: -95px 0 0 -60px;
  will-change: transform, opacity; }
.vd-vessel svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.vd-vessel__glow { position: absolute; left: 50%; top: 64%; width: 150px; height: 150px; margin: -75px 0 0 -75px;
  border-radius: 50%; pointer-events: none; will-change: transform, opacity;
  background: radial-gradient(circle, rgba(255, 246, 226, 0.95) 0%, rgba(255, 232, 196, 0.5) 32%,
    rgba(255, 236, 210, 0.12) 58%, rgba(255, 240, 220, 0) 72%); }

/* ---- drops (雫) ---- */
.vd-drop { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 0.7em; padding: 0;
  border: 0; background: none; cursor: pointer; pointer-events: auto; outline: none; white-space: nowrap; }
/* the drop's parts fade, not the drop itself: an ancestor with opacity < 1 would cut the frost off from the backdrop */
.vd-drop > * { opacity: var(--appear, 1); }
.vd-drop__bead { position: relative; flex: none; width: 1.55em; height: 1.55em; border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, rgba(255, 255, 255, 0.95) 0 9%, rgba(255, 255, 255, 0.28) 16%,
    rgba(214, 232, 240, 0.16) 52%, rgba(160, 200, 190, 0.32) 86%, rgba(230, 250, 244, 0.55) 100%);
  box-shadow: inset 0 -2px 5px rgba(255, 255, 255, 0.35), inset 0 2px 6px rgba(40, 70, 80, 0.25),
    0 3px 10px rgba(10, 20, 30, 0.22);
  transform: scale(1); transition: transform 0.26s ${UI_TOKENS.ease}, box-shadow 0.26s ${UI_TOKENS.ease}; }
.vd-drop__light { position: absolute; inset: 18%; border-radius: 50%; opacity: 0;
  background: radial-gradient(circle, rgba(255, 244, 214, 1) 0%, rgba(255, 220, 160, 0.6) 45%, rgba(255, 220, 160, 0) 72%);
  transition: opacity 0.3s ${UI_TOKENS.ease}; }
.vd-drop__label { padding: 0.32em 0.95em 0.36em; border-radius: 999px; transition: background-color 0.26s ${UI_TOKENS.ease}; }
.vd-drop.is-hover .vd-drop__bead { transform: scale(1.24); }
.vd-drop.is-focus .vd-drop__light, .vd-drop:focus-visible .vd-drop__light { opacity: 1; }
.vd-drop.is-focus .vd-drop__bead { box-shadow: inset 0 -2px 5px rgba(255, 255, 255, 0.45),
  inset 0 2px 6px rgba(40, 70, 80, 0.2), 0 0 18px rgba(255, 228, 180, 0.55); }
.vd-drop.is-focus .vd-drop__label { background-color: rgba(255, 255, 255, 0.2); }
/* chosen: sinks instead of bursting (細部の振る舞い) */
.vd-drop.is-pressed .vd-drop__bead { transform: translateY(0.18em) scale(0.86); }

.vd-loading .vd-drop { left: 50%; top: calc(44% + 78px); }
.vd-home { position: absolute; inset: 0; margin: 0; padding: 0; }
`;

/** Injects the shared stylesheet once and returns a root element for one screen set. */
export function createUiRoot(parent: HTMLElement, lang: Lang): { root: HTMLElement; dispose(): void } {
  const style = document.createElement('style');
  style.dataset.vidro = 'ui';
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.className = 'vd-root';
  root.lang = lang;
  root.style.fontFamily = FONT_STACK[lang];
  parent.appendChild(root);
  return {
    root,
    dispose() {
      root.remove();
      style.remove();
    },
  };
}
