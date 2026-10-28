import type * as THREE from 'three/webgpu';

/**
 * The contract between the home → dive host (src/ui/home/dive-host.ts, S-04) and the game world it dives
 * into (S-06's prologue, or S-04's placeholder city). Neutral ground: the game does not depend on the UI.
 *
 * The home orb shows the world drawn with its own camera (トランジション設計 > 遷移の一覧: 玉の中身は序章の
 * シーンそのもの), the dive flies that camera along the world's path, and once landed the world plays and
 * draws itself.
 */
export interface DiveWorld {
  /** The game scene, drawn inside the home orb and on the whole screen during the dive. */
  scene: THREE.Scene;
  /** The game camera; the host flies it during the dive, the world drives it in play. */
  camera: THREE.PerspectiveCamera;
  /** The point the miniature view turns around when the home orb tilts. */
  pivot: THREE.Vector3;
  /** Field of view while the orb shows the miniature, and when standing (the end of the dive). */
  miniatureFov: number;
  standingFov: number;
  /** Game camera pose along the dive: u = 0 the miniature view, u = 1 the pose play starts from. */
  pose(u: number, outPos: THREE.Vector3, outTarget: THREE.Vector3): void;
  /** Once, first thing while loading: build the world (physics, art, environment maps…). */
  prepare(): Promise<void> | void;
  /** One real draw of the playable view to the canvas, so its pipelines compile while loading. */
  warm(): void;
  /** Every frame. While playing it moves the player and the camera; otherwise only ambient motion. */
  update(dt: number, t: number): void;
  /** Draws a playing frame to the canvas. */
  render(): void;
  /** Landed (true) or left (false). Input is held back while false (演出中は入力を預かる). */
  setPlaying(on: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;

  // ---- optional ports (a world without them plays without a pause or settings: S-04's placeholder city) ----

  /** S-42: the world's input asks for the pause (Esc, the mouse let go, Start). Returns the unsubscribe. */
  onPauseRequest?(listener: () => void): () => void;
  /** S-42: the game's time speed, 0..1. */
  setTimeScale?(scale: number): void;
  /** S-42: holds the player's input back (and lets the mouse go) while the pause is up. */
  setHeld?(held: boolean): void;
  /** S-42: asks for the mouse lock again, inside the click or key press that resumes. */
  relock?(): void;
  /**
   * S-43: the player's settings, as the world takes them (設定: 視野角, 覗く, マウスの感度, 上下の反転, 言語). Applied at
   * once, also before the world is built; the camera's field of view at the end of the dive follows `standingFov`.
   */
  applySettings?(settings: WorldSettings): void;
}

/** The settings a world takes (S-43), in its own terms. */
export interface WorldSettings {
  /** Vertical field of view when standing, 60..100 (操作とカメラ > カメラ). Peeking narrows it by 6 as ever. */
  fovDeg: number;
  /** 覗く操作は「長押し」と「押すたびに切り替え」を設定で選べる. */
  peekMode: 'hold' | 'toggle';
  /** Radians per pixel of mouse movement. */
  mouseSensitivity: number;
  invertY: boolean;
  /** Language of the world's own words (the prompts). */
  lang: 'ja' | 'en';
  /** The UI's text size (×1, ×1.2, ×1.4) for the world's own words (the prompts: アクセシビリティ). */
  textScale: number;
  /** コントラスト強化: the world's own frosted labels (the prompts) denser, their edges brighter. */
  contrast: boolean;
  /** The UI's typeface for that language (英語版: 細めのセリフ体), for the world's own words. */
  fontFamily: string;
}
