import type { SandboxScene, SceneFactory } from '../core/scene';
import { Autopilot } from '../game/prologue/autopilot';
import { isSpawnName, type SpawnName } from '../game/prologue/layout';
import { createPrologueRoom } from '../game/prologue/room';
import { createPrologueSound, type PrologueSound } from '../game/prologue/sound';
import { AudioGate } from '../ui/audio-gate';
import { createHomeDive } from '../ui/home/dive-host';
import { pickLang } from '../ui/lang';

export const title =
  'S-06 prologue prototype: dive in, take the vidro, walk, peek, place, cross, touch the light drop (?autoplay=1)';

/**
 * M0 統合 — 序章の試作部屋 (S-06). Loading → home → dive into the orb (S-04) lands in front of the workbench
 * of the workshop; from there it is played with S-03's body and input, S-02's layers and orb, S-01's glass.
 *
 * URL switches:
 *   (none)         the whole prologue: loading → home → dive → the workshop
 *   autoplay=1     the same, played by the script (S-04's home autoplay, then the in-room autopilot)
 *   direct=1       start in the workshop without the home;
 *                  spawn=bench|furnace|shelf|door|path|dead-end|far|gate|road|slope|plaza|east|south|west|film|
 *                  area1-road|area1-plaza|area1-alley|area1-wall|area1-slope|area1-court|area1-court-a|area1-court-b|
 *                  area1-summit|area1-edge|area1-shortcut|area1-shortcut-foot|area1-gate-court|area1-gate-summit
 *                  (gate/road: S-34's gate and the road past it; S-35: slope = the slope's brow looking down to the plaza,
 *                  plaza = up at the broken lighthouse, east/south/west = the plaza's gates (east open, toward the dawn
 *                  since S-39), film = held at the film in the gate's arch, looking back at the vidro's pedestal;
 *                  S-36: area1-road = on the road where the sky moves toward morning, area1-plaza = up at the chimney from
 *                  エリア1's entrance plaza, area1-alley = before 部屋1's alley, area1-wall = before its crumbled wall looking at
 *                  where the drop hovers; S-40: area1-slope = up the slope toward 部屋2 (S-36's area1-gate), area1-court(-a/-b) = 部屋2's
 *                  courtyard and its pedestals A and B, area1-summit / area1-edge = 部屋3's lookout and its edge over the valley,
 *                  area1-shortcut(-foot) = the shortcut's stairs from the summit / at the entrance plaza; S-41: area1-gate-court = gate 1
 *                  from the street, area1-gate-summit = gate 2 from the landing, area1-edge = the plateau's south-west corner)
 *   finaleHold=<s> (S-34, with a spawn) as if the drop had been taken that many seconds ago, held there: the light over
 *                  the bridge, what it has settled and the gate; &finaleOrb=hand: the vidro then taken back
 *                  (furnace/shelf/door: S-24's views of the interior)
 *   trial=surface-wall   a surface-only wall at the dead end (S-24's trial): its collider is cut inside a placed
 *                  orb's sphere, and the orb cannot be picked up while you stand in it (S-28)
 *   bench=<s>      (sensor) direct at the dead end, the vidro in hand, peeking (the heaviest view; peek=free
 *                  measures it at rest)
 *   peek=hold      keep peeking (the heaviest view, for measuring); peek=toggle: peek toggles per press
 *   peekHold=<0..1>, growHold=<0..1>   freeze the peek / a placed orb's growth (exact screenshots)
 *   autoplayTo=area1   (S-36, S-40) autoplay on through エリア1's three rooms and down the shortcut (by default it stops before
 *                  the plaza's east gate)
 *   area1=lazy     (S-36, with a spawn in the town) build エリア1 behind the scenes as in play (by default before the first frame)
 *   area1Drop=taken    (S-36) start with 部屋1's drop taken (to see the next room's lamps); S-40: area1Drop=1,2 the rooms whose
 *                  drops are taken
 *   peekFar=<m>    (S-41, dev) the peek's far end: what lies wholly beyond it is left out of the peek's picture
 *   shortcutHold=<s>   (S-40, with a spawn) every drop of エリア1 taken and the shortcut's light held that many seconds in
 * Publishes window.__vidro.sceneProbe.room (game/prologue/room.ts RoomProbe) next to the home/dive probe, and
 * .sound (game/prologue/sound.ts SoundProbe): the room's events answered with po-pens and glass (S-16), silent until
 * the audio starts: through the home, the press of 「はじめる」 starts the page's one engine, shared by the home's drops
 * and the room (.audioGate, S-18); in direct mode, the room's own on the first gesture.
 * S-42: through the home, Esc (or the mouse let go) and a pad's Start open the pause in play (src/ui/pause, the home host's;
 * not in direct mode): the time stops, つづける / タイトルへ (the dive played back to the home). Its probe is .pause
 * (ui/pause/pause-host.ts PauseProbe; `.pause.hold = <s>` stands the opening that far in, for screenshots).
 */
const unit = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

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
    lang: pickLang(navigator.languages),
  });

  // One AudioContext (S-18): through the home, 「はじめる」 starts the page's engine and the room plays on it;
  // alone (direct), the room makes its own on the first gesture (S-16).
  const audio = direct ? null : new AudioGate();
  const sound = createPrologueSound(room, audio ? { shared: audio } : {});

  // The WebGL2 timestamp-pool workaround that lived here is gone: main.ts drains the pool outside any render (S-11).
  if (audio) {
    const host = createHomeDive(ctx, room, {
      rewindFromGame: false,
      audio,
      probeExtras: { room: room.probe, sound: sound.probe },
    });
    return withSound(host, sound, audio);
  }

  window.__vidro.sceneProbe = { screen: 'game', room: room.probe, sound: sound.probe };
  try {
    await room.prepare();
  } catch (e) {
    // a factory that rejects is never disposed (main.ts): let go of the gesture listeners and the room here
    sound.dispose();
    room.dispose();
    window.__vidro.sceneProbe = {};
    throw e;
  }
  room.setPlaying(true);
  let first = true;
  const sandbox: SandboxScene = {
    scene: room.scene,
    camera: room.camera,
    update(dt, t) {
      room.update(dt, t);
      sound.update();
    },
    render() {
      // the first frame also compiles the placed orb and the boundary film (no stall at the first placement)
      if (first) room.warm();
      first = false;
      room.render();
    },
    resize: (w, h) => room.resize(w, h),
    dispose() {
      sound.dispose();
      room.dispose();
      window.__vidro.sceneProbe = {};
    },
  };
  return sandbox;
};

/**
 * The home → dive host with the room's sound: the listener follows the camera after the host moved it. On leaving,
 * the room's sound lets go of the shared engine first, then the page's audio is closed.
 */
function withSound(host: SandboxScene, sound: PrologueSound, audio: AudioGate): SandboxScene {
  const wrapped: SandboxScene = {
    get scene() {
      return host.scene;
    },
    get camera() {
      return host.camera;
    },
    update(dt, t) {
      host.update(dt, t);
      sound.update();
    },
    dispose() {
      // also when one of them fails to let go: the page's AudioContext must not outlive the scene
      try {
        sound.dispose();
      } finally {
        try {
          host.dispose();
        } finally {
          audio.dispose();
        }
      }
    },
  };
  if (host.render) wrapped.render = () => host.render?.();
  if (host.resize) wrapped.resize = (w, h) => host.resize?.(w, h);
  return wrapped;
}

export default create;
