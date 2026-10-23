/**
 * The server's game time in milliseconds (design.md section 1). Each frame
 * number the server sends sets it to frame times the frame length; between
 * frames it moves on with the local clock. Until both a frame and the frame
 * length are known, it is the local clock.
 */
export class GameClock {
  /** @type {number | undefined} milliseconds per frame (the server's CLOCK) */
  #frameMs;
  /** @type {number | undefined} */
  #frame;
  /** local time when the last frame arrived */
  #frameAt = 0;

  /** @param {() => number} [local]  the local clock */
  constructor(local = Date.now) {
    this.local = local;
  }

  /** @param {number} frameMs */
  setFrameMs(frameMs) {
    this.#frameMs = frameMs;
  }

  /** @param {number} frame */
  onFrame(frame) {
    this.#frame = frame;
    this.#frameAt = this.local();
  }

  now() {
    if (this.#frameMs === undefined || this.#frame === undefined) return this.local();
    return this.#frame * this.#frameMs + (this.local() - this.#frameAt);
  }
}
