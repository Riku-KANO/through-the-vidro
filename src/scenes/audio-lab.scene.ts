import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as THREE from 'three/webgpu';
import { createVidroEngine } from '../audio/engine';
import { strikeGlass, VIDRO_GLASS } from '../audio/glass-tuning';
import { designPopen, type PopenKind, playPopen } from '../audio/popen';
import { VIDRO_ROOMS, type VidroRoomId } from '../audio/rooms';
import { glassPitch } from '../audio/tuning';
import type { AudioEngine, Emitter, Vec3 } from '../core/audio/engine';
import { designGlassVoice, type GlassStrength, scheduleGlassVoice } from '../core/audio/glass';
import { VOLUME_CHANNELS, type VolumeChannel } from '../core/audio/mix';
import { mixdown, renderOffline } from '../core/audio/offline';
import { playGlass } from '../core/audio/play';
import { schedulePops } from '../core/audio/pop';
import { RoomReverb } from '../core/audio/reverb';
import { mulberry32 } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';
import { followBackdropResize } from '../core/glass';
import type { SceneFactory } from '../core/scene';

export const title = 'S-09 audio lab: glass by size, po-pen, HRTF orbit, workshop / dome reverb';

/**
 * Listening lab for the audio foundation (src/core/audio).
 *  click a sphere / 1–5: strike glass (bigger = lower; each glass is its own HRTF source)
 *  Q W E: strength touch / tap / hit      6 7 8 9: po-pen peek / place / pick up / tremble
 *  R: reverb workshop ⇄ dome               O: a source orbits the listener (HRTF)
 *  A / M: test beds on the ambience / music buses (so all four volume sliders do something)
 * Sound starts with the first click or key (AudioContext stays suspended until then).
 * window.__vidro.sceneProbe exposes the audio state; window.__vidroAudioLab.render() renders sounds
 * with OfflineAudioContext for the S-09 sensor.
 */

/** Glass diameters in metres, key 1 (biggest, lowest) … key 5 (smallest, highest), like a keyboard. */
const GLASS_SIZES = [0.4, 0.26, 0.18, 0.12, 0.08];
const STRENGTH_KEYS: Record<string, GlassStrength> = { q: 'touch', w: 'tap', e: 'hit' };
const POPEN_KEYS: Record<string, PopenKind> = { '6': 'peek', '7': 'place', '8': 'pickup', '9': 'tremble' };
const STRENGTH_LABEL: Record<GlassStrength, string> = { touch: '触れる', tap: '叩く', hit: '玉が当たる' };
const ROOM_LABEL: Record<VidroRoomId, string> = { workshop: '工房（短い残響）', dome: 'ドーム（長い残響）' };
const VOLUME_LABEL: Record<VolumeChannel, string> = {
  master: '全体',
  music: '音楽',
  sfx: '効果音',
  ambience: '環境音',
};
/** The orbiting source plays a rising pentatonic figure: D6 E6 F#6 A6 B6. */
const ORBIT_NOTES = [86, 88, 90, 93, 95];
const ORBIT_RADIUS = 1.4;
const ORBIT_SPEED = 0.6; // rad/s, ~10 s per turn
const ORBIT_INTERVAL = 0.7; // s between notes
const RING_SECONDS = 0.9;

type RenderSpec =
  | { kind: 'glass'; size: number; strength: GlassStrength; seed: number; duration?: number }
  | { kind: 'popen'; type: PopenKind; seed: number; duration?: number }
  | { kind: 'impulse'; room: VidroRoomId; duration?: number }
  /** The whole engine (buses, emitter, reverb, limiter) on an OfflineAudioContext. */
  | { kind: 'mix'; volumes: Partial<Record<VolumeChannel, number>>; seed: number; duration?: number }
  /**
   * A ringing glass cut at CUT_AT: 'steal' forces the voice cap (1 per emitter) to take it,
   * 'silence' fades the whole engine as dispose() does while playing.
   */
  | { kind: 'cut'; mode: 'steal' | 'silence' }
  /** A lab test bed (wind / drone) started at 0 and stopped at `stopAt`. */
  | { kind: 'bed'; bed: 'wind' | 'drone'; stopAt: number };

