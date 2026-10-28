import { describe, expect, it } from 'vitest';
import { glassEase } from '../../core/transition';
import {
  CONTROLS,
  keyCommand,
  PANEL_SECONDS,
  PANEL_START,
  type PanelFocus,
  PanelTimeline,
  padCommands,
  pickOption,
  pickTab,
  rowAt,
  rowValue,
  SETTINGS_ROWS,
  SETTINGS_TABS,
  setSlider,
  sliderFraction,
  stepPanel,
} from './settings-logic';
import { defaultSettings, type Settings } from './settings-model';

const base: Settings = { ...defaultSettings({ lang: 'ja' }), quality: 'mid' };

function run(t: PanelTimeline, seconds: number, step = 1 / 120): void {
  for (let left = seconds; left > 1e-9; left -= step) t.update(Math.min(step, left));
}

describe('the tabs and rows (画面ごとの設計: 設定 — タブは画質 / 操作 / 音 / 表示とアクセシビリティ)', () => {
  it('has the four tabs in the design’s order', () => {
    expect(SETTINGS_TABS).toEqual(['graphics', 'controls', 'sound', 'display']);
  });

  it('puts the settings under them (S-45: the key page last under 操作, the rest of accessibility after コントラスト強化)', () => {
    expect(SETTINGS_ROWS.graphics).toEqual(['quality', 'fov']);
    expect(SETTINGS_ROWS.controls).toEqual(['peekMode', 'sensitivity', 'invertY', 'keys']);
    expect(SETTINGS_ROWS.sound).toEqual(['master', 'sfx', 'ambience', 'ui']);
    expect(SETTINGS_ROWS.display).toEqual([
      'lang',
      'textSize',
      'contrast',
      'headBob',
      'reticle',
      'distortion',
      'reduceFlashes',
      'simpleTransitions',
    ]);
  });

  it('S-45: 歩行の揺れ and 覗いたときの歪み are sliders 0..100 % (100 = as before); the point, the flashes and the fades toggles', () => {
    for (const row of ['headBob', 'distortion'] as const) {
      const c = CONTROLS[row];
      expect(c.kind).toBe('slider');
      if (c.kind === 'slider') {
        expect(c.min).toBe(0);
        expect(c.max).toBe(1);
      }
      expect(rowValue(base, row)).toBe(1);
    }
    for (const row of ['reticle', 'reduceFlashes', 'simpleTransitions'] as const) {
      expect(CONTROLS[row].kind).toBe('toggle');
      expect(rowValue(base, row)).toBe(false);
    }
    expect(CONTROLS.keys.kind).toBe('page');
  });

  it('品質 is 自動・低・中・高; 視野角 60〜100 度', () => {
    expect(CONTROLS.quality).toEqual({ kind: 'choice', options: ['auto', 'low', 'mid', 'high'] });
    const fov = CONTROLS.fov;
    expect(fov.kind).toBe('slider');
    if (fov.kind === 'slider') {
      expect(fov.min).toBe(60);
      expect(fov.max).toBe(100);
    }
    expect(CONTROLS.peekMode).toEqual({ kind: 'choice', options: ['hold', 'toggle'] });
    expect(CONTROLS.lang).toEqual({ kind: 'choice', options: ['ja', 'en'] });
    expect(CONTROLS.invertY.kind).toBe('toggle');
    expect(CONTROLS.contrast.kind).toBe('toggle');
  });
});

