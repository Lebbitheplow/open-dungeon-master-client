// "Add to Steam" in Settings, under Steam Deck and controllers (the work is
// src/main/steam-shortcut.ts): the row, Steam's restart question while
// Steam is open, and what happened. The note lives outside the card like
// the Troubleshooting note, since Settings repaints on every status event of
// the world.
import { button, el, spinner } from "./dom.js";
import { state } from "./state.js";
import type { SteamAddResult } from "../shared/types.js";

type SteamNote =
  | { kind: "none" }
  | { kind: "working"; restarting: boolean }
  | { kind: "confirm" }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

const steam: { note: SteamNote; repaint: (() => void) | null; shown: SteamNote | null } = {
  note: { kind: "none" },
  repaint: null,
  shown: null,
};

function setNote(note: SteamNote): void {
  steam.note = note;
  steam.repaint?.();
}

// A fresh visit to Settings starts without the last answer.
export function forgetSteamNote(): void {
  if (steam.note.kind !== "working") steam.note = { kind: "none" };
}

function doneText(result: Extract<SteamAddResult, { state: "added" | "updated" }>): string {
  const library = result.persona ? `${result.persona}'s Steam library` : "your Steam library";
  const what = result.state === "added" ? `Added to ${library}, with its artwork.` : `The app's place in ${library} and its artwork are up to date.`;
  const when = result.restarted ? " Steam is starting again." : " It shows up the next time Steam starts.";
  const where = state.appInfo?.deck?.device ? " In Game Mode it waits under Non-Steam in your library." : "";
  const moved = result.moved ? ` The app's file is now ${result.moved}, a name that stays the same through updates.` : "";
  return `${what}${when}${where}${moved}`;
}

async function add(restart: boolean): Promise<void> {
  const ask = window.odm.addToSteam;
  if (!ask || steam.note.kind === "working") return;
  setNote({ kind: "working", restarting: restart });
  const result = await ask(restart).catch(
    (): SteamAddResult => ({ ok: false, error: "The app could not reach Steam's files." }),
  );
  if (!result.ok) setNote({ kind: "error", message: result.error });
  else if (result.state === "needs-restart") setNote({ kind: "confirm" });
  else setNote({ kind: "done", text: doneText(result) });
}

function noteNodes(note: SteamNote): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      const text = note.restarting ? "Closing Steam, adding the app and opening Steam again" : "Adding the app to Steam";
      line.append(spinner(), document.createTextNode(` ${text}...`));
      return [line];
    }
    case "confirm": {
      const actions = el("div", "transfer-actions");
      actions.append(
        button("primary", "Restart Steam and add", () => void add(true), "refresh"),
        button("secondary", "Not now", () => setNote({ kind: "none" })),
      );
      return [
        el("p", "", "Steam is open. It has to close and open again to take the new game, so anything running in Steam, a game or a download, stops too."),
        actions,
      ];
    }
    case "done":
      return [el("p", "hint", note.text)];
    case "error":
      return [el("p", "error tt-shake", note.message)];
  }
}

// The row and its note, or nothing where the app cannot add itself (not
// Linux, a development run, or no Steam here).
export function steamRows(): HTMLElement[] {
  if (!state.appInfo?.addToSteam || !window.odm.addToSteam) return [];
  const launched = Boolean(state.appInfo.deck?.steam);
  const line = el("div", "settings-row");
  const go = button("secondary", "Add to Steam", () => void add(false), "gamepad");
  line.append(el("span", "grow", "Put this app in your Steam library with its artwork, so it starts from Game Mode like any game"), go);
  if (launched) {
    line.append(el("p", "hint", "Steam started this run, so the app is in your Steam library already. To add it again, start it from your desktop."));
  }
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");

  let shownNote: SteamNote | null = null;
  const paint = (): void => {
    go.disabled = launched || steam.note.kind === "working" || steam.note.kind === "confirm";
    if (shownNote === steam.note) return;
    shownNote = steam.note;
    const nodes = noteNodes(steam.note);
    const holder = el("div", steam.shown === steam.note ? "memory-line settled" : "memory-line");
    steam.shown = steam.note;
    holder.append(...nodes);
    status.replaceChildren(...(nodes.length ? [holder] : []));
  };
  steam.repaint = () => {
    if (status.isConnected) paint();
  };
  paint();
  return [line, status];
}
