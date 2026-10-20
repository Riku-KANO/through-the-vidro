import { describe, expect, it } from 'vitest';
import { ScreenFlow, TRANSITIONS } from './flow';

function run(flow: ScreenFlow, seconds: number, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) flow.update(step);
}

describe('transition lengths (トランジション設計 > 遷移の一覧)', () => {
  it('uses 1.5 s for loading → home and 2.0 s for home → game', () => {
    expect(TRANSITIONS.loadingToHome.seconds).toBe(1.5);
    expect(TRANSITIONS.homeToGame.seconds).toBe(2.0);
  });
});

describe('ScreenFlow', () => {
  it('stays on the loading screen until loading has finished', () => {
    const flow = new ScreenFlow();
    expect(flow.screen).toBe('loading');
    expect(flow.start()).toBe(false);
    expect(flow.transition).toBeNull();
    flow.markLoaded();
    expect(flow.start()).toBe(true);
    expect(flow.transition?.spec.id).toBe('loading-home');
  });

  it('arrives at home after the 1.5 s opening', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 1.4);
    expect(flow.screen).toBe('loading');
    run(flow, 0.2);
    expect(flow.screen).toBe('home');
    expect(flow.transition).toBeNull();
  });

  it('dives from home into the game in 2.0 s', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 1.6);
    expect(flow.select('start')).toBe(true);
    expect(flow.transition?.spec.id).toBe('home-game');
    run(flow, 1.9);
    expect(flow.screen).toBe('home');
    run(flow, 0.2);
    expect(flow.screen).toBe('game');
  });

  it('accepts Esc during a long transition and plays it back to the previous screen', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 0.6);
    expect(flow.escape()).toBe(true);
    expect(flow.transition?.direction).toBe(-1);
    run(flow, 0.7);
    expect(flow.screen).toBe('loading');
    expect(flow.transition).toBeNull();

    flow.start();
    run(flow, 1.6);
    flow.select('start');
    run(flow, 1.2);
    expect(flow.escape()).toBe(true);
    run(flow, 1.3);
    expect(flow.screen).toBe('home');
  });

  it('ignores other input while a transition is playing (only Esc gets through)', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 0.3);
    expect(flow.start()).toBe(false);
    expect(flow.select('start')).toBe(false);
    expect(flow.transition?.spec.id).toBe('loading-home');
  });

  it('does nothing on Esc when no transition is playing', () => {
    const flow = new ScreenFlow();
    expect(flow.escape()).toBe(false);
    flow.markLoaded();
    flow.start();
    run(flow, 1.6);
    expect(flow.escape()).toBe(false);
    expect(flow.screen).toBe('home');
  });

  it('only "start" leads into the game; the other drops are not wired in M0', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 1.6);
    expect(flow.select('settings')).toBe(false);
    expect(flow.screen).toBe('home');
    expect(flow.transition).toBeNull();
  });

  it('holds the dive mid-pose while the game scene is not ready, then continues', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 1.6);
    flow.setGameReady(false);
    flow.select('start');
    run(flow, 4);
    expect(flow.screen).toBe('home');
    expect(flow.transition?.holding).toBe(true);
    flow.setGameReady(true);
    run(flow, 2.1);
    expect(flow.screen).toBe('game');
  });

  it('can rewind from the game back to home along the dive (sandbox only)', () => {
    const flow = new ScreenFlow();
    flow.markLoaded();
    flow.start();
    run(flow, 1.6);
    flow.select('start');
    run(flow, 2.1);
    expect(flow.rewindFromGame()).toBe(true);
    expect(flow.transition?.direction).toBe(-1);
    run(flow, 2.1);
    expect(flow.screen).toBe('home');
  });
});
