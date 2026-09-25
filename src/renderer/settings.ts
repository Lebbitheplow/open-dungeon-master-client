// App settings, reachable from every screen: updates, the device world's
// switches (Story AI, its account page, sharing online with copy, share
// and QR), the home screen's hide-offline toggle, help and the tour, and
// the legal links. Servers keep their own account settings; this screen
// says so and points there.
import { backLink, closeOverlay, intro, onLeaveScreen, show, showOverlay, updateControls } from "./chrome.js";
import { button, chip, el, icon, spinner } from "./dom.js";
import type { IconName } from "./dom.js";
import { isGameShowing, mountDeviceSettings } from "./game-screen.js";
import { offlineToggle, renderHome } from "./home.js";
import { GUIDE_URL, renderHelp } from "./help.js";
import { openLocal, shareRow } from "./local.js";
import { renderLocalAi } from "./local-ai.js";
import { DEVICE, isAndroid, refresh, state } from "./state.js";
import type { StoryMemory, StoryMemoryStatus } from "../shared/story-memory.js";
import { startAppTour } from "./tour.js";

function section(iconName: IconName, title: string, detail: string): {
  card: HTMLElement;
  body: HTMLElement;
} {
  const card = el("section", "panel ornate grain settings-section");
  const head = el("div", "settings-head");
  head.append(chip(iconName));
  const text = el("div", "grow");
  text.append(el("h3", "", title));
  if (detail) text.append(el("p", "detail", detail));
  head.append(text);
  const body = el("div", "settings-body");
  card.append(head, body);
  return { card, body };
}

function row(label: string, control: HTMLElement): HTMLElement {
  const line = el("div", "settings-row");
  line.append(el("span", "grow", label), control);
  return line;
}

// Microphone, playback, levels and dice: the server's own DeviceSettings
// panel, drawn by the game bundle into this card. Its controls write the
// stores the table reads, so a call or table in progress follows along.
function audioSection(): HTMLElement {
  const { card, body } = section(
    "sliders",
    "Audio and dice",
    "The microphone and output this device uses, how loud each part of the table is, and the dice on it. Changes reach a call or a table already in progress.",
  );
  const host = el("div", "game-root device-settings");
  host.append(spinner());
  body.append(host);
  // The panel arrives after the screen is shown; whichever comes first,
  // leaving the screen takes the panel (and any microphone test) down.
  let gone = false;
  let unmount: (() => void) | null = null;
  onLeaveScreen(() => {
    gone = true;
    unmount?.();
  });
  void mountDeviceSettings(host)
    .then((release) => {
      if (gone) release();
      else unmount = release;
    })
    .catch(() => {
      host.replaceChildren(el("p", "hint", "The audio and dice controls did not load."));
    });
  return card;
}

function appSection(): HTMLElement {
  const version = state.appInfo?.version ? `Version ${state.appInfo.version}` : "";
  const { card, body } = section(
    "cpu",
    "This app",
    isAndroid
      ? `${version}${version ? ". " : ""}Updates arrive through Google Play.`
      : version,
  );
  if (!isAndroid) {
    const note = el("p", "settings-note", state.updateNote);
    body.append(note, updateControls(() => renderSettings()));
  }
  return card;
}

function deviceSection(): HTMLElement | null {
  const local = state.local;
  if (local.state === "unavailable") return null;
  const { card, body } = section(
    isAndroid ? "globe" : "monitor",
    DEVICE,
    local.firstRun
      ? "Your world has not begun yet. Enter it from the home screen and these switches wake up."
      : local.username
        ? `Playing as ${local.username}.${local.lanOrigin ? ` On your Wi-Fi at ${local.lanOrigin}.` : ""}`
        : "",
  );
  if (local.firstRun) return card;
  body.append(
    row(
      "Who narrates: a human, your OpenAI key" + (isAndroid ? "" : ", or a local model"),
      button("secondary", "Story AI", () => renderLocalAi(true), "sparkles"),
    ),
  );
  const account = button("secondary", "Open", () => void openLocal("/settings"), "user");
  const accountRow = row("Your account in this world: name, avatar, password", account);
  if (local.state !== "running") {
    account.disabled = true;
    accountRow.append(el("p", "hint", "Enter your world first; its settings page opens once it is awake."));
  }
  body.append(accountRow);
  const share = el("div", "settings-share");
  share.append(el("span", "settings-label", "Share online"));
  share.append(
    local.state === "running"
      ? shareRow()
      : el("p", "hint", "Sharing starts once your world is awake. Enter it, then come back here or use the campaign lobby's invite dialog."),
  );
  body.append(share);
  return card;
}

// A switch in the same dress as the home screen's hide-offline toggle.
function switchButton(on: boolean, onChange: (next: boolean) => void): HTMLElement {
  const btn = el("button", on ? "toggle on" : "toggle");
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(on));
  const track = el("span", "track");
  track.append(el("span", "knob"));
  btn.append(document.createTextNode(on ? "On" : "Off"), track);
  btn.addEventListener("click", () => onChange(!on));
  return btn;
}

