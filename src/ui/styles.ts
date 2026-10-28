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
  /**
   * Scales with the viewport height (20px at 1080p), never below the 18px minimum of 文字と色; and with the settings'
   * text size (--vd-text: 1, 1.2, 1.4 — アクセシビリティ: 文字の大きさを3段階で, S-43).
   */
  fontSize: 'calc(max(18px, 1.85vh) * var(--vd-text, 1))',
  /** 数字と英字は細身のサンセリフ (文字と色). */
  numerals: '"Helvetica Neue", "Segoe UI", "Hiragino Sans", system-ui, sans-serif',
} as const;

/** S-45: a key's name — its letters in the thin sans-serif (数字と英字), its Japanese words (右クリック) in the Mincho. */
const KEY_FONT = `"Helvetica Neue", "Segoe UI", ${FONT_STACK.ja}`;

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
/* the settings are open over the home (S-43): the drops step aside under the panel */
.vd-home.is-veiled .vd-drop > * { opacity: 0; transition: opacity 0.25s ${UI_TOKENS.ease}; }
.vd-home.is-unveiling .vd-drop > * { transition: opacity 0.25s ${UI_TOKENS.ease}; }

/* ---- pause (S-42): a breath of frost from the middle, the items written on it with a finger ----
   No ancestor of a frosted part may have opacity, a filter or a mask: it would cut the frost off from the backdrop. */
