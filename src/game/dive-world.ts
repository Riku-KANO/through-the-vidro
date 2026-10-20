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
}
