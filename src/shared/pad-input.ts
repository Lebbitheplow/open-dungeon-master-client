// Turns gamepad snapshots (the Gamepad API's standard mapping, which is what
// Steam Input's virtual pad and an Xbox or PlayStation pad report) into the
// shell's controller actions: moves that repeat while held, presses on the
// way down, holds for push to talk, and scrolling. Pure: the page feeds it
// navigator.getGamepads() once a frame, the tests feed it numbers.

import type { Direction } from "./spatial-nav";

export interface PadSnapshot {
  // Button values, 0 to 1 (triggers are analog).
  buttons: readonly number[];
  axes: readonly number[];
}

export type PadButton = "a" | "b" | "x" | "y" | "view" | "menu";
export type PadHold = "lb" | "rb";

export type PadAction =
  | { kind: "move"; dir: Direction }
  | { kind: "press"; button: PadButton }
  | { kind: "hold"; button: PadHold; down: boolean }
  | { kind: "scroll"; dx: number; dy: number };

// Standard mapping indices.
export const PAD_INDEX = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

const PRESSES: readonly PadButton[] = ["a", "b", "x", "y", "view", "menu"];
const HOLDS: readonly PadHold[] = ["lb", "rb"];

export interface PadTiming {
  // A held direction moves again after this long, then every repeatMs.
  firstRepeatMs: number;
  repeatMs: number;
  // Stick travel that counts as a direction.
  stickThreshold: number;
  // Below this the right stick and the triggers rest.
  scrollDeadzone: number;
  // Full deflection scrolls this many pixels a second.
  scrollSpeed: number;
}

export const DEFAULT_TIMING: PadTiming = {
  firstRepeatMs: 380,
  repeatMs: 110,
  stickThreshold: 0.5,
  scrollDeadzone: 0.18,
  scrollSpeed: 1600,
};

function value(pads: readonly PadSnapshot[], index: number): number {
  let best = 0;
  for (const pad of pads) best = Math.max(best, pad.buttons[index] ?? 0);
  return best;
}

// The axis value with the largest travel across every pad, so a second pad
// resting at zero never cancels the one being used.
function axis(pads: readonly PadSnapshot[], index: number): number {
  let best = 0;
  for (const pad of pads) {
    const v = pad.axes[index] ?? 0;
    if (Math.abs(v) > Math.abs(best)) best = v;
  }
  return best;
}

function curve(raw: number, deadzone: number): number {
  const travel = Math.abs(raw);
  if (travel < deadzone) return 0;
  const scaled = (travel - deadzone) / (1 - deadzone);
  // Squared, so a small push reads a line at a time and a full one flies.
  return Math.sign(raw) * scaled * scaled;
}

export class PadReader {
  private held = new Set<string>();
  private dir: Direction | null = null;
  private nextRepeat = 0;
  private lastTick = -1;
  private carryX = 0;
  private carryY = 0;

  constructor(private readonly timing: PadTiming = DEFAULT_TIMING) {}

  private direction(pads: readonly PadSnapshot[]): Direction | null {
    const on = (index: number): boolean => value(pads, index) > 0.5;
    if (on(PAD_INDEX.up)) return "up";
    if (on(PAD_INDEX.down)) return "down";
    if (on(PAD_INDEX.left)) return "left";
    if (on(PAD_INDEX.right)) return "right";
    const x = axis(pads, 0);
    const y = axis(pads, 1);
    const threshold = this.timing.stickThreshold;
    if (Math.max(Math.abs(x), Math.abs(y)) < threshold) return null;
    if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
    return y > 0 ? "down" : "up";
  }

  // Everything that happened since the last frame. An empty pad list (the
  // pad went away, or the window lost it) lets go of any hold.
  read(pads: readonly PadSnapshot[], now: number): PadAction[] {
    const actions: PadAction[] = [];
    const elapsed = this.lastTick < 0 ? 0 : Math.min(50, Math.max(0, now - this.lastTick));
    this.lastTick = now;

    const dir = this.direction(pads);
    if (dir !== this.dir) {
      this.dir = dir;
      if (dir) {
        actions.push({ kind: "move", dir });
        this.nextRepeat = now + this.timing.firstRepeatMs;
      }
    } else if (dir && now >= this.nextRepeat) {
      actions.push({ kind: "move", dir });
      this.nextRepeat = now + this.timing.repeatMs;
    }

    for (const button of PRESSES) {
      const down = value(pads, PAD_INDEX[button]) > 0.5;
      if (down && !this.held.has(button)) actions.push({ kind: "press", button });
      if (down) this.held.add(button);
      else this.held.delete(button);
    }
    for (const button of HOLDS) {
      const down = value(pads, PAD_INDEX[button]) > 0.5;
      if (down !== this.held.has(button)) actions.push({ kind: "hold", button, down });
      if (down) this.held.add(button);
      else this.held.delete(button);
    }

    const { scrollDeadzone, scrollSpeed } = this.timing;
    const triggers = value(pads, PAD_INDEX.rt) - value(pads, PAD_INDEX.lt);
    const sx = curve(axis(pads, 2), scrollDeadzone);
    const sy = curve(axis(pads, 3), scrollDeadzone) + curve(triggers, scrollDeadzone);
    if (!sx && !sy) {
      this.carryX = 0;
      this.carryY = 0;
    } else if (elapsed > 0) {
      // Fractions carry over, so a gentle push still creeps instead of
      // rounding to nothing every frame.
      const step = (scrollSpeed * elapsed) / 1000;
      this.carryX += sx * step;
      this.carryY += Math.max(-1, Math.min(1, sy)) * step;
      const dx = Math.trunc(this.carryX);
      const dy = Math.trunc(this.carryY);
      this.carryX -= dx;
      this.carryY -= dy;
      if (dx || dy) actions.push({ kind: "scroll", dx, dy });
    }
    return actions;
  }
}
