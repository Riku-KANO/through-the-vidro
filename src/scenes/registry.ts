import type { SceneModule } from '../core/scene';

/**
 * Scenes are discovered from files named `src/scenes/<name>.scene.ts`.
 * Adding a scene never edits a shared file, so parallel slices do not conflict here.
 */
const modules = import.meta.glob<SceneModule>('./*.scene.ts');

export function sceneNameFromPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\.scene\.ts$/, '');
}

export const sceneNames: string[] = Object.keys(modules).map(sceneNameFromPath).sort();

export async function loadScene(name: string): Promise<SceneModule> {
  const loader = modules[`./${name}.scene.ts`];
  if (!loader) throw new Error(`Unknown scene "${name}". Known: ${sceneNames.join(', ')}`);
  return loader();
}