// Portal mode (src/shared/portal-logic.ts). The answer is asked for on
// each paint; until it lands the row shows the default.
let portalOn: boolean | null = null;

function worldsSection(): HTMLElement | null {
  if (state.local.state === "unavailable") return null;
  if (portalOn === null) {
    void window.odm.portalMode().then((on) => {
      portalOn = on;
      if (state.screenName === "settings") renderSettings();
    });
  }
  const { card, body } = section(
    "link",
    "Visiting hosts",
    "Hosts running server 0.16.1 or newer are drawn by the app itself: its own screens, fed by the host's data. This setting covers older hosts.",
  );
  const line = row(
    "Load older worlds through the app: a host on server 0.16.0 gets this app's bundled screens, with only game data travelling to it. Hosts older than that open their own pages regardless.",
    switchButton(portalOn ?? true, (next) => {
      portalOn = next;
      void window.odm.setPortalMode(next);
      renderSettings();
    }),
  );
  body.append(line);
  return card;
}

// Story memory (src/shared/story-memory.ts): which model the device world
// searches its story with. Built once per paint and then updated in place,
// so the chosen card's edge and lift travel through the .choice transitions
// instead of a re-render swapping the cards. Absent on the phone and null
// where the package has no embedding runtime: then the card leaves.
const MEMORY_CHOICES: { id: StoryMemory; icon: IconName; title: string; desc: string }[] = [
  {
    id: "english",
    icon: "book",
    title: "English",
    desc: "Light and quick, and the best fit when your table plays in English. About 90 MB, downloaded once.",
  },
  {
    id: "multilingual",
    icon: "globe",
    title: "Many languages",
    desc: "Italian, Spanish, French, German, Portuguese and about 45 more, and still sound in English. About 135 MB, downloaded once.",
  },
];

// What the card says below the choices. Kept outside the card: the screen
// repaints itself on every status event of the device world (a restart
// sends three), and the line must outlive those repaints.
type MemoryNote =
  | { kind: "none" }
  | { kind: "working" }
  | { kind: "rereading" }
  | { kind: "later" }
  | { kind: "offer"; why: string }
  | { kind: "error"; message: string };

const memory: {
  current: StoryMemoryStatus | null;
  busy: boolean;
  note: MemoryNote;
  repaint: (() => void) | null;
  // The note last laid on screen: a rebuilt card lays it again settled, so
  // only a new note rises in.
  shown: MemoryNote | null;
} = { current: null, busy: false, note: { kind: "none" }, repaint: null, shown: null };

function memoryNote(note: MemoryNote, apply: () => void): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      line.append(spinner(), document.createTextNode(" Restarting your world with its new memory..."));
      return [line];
    }
    case "rereading":
      return [el("p", "hint", "Your world is re-reading its story in the background. Until it finishes, search finds things by keyword, so play on.")];
    case "later":
      return [el("p", "hint", "Saved. Your world uses it the next time it wakes, and re-reads its story then.")];
    case "offer":
      return [
        el("p", "hint", `Saved. ${note.why ? `${note.why} ` : ""}It takes effect the next time your world starts.`),
        row("Switch now instead", button("secondary", "Restart now", apply, "refresh")),
        el("p", "hint", "Anyone at the table reconnects after a few seconds; a turn in progress is lost."),
      ];
    case "error":
      return [el("p", "error", `Your world did not restart: ${note.message}`)];
  }
}

