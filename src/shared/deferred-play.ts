// play() for a media element whose address the shell sets a beat late
// (server issue 539). The apps fetch a protected sound with the player's
// token and hand the element an object URL once the bytes are in, while a
// page calls play() straight after setting src, as it may in a browser,
// where the element has its new address from that moment. An element that
// already held a file would start the old one again; the new address,
// landing a moment later, reloads the element paused and calls that play()
// off with an AbortError, or leaves it resolved and silent. Narration heard
// once on an element went quiet for every passage after it.
//
// So a play() asked while an address is on its way waits for it, then plays
// what the page asked for. What the page does meanwhile wins, as it does in
// a browser: a newer address or a pause() calls the waiting play() off with
// an AbortError, and an address the host refused rejects it the way a file
// that will not load does, so the page can say the sound failed.

export type DeferredPlay<E extends object> = {
  // The page gave the element an address. `landed` is passed when the shell
  // sets it later: true once the element has it, false if it never will.
  assigned(element: E, landed?: Promise<boolean>): void;
  // The page paused the element.
  paused(element: E): void;
  // The page's play(): at once when the element has its address, otherwise
  // once the address lands.
  play(element: E, nativePlay: () => Promise<void>): Promise<void>;
};

type State = { turn: number; landed: Promise<boolean> | null };

export function createDeferredPlay<E extends object>(): DeferredPlay<E> {
  const states = new WeakMap<E, State>();
  return {
    assigned(element, landed) {
      const state = states.get(element) ?? { turn: 0, landed: null };
      states.set(element, state);
      state.turn += 1;
      state.landed = landed ?? null;
      if (!landed) return;
      void landed.then(
        () => {
          if (state.landed === landed) state.landed = null;
        },
        () => {
          if (state.landed === landed) state.landed = null;
        },
      );
    },
    paused(element) {
      const state = states.get(element);
      if (state) state.turn += 1;
    },
    play(element, nativePlay) {
      const state = states.get(element);
      const landed = state?.landed;
      if (!state || !landed) return nativePlay();
      const turn = state.turn;
      return landed.then(
        (ok) => {
          if (state.turn !== turn) throw new DOMException("The play() request was interrupted by a new load request or a call to pause().", "AbortError");
          if (!ok) throw new DOMException("The element has no supported sources.", "NotSupportedError");
          return nativePlay();
        },
        () => {
          throw new DOMException("The element has no supported sources.", "NotSupportedError");
        },
      );
    },
  };
}