.vd-pause { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
.vd-pause.is-up { visibility: visible; pointer-events: auto; }
/* 息を吹きかけたような曇り: white 10–18 % over the blurred, dimmed picture, spreading from the middle (--r) */
.vd-pause__breath { position: absolute; inset: 0;
  background: radial-gradient(ellipse 70% 65% at 50% 50%, rgba(255, 255, 255, 0.17), rgba(255, 255, 255, 0.12) 60%,
    rgba(255, 255, 255, 0.1));
  -webkit-backdrop-filter: blur(var(--blur, 12px)) brightness(0.8) saturate(0.85);
  backdrop-filter: blur(var(--blur, 12px)) brightness(0.8) saturate(0.85);
  --mask: radial-gradient(circle at 50% 52%, #000 var(--core, 0px), transparent var(--r, 0px)),
    radial-gradient(circle at 45% 48%, #000 calc(var(--core, 0px) * 0.85), transparent calc(var(--r, 0px) * 0.92)),
    radial-gradient(circle at 56% 47%, #000 calc(var(--core, 0px) * 0.8), transparent calc(var(--r, 0px) * 0.88));
  -webkit-mask-image: var(--mask); mask-image: var(--mask); }
.vd-pause__breath.is-full { -webkit-mask-image: none; mask-image: none;
  transition: background 0.3s ${UI_TOKENS.ease}, -webkit-backdrop-filter 0.3s ${UI_TOKENS.ease},
    backdrop-filter 0.3s ${UI_TOKENS.ease}; }
/* the settings open over the pause (S-43): the items step aside and the breath thins, so the picture shows through */
.vd-pause.is-yielded .vd-pause__page, .vd-pause.is-yielded .vd-pause__note { visibility: hidden; }
.vd-pause.is-yielded .vd-pause__breath { background: rgba(255, 255, 255, 0.03);
  -webkit-backdrop-filter: blur(1.5px) brightness(0.94); backdrop-filter: blur(1.5px) brightness(0.94); }
.vd-pause__page { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex;
  flex-direction: column; align-items: center; gap: 0.85em; margin: 0;
  font-size: calc(max(22px, 2.5vh) * var(--vd-text, 1)); }
.vd-pause__page[hidden] { display: none; }
.vd-pause__choices { display: flex; gap: 1.1em; }
.vd-pause__ask { margin: 0; }
.vd-pause__item { padding: 0; border: 0; background: none; cursor: pointer; outline: none; }
/* the frosted tag grows with its words (英語版: 札は文字の長さに合わせて伸びる) */
.vd-pause__tag { position: relative; display: inline-block; padding: 0.36em 1.35em 0.42em; border-radius: 999px;
  white-space: nowrap; opacity: var(--tag, 1); transform: translateY(0) scale(1);
  -webkit-backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.74);
  backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.74);
  transition: transform 0.26s ${UI_TOKENS.ease}, background-color 0.26s ${UI_TOKENS.ease},
    box-shadow 0.26s ${UI_TOKENS.ease}; }
.vd-pause__ask .vd-pause__tag { font-size: 0.86em; background: rgba(255, 255, 255, 0.1); }
/* 指でなぞった文字: the ink shows from the left as far as the finger has gone (--w), a light at the finger (--tip) */
.vd-pause__line { position: relative; display: inline-block; }
.vd-pause__ink { display: inline-block; text-shadow: 0 0 0.5em rgba(255, 238, 210, 0.3), 0 1px 2px rgba(20, 26, 34, 0.35);
  --edge: calc(var(--w, 1) * (100% + 0.8em));
  -webkit-mask-image: linear-gradient(90deg, #000 calc(var(--edge) - 0.8em), transparent var(--edge));
  mask-image: linear-gradient(90deg, #000 calc(var(--edge) - 0.8em), transparent var(--edge)); }
.vd-pause__tip { position: absolute; top: -12%; bottom: -12%; width: 1em; pointer-events: none;
  left: calc(var(--w, 1) * (100% + 0.8em) - 0.9em); opacity: var(--tip, 0);
  background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(255, 246, 222, 0.95), rgba(255, 226, 170, 0.45) 45%,
    rgba(255, 226, 170, 0) 72%); }
/* hover swells (表面張力), focus lights from inside (選択中の項目は、内部に光が灯る), a choice sinks (細部の振る舞い) */
.vd-pause__item .vd-pause__ink { opacity: 0.84; transition: opacity 0.26s ${UI_TOKENS.ease}; }
.vd-pause__item .vd-pause__tag::before { content: ''; position: absolute; inset: -10% 4%; border-radius: 999px; opacity: 0;
  pointer-events: none; transition: opacity 0.3s ${UI_TOKENS.ease};
  background: radial-gradient(ellipse 60% 70% at 50% 55%, rgba(255, 236, 196, 0.5), rgba(255, 220, 160, 0.16) 55%,
    rgba(255, 220, 160, 0) 75%); }
.vd-pause__item.is-hover .vd-pause__tag { transform: translateY(0) scale(1.07); }
.vd-pause__item.is-focus .vd-pause__tag { background-color: rgba(255, 255, 255, 0.24);
  border-color: rgba(255, 240, 214, 0.6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 0 26px rgba(255, 222, 160, 0.5), 0 6px 24px rgba(20, 30, 45, 0.18); }
.vd-pause__item.is-focus .vd-pause__tag::before { opacity: 1; }
.vd-pause__item.is-focus .vd-pause__ink { opacity: 1;
  text-shadow: 0 0 0.6em rgba(255, 232, 186, 0.9), 0 1px 2px rgba(20, 26, 34, 0.35); }
.vd-pause__item.is-pressed .vd-pause__tag { transform: translateY(0.12em) scale(0.93); }
/* the small line about the mouse (Esc の直後は固定し直せないことがある) */
.vd-pause__note { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); margin: 0;
  font-size: ${UI_TOKENS.fontSize}; white-space: nowrap; }
.vd-pause__note > span { display: inline-block; padding: 0.3em 1.1em 0.34em; border-radius: 999px; opacity: var(--note, 0); }

/* ---- settings (S-43): a pane of frosted glass spreading sideways (--open), the tabs and the settings on it ----
   The pane (glass) is the only frosted part: the body over it is revealed by a clip-path and holds no backdrop filter. */
.vd-settings { position: absolute; top: 50%; right: max(4vw, 16px); transform: translateY(-50%);
  width: min(calc(100vw - 32px), max(30em, 38vw)); visibility: hidden; pointer-events: none; --open: 0; }
/* 英語版: the words run longer (札は文字の長さに合わせて伸びる): a slightly wider pane and closer tabs keep them on one line
   (without covering more of the picture behind) */
.vd-root:lang(en) .vd-settings { width: min(calc(100vw - 32px), max(32em, 40vw)); }
.vd-root:lang(en) .vd-settings button.vd-settings__tab { padding-left: 0.6em; padding-right: 0.6em; letter-spacing: 0.04em; }
.vd-settings.is-up { visibility: visible; }
.vd-settings.is-interactive { pointer-events: auto; }
.vd-settings__glass { position: absolute; inset: 0; border-radius: 1.3em; background: rgba(255, 255, 255, 0.13);
  -webkit-backdrop-filter: blur(16px) brightness(0.74) saturate(0.9); backdrop-filter: blur(16px) brightness(0.74) saturate(0.9);
  border: 1px solid rgba(255, 255, 255, 0.26);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.38), 0 10px 40px rgba(10, 16, 26, 0.28);
  transform: scaleX(var(--open)); transform-origin: 50% 50%; }
.vd-settings__body { position: relative; display: flex; flex-direction: column; gap: 0.8em; padding: 1em 1.4em 1.1em;
  clip-path: inset(0 calc((1 - var(--open)) * 50%) round 1.3em);
  opacity: clamp(0, calc((var(--open) - 0.3) * 1.5), 1);
  text-shadow: 0 1px 2px rgba(20, 26, 34, 0.4); }
.vd-settings button { padding: 0; border: 0; background: none; cursor: pointer; outline: none; }
.vd-settings__tabs { display: flex; flex-wrap: wrap; gap: 0.35em 0.5em; padding-bottom: 0.7em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18); }
.vd-settings button.vd-settings__tab { padding: 0.28em 0.95em 0.32em; border-radius: 999px; border: 1px solid transparent;
  opacity: 0.74; white-space: nowrap;
  transition: transform 0.26s ${UI_TOKENS.ease}, opacity 0.26s ${UI_TOKENS.ease}, background-color 0.26s ${UI_TOKENS.ease},
    box-shadow 0.26s ${UI_TOKENS.ease}; }
.vd-settings button.vd-settings__tab.is-shown { opacity: 1; background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.32); }
.vd-settings__page { display: flex; flex-direction: column; gap: 0.3em; }
.vd-settings__page[hidden] { display: none; }
.vd-settings__row { display: flex; align-items: center; justify-content: space-between; gap: 0.6em 1.2em; flex-wrap: wrap;
  padding: 0.42em 0.8em; border-radius: 0.8em; outline: none; border: 1px solid transparent;
  transition: background-color 0.26s ${UI_TOKENS.ease}, box-shadow 0.26s ${UI_TOKENS.ease}; }
.vd-settings__label { white-space: nowrap; }
.vd-settings__control { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.4em;
  margin-left: auto; }
/* focus lights from inside (選択中の項目は、内部に光が灯る) */
.vd-settings button.vd-settings__tab.is-focus, .vd-settings__row.is-focus { background-color: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 240, 214, 0.55); opacity: 1;
  box-shadow: inset 0 0 18px rgba(255, 226, 170, 0.22), 0 0 22px rgba(255, 222, 160, 0.4); }
