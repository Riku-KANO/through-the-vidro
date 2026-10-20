import { describe, expect, it } from 'vitest';
import { sceneNameFromPath, sceneNames } from './registry';

describe('scene registry', () => {
  it('derives scene names from *.scene.ts files', () => {
    expect(sceneNameFromPath('./glass-gallery.scene.ts')).toBe('glass-gallery');
  });

  it('discovers the hello scene', () => {
    expect(sceneNames).toContain('hello');
  });

  it('only contains URL-safe names', () => {
    for (const name of sceneNames) expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});
