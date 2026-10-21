/**
 * When main.ts lets three write its per-pass GPU timestamps, and when it reads them out (S-11, S-20).
 *
 * three r186's WebGL2 query pool holds 2048 queries, two per render context (every renderer.render(), pass and
 * shadow map: WebGLBackend.initTimestampQuery), and is emptied only when a readback settles. A full pool resets itself,
 * also inside a nested render, and the browser then warns "beginQuery: a query is already active" (S-11). How long a
 * readback takes is up to the browser: 3 to 18 ms with paced frames (60 to 480 fps), but 85 ms to 1.7 s when the page
 * renders uncapped (~600 fps); with the finishing passes (~20 render contexts a frame, S-17) the pool filled before it
 * settled, and the reset handed the pending readback's queries to new passes, so it stalled as well (S-20).
 *
 * So on WebGL2 three writes no per-pass timestamps while a readback is in flight, from the moment it starts: the pool
 * then holds only what the frames between two readbacks wrote, whatever the frame rate and however long a readback
 * takes. A readback starts on
 * the GPU sampling frames (every 8th, main.ts) or as soon as a quarter of the pool is in use, so up to ~770 render
 * contexts a frame fit. The reading is the pass sum of the last frame before the readback either way.
 *
 * WebGPU keeps the earlier behaviour (no pause, no early readback): its pool empties itself when a readback starts and
 * has no active query to collide with, and a pass descriptor cached while the timestamps were on keeps its
 * timestampWrites (main.ts), so they are not switched off and on there.
 *
 * Only main.ts, through this class, may write backend.trackTimestamp (and only it may call resolveTimestampsAsync,
 * S-11): the count of pooled render contexts assumes three writes timestamps exactly while `writing` says so.
 * Recheck on a three upgrade: the WebGL2 pool's size (2048 queries, two per render context), that
 * resolveTimestampsAsync looks at trackTimestamp when it is called, not after an await, and that the pool is emptied
 * when a readback settles. tests/e2e/S-20-timestamp-drain.spec.ts watches the outcome uncapped.
 */

/** Render contexts three r186's WebGL2 pool holds: new WebGLTimestampQueryPool(gl, type, 2048), two queries each. */
export const POOL_CONTEXTS = 1024;
/** A readback starts early once this many render contexts are in the pool (WebGL2). */
export const READ_AT_CONTEXTS = POOL_CONTEXTS / 4;

export interface PassTimestampDrainOptions {
  /** Stop the per-pass timestamps while a readback is in flight (WebGL2). */
  pauseWhileReading: boolean;
  /** Whether three writes them now (backend.trackTimestamp). */
  tracking: boolean;
  /** renderer.info.render.calls now (it counts every render context since the renderer was created). */
  renderCalls: number;
}

export class PassTimestampDrain {
  private readonly pause: boolean;
  private tracking: boolean;
  private calls: number;
  private inFlight = false;
  /** Render contexts that took queries since the pool was last emptied (used where the pause applies). */
  private pooled = 0;

  constructor(options: PassTimestampDrainOptions) {
    this.pause = options.pauseWhileReading;
    this.tracking = options.tracking;
    this.calls = options.renderCalls;
  }

  /** A readback is in flight. */
  get reading(): boolean {
    return this.inFlight;
  }

  /** Whether three should write per-pass timestamps now (after endFrame: until the next frame). */
  get writing(): boolean {
    return this.tracking;
  }

  /**
   * Before the frame's render: whether three writes per-pass timestamps in it (set backend.trackTimestamp to this).
   * `want`: something uses the pass sum (the governor where it is the GPU time, or a recording bench).
   */
  beginFrame(want: boolean, renderCalls: number): boolean {
    this.count(renderCalls);
    this.tracking = want && !(this.pause && this.inFlight);
    return this.tracking;
  }

  /**
   * After the frame's render: whether to start a readback now. Never in a frame three wrote no timestamps in (three
   * warns when asked to resolve them then). After a yes: start it, set backend.trackTimestamp to `writing` (off on
   * WebGL2, so that renders before the next frame take no queries either), and call settled() once it settles or fails.
   */
  endFrame(renderCalls: number, pollFrame: boolean): boolean {
    this.count(renderCalls);
    if (!this.tracking || this.inFlight) return false;
    const filling = this.pause && this.pooled >= READ_AT_CONTEXTS;
    if (!pollFrame && !filling) return false;
    this.inFlight = true;
    if (this.pause) this.tracking = false;
    return true;
  }

  /**
   * The readback settled (or failed): three should have emptied its pool. r186 does not when one of its own readbacks
   * (started by a full pool) is still pending or when no query had ended; neither happens while the pool cannot fill,
   * and three's own reset bounds them anyway.
   */
  settled(): void {
    this.inFlight = false;
    this.pooled = 0;
  }

  /** Renders since the last call took queries if the timestamps were on meanwhile (also renders outside a frame). */
  private count(renderCalls: number): void {
    if (this.tracking) this.pooled += Math.max(0, renderCalls - this.calls);
    this.calls = renderCalls;
  }
}
