/**
 * Small events of the hand orb (コアメカニクス > 基本の動作), for whatever wants to answer them —
 * first of all the vidro's 「ぽぺん」 (サウンドデザイン > ガラスの音: 覗く・置く・拾うのたびに鳴る;
 * アセットリスト > 音: ビードロの音 4 = 覗く、置く、拾う、震える). S-09 subscribes here; nothing in this
 * module makes a sound.
 */
export type OrbEvent =
  /** The orb starts rising to the eye (覗く開始). */
  | { type: 'peekStart' }
  /** The orb goes back down (覗く終了). */
  | { type: 'peekEnd' }
  /** The orb is set on a pedestal; the back layer starts to materialize (置く). */
  | { type: 'place'; pedestal: string }
  /** The orb comes into the hand: from the workbench, or back from a pedestal (拾う). */
  | { type: 'pickup'; from: 'bench' | 'pedestal' }
  /**
   * The orb trembles to say no (玉が小さく震えて知らせる): peeking while it is placed, or picking it up
   * while standing on footing that only it holds.
   */
  | { type: 'shake'; reason: 'peek' | 'pickup' };

/** Room events that are not the orb's own: touching the light drop and the drop reaching the orb. */
export type RoomEvent = { type: 'dropTouched' } | { type: 'dropTaken' };

export type PrologueEvent = OrbEvent | RoomEvent;

/**
 * An event's name in the probes' logs (the room's event log, the sound's played / refused cues; S-21): its type,
 * with where a pickup came from and why a shake refused — 'pickup:bench', 'shake:peek', 'dropTaken'.
 */
export function eventName(event: PrologueEvent): string {
  if (event.type === 'pickup') return `pickup:${event.from}`;
  if (event.type === 'shake') return `shake:${event.reason}`;
  return event.type;
}

export type Listener<E> = (event: E) => void;

/** Minimal synchronous event bus. */
export class EventBus<E> {
  private readonly listeners = new Set<Listener<E>>();

  /** Subscribes; returns the unsubscribe function. */
  on(listener: Listener<E>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: E): void {
    for (const listener of this.listeners) listener(event);
  }

  clear(): void {
    this.listeners.clear();
  }
}
