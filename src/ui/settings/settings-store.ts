import { isQualityChoice, isQualityLevel, type QualityChoice, type QualityLevel } from '../../core/quality';
import { type Settings, sanitizeSettings } from './settings-model';

/**
 * Keeping the settings (S-43). 技術設計 > 読み込みとセーブ: セーブはブラウザ内(localStorage) — ブラウザの設定によって保存
 * できない場合も遊べるようにし、そのときだけ「この環境では保存できません」と一度だけ知らせる.
 * Every read and write is guarded (a browser may refuse the storage, throw on reading it, or be full); what to tell the
 * player is decided here, purely, from what the storage did.
 */

/** The part of localStorage used here (unit tests pass a stand-in). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Gets the storage; may throw (SecurityError) or give none. */
export type StorageSource = () => StorageLike | null;

export const SETTINGS_KEY = 'vidro.settings';
/** The kept shape's version: an entry of another one is not read (the defaults then). */
const VERSION = 1;

/** The page's localStorage, or null where the browser does not give one. */
export const browserStorage: StorageSource = () =>
  typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;

function storageOf(source: StorageSource): StorageLike | null {
  try {
    return source();
  } catch {
    return null;
  }
}

/** The kept entry's settings field (unchecked), or undefined when there is none or it cannot be read. */
function readRaw(source: StorageSource): { raw: unknown; readable: boolean } {
  const storage = storageOf(source);
  if (!storage) return { raw: undefined, readable: false };
  let text: string | null;
  try {
    text = storage.getItem(SETTINGS_KEY);
  } catch {
    return { raw: undefined, readable: false };
  }
  if (text === null) return { raw: undefined, readable: true };
  try {
    const parsed = JSON.parse(text) as { v?: unknown; settings?: unknown } | null;
    return { raw: parsed?.v === VERSION ? parsed.settings : undefined, readable: true };
  } catch {
    return { raw: undefined, readable: true };
  }
}

export interface ReadResult {
  settings: Settings;
  /** Something was kept (and of this version). */
  found: boolean;
  /** The storage could be read at all. */
  readable: boolean;
}

export function readSettings(source: StorageSource, defaults: Settings): ReadResult {
  const { raw, readable } = readRaw(source);
  return { settings: sanitizeSettings(raw, defaults), found: raw !== undefined, readable };
}

/** Keeps the settings; false where the browser would not. */
export function writeSettings(source: StorageSource, settings: Settings): boolean {
  const storage = storageOf(source);
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ v: VERSION, settings }));
    return true;
  } catch {
    return false;
  }
}

/** The quality the player chose, alone (the shell creates the scene with it, before any screen exists). */
export function readSavedQuality(source: StorageSource): QualityChoice | null {
  const { raw } = readRaw(source);
  const q = (raw as { quality?: unknown } | undefined)?.quality;
  return isQualityChoice(q) ? q : null;
}

/**
 * S-48: the preset 自動 picked, kept by the shell for the next visit to be built from (選ばれたプリセットを保存し、次に開いた
 * ときはそのプリセットで作る). Under a key of its own: the shell writes it when 自動 has measured, the settings panel writes
 * the settings when the player changes one, and neither write may wipe the other's.
 */
export const AUTO_PICK_KEY = 'vidro.autoQuality';

/** 自動's pick from an earlier visit, or null (none, unreadable, broken, of another version). */
export function readAutoPick(source: StorageSource): QualityLevel | null {
  const storage = storageOf(source);
  if (!storage) return null;
  try {
    const text = storage.getItem(AUTO_PICK_KEY);
    if (text === null) return null;
    const parsed = JSON.parse(text) as { v?: unknown; level?: unknown } | null;
    return parsed?.v === VERSION && isQualityLevel(parsed.level) ? parsed.level : null;
  } catch {
    return null;
  }
}

/** Keeps 自動's pick; false where the browser would not (遊べる all the same). */
export function writeAutoPick(source: StorageSource, level: QualityLevel): boolean {
  const storage = storageOf(source);
  if (!storage) return false;
  try {
    storage.setItem(AUTO_PICK_KEY, JSON.stringify({ v: VERSION, level }));
    return true;
  } catch {
    return false;
  }
}

/** What one save did, and whether the player should be told now that nothing can be kept (the first failure only). */
export interface SaveResult {
  saved: boolean;
  notify: boolean;
}

/** The settings in use and their keeping: every change takes effect, kept where the browser lets it. */
export class SettingsStore {
  private current: Settings;
  private told = false;
  private persistentValue = true;

  constructor(
    private readonly source: StorageSource,
    private readonly defaults: Settings,
  ) {
    const r = readSettings(source, defaults);
    this.current = r.settings;
  }

  get settings(): Settings {
    return this.current;
  }

  /** False once a save failed: the settings then last for this visit only. */
  get persistent(): boolean {
    return this.persistentValue;
  }

  save(next: Settings): SaveResult {
    this.current = sanitizeSettings(next, this.defaults);
    const saved = writeSettings(this.source, this.current);
    if (saved) return { saved, notify: false };
    this.persistentValue = false;
    const notify = !this.told;
    this.told = true;
    return { saved, notify };
  }
}
