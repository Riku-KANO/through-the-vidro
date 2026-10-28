import { describe, expect, it } from 'vitest';
import { defaultSettings } from './settings-model';
import {
  readSavedQuality,
  readSettings,
  SETTINGS_KEY,
  SettingsStore,
  type StorageLike,
  writeSettings,
} from './settings-store';

/** A stand-in for localStorage: a map, or one that refuses (a browser that does not let the page keep anything). */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  writes = 0;
  constructor(
    private readonly refuseWrite = false,
    private readonly refuseRead = false,
  ) {}
  getItem(key: string): string | null {
    if (this.refuseRead) throw new DOMException('denied', 'SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    if (this.refuseWrite) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, value);
  }
}

const defaults = defaultSettings({ lang: 'ja' });

describe('readSettings (読み込みとセーブ: 設定はブラウザ(localStorage)に保存して次に開いたときも使う)', () => {
  it('nothing kept yet: the defaults', () => {
    const r = readSettings(() => new MemoryStorage(), defaults);
    expect(r.settings).toEqual(defaults);
    expect(r.found).toBe(false);
    expect(r.readable).toBe(true);
  });

  it('reads back what was written', () => {
    const storage = new MemoryStorage();
    const mine = { ...defaults, fov: 84, lang: 'en' as const, quality: 'low' as const };
    expect(writeSettings(() => storage, mine)).toBe(true);
    const r = readSettings(() => storage, defaults);
    expect(r.found).toBe(true);
    expect(r.settings).toEqual(mine);
  });

  it('a broken or foreign entry reads as the defaults (and does not throw)', () => {
    const storage = new MemoryStorage();
    storage.map.set(SETTINGS_KEY, '{not json');
    expect(readSettings(() => storage, defaults).settings).toEqual(defaults);
    storage.map.set(SETTINGS_KEY, JSON.stringify({ v: 99, settings: { fov: 90 } }));
    expect(readSettings(() => storage, defaults).settings).toEqual(defaults);
  });

  it('no storage at all, or one that throws on reading: the defaults, marked unreadable', () => {
    for (const get of [
      () => null,
      () => new MemoryStorage(false, true),
      () => {
        throw new DOMException('denied', 'SecurityError');
      },
    ]) {
      const r = readSettings(get, defaults);
      expect(r.settings).toEqual(defaults);
      expect(r.readable).toBe(false);
    }
  });
});

describe('writeSettings', () => {
  it('says whether it could keep them', () => {
    expect(writeSettings(() => new MemoryStorage(), defaults)).toBe(true);
    expect(writeSettings(() => new MemoryStorage(true), defaults)).toBe(false);
    expect(writeSettings(() => null, defaults)).toBe(false);
  });
});

describe('readSavedQuality (the shell creates the scene with the preset the player chose)', () => {
  it('reads the choice alone, null when none was made or nothing can be read', () => {
    const storage = new MemoryStorage();
    expect(readSavedQuality(() => storage)).toBeNull();
    writeSettings(() => storage, { ...defaults, quality: 'high' });
    expect(readSavedQuality(() => storage)).toBe('high');
    writeSettings(() => storage, { ...defaults, quality: 'auto' });
    expect(readSavedQuality(() => storage)).toBe('auto');
    writeSettings(() => storage, { ...defaults, quality: null });
    expect(readSavedQuality(() => storage)).toBeNull();
    expect(readSavedQuality(() => null)).toBeNull();
  });
});

describe('SettingsStore (保存できない環境でも遊べ、そのときは一度だけ知らせる)', () => {
  it('starts from what was kept and keeps every change', () => {
    const storage = new MemoryStorage();
    writeSettings(() => storage, { ...defaults, fov: 66 });
    const store = new SettingsStore(() => storage, defaults);
    expect(store.settings.fov).toBe(66);
    const r = store.save({ ...store.settings, fov: 99 });
    expect(r).toEqual({ saved: true, notify: false });
    expect(store.settings.fov).toBe(99);
    expect(readSettings(() => storage, defaults).settings.fov).toBe(99);
  });

  it('where nothing can be kept, the change still takes effect, and it says so once only', () => {
    const storage = new MemoryStorage(true);
    const store = new SettingsStore(() => storage, defaults);
    const first = store.save({ ...store.settings, fov: 80 });
    expect(first).toEqual({ saved: false, notify: true });
    expect(store.settings.fov).toBe(80);
    const second = store.save({ ...store.settings, fov: 81 });
    expect(second).toEqual({ saved: false, notify: false });
    expect(store.settings.fov).toBe(81);
    expect(store.persistent).toBe(false);
  });

  it('cleans what it is handed (a value out of range is not kept)', () => {
    const store = new SettingsStore(() => new MemoryStorage(), defaults);
    store.save({ ...store.settings, fov: 300 });
    expect(store.settings.fov).toBe(100);
  });
});
