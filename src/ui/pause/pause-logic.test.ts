import { describe, expect, it } from 'vitest';
import { glassEase } from '../../core/transition';
import {
  CONFIRM_ITEMS,
  focusedItem,
  keyCommand,
  lineWriting,
  MENU_START,
  PAUSE_ITEMS,
  PAUSE_SECONDS,
  type PauseMenu,
  PauseTimeline,
  padCommands,
  pickItem,
  stepMenu,
} from './pause-logic';

/** Runs the timeline for `seconds` in small steps. */
function run(t: PauseTimeline, seconds: number, step = 1 / 120): void {
  for (let left = seconds; left > 1e-9; left -= step) t.update(Math.min(step, left));
}

describe('PAUSE_SECONDS (トランジション設計 > 遷移の一覧)', () => {
  it('stops the time in 0.4 s, writes in 0.3 s, clears in 0.3 s', () => {
    expect(PAUSE_SECONDS).toEqual({ stop: 0.4, write: 0.3, clear: 0.3 });
  });
});

describe('PauseTimeline: ゲーム → ポーズ (時間が0.4秒かけてゆっくり止まり、曇りが中心から広がり、文字が書かれる)', () => {
  it('starts closed, at full speed', () => {
    const t = new PauseTimeline();
    expect(t.phase).toBe('closed');
    expect(t.timeScale).toBe(1);
    expect(t.frost).toBe(0);
    expect(t.writing).toBe(0);
    expect(t.interactive).toBe(false);
  });

  it('slows the time to a stop over 0.4 s on the glass curve while the frost spreads', () => {
    const t = new PauseTimeline();
    expect(t.open()).toBe(true);
    expect(t.phase).toBe('opening');
    for (const at of [0.1, 0.2, 0.3]) {
      run(t, 0.1);
      expect(t.timeScale).toBeCloseTo(1 - glassEase(at / 0.4), 3);
      expect(t.frost).toBeCloseTo(glassEase(at / 0.4), 3);
      expect(t.writing).toBe(0);
    }
    run(t, 0.1);
    expect(t.timeScale).toBe(0);
    expect(t.frost).toBe(1);
  });

  it('answers at once: the frost has moved within 0.1 s of the request', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.1);
    expect(t.frost).toBeGreaterThan(0.02);
    expect(t.timeScale).toBeLessThan(0.98);
  });

  it('writes the items over the next 0.3 s, once the frost has spread, then is open', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.4);
    expect(t.writing).toBe(0);
    run(t, 0.15);
    expect(t.writing).toBeGreaterThan(0.3);
    expect(t.writing).toBeLessThan(0.7);
    expect(t.phase).toBe('opening');
    run(t, 0.16);
    expect(t.writing).toBe(1);
    expect(t.phase).toBe('open');
  });

  it('takes commands once the frost is all there (while the text is being written too)', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.3);
    expect(t.interactive).toBe(false);
    run(t, 0.12);
    expect(t.interactive).toBe(true);
  });

  it('ignores a second open while it is up', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.2);
    const frost = t.frost;
    expect(t.open()).toBe(false);
    expect(t.frost).toBe(frost);
  });
});

describe('PauseTimeline: ポーズ → ゲーム (曇りが外側から晴れ、時間が動き出す 0.3秒、開くときの逆再生)', () => {
  const opened = (): PauseTimeline => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.8);
    return t;
  };

  it('clears in 0.3 s, the same curve played back, and the time runs again', () => {
    const t = opened();
    expect(t.close()).toBe(true);
    expect(t.phase).toBe('closing');
    run(t, 0.15);
    // halfway through the clearing is halfway back along the opening's time
    expect(t.frost).toBeCloseTo(glassEase(0.5), 3);
    expect(t.timeScale).toBeCloseTo(1 - glassEase(0.5), 3);
    run(t, 0.15);
    expect(t.frost).toBe(0);
    expect(t.timeScale).toBe(1);
    expect(t.phase).toBe('closed');
  });

  it('takes the text away first (gone in the first half of the clearing)', () => {
    const t = opened();
    t.close();
    run(t, 0.15);
    expect(t.writing).toBe(0);
    expect(t.interactive).toBe(false);
  });

  it('closing in the middle of the opening goes back from where the frost is, without a jump', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.2);
    const frost = t.frost;
    t.close();
    t.update(1 / 240);
    expect(t.frost).toBeLessThanOrEqual(frost);
    expect(frost - t.frost).toBeLessThan(0.05);
    run(t, 0.3);
    expect(t.phase).toBe('closed');
  });

  it('opening again in the middle of the clearing goes on from where the frost is', () => {
    const t = opened();
    t.close();
    run(t, 0.1);
    const frost = t.frost;
    expect(t.open()).toBe(true);
    t.update(1 / 240);
    expect(t.frost).toBeGreaterThanOrEqual(frost);
    expect(t.frost - frost).toBeLessThan(0.05);
  });

  it('closes only what is up', () => {
    const t = new PauseTimeline();
    expect(t.close()).toBe(false);
    expect(t.leave()).toBe(false);
  });
});

