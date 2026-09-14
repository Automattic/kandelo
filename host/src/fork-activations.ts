/**
 * What the host still has to remember about a fork activation.
 *
 * Four fields, and each is here because of something JavaScript can do and the
 * fork-module cannot:
 *
 * - `instance`, because binding a guest function into the module's drive table
 *   is a reference-typed `Table.set`. The module is instantiated BEFORE its
 *   guests -- it supplies their frame-flip imports -- so it cannot import their
 *   exports and the host has to put them where it can reach.
 * - `module`, because custom sections (KFIG, KFIT, the GC codec, the frame
 *   format) come out through `WebAssembly.Module.customSections` and nowhere
 *   else.
 * - `fixedPrefixSize`, read from that frame-format section, which a capture
 *   needs for every side activation.
 * - `activationId`, the key every seed is published under.
 *
 * What is deliberately NOT here is the 2,098-line registry this replaces. That
 * one wrapped each guest's save/restore/harvest exports in JavaScript objects
 * for the HOST to call; the module calls them through the drive table now, so
 * the wrapper has no reader. Reference state, GC transit and the dirty-page
 * journal are the module's for the same reason -- see census section 157.
 */

/** One live activation. */
export interface ForkActivation {
  readonly activationId: number;
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
  readonly fixedPrefixSize: number;
}

/** One side activation, as `fm_parent_begin_capture` reads them. */
export interface ForkSideActivation {
  readonly id: number;
  readonly fixedPrefix: number;
}

/** The module entry registration publishes through. */
export interface ForkActivationDriveSink {
  bindActivationDrive(activationId: number, exports: Record<string, unknown>): void;
}

export class ForkActivations {
  private readonly live = new Map<number, ForkActivation>();

  constructor(
    private readonly drive: ForkActivationDriveSink,
    private readonly label: string,
  ) {}

  /**
   * Remember an activation and bind its guest functions into the drive table.
   *
   * The bind happens HERE rather than at capture because it is a property of
   * the instance, not of a fork: an unbound slot is a `call_indirect` on null
   * inside the module, which surfaces as a trap in the middle of an unwind
   * rather than as a missing feature at registration.
   */
  register(activation: ForkActivation): void {
    if (this.live.has(activation.activationId)) {
      throw new Error(
        `${this.label}: activation ${activation.activationId} is already registered`,
      );
    }
    this.drive.bindActivationDrive(
      activation.activationId,
      activation.instance.exports as Record<string, unknown>,
    );
    this.live.set(activation.activationId, activation);
  }

  /**
   * Forget an activation whose registration did not complete.
   *
   * A delete, and nothing else. What the coordinator's `unregisterActivation`
   * unwound -- reference tables, journals, prepared state -- belongs to the
   * module, which discards it with the capture rather than per activation.
   */
  forget(activationId: number): void {
    if (!this.live.delete(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is not registered`);
    }
  }

  get(activationId: number): ForkActivation | undefined {
    return this.live.get(activationId);
  }

  /**
   * Every live activation, ascending by id.
   *
   * Ascending because that is the order a capture drives them in and the order
   * a child instantiates them: a side activation can register before a
   * lower-numbered one (a dlopen races nothing), so insertion order is not it.
   */
  ordered(): readonly ForkActivation[] {
    return [...this.live.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

  /** The side activations a capture must be told about; activation 0 is not one. */
  sides(): readonly ForkSideActivation[] {
    return this.ordered()
      .filter((activation) => activation.activationId !== 0)
      .map((activation) => ({
        id: activation.activationId,
        fixedPrefix: activation.fixedPrefixSize,
      }));
  }
}