/* the options: small frosted tags; the chosen one is lit */
.vd-settings button.vd-settings__chip { padding: 0.2em 0.85em 0.26em; border-radius: 999px; white-space: nowrap;
  border: 1px solid rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.07);
  transition: transform 0.26s ${UI_TOKENS.ease}, background-color 0.26s ${UI_TOKENS.ease}, box-shadow 0.26s ${UI_TOKENS.ease}; }
.vd-settings button.vd-settings__option.is-chosen { background: rgba(255, 242, 218, 0.28); border-color: rgba(255, 240, 214, 0.78);
  box-shadow: 0 0 14px rgba(255, 222, 160, 0.42); }
/* hover swells (表面張力), a choice sinks (細部の振る舞い) */
.vd-settings .is-hover { transform: scale(1.07); }
.vd-settings .is-pressed { transform: translateY(0.1em) scale(0.93); }
/* a slider: a groove of clear glass, a drop riding it (--at: 0..1) */
.vd-settings__track { position: relative; display: inline-block; width: 10.5em; height: 1.5em; cursor: pointer;
  touch-action: none; --at: 0; transition: transform 0.26s ${UI_TOKENS.ease}; }
.vd-settings__track.is-hover { transform: scale(1.04); }
.vd-settings__groove { position: absolute; left: 0; right: 0; top: 50%; height: 0.34em; transform: translateY(-50%);
  border-radius: 999px; background: rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 1px 2px rgba(10, 20, 30, 0.4), 0 1px 0 rgba(255, 255, 255, 0.22); }
.vd-settings__fill { position: absolute; left: 0; top: 50%; height: 0.34em; width: calc(var(--at) * 100%);
  transform: translateY(-50%); border-radius: 999px;
  background: linear-gradient(90deg, rgba(255, 232, 196, 0.2), rgba(255, 236, 204, 0.62)); }
.vd-settings__bead { position: absolute; top: 50%; left: calc(var(--at) * 100%); width: 1.15em; height: 1.15em;
  transform: translate(-50%, -50%); border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, rgba(255, 255, 255, 0.95) 0 9%, rgba(255, 255, 255, 0.3) 16%,
    rgba(214, 232, 240, 0.2) 52%, rgba(160, 200, 190, 0.36) 86%, rgba(230, 250, 244, 0.6) 100%);
  box-shadow: inset 0 -2px 5px rgba(255, 255, 255, 0.35), inset 0 2px 6px rgba(40, 70, 80, 0.25),
    0 3px 10px rgba(10, 20, 30, 0.25); }
