import type { SandboxScene, SceneFactory } from '../core/scene';
import { Autopilot } from '../game/prologue/autopilot';
import { isSpawnName, type SpawnName } from '../game/prologue/layout';
import { createPrologueRoom } from '../game/prologue/room';
import { createHomeDive } from '../ui/home/dive-host';

export const title =
  'S-06 prologue prototype: dive in, take the vidro, walk, peek, place, cross, touch the light drop (?autoplay=1)';

/**
 * M0 統合 — 序章の試作部屋 (S-06). Loading → home → dive into the orb (S-04) lands in front of the workbench
 * of the workshop; from there it is played with S-03's body and input, S-02's layers and orb, S-01's glass.
 *
 * URL switches:
 *   (none)         the whole prologue: loading → home → dive → the workshop
 *   autoplay=1     the same, played by the script (S-04's home autoplay, then the in-room autopilot)
 *   direct=1       start in the workshop without the home; spawn=bench|path|dead-end|far
 *   bench=<s>      (sensor) direct at the dead end, the vidro in hand, peeking (the heaviest view; peek=free
 *                  measures it at rest)
 *   peek=hold      keep peeking (the heaviest view, for measuring); peek=toggle: peek toggles per press
 *   peekHold=<0..1>, growHold=<0..1>   freeze the peek / a placed orb's growth (exact screenshots)
 * Publishes window.__vidro.sceneProbe.room (game/prologue/room.ts RoomProbe) next to the home/dive probe.
 */
const unit = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

/**
 * Workaround (three r186, WebGL2): the timestamp query pool resets itself when it is full (1024 render
 * contexts) even in the middle of a nested render (a RenderPipeline pass, a shadow map), and the next
 * beginQuery then warns "a query is already active". Since S-08, main.ts turns three's per-pass timestamps
 * off where the GPU span is the source (WebGPU); on WebGL2 they stay on and are only read while the stats
 * or a bench want them, so here the pool is drained regularly from outside any render (checked after
 * merging main b88d317: still 2 warnings in 45 s without this). S-11 fixes main.ts; remove this then.
 */
const DRAIN_EVERY_FRAMES = 64;

function drainTimestamps(ctx: Parameters<SceneFactory>[0], sandbox: SandboxScene): SandboxScene {
  if (ctx.backend !== 'webgl2') return sandbox;
  let frames = 0;
  const draw = sandbox.render?.bind(sandbox);
  return Object.assign(sandbox, {
    render() {
      if (draw) draw();
      else ctx.renderer.render(sandbox.scene, sandbox.camera);
      if (++frames % DRAIN_EVERY_FRAMES === 0) ctx.renderer.resolveTimestampsAsync('render').catch(() => {});
    },
  });
}

const create: SceneFactory = async (ctx) => {
  const { params } = ctx;
  const bench = params.has('bench');
  const direct = bench || params.get('direct') === '1' || params.has('spawn');
  const asked = params.get('spawn');
  const spawn: SpawnName = isSpawnName(asked) ? asked : bench ? 'dead-end' : 'bench';
  const growHold = direct ? unit(params.get('growHold')) : null;
  const peekParam = params.get('peek');
  const room = createPrologueRoom(ctx, {
    spawn,
    orbStart: spawn === 'bench' && growHold === null ? 'bench' : 'hand',
    peekMode: peekParam === 'toggle' ? 'toggle' : 'hold',
    forcePeek: peekParam === 'hold' || (bench && peekParam === null),
    peekHold: direct ? unit(params.get('peekHold')) : null,
    growHold,
    autopilot: params.get('autoplay') === '1' ? new Autopilot() : null,
  });

  if (!direct)
    return drainTimestamps(
      ctx,
      createHomeDive(ctx, room, { rewindFromGame: false, probeExtras: { room: room.probe } }),
    );

  window.__vidro.sceneProbe = { screen: 'game', room: room.probe };
  await room.prepare();
  room.setPlaying(true);
  let first = true;
  const sandbox: SandboxScene = {
    scene: room.scene,
    camera: room.camera,
    update: (dt, t) => room.update(dt, t),
    render() {
      // the first frame also compiles the placed orb and the boundary film (no stall at the first placement)
      if (first) room.warm();
      first = false;
      room.render();
    },
    resize: (w, h) => room.resize(w, h),
    dispose() {
      room.dispose();
      window.__vidro.sceneProbe = {};
    },
  };
  return drainTimestamps(ctx, sandbox);
};

export default create;