async function applyMemory(): Promise<void> {
  const bridge = window.odm;
  if (!bridge.applyStoryMemory || memory.busy) return;
  memory.busy = true;
  memory.note = { kind: "working" };
  memory.repaint?.();
  const result = await bridge.applyStoryMemory();
  memory.busy = false;
  if (result.ok) {
    memory.current = result.status;
    memory.note = { kind: "rereading" };
    memory.repaint?.();
    return;
  }
  // A world that did not come back changes the rest of the screen too.
  memory.note = { kind: "error", message: result.error };
  if (isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings") renderSettings();
}

async function chooseMemory(id: StoryMemory): Promise<void> {
  const bridge = window.odm;
  if (!bridge.setStoryMemory || memory.busy || !memory.current || memory.current.choice === id) return;
  memory.current = { ...memory.current, choice: id };
  memory.repaint?.();
  const status = await bridge.setStoryMemory(id);
  memory.current = status;
  if (!status.pendingRestart) {
    // Back to the model the world already runs, or a world asleep.
    memory.note = state.local.state === "running" ? { kind: "none" } : { kind: "later" };
    memory.repaint?.();
    return;
  }
  if (isGameShowing()) memory.note = { kind: "offer", why: "A table is open in your world." };
  else if (status.worldInUse) {
    memory.note = {
      kind: "offer",
      why: state.tunnel.state === "running" ? "Your world is shared online." : "Your world is open in this window.",
    };
  } else {
    await applyMemory();
    return;
  }
  memory.repaint?.();
}

function memorySection(): HTMLElement | null {
  const bridge = window.odm;
  if (!bridge.storyMemory || !bridge.setStoryMemory || !bridge.applyStoryMemory) return null;
  if (state.local.state === "unavailable" || state.local.firstRun) return null;
  const { card, body } = section(
    "scroll",
    "Story memory",
    "How your world finds earlier scenes, lore and notes when the story calls back to them. Pick the language your table plays in.",
  );
  const group = el("div", "choices memory-choices");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Story memory language");
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");
  body.append(group, status);

  const cards = new Map<StoryMemory, HTMLButtonElement>();
  for (const option of MEMORY_CHOICES) {
    const btn = el("button", "panel ornate choice");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.append(chip(option.icon));
    const text = el("span", "text");
    text.append(el("span", "title", option.title), el("span", "desc", option.desc));
    btn.append(text);
    btn.addEventListener("click", () => void chooseMemory(option.id));
    cards.set(option.id, btn);
    group.append(btn);
  }

  // In place: the chosen card's edge and lift ride the .choice transitions,
  // and only a changed note lays a new line (whose fade-up then plays).
  let shownNote: MemoryNote | null = null;
  const paint = (): void => {
    for (const [id, btn] of cards) {
      btn.setAttribute("aria-checked", String(memory.current?.choice === id));
      btn.disabled = memory.busy || !memory.current;
    }
    if (shownNote === memory.note) return;
    shownNote = memory.note;
    const nodes = memoryNote(memory.note, () => void applyMemory());
    const line = el("div", memory.shown === memory.note ? "memory-line settled" : "memory-line");
    memory.shown = memory.note;
    line.append(...nodes);
    status.replaceChildren(...(nodes.length ? [line] : []));
  };
  memory.repaint = () => {
    if (card.isConnected) paint();
  };
  paint();

  if (!memory.busy) {
    void bridge.storyMemory().then((answer) => {
      if (!answer) {
        card.remove();
        return;
      }
      if (memory.busy) return;
      memory.current = answer;
      if (answer.pendingRestart && memory.note.kind === "none") {
        memory.note = { kind: "offer", why: answer.worldInUse || isGameShowing() ? "Your world is in use." : "" };
      }
      memory.repaint?.();
    });
  }
  return card;
}

function homeSection(): HTMLElement {
  const { card, body } = section("scroll", "Title screen", "");
  body.append(row("Hide the save slots of hosts that are offline", offlineToggle(() => renderSettings())));
  return card;
}

function helpSection(): HTMLElement {
  const { card, body } = section("help", "Help", "");
  body.append(
    row("Where everything lives and how to get around", button("secondary", "User guide", () => renderHelp(), "book")),
    row(
      "Walk through the title screen again",
      button("secondary", "Replay tour", () => void refresh().then(() => {
        renderHome();
        startAppTour();
      }), "play"),
    ),
  );
  return card;
}

function serversNote(): HTMLElement | null {
  if (state.servers.length === 0) return null;
  const { card, body } = section(
    "server",
    "Servers",
    "Each server keeps your account, avatar and password on its own Settings page: open the server and use the account menu there. Forgetting a server or deleting your account on it is in the menu beside the server's name.",
  );
  body.remove();
  return card;
}

function legalSection(): HTMLElement {
  const { card, body } = section("link", "Links", "");
  for (const [label, href] of [
    ["User guide online", GUIDE_URL],
    ["Privacy policy", "https://opendungeonmaster.com/privacy/"],
    ["Terms of service", "https://opendungeonmaster.com/terms/"],
  ] as const) {
    const link = el("a", "settings-link", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(icon("chevronRight"));
    body.append(link);
  }
  return card;
}

export function renderSettings(): void {
  // A status event repainting this screen keeps the story memory note; a
  // fresh visit starts without one (unless a restart is still running).
  const again = isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings";
  // A story memory restart sends the world's status three times (stopped,
  // starting, running). Rebuilding for each would swap the cards out under
  // their transitions; the restart ends where the screen already stands
  // (running), so those repaints are skipped and applyMemory settles it.
  if (again && memory.busy) return;
  if (!again && !memory.busy) memory.note = { kind: "none" };
  const sections = (): (HTMLElement | null)[] => [
    intro("Settings", "The app, your device world, and the way home."),
    audioSection(),
    appSection(),
    deviceSection(),
    memorySection(),
    worldsSection(),
    homeSection(),
    helpSection(),
    serversNote(),
    legalSection(),
  ];
  // Inside a world, Settings opens over the table so the call and the
  // stream keep running; the way back is to the game, not home.
  if (isGameShowing()) {
    showOverlay("settings", backLink("Back to the game", () => closeOverlay()), ...sections());
    return;
  }
  state.screenName = "settings";
  show("mid", backLink("Home", () => renderHome()), ...sections());
}