.vd-settings__row.is-focus .vd-settings__bead { box-shadow: inset 0 -2px 5px rgba(255, 255, 255, 0.45),
  inset 0 2px 6px rgba(40, 70, 80, 0.2), 0 0 16px rgba(255, 228, 180, 0.6); }
.vd-settings__value { min-width: 3.4em; text-align: right; font-family: ${UI_TOKENS.numerals}; font-weight: 300;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.vd-settings__foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5em 1em;
  padding-top: 0.7em; border-top: 1px solid rgba(255, 255, 255, 0.16); }
.vd-settings__keys { opacity: 0.78; }
.vd-settings__notice { position: absolute; left: 50%; top: calc(100% + 0.7em); transform: translateX(-50%); margin: 0;
  padding: 0.3em 1.1em 0.34em; border-radius: 999px; white-space: nowrap; opacity: var(--notice, 0);
  background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 244, 226, 0.5);
  -webkit-backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.62); backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.62); }
.vd-settings__notice[hidden] { display: none; }
/* under 品質, while part of the preset waits for the next time */
.vd-settings__hint { margin: -0.1em 0.8em 0.2em; opacity: 0.82; text-align: right; }
.vd-settings__hint[hidden] { display: none; }
/* a frosted tag reached by Tab (the 戻る button): lit like a focused row */
.vd-settings button.vd-settings__chip:focus-visible { border-color: rgba(255, 240, 214, 0.75);
  box-shadow: 0 0 16px rgba(255, 222, 160, 0.5); }

/* ---- コントラスト強化 (アクセシビリティ, S-43): the glass's edges thicker and brighter, the frost behind the text denser ---- */
.vd-root.vd-contrast { text-shadow: 0 1px 3px rgba(8, 12, 18, 0.7); }
.vd-contrast .vd-frost { background: rgba(16, 22, 30, 0.62); border: 2px solid rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.5); backdrop-filter: blur(${UI_TOKENS.frostBlur}) brightness(0.5); }
.vd-contrast .vd-drop__bead { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), inset 0 2px 6px rgba(40, 70, 80, 0.25); }
.vd-contrast .vd-pause__breath { background: rgba(10, 14, 20, 0.42); }
.vd-contrast .vd-pause__tag { background-color: rgba(16, 22, 30, 0.62); border: 2px solid rgba(255, 255, 255, 0.82); }
.vd-contrast .vd-settings__glass { background: rgba(12, 18, 26, 0.74); border: 2px solid rgba(255, 255, 255, 0.85);
  -webkit-backdrop-filter: blur(16px) brightness(0.5); backdrop-filter: blur(16px) brightness(0.5); }
.vd-contrast .vd-settings button.vd-settings__chip, .vd-contrast .vd-settings button.vd-settings__tab.is-shown {
  border: 2px solid rgba(255, 255, 255, 0.78); }
.vd-contrast .vd-settings__row.is-focus, .vd-contrast .vd-settings button.vd-settings__tab.is-focus {
  border: 2px solid rgba(255, 240, 214, 0.95); }
.vd-contrast .vd-settings__groove { background: rgba(255, 255, 255, 0.3); box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.7); }
/* the chosen tag is told by its shape too (色だけに頼らない): a second ring, a brighter fill */
.vd-contrast .vd-settings button.vd-settings__option.is-chosen { background: rgba(255, 244, 222, 0.42);
  border-color: rgba(255, 236, 190, 1); box-shadow: 0 0 0 2px rgba(16, 22, 30, 0.9), 0 0 0 4px rgba(255, 236, 190, 0.95); }

/* ---- S-45 キーの割り当て: a page on the same pane — a list of frosted tags, the one that waits breathing ----
   In place of the tabs and the tab's rows (a page of its own); a little wider, so the keys' names fit. Every word at the
   UI's size (文字と色: 最小18px). */