interface RenderResult {
  sampleRate: number;
  /** For 'cut': the context time at which the cut was asked to start. */
  cutAt?: number;
  samples: number[];
  notes: { time: number; midi: number; hz: number; t60: number }[];
  t60: number;
  voicesStarted?: number;
}

declare global {
  interface Window {
    __vidroAudioLab?: { render(spec: RenderSpec): Promise<RenderResult> };
  }
}

const CUT_AT = 0.2;
/** Fade used when a test bed is switched off (avoids a click that could be mistaken for a bug). */
const BED_FADE_TAU = 0.02;

interface Bed {
  /** Fade out from `at` and stop. */
  stop(at?: number): void;
}

/** 3 s of noise for the wind bed (long enough that the loop does not flutter). */
function windNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = mulberry32(17);
  for (let i = 0; i < d.length; i++) d[i] = rng() * 2 - 1;
  return buf;
}

/** Lab test beds for the ambience (wind through glass) and music (D3 A3 D4 drone) buses. */
function startBed(ctx: BaseAudioContext, destination: AudioNode, kind: 'wind' | 'drone', when = 0): Bed {
  const gain = ctx.createGain();
  gain.connect(destination);
  const sources: AudioScheduledSourceNode[] = [];
  if (kind === 'wind') {
    gain.gain.value = 0.06;
    const src = ctx.createBufferSource();
    src.buffer = windNoise(ctx);
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain).connect(band.frequency);
    src.connect(band).connect(gain);
    sources.push(src, lfo);
  } else {
    gain.gain.value = 0.035;
    for (const m of [50, 57, 62]) {
      const o = ctx.createOscillator();
      o.frequency.value = midiToHz(m);
      o.connect(gain);
      sources.push(o);
    }
  }
  for (const src of sources) src.start(when);
  return {
    stop(at = ctx.currentTime + 0.005) {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, BED_FADE_TAU);
      const end = at + BED_FADE_TAU * 8;
      for (const src of sources) src.stop(end);
      (sources[0] as AudioScheduledSourceNode).onended = () => gain.disconnect();
    },
  };
}