describe('stepPanel: moving (キーボード・パッド操作)', () => {
  it('opens on the tab strip; left / right go through the tabs, around the ends', () => {
    expect(PANEL_START).toEqual({ tab: 0, row: -1 });
    let f: PanelFocus = PANEL_START;
    const s = stepPanel(f, base, 'right');
    expect(s.focus).toEqual({ tab: 1, row: -1 });
    expect(s.tabChanged).toBe(true);
    expect(s.moved).toBe(true);
    f = stepPanel(PANEL_START, base, 'left').focus;
    expect(f).toEqual({ tab: 3, row: -1 });
  });

  it('down goes from the tabs into the rows and through them; up comes back to the tabs', () => {
    let f = stepPanel(PANEL_START, base, 'down').focus;
    expect(f).toEqual({ tab: 0, row: 0 });
    f = stepPanel(f, base, 'down').focus;
    expect(f).toEqual({ tab: 0, row: 1 });
    // the last row stays
    const last = stepPanel(f, base, 'down');
    expect(last.focus).toEqual({ tab: 0, row: 1 });
    expect(last.moved).toBe(false);
    f = stepPanel(stepPanel(f, base, 'up').focus, base, 'up').focus;
    expect(f).toEqual({ tab: 0, row: -1 });
  });

  it('Enter on the tab strip goes into its rows', () => {
    expect(stepPanel({ tab: 2, row: -1 }, base, 'choose').focus).toEqual({ tab: 2, row: 0 });
  });

  it('Q / E (LB / RB) change the tab from anywhere, staying in the rows', () => {
    const s = stepPanel({ tab: 1, row: 2 }, base, 'nextTab');
    expect(s.focus.tab).toBe(2);
    expect(s.focus.row).toBe(2);
    expect(stepPanel({ tab: 0, row: 1 }, base, 'prevTab').focus).toEqual({ tab: 3, row: 1 });
    // fewer rows on the new tab: the last of them
    expect(stepPanel({ tab: 3, row: 6 }, base, 'nextTab').focus).toEqual({ tab: 0, row: 1 });
    expect(stepPanel({ tab: 0, row: -1 }, base, 'nextTab').focus).toEqual({ tab: 1, row: -1 });
  });

  it('Esc / B closes the panel (one step back), from anywhere', () => {
    expect(stepPanel(PANEL_START, base, 'back').close).toBe(true);
    expect(stepPanel({ tab: 2, row: 1 }, base, 'back').close).toBe(true);
    expect(stepPanel({ tab: 2, row: 1 }, base, 'down').close).toBe(false);
  });

  it('rowAt names the focused row', () => {
    expect(rowAt(PANEL_START)).toBeNull();
    expect(rowAt({ tab: 0, row: 1 })).toBe('fov');
    expect(rowAt({ tab: 2, row: 3 })).toBe('ui');
  });
});

describe('stepPanel: changing (変更は即時反映)', () => {
  it('left / right step a choice, stopping at its ends', () => {
    const q = { tab: 0, row: 0 };
    const s = stepPanel(q, base, 'right');
    expect(s.settings.quality).toBe('high');
    expect(s.changed).toBe('quality');
    const end = stepPanel(q, s.settings, 'right');
    expect(end.settings.quality).toBe('high');
    expect(end.changed).toBeNull();
    expect(stepPanel(q, base, 'left').settings.quality).toBe('low');
  });

  it('Enter goes round a choice, and flips a toggle', () => {
    const q = { tab: 0, row: 0 };
    const high = { ...base, quality: 'high' as const };
    expect(stepPanel(q, high, 'choose').settings.quality).toBe('auto');
    const inv = { tab: 1, row: 2 };
    const s = stepPanel(inv, base, 'choose');
    expect(s.settings.invertY).toBe(true);
    expect(s.changed).toBe('invertY');
    // a toggle reads オフ | オン: left is off, right is on
    expect(stepPanel(inv, s.settings, 'left').settings.invertY).toBe(false);
    expect(stepPanel(inv, s.settings, 'right').changed).toBeNull();
  });

  it('left / right move a slider by its step, within its range', () => {
    const fov = { tab: 0, row: 1 };
    const up = stepPanel(fov, base, 'right');
    expect(up.settings.fov).toBe(75);
    expect(up.changed).toBe('fov');
    expect(stepPanel(fov, { ...base, fov: 100 }, 'right').changed).toBeNull();
    expect(stepPanel(fov, { ...base, fov: 61 }, 'left').settings.fov).toBe(60);
    const vol = { tab: 2, row: 2 };
    expect(stepPanel(vol, base, 'left').settings.volumes.ambience).toBeCloseTo(
      base.volumes.ambience - 0.05,
      9,
    );
    expect(stepPanel({ tab: 1, row: 1 }, base, 'right').settings.mouseSensitivity).toBeCloseTo(1.25, 9);
  });

  it('nothing changes on the tab strip', () => {
    expect(stepPanel(PANEL_START, base, 'right').changed).toBeNull();
    expect(stepPanel(PANEL_START, base, 'right').settings).toEqual(base);
  });

  it('a change leaves every other setting as it was', () => {
    const s = stepPanel({ tab: 3, row: 0 }, base, 'right').settings;
    expect(s.lang).toBe('en');
    expect({ ...s, lang: base.lang }).toEqual(base);
  });

  it('rowValue reads what a row shows', () => {
    expect(rowValue(base, 'quality')).toBe('mid');
    expect(rowValue(base, 'fov')).toBe(70);
    expect(rowValue(base, 'contrast')).toBe(false);
    expect(rowValue(base, 'ui')).toBe(1);
  });

  it('S-45: the new rows step as the others do', () => {
    const bob = { tab: 3, row: 3 };
    const less = stepPanel(bob, base, 'left');
    expect(less.changed).toBe('headBob');
    expect(less.settings.headBob).toBeCloseTo(0.75, 9);
    expect(stepPanel(bob, { ...base, headBob: 0 }, 'left').changed).toBeNull();
    expect(setSlider(base, 'distortion', 0).distortion).toBe(0);
    const flashes = stepPanel({ tab: 3, row: 6 }, base, 'choose');
    expect(flashes.changed).toBe('reduceFlashes');
    expect(flashes.settings.reduceFlashes).toBe(true);
    expect(stepPanel({ tab: 3, row: 7 }, base, 'right').settings.simpleTransitions).toBe(true);
    expect(stepPanel({ tab: 3, row: 4 }, base, 'right').settings.reticle).toBe(true);
  });

  it('S-45: the key page’s row opens its page on Enter / A; left / right change nothing there', () => {
    const keys = { tab: 1, row: 3 };
    expect(rowAt(keys)).toBe('keys');
    const s = stepPanel(keys, base, 'choose');
    expect(s.page).toBe('keys');
    expect(s.changed).toBeNull();
    expect(s.close).toBe(false);
    expect(stepPanel(keys, base, 'right').changed).toBeNull();
    expect(stepPanel(keys, base, 'right').page).toBeUndefined();
    expect(stepPanel({ tab: 1, row: 2 }, base, 'choose').page).toBeUndefined();
  });
});