.vd-settings.is-keys { width: min(calc(100vw - 32px), max(33em, 44vw)); }
.vd-root:lang(en) .vd-settings.is-keys { width: min(calc(100vw - 32px), max(35em, 46vw)); }
.vd-settings.is-keys .vd-settings__tabs { display: none; }
.vd-settings button.vd-settings__open { margin-left: auto; }
.vd-keys { gap: 0.3em; }
.vd-keys__title { margin: 0; letter-spacing: 0.12em; }
/* two lines always (how to use it, or what it waits for; how to go back): the pane does not jump while a cell waits */
.vd-keys__hint { margin: 0 0 0.2em; min-height: 2.7em; opacity: 0.8; line-height: 1.35; white-space: pre-line; }
.vd-keys__hint.is-waiting { opacity: 1; color: #fff6e6; }
.vd-keys__list { display: flex; flex-direction: column; gap: 0.14em; max-height: calc(100vh - 12.5em); overflow-y: auto;
  overscroll-behavior: contain; padding: 0.15em 0.2em; scrollbar-width: thin; }
/* the names' column as wide as the longest name of the language (置く・拾う・調べる; Place / pick up / touch), the same in every row */
.vd-keys__row { display: grid; grid-template-columns: 10.2em repeat(3, minmax(0, 1fr)); align-items: center;
  gap: 0.35em; }
.vd-root:lang(en) .vd-keys__row { grid-template-columns: 12.2em repeat(3, minmax(0, 1fr)); }
.vd-keys__head { padding: 0 0.2em; opacity: 0.72; }
.vd-keys__colhead { text-align: center; white-space: nowrap; }
.vd-keys__action { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vd-settings button.vd-keys__cell, .vd-keys__cell { display: block; box-sizing: border-box; width: 100%;
  padding: 0.06em 0.45em 0.1em; border-radius: 999px;
  line-height: 1.35; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: ${KEY_FONT}; font-weight: 300; letter-spacing: 0.03em; }
.vd-keys__cell--fixed { opacity: 0.62; border: 1px dashed rgba(255, 255, 255, 0.28); font-family: inherit; }
.vd-keys__row--fixed .vd-keys__action { opacity: 0.72; }
.vd-settings button.vd-keys__cell.is-focus, .vd-settings button.vd-keys__button.is-focus {
  background-color: rgba(255, 255, 255, 0.2); border-color: rgba(255, 240, 214, 0.75);
  box-shadow: inset 0 0 12px rgba(255, 226, 170, 0.25), 0 0 16px rgba(255, 222, 160, 0.45); }
/* the cell that waits for its key: lit, its light breathing slowly (under once a second: nothing blinks) */
.vd-settings button.vd-keys__cell.is-waiting { background-color: rgba(255, 242, 218, 0.3); border-color: rgba(255, 240, 214, 0.9);
  animation: vd-keys-wait 1.6s ${UI_TOKENS.ease} infinite alternate; }
@keyframes vd-keys-wait { from { box-shadow: 0 0 8px rgba(255, 222, 160, 0.3); } to { box-shadow: 0 0 20px rgba(255, 222, 160, 0.7); } }
.vd-keys__notice { margin: 0.1em 0 0; padding: 0.22em 0.9em 0.26em; border-radius: 0.8em; background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 244, 226, 0.4); line-height: 1.35; }
.vd-keys__notice[hidden] { display: none; }
.vd-keys__foot { display: flex; justify-content: space-between; gap: 0.5em 1em; padding-top: 0.5em;
  border-top: 1px solid rgba(255, 255, 255, 0.16); }
.vd-settings__foot[hidden] { display: none; }
.vd-contrast .vd-settings button.vd-keys__cell.is-focus, .vd-contrast .vd-settings button.vd-keys__button.is-focus {
  border: 2px solid rgba(255, 240, 214, 0.95); }
.vd-contrast .vd-keys__cell--fixed { border: 2px dashed rgba(255, 255, 255, 0.7); opacity: 0.85; }

/* ---- S-45 視点の基準の点 (3D酔い対策): a small glass bead in the middle of the screen while playing ---- */
.vd-reticle { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  z-index: 40; pointer-events: none; opacity: 0; transition: opacity 0.15s ${UI_TOKENS.ease};
  background: radial-gradient(circle at 34% 30%, rgba(255, 255, 255, 0.95) 0 18%, rgba(255, 255, 255, 0.4) 34%,
    rgba(214, 232, 240, 0.28) 62%, rgba(230, 250, 244, 0.7) 100%);
  box-shadow: 0 0 0 1px rgba(20, 30, 40, 0.35), 0 1px 3px rgba(10, 20, 30, 0.45); }
.vd-reticle.is-on { opacity: 0.92; }
.vd-contrast .vd-reticle { box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.95), 0 0 0 3px rgba(10, 14, 20, 0.85); }

/* ---- S-45 簡易トランジション (遷移のルール 1): a white sheet over everything, as white as the fade (never black) ---- */
.vd-fade { position: absolute; inset: 0; z-index: 50; pointer-events: none; opacity: 0; visibility: hidden;
  background: #f7f5f0; }
.vd-fade.is-on { visibility: visible; }
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