/** Offline render through the same synth / reverb code as live playback (no gesture needed). */
async function renderForSensor(spec: RenderSpec): Promise<RenderResult> {
  const sampleRate = 44100;
  if (spec.kind === 'glass') {
    const pitch = glassPitch(spec.size);
    const voice = designGlassVoice(
      { hz: pitch.hz, size: spec.size, strength: spec.strength, sampleRate },
      mulberry32(spec.seed),
      VIDRO_GLASS,
    );
    const t60 = voice.partials[0]?.t60 ?? 0;
    const buf = await renderOffline(
      { duration: spec.duration ?? voice.duration + 0.05, sampleRate },
      (ctx, dest) => scheduleGlassVoice(ctx, dest, voice, 0),
    );
    return {
      sampleRate,
      samples: Array.from(mixdown(buf)),
      notes: [{ time: 0, midi: pitch.midi, hz: pitch.hz, t60 }],
      t60,
    };
  }
  if (spec.kind === 'popen') {
    const score = designPopen(spec.type, mulberry32(spec.seed));
    const buf = await renderOffline(
      { duration: spec.duration ?? score.duration + 0.05, sampleRate },
      (ctx, dest) => schedulePops(ctx, dest, score, 0),
    );
    return {
      sampleRate,
      samples: Array.from(mixdown(buf)),
      notes: score.pops.map((p) => ({ time: p.time, midi: p.midi, hz: p.hz, t60: p.t60 })),
      t60: Math.max(...score.pops.map((p) => p.t60)),
    };
  }
  if (spec.kind === 'mix') {
    // A glass struck 2 m in front of the listener through an HRTF emitter on the sfx bus.
    const held: { engine?: AudioEngine } = {};
    const buf = await renderOffline(
      { duration: spec.duration ?? 1.2, sampleRate, channels: 2 },
      async (ctx) => {
        const engine = await createVidroEngine(ctx, VIDRO_ROOMS.workshop);
        for (const ch of VOLUME_CHANNELS) {
          const v = spec.volumes[ch];
          if (v !== undefined) engine.setVolume(ch, v);
        }
        const emitter = engine.createEmitter('sfx', { x: 0, y: 0, z: -2 });
        const size = 0.12;
        strikeGlass(engine, size, 'tap', { emitter, seed: spec.seed });
        held.engine = engine;
        return engine;
      },
    );
    const voicesStarted = held.engine?.snapshot().voicesStarted ?? 0;
    await held.engine?.dispose();
    return { sampleRate, samples: Array.from(mixdown(buf)), notes: [], t60: 0, voicesStarted };
  }
  if (spec.kind === 'cut') {
    // A low glass (A3) rings on one emitter; at CUT_AT it is stolen or the whole mix is faded.
    const held: { engine?: AudioEngine; at?: number } = {};
    const buf = await renderOffline({ duration: 0.6, sampleRate, channels: 2 }, async (ctx) => {
      const engine = await createVidroEngine(ctx, VIDRO_ROOMS.workshop, { maxVoicesPerEmitter: 1 });
      const emitter = engine.createEmitter('sfx', { x: 0, y: 0, z: -2 });
      strikeGlass(engine, 0.4, 'tap', { emitter, seed: 3 });
      void ctx.suspend(CUT_AT).then(() => {
        held.at = engine.now();
        if (spec.mode === 'steal') {
          // A silent voice on the same emitter: the cap of 1 forces the ringing glass to be stolen.
          engine.startVoice({ level: 1, emitter }, (_c, _d, when) => ({ end: when + 1, fadeOut: () => {} }));
        } else {
          engine.fadeOutAll(held.at);
        }
        void ctx.resume();
      });
      held.engine = engine;
      return engine;
    });
    const stolen = held.engine?.snapshot().voicesStolen ?? 0;
    await held.engine?.dispose();
    return {
      sampleRate,
      samples: Array.from(mixdown(buf)),
      notes: [],
      t60: 0,
      voicesStarted: stolen,
      cutAt: held.at,
    };
  }
  if (spec.kind === 'bed') {
    const buf = await renderOffline({ duration: spec.stopAt + 0.5, sampleRate }, (ctx, dest) => {
      const bed = startBed(ctx, dest, spec.bed);
      bed.stop(spec.stopAt);
      return bed;
    });
    return { sampleRate, samples: Array.from(mixdown(buf)), notes: [], t60: 0, cutAt: spec.stopAt };
  }
  const room = VIDRO_ROOMS[spec.room];
  const buf = await renderOffline(
    {
      duration: spec.duration ?? room.preDelay + room.t60 * 1.3 + 0.05,
      sampleRate,
      channels: 2,
    },
    (ctx, dest) => {
      const reverb = new RoomReverb(ctx, room);
      reverb.output.connect(dest);
      const click = ctx.createBuffer(1, 1, sampleRate);
      click.getChannelData(0)[0] = 1;
      const src = ctx.createBufferSource();
      src.buffer = click;
      src.connect(reverb.input);
      src.start(0);
      return { reverb, src };
    },
  );
  return { sampleRate, samples: Array.from(mixdown(buf)), notes: [], t60: room.t60 };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

// UI: frosted glass panels, warm off-white Mincho text (UI/UX設計 > 文字と色).
const FONT = '"Shippori Mincho","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const PANEL =
  'position:absolute;background:rgba(255,255,255,0.13);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
  'border:1px solid rgba(255,255,255,0.22);border-radius:14px;color:#f1ece4;' +
  `font:18px/1.5 ${FONT};text-shadow:0 1px 2px rgba(10,20,35,0.45);`;

const create: SceneFactory = async ({ renderer, overlay, canvas }) => {
  // made before any gesture (a lab opened alone): the engine makes its own context and keeps it suspended until then
  const engine = await createVidroEngine(undefined, VIDRO_ROOMS.workshop);
  engine.bindUnlockGestures(window);

  // ---------- 3D: pre-dawn blue lab, a brass rail with five glass spheres ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x26354a);
  scene.fog = new THREE.Fog(0x26354a, 2.5, 7);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.75;
  envScene.dispose();

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50);
  camera.position.set(0, 0.95, 1.7);
  camera.lookAt(0, 0.6, 0);

  const dawn = new THREE.DirectionalLight(0xcfe0ff, 1.6);
  dawn.position.set(-2, 3, -2);
  scene.add(dawn);
  scene.add(new THREE.HemisphereLight(0x9fb6d6, 0x1b2433, 0.8));

  const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0x33445a, roughness: 0.45, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const brass = new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.35 });
  const railY = 0.32;
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.3, 16), brass);
  rail.rotation.z = Math.PI / 2;
  rail.position.y = railY;
  scene.add(rail);
  for (const x of [-1.1, 1.1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, railY, 12), brass);
    leg.position.set(x, railY / 2, 0);
    scene.add(leg);
  }

  // Hand-made transmissive glass has no node, so three would skip refreshing it and keep a destroyed backdrop
  // after a render scale change (S-12). followBackdropResize gives it one without changing the look (S-14).
  const glassMat = followBackdropResize(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0,
      transmission: 1,
      ior: 1.5,
      thickness: 0.3,
      attenuationColor: new THREE.Color(0xe8fff4),
      attenuationDistance: 2.5,
    }),
  );
  const sphereGeo = new THREE.SphereGeometry(0.5, 64, 48);
  const cradleGeo = new THREE.TorusGeometry(1, 0.06, 8, 48);
  const ringGeo = new THREE.TorusGeometry(1, 0.012, 6, 96);
  const ringMats: THREE.MeshBasicNodeMaterial[] = [];

  const xs = [-0.82, -0.3, 0.13, 0.48, 0.78];
  const glasses = GLASS_SIZES.map((size, i) => {
    const pitch = glassPitch(size);
    const radius = size / 2;
    const pos = new THREE.Vector3(xs[i] as number, railY + 0.012 + radius * 0.96, 0);
    const mesh = new THREE.Mesh(sphereGeo, glassMat);
    mesh.scale.setScalar(size);
    mesh.position.copy(pos);
    mesh.userData.index = i;
    scene.add(mesh);
    const cradle = new THREE.Mesh(cradleGeo, brass);
    cradle.scale.setScalar(radius * 0.45);
    cradle.rotation.x = Math.PI / 2;
    cradle.position.set(pos.x, railY + 0.012, 0);
    scene.add(cradle);
    // Light ring that spreads when the glass rings (sound made visible).
    const ringMat = new THREE.MeshBasicNodeMaterial({
      color: 0xffe2b0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    ringMats.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(pos);
    ring.visible = false;
    scene.add(ring);
    const emitter = engine.createEmitter('sfx', pos);
    return { size, pitch, mesh, ring, ringAge: Number.POSITIVE_INFINITY, emitter, pos };
  });

  const orbMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffe9c4,
    emissive: new THREE.Color(0xffc988),
    emissiveIntensity: 2.2,
    roughness: 0.3,
  });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), orbMat);
  orb.visible = false;
  scene.add(orb);
  const orbitEmitter: Emitter = engine.createEmitter('sfx');
  const orbitPos: Vec3 = { x: 0, y: 0, z: 0 };

  // Listener = camera (static in this lab, so set once; the engine applies it when audio starts).
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  engine.setListener(camera.position, fwd, camera.up);

  // ---------- Test beds for the music and ambience buses ----------
  let wind: Bed | null = null;
  let drone: Bed | null = null;
  const startWind = (): Bed => startBed(engine.ctx, engine.bus('ambience'), 'wind', engine.now());
  const startDrone = (): Bed => startBed(engine.ctx, engine.bus('music'), 'drone', engine.now());

  // ---------- Probe ----------
  const state = {
    strength: 'tap' as GlassStrength,
    room: 'workshop' as VidroRoomId,
    /** dotX / dotY: offset (px) last applied to the direction dial's dot. */
    orbit: { on: false, angle: 0, dotX: 0, dotY: 0 },
    plays: 0,
    glassPlays: 0,
    popenPlays: 0,
    orbitPlays: 0,
    lastSound: null as
      | null
      | { kind: 'glass'; size: number; note: string; strength: GlassStrength }
      | {
          kind: 'popen';
          type: PopenKind;
          notes: number[];
        },
  };
  const probe = {
    ready: false,
    get audio() {
      return engine.snapshot();
    },
    get strength() {
      return state.strength;
    },
    get plays() {
      return state.plays;
    },
    get glassPlays() {
      return state.glassPlays;
    },
    get popenPlays() {
      return state.popenPlays;
    },
    get orbitPlays() {
      return state.orbitPlays;
    },
    get lastSound() {
      return state.lastSound;
    },
    orbit: state.orbit,
    glasses: glasses.map((g, i) => ({
      key: i + 1,
      size: g.size,
      midi: g.pitch.midi,
      hz: g.pitch.hz,
      note: g.pitch.name,
    })),
    beds: { wind: false, drone: false },
  };
  window.__vidro.sceneProbe = probe;
  window.__vidroAudioLab = { render: renderForSensor };

  // ---------- Overlay (DOM) ----------
  // Panels stay off the orbit path (a band just above the screen centre) and off the glasses.
  // Text is at least 18px (UI/UX設計 > 文字と色).
  const panel = el('section', `${PANEL}right:24px;top:24px;padding:14px 22px;max-width:560px`, overlay);
  panel.setAttribute('aria-label', '音の状態');
  el('div', 'font-size:22px;letter-spacing:0.08em', panel, '音の実験室');
  const status = el('div', 'color:#ffe2b0', panel);
  const current = el('div', '', panel);
  el('div', 'opacity:0.8', panel, 'ヘッドホンで聴くと方向が分かります');

  const help = el(
    'section',
    `${PANEL}left:50%;bottom:24px;transform:translateX(-50%);padding:12px 22px;display:grid;` +
      'grid-template-columns:auto auto auto auto;column-gap:14px;row-gap:0;white-space:nowrap',
    overlay,
  );
  help.setAttribute('aria-label', '操作の説明');
  const rows: [string, string][] = [
    ['クリック', '球を叩く'],
    ['6 7 8 9', 'ぽぺん: 覗く / 置く / 拾う / 震える'],
    ['1 – 5', 'ガラス（1 が最も大きく低い）'],
    ['R', '残響: 工房 ⇄ ドーム'],
    ['Q W E', '強さ: 触れる / 叩く / 玉が当たる'],
    ['O', '音源が頭の周りを回る'],
    ['', ''],
    ['A / M', '環境音（風）/ 音楽（持続音）'],
  ];
  for (const [k, v] of rows) {
    el('div', 'font-family:ui-sans-serif,system-ui,sans-serif;opacity:0.9', help, k);
    el('div', 'margin-right:18px', help, v);
  }

  const mixer = el(
    'section',
    `${PANEL}left:24px;top:96px;padding:10px 18px;pointer-events:auto;display:grid;` +
      'grid-template-columns:auto 150px;column-gap:12px;row-gap:2px;align-items:center',
    overlay,
  );
  mixer.setAttribute('aria-label', '音量');
  for (const ch of VOLUME_CHANNELS) {
    el('label', '', mixer, VOLUME_LABEL[ch]);
    const input = el('input', 'width:150px;accent-color:#d9b77e', mixer);
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = String(Math.round(engine.getVolume(ch) * 100));
    input.setAttribute('aria-label', `音量 ${VOLUME_LABEL[ch]}`);
    input.addEventListener('input', () => engine.setVolume(ch, Number(input.value) / 100));
  }

  const radar = el('section', `${PANEL}right:24px;bottom:24px;width:150px;height:160px;padding:0`, overlay);
  radar.setAttribute('aria-label', '音源の方向');
  el('div', 'position:absolute;left:0;right:0;top:6px;text-align:center', radar, '音源の方向');
  const dial = el(
    'div',
    'position:absolute;left:30px;top:44px;width:90px;height:90px;border-radius:50%;' +
      'border:1px solid rgba(255,255,255,0.45)',
    radar,
  );
  // Listener in the centre; a small notch marks "ahead".
  el(
    'div',
    'position:absolute;left:41px;top:41px;width:8px;height:8px;border-radius:50%;background:#f1ece4',
    dial,
  );
  el(
    'div',
    'position:absolute;left:40px;top:-6px;width:0;height:0;border-left:5px solid transparent;' +
      'border-right:5px solid transparent;border-bottom:8px solid rgba(255,255,255,0.8)',
    dial,
  );
  const dot = el(
    'div',
    'position:absolute;left:39px;top:39px;width:12px;height:12px;border-radius:50%;background:#ffc988;' +
      'box-shadow:0 0 10px #ffc988;opacity:0.25',
    dial,
  );

  const labels = glasses.map((g, i) =>
    el(
      'div',
      `position:absolute;transform:translate(-50%,0);color:#f1ece4;font:18px/1.3 ${FONT};text-align:center;` +
        'text-shadow:0 1px 3px rgba(10,20,35,0.7);white-space:nowrap',
      overlay,
      `${i + 1} · ${g.pitch.name}`,
    ),
  );

  const refreshText = (): void => {
    const s = engine.state;
    status.textContent =
      s === 'running'
        ? `● 音: 再生中（AudioContext ${s}）`
        : `○ 音: 停止中（${s}）— クリックで音を有効にする`;
    current.textContent =
      `強さ「${STRENGTH_LABEL[state.strength]}」 残響「${ROOM_LABEL[state.room]}」 ` +
      `周回 ${state.orbit.on ? 'オン' : 'オフ'}`;
  };
  refreshText();
  engine.ctx.addEventListener('statechange', refreshText);

  // ---------- Interaction ----------
  const ring = (i: number): void => {
    const g = glasses[i];
    if (g) g.ringAge = 0;
  };
  const ringGlassAt = (i: number): void => {
    const g = glasses[i];
    if (!g) return;
    const voice = strikeGlass(engine, g.size, state.strength, { emitter: g.emitter });
    if (!voice) return;
    state.plays++;
    state.glassPlays++;
    state.lastSound = { kind: 'glass', size: g.size, note: g.pitch.name, strength: state.strength };
    ring(i);
  };
  const popen = (kind: PopenKind): void => {
    const score = playPopen(engine, kind);
    if (!score) return;
    state.plays++;
    state.popenPlays++;
    state.lastSound = { kind: 'popen', type: kind, notes: score.pops.map((p) => p.midi) };
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const meshes = glasses.map((g) => g.mesh);
  const onPointerDown = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit) ringGlassAt(hit.object.userData.index as number);
  };
  canvas.addEventListener('pointerdown', onPointerDown);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    const digit = Number(key);
    if (digit >= 1 && digit <= glasses.length) ringGlassAt(digit - 1);
    else if (POPEN_KEYS[key]) popen(POPEN_KEYS[key]);
    else if (STRENGTH_KEYS[key]) state.strength = STRENGTH_KEYS[key];
    else if (key === 'r') {
      state.room = state.room === 'workshop' ? 'dome' : 'workshop';
      engine.setRoom(VIDRO_ROOMS[state.room]);
    } else if (key === 'o') {
      state.orbit.on = !state.orbit.on;
      orb.visible = state.orbit.on;
      dot.style.opacity = state.orbit.on ? '1' : '0.25';
    } else if (key === 'a') {
      if (wind) {
        wind.stop();
        wind = null;
      } else wind = startWind();
      probe.beds.wind = wind !== null;
    } else if (key === 'm') {
      if (drone) {
        drone.stop();
        drone = null;
      } else drone = startDrone();
      probe.beds.drone = drone !== null;
    } else return;
    refreshText();
  };
  window.addEventListener('keydown', onKeyDown);

  let orbitTimer = 0;
  const dotAt = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  let orbitNote = 0;
  const projected = new THREE.Vector3();
  probe.ready = true;

  return {
    scene,
    camera,
    update(dt) {
      // Light rings: spread and fade over RING_SECONDS.
      for (const g of glasses) {
        if (g.ringAge > RING_SECONDS) {
          g.ring.visible = false;
          continue;
        }
        g.ringAge += dt;
        const k = Math.min(1, g.ringAge / RING_SECONDS);
        g.ring.visible = true;
        g.ring.scale.setScalar((g.size / 2) * (1.1 + 1.6 * k));
        (g.ring.material as THREE.MeshBasicNodeMaterial).opacity = 0.85 * (1 - k) ** 2;
      }
      if (state.orbit.on) {
        state.orbit.angle = (state.orbit.angle + THREE.MathUtils.radToDeg(ORBIT_SPEED * dt)) % 360;
        const a = THREE.MathUtils.degToRad(state.orbit.angle);
        // Angle 0 = straight ahead of the listener, increasing clockwise seen from above.
        orbitPos.x = camera.position.x + Math.sin(a) * ORBIT_RADIUS;
        orbitPos.y = camera.position.y - 0.15;
        orbitPos.z = camera.position.z - Math.cos(a) * ORBIT_RADIUS;
        orb.position.set(orbitPos.x, orbitPos.y, orbitPos.z);
        orbitEmitter.setPosition(orbitPos);
        // Only touch the DOM when the dot moved by at least half a pixel.
        const dx = Math.sin(a) * 38;
        const dy = -Math.cos(a) * 38;
        if (Math.abs(dx - dotAt.x) >= 0.5 || Math.abs(dy - dotAt.y) >= 0.5) {
          dotAt.x = dx;
          dotAt.y = dy;
          dot.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
          state.orbit.dotX = dx;
          state.orbit.dotY = dy;
        }
        orbitTimer -= dt;
        if (orbitTimer <= 0) {
          orbitTimer = ORBIT_INTERVAL;
          const note = ORBIT_NOTES[orbitNote++ % ORBIT_NOTES.length] as number;
          const voice = playGlass(
            engine,
            { hz: midiToHz(note), size: 0.07, strength: 'tap' },
            { emitter: orbitEmitter, tuning: VIDRO_GLASS },
          );
          if (voice) state.orbitPlays++;
        }
      }
    },
    resize(width, height) {
      // Note labels under each sphere (static camera, so only on resize).
      for (const [i, g] of glasses.entries()) {
        projected.set(g.pos.x, g.pos.y - g.size / 2 - 0.04, g.pos.z).project(camera);
        const label = labels[i] as HTMLDivElement;
        label.style.left = `${((projected.x + 1) / 2) * width}px`;
        label.style.top = `${((1 - projected.y) / 2) * height + 8}px`;
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      engine.ctx.removeEventListener('statechange', refreshText);
      wind?.stop();
      drone?.stop();
      for (const g of glasses) g.emitter.dispose();
      orbitEmitter.dispose();
      void engine.dispose();
      delete window.__vidroAudioLab;
      envRT.dispose();
      pmrem.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) geometries.add(o.geometry);
      });
      for (const geo of geometries) geo.dispose();
      for (const m of [floorMat, brass, glassMat, orbMat, ...ringMats]) m.dispose();
    },
  };
};

export default create;