describe('PauseTimeline: タイトルへ', () => {
  it('leaves by clearing like the close, the time running again behind it', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.8);
    expect(t.leave()).toBe(true);
    expect(t.phase).toBe('leaving');
    run(t, 0.3);
    expect(t.phase).toBe('closed');
    expect(t.frost).toBe(0);
    expect(t.timeScale).toBe(1);
  });

  it('writes a new page from the start (the confirmation is written like the items)', () => {
    const t = new PauseTimeline();
    t.open();
    run(t, 0.8);
    t.rewrite();
    expect(t.writing).toBe(0);
    expect(t.interactive).toBe(true);
    run(t, 0.31);
    expect(t.writing).toBe(1);
  });
});

describe('lineWriting (指でなぞった文字: 文の左から右へ光の筆跡が進む)', () => {
  it('writes the lines one after another, overlapping, all done at the end', () => {
    expect(lineWriting(0, 0, 2)).toBe(0);
    expect(lineWriting(1, 0, 2)).toBe(1);
    expect(lineWriting(1, 1, 2)).toBe(1);
    // the first line is under way before the second starts
    expect(lineWriting(0.2, 0, 2)).toBeGreaterThan(0);
    expect(lineWriting(0.2, 1, 2)).toBe(0);
    // and the second starts before the first is done
    const mid = 0.5;
    expect(lineWriting(mid, 0, 2)).toBeLessThan(1);
    expect(lineWriting(mid, 1, 2)).toBeGreaterThan(0);
  });

  it('a single line takes the whole time', () => {
    expect(lineWriting(0.5, 0, 1)).toBeCloseTo(0.5, 6);
  });

  it('never runs backwards', () => {
    for (let k = 0; k < 3; k++) {
      let last = 0;
      for (let w = 0; w <= 1.0001; w += 0.01) {
        const v = lineWriting(w, k, 3);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
      }
    }
  });
});

describe('the items (画面ごとの設計: ポーズ — this slice: つづける / タイトルへ; 確認ダイアログ: 2択)', () => {
  it('lists つづける and タイトルへ, and the two answers', () => {
    expect(PAUSE_ITEMS).toEqual(['resume', 'title']);
    expect(CONFIRM_ITEMS).toEqual(['yes', 'no']);
    expect(focusedItem(MENU_START)).toBe('resume');
  });
});

describe('stepMenu (キーボード・パッド操作, 戻る操作, 確認ダイアログ)', () => {
  it('moves the focus up and down through the items, around the ends', () => {
    let m: PauseMenu = MENU_START;
    m = stepMenu(m, 'down').menu;
    expect(focusedItem(m)).toBe('title');
    m = stepMenu(m, 'down').menu;
    expect(focusedItem(m)).toBe('resume');
    m = stepMenu(m, 'up').menu;
    expect(focusedItem(m)).toBe('title');
  });

  it('says when the focus moved (it answers with light and sound)', () => {
    expect(stepMenu(MENU_START, 'down').moved).toBe(true);
    expect(stepMenu(MENU_START, 'left').moved).toBe(false);
  });

  it('つづける resumes', () => {
    const s = stepMenu(MENU_START, 'choose');
    expect(s.outcome).toBe('resume');
    expect(s.chosen).toBe('resume');
  });

  it('Esc / B on the items resumes (one step back is the game)', () => {
    expect(stepMenu(MENU_START, 'back').outcome).toBe('resume');
    expect(stepMenu({ page: 'menu', focus: 1 }, 'back').outcome).toBe('resume');
  });

  it('タイトルへ asks first, with いいえ chosen to begin with', () => {
    const s = stepMenu({ page: 'menu', focus: 1 }, 'choose');
    expect(s.outcome).toBeNull();
    expect(s.chosen).toBe('title');
    expect(s.menu.page).toBe('confirm');
    expect(focusedItem(s.menu)).toBe('no');
  });

  it('in the confirmation, left / right (and up / down) move between はい and いいえ', () => {
    const ask: PauseMenu = { page: 'confirm', focus: 1 };
    expect(focusedItem(stepMenu(ask, 'left').menu)).toBe('yes');
    expect(focusedItem(stepMenu(ask, 'right').menu)).toBe('yes');
    expect(focusedItem(stepMenu(ask, 'up').menu)).toBe('yes');
    expect(focusedItem(stepMenu({ page: 'confirm', focus: 0 }, 'right').menu)).toBe('no');
  });

  it('はい leaves for the title', () => {
    const s = stepMenu({ page: 'confirm', focus: 0 }, 'choose');
    expect(s.outcome).toBe('leave');
    expect(s.chosen).toBe('yes');
  });

  it('いいえ, Esc or B goes back to the items, on タイトルへ', () => {
    for (const command of ['choose', 'back'] as const) {
      const s = stepMenu({ page: 'confirm', focus: 1 }, command);
      expect(s.outcome).toBeNull();
      expect(s.menu).toEqual({ page: 'menu', focus: 1 });
    }
  });
});

