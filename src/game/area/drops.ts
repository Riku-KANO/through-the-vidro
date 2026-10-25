import { type AreaDecl, dropsOf, type PlacedDrop } from './area';

/**
 * The light drops of the areas and how many of them have been taken, by area (S-36: 取った雫の数をエリアごとに数える).
 * A drop waits; touched it flies into the vidro for `flightSeconds` (光の雫の数: 手の玉の中に光の粒として入っていく); then it is
 * taken for good. Pure state, stepped by the session.
 */
export type DropState = 'waiting' | 'flying' | 'taken';

interface Entry {
  drop: PlacedDrop;
  state: DropState;
  elapsed: number;
}

/** One area's count: its drops and how many are taken. */
export interface AreaCount {
  drops: number;
  taken: number;
}

export class DropTally {
  private readonly entries: Entry[];
  private readonly byId = new Map<string, Entry>();
  /** Every drop, in declaration order (made once). */
  readonly drops: readonly PlacedDrop[];

  constructor(
    areas: readonly AreaDecl[],
    readonly flightSeconds: number,
  ) {
    this.entries = dropsOf(areas).map((drop) => ({ drop, state: 'waiting' as DropState, elapsed: 0 }));
    for (const e of this.entries) this.byId.set(e.drop.id, e);
    this.drops = this.entries.map((e) => e.drop);
  }

  /** The first drop's id (the prologue's, when its area comes first). */
  get first(): string | null {
    return this.entries[0]?.drop.id ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  drop(id: string): PlacedDrop | null {
    return this.byId.get(id)?.drop ?? null;
  }

  state(id: string): DropState {
    return this.byId.get(id)?.state ?? 'waiting';
  }

  /** 0..1 along a drop's flight into the vidro (1 once taken). */
  progress(id: string): number {
    const e = this.byId.get(id);
    if (!e || e.state === 'waiting') return 0;
    if (e.state === 'taken') return 1;
    return Math.min(1, e.elapsed / this.flightSeconds);
  }

  /** Starts a waiting drop's flight. False when it is not waiting (or unknown). */
  touch(id: string): boolean {
    const e = this.byId.get(id);
    if (e?.state !== 'waiting') return false;
    e.state = 'flying';
    e.elapsed = 0;
    return true;
  }

  /** Dev holds: a drop as if taken long ago. */
  setTaken(id: string): void {
    const e = this.byId.get(id);
    if (!e) return;
    e.state = 'taken';
    e.elapsed = this.flightSeconds;
  }

  /** Moves the flights on. Returns the ids of the drops that reached the vidro in this step, in declaration order. */
  step(dt: number): readonly string[] {
    let out: string[] | null = null;
    for (const e of this.entries) {
      if (e.state !== 'flying') continue;
      e.elapsed += dt;
      if (e.elapsed >= this.flightSeconds - 1e-9) {
        e.state = 'taken';
        out ??= [];
        out.push(e.drop.id);
      }
    }
    return out ?? NONE;
  }

  /** Drops taken in an area. */
  taken(area: string): number {
    let n = 0;
    for (const e of this.entries) if (e.drop.area === area && e.state === 'taken') n++;
    return n;
  }

  /** Every area's drops and how many are taken, written into `out` (the probe's object, reused). */
  counts(out: Record<string, AreaCount> = {}): Record<string, AreaCount> {
    for (const e of this.entries) {
      const c = out[e.drop.area];
      if (c) {
        c.drops = 0;
        c.taken = 0;
      } else out[e.drop.area] = { drops: 0, taken: 0 };
    }
    for (const e of this.entries) {
      const c = out[e.drop.area] as AreaCount;
      c.drops++;
      if (e.state === 'taken') c.taken++;
    }
    return out;
  }
}

const NONE: readonly string[] = [];