describe('the mouse (ホバーで膨らんで鳴る、クリックで選ぶ)', () => {
  it('pickTab shows a tab, the focus on its strip', () => {
    const s = pickTab({ tab: 0, row: 1 }, 2);
    expect(s.focus).toEqual({ tab: 2, row: -1 });
    expect(s.tabChanged).toBe(true);
    expect(pickTab({ tab: 2, row: -1 }, 2).tabChanged).toBe(false);
  });

  it('pickOption sets a choice or a toggle to the option clicked, focusing its row', () => {
    const s = pickOption(PANEL_START, base, 'peekMode', 'toggle');
    expect(s.settings.peekMode).toBe('toggle');
    expect(s.changed).toBe('peekMode');
    expect(s.focus).toEqual({ tab: 1, row: 0 });
    expect(pickOption(PANEL_START, base, 'contrast', true).settings.contrast).toBe(true);
    // an option that is not the row's is ignored
    expect(pickOption(PANEL_START, base, 'quality', 'ultra').changed).toBeNull();
  });

  it('setSlider puts a slider where the pointer is along it (0..1), on its fine step', () => {
    expect(setSlider(base, 'fov', 0).fov).toBe(60);
    expect(setSlider(base, 'fov', 1).fov).toBe(100);
    expect(setSlider(base, 'fov', 0.5).fov).toBe(80);
    expect(setSlider(base, 'fov', 0.513).fov).toBe(81);
    expect(setSlider(base, 'master', 0.333).volumes.master).toBeCloseTo(0.33, 9);
    expect(setSlider(base, 'master', 2).volumes.master).toBe(1);
    expect(sliderFraction(base, 'fov')).toBeCloseTo(0.25, 9);
  });
});