describe('pickItem (マウス: 選ぶと沈み込む)', () => {
  it('chooses the item clicked, wherever the focus was', () => {
    expect(pickItem(MENU_START, 'title').menu.page).toBe('confirm');
    expect(pickItem({ page: 'menu', focus: 1 }, 'resume').outcome).toBe('resume');
    expect(pickItem({ page: 'confirm', focus: 1 }, 'yes').outcome).toBe('leave');
    expect(pickItem({ page: 'confirm', focus: 0 }, 'no').menu).toEqual({ page: 'menu', focus: 1 });
  });

  it('ignores an item of the other page', () => {
    const s = pickItem(MENU_START, 'yes');
    expect(s.outcome).toBeNull();
    expect(s.menu).toEqual(MENU_START);
    expect(s.chosen).toBeNull();
  });
});

describe('keyCommand (キーボード)', () => {
  it('reads arrows and WASD, Enter and Space, Esc and Backspace', () => {
    expect(keyCommand({ key: 'ArrowUp', code: 'ArrowUp' })).toBe('up');
    expect(keyCommand({ key: 'w', code: 'KeyW' })).toBe('up');
    expect(keyCommand({ key: 'ArrowDown', code: 'ArrowDown' })).toBe('down');
    expect(keyCommand({ key: 's', code: 'KeyS' })).toBe('down');
    expect(keyCommand({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('left');
    expect(keyCommand({ key: 'ArrowRight', code: 'ArrowRight' })).toBe('right');
    expect(keyCommand({ key: 'Enter', code: 'Enter' })).toBe('choose');
    expect(keyCommand({ key: ' ', code: 'Space' })).toBe('choose');
    expect(keyCommand({ key: 'Escape', code: 'Escape' })).toBe('back');
    expect(keyCommand({ key: 'Backspace', code: 'Backspace' })).toBe('back');
  });

  it('leaves other keys alone (Tab moves the focus natively)', () => {
    expect(keyCommand({ key: 'Tab', code: 'Tab' })).toBeNull();
    expect(keyCommand({ key: 'e', code: 'KeyE' })).toBeNull();
  });
});

describe('padCommands (ゲームパッド: 十字・A・B、Start でも閉じる)', () => {
  it('turns newly pressed buttons into commands', () => {
    const none = new Set<string>();
    expect(padCommands(none, new Set(['PadDown']))).toEqual(['down']);
    expect(padCommands(none, new Set(['PadUp']))).toEqual(['up']);
    expect(padCommands(none, new Set(['PadLeft']))).toEqual(['left']);
    expect(padCommands(none, new Set(['PadRight']))).toEqual(['right']);
    expect(padCommands(none, new Set(['PadA']))).toEqual(['choose']);
    expect(padCommands(none, new Set(['PadB']))).toEqual(['back']);
    expect(padCommands(none, new Set(['PadStart']))).toEqual(['back']);
  });

  it('a held button counts once (the Start that opened the pause does not close it)', () => {
    expect(padCommands(new Set(['PadStart']), new Set(['PadStart']))).toEqual([]);
    expect(padCommands(new Set(['PadA']), new Set(['PadA', 'PadDown']))).toEqual(['down']);
  });

  it('ignores the other buttons', () => {
    expect(padCommands(new Set(), new Set(['PadX', 'PadLT']))).toEqual([]);
  });
});
