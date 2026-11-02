// Safety watchdog for runaway execution. Progress is measured in acceptance
// tests flipping to pass and the delta shrinking — never in elapsed time.
// An arbitrary execution duration is not completion; running out the clock
// without progress halts the run with a checkpoint, not a success claim.

export class Watchdog {
  private actionsSinceProgress = 0;
  private lastPassed = -1;

  constructor(readonly maxActionsWithoutProgress = 6) {
    if (!(maxActionsWithoutProgress >= 1)) throw new Error("Watchdog needs at least 1 action of patience.");
  }

  /**
   * Record that an action completed with `passedCount` acceptance tests passing.
   * Returns true to continue, false when the run is going nowhere and must halt.
   */
  noteAction(passedCount: number): boolean {
    if (passedCount > this.lastPassed) {
      this.lastPassed = passedCount;
      this.actionsSinceProgress = 0;
      return true;
    }
    this.actionsSinceProgress++;
    return this.actionsSinceProgress < this.maxActionsWithoutProgress;
  }

  get stalledActions(): number {
    return this.actionsSinceProgress;
  }
}