describe('keyCommand / padCommands', () => {
  it('reads arrows and WASD, Enter and Space, Esc and Backspace, Q / E and PageUp / PageDown for the tabs', () => {
    expect(keyCommand({ key: 'ArrowUp', code: 'ArrowUp' })).toBe('up');
    expect(keyCommand({ key: 'ArrowDown', code: 'ArrowDown' })).toBe('down');
    expect(keyCommand({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('left');
    expect(keyCommand({ key: 'd', code: 'KeyD' })).toBe('right');
    expect(keyCommand({ key: 'Enter', code: 'Enter' })).toBe('choose');
    expect(keyCommand({ key: ' ', code: 'Space' })).toBe('choose');
    expect(keyCommand({ key: 'Escape', code: 'Escape' })).toBe('back');
    expect(keyCommand({ key: 'Backspace', code: 'Backspace' })).toBe('back');
    expect(keyCommand({ key: 'q', code: 'KeyQ' })).toBe('prevTab');
    expect(keyCommand({ key: 'e', code: 'KeyE' })).toBe('nextTab');
    expect(keyCommand({ key: 'PageUp', code: 'PageUp' })).toBe('prevTab');
    expect(keyCommand({ key: 'PageDown', code: 'PageDown' })).toBe('nextTab');
    expect(keyCommand({ key: 'Tab', code: 'Tab' })).toBeNull();
  });

  it('turns new pad presses into commands: 十字, A, B (Start too goes back), LB / RB the tabs', () => {
    const none = new Set<string>();
    expect(padCommands(none, new Set(['PadUp']))).toEqual(['up']);
    expect(padCommands(none, new Set(['PadRight']))).toEqual(['right']);
    expect(padCommands(none, new Set(['PadA']))).toEqual(['choose']);
    expect(padCommands(none, new Set(['PadB']))).toEqual(['back']);
    expect(padCommands(none, new Set(['PadStart']))).toEqual(['back']);
    expect(padCommands(none, new Set(['PadLB']))).toEqual(['prevTab']);
    expect(padCommands(none, new Set(['PadRB']))).toEqual(['nextTab']);
    expect(padCommands(new Set(['PadB']), new Set(['PadB']))).toEqual([]);
  });
});

describe('PanelTimeline (トランジション設計: 設定パネル — 曇りガラスが横に広がり、閉じると縮んで消える 0.3秒)', () => {
  it('opens in 0.3 s on the glass curve, and takes commands once it is open', () => {
    expect(PANEL_SECONDS).toBe(0.3);
    const t = new PanelTimeline();
    expect(t.phase).toBe('closed');
    expect(t.open()).toBe(true);
    expect(t.phase).toBe('opening');
    run(t, 0.15);
    expect(t.value).toBeCloseTo(glassEase(0.5), 3);
    expect(t.interactive).toBe(false);
    run(t, 0.16);
    expect(t.value).toBe(1);
    expect(t.phase).toBe('open');
    expect(t.interactive).toBe(true);
  });

  it('answers at once: it has moved within 0.1 s', () => {
    const t = new PanelTimeline();
    t.open();
    run(t, 0.1);
    expect(t.value).toBeGreaterThan(0.02);
  });

  it('closes by playing the opening back (縮んで消える), in 0.3 s', () => {
    const t = new PanelTimeline();
    t.open();
    run(t, 0.3);
    expect(t.close()).toBe(true);
    expect(t.phase).toBe('closing');
    run(t, 0.15);
    expect(t.value).toBeCloseTo(glassEase(0.5), 3);
    run(t, 0.16);
    expect(t.value).toBe(0);
    expect(t.phase).toBe('closed');
  });

  it('turned back half way, it goes back from where it is (no jump)', () => {
    const t = new PanelTimeline();
    t.open();
    run(t, 0.1);
    const at = t.value;
    t.close();
    expect(t.value).toBeCloseTo(at, 9);
    run(t, 0.05);
    expect(t.value).toBeLessThan(at);
    t.open();
    run(t, 0.3);
    expect(t.phase).toBe('open');
  });

  it('can be held part way through the opening (screenshots), and goes on from there', () => {
    const t = new PanelTimeline();
    t.open();
    t.holdAt(0.15);
    expect(t.value).toBeCloseTo(glassEase(0.5), 6);
    expect(t.phase).toBe('opening');
    run(t, 0.16);
    expect(t.phase).toBe('open');
  });

  it('does not close what is closed, nor open what is open', () => {
    const t = new PanelTimeline();
    expect(t.close()).toBe(false);
    t.open();
    run(t, 0.3);
    expect(t.open()).toBe(false);
  });

  it('S-45 簡易トランジション: a white fade of 0.3 s, the pane all there from its middle (no spreading)', () => {
    const t = new PanelTimeline();
    t.simple = true;
    expect(t.white).toBe(0);
    t.open();
    run(t, 0.075);
    expect(t.value).toBe(0);
    expect(t.white).toBeCloseTo(0.5, 2);
    run(t, 0.08);
    expect(t.value).toBe(1);
    expect(t.white).toBeGreaterThan(0.9);
    expect(t.interactive).toBe(false);
    run(t, 0.15);
    expect(t.phase).toBe('open');
    expect(t.white).toBe(0);
    expect(t.interactive).toBe(true);
    // closing: the same fade, the pane gone from its middle
    t.close();
    run(t, 0.16);
    expect(t.value).toBe(0);
    expect(t.white).toBeGreaterThan(0.85);
    run(t, 0.15);
    expect(t.phase).toBe('closed');
    expect(t.white).toBe(0);
  });

  it('S-45 簡易トランジション: answers at once (white within 0.1 s), and plays back from where it is (Esc は常に)', () => {
    const t = new PanelTimeline();
    t.simple = true;
    t.open();
    run(t, 0.05);
    const w = t.white;
    expect(w).toBeGreaterThan(0.2);
    t.close();
    expect(t.white).toBeCloseTo(w, 9);
    run(t, 0.06);
    expect(t.phase).toBe('closed');
    expect(t.value).toBe(0);
  });

  it('S-45: switched to simple while open, it closes by the white fade; the glass fade has no white', () => {
    const t = new PanelTimeline();
    t.open();
    run(t, 0.3);
    expect(t.white).toBe(0);
    t.simple = true;
    expect(t.value).toBe(1);
    t.close();
    run(t, 0.2);
    expect(t.value).toBe(0);
    expect(t.white).toBeGreaterThan(0);
  });
});
