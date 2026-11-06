// Serial gate: at most one desktop popup at a time. A second question asked while
// a popup is already open goes straight to the native DSH UI instead of stacking
// windows (and never blocks).

/** Single-slot mutual exclusion with an idempotent release. */
export class PopupGate {
  #busy = false

  /** @returns {boolean} whether the slot is taken. */
  get isBusy() {
    return this.#busy
  }

  /**
   * Take the slot when free.
   * @returns {(() => void) | undefined} an idempotent release function, or undefined when busy.
   */
  tryAcquire() {
    if (this.#busy) return undefined
    this.#busy = true
    let released = false
    return () => {
      if (released) return
      released = true
      this.#busy = false
    }
  }
}
