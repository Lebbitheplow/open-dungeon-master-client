// The guided tour: a spotlight that walks a newcomer through the shell's
// doors one at a time, with a card explaining each. Runs once on first
// launch and again whenever Help or Settings asks for it. The decisions
// (which steps apply, where the card goes) are in src/shared/tour-logic.ts;
// this file owns the overlay, the drawer, the keyboard and the clock.
import {
  markTourSeen,
  placeCard,
  resolveSteps,
  tourSeen,
  type ResolvedStep,
  type TourStep,
} from "../shared/tour-logic.js";
import { button, el, iconButton } from "./dom.js";
import { closeDrawer, drawerElement, isDrawerOpen, openDrawer } from "./drawer.js";
import { isAndroid, state } from "./state.js";

export const APP_TOUR_ID = "app";

const localModels = isAndroid ? "" : ", or a local model installed on this machine";
const wayBack = isAndroid
  ? "The back gesture at a page's root does the same."
  : "Ctrl+M does the same from anywhere.";

// data-tour values are set where the elements are built (drawer.ts,
// home.ts, chrome.ts). A step names its targets best first; a missing
// first choice falls through to the next with the fallback wording.
export const APP_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Open Dungeon Master",
    body: "Your worlds, your servers and your friends' tables all gather here. This short tour shows where everything lives. You can replay it any time from Help.",
    anchors: [],
  },
  {
    id: "add-server",
    title: "Join a friend's table, or add a server",
    body: "Have an invite? Type the room code the host read out, paste the link, or scan its QR code where the app has a camera. The menu also connects to a self-hosted server by address.",
    anchors: ["home-invite", "add-server", "invite"],
  },
  {
    id: "hosts",
    title: "Your hosts",
    body: "Every server you have signed in to, and the world that lives on this device, are listed here. Tap one to enter it. The dot shows whether it is online right now.",
    anchors: ["hosts"],
  },
  {
    id: "story-ai",
    title: "Enable an AI Dungeon Master",
    body: `Story AI chooses who narrates the world on this device: a human at the table, an AI billed to your OpenAI API key${localModels}. To play with AI on someone else's server, connect to an AI-enabled server.`,
    anchors: ["drawer-story-ai", "hero"],
    fallbackBody: `Begin your world and Story AI appears in the menu. It chooses who narrates: a human at the table, an AI billed to your OpenAI API key${localModels}. Or connect to an AI-enabled server and play there.`,
  },
  {
    id: "workshop",
    title: "The DM workshop",
    body: "The Workshop is where a Dungeon Master preps: maps, monsters, NPCs, lore and handouts, ready to drop into any campaign.",
    anchors: ["tile-workshop", "hero"],
    fallbackBody:
      "Once you have entered a world, a Workshop tile appears here: the Dungeon Master's prep bench for maps, monsters, NPCs, lore and handouts.",
  },
  {
    id: "characters",
    title: "Create your character",
    body: "Build a character in the wizard, or keep a library of them to bring into any campaign.",
    anchors: ["tile-characters", "hero"],
    fallbackBody:
      "Once you have entered a world, a Characters tile appears here for building your adventurers and keeping a library of them.",
  },
  {
    id: "campaign",
    title: "Create your campaign",
    body: "Start a new campaign here: pick a genre or a world pack, decide who narrates, and invite friends with a room code.",
    anchors: ["tile-new-campaign", "hero"],
    fallbackBody:
      "Begin your world here. Once it is running, a New campaign tile appears for starting adventures and inviting friends with a room code.",
  },
  {
    id: "tools",
    title: "Settings and help",
    body: "Updates, sharing your world online, Story AI and this tour live under the gear. The question mark opens the user guide.",
    anchors: ["topbar-tools"],
  },
  {
    id: "back",
    title: "Finding your way back",
    body: `From inside any world, the account menu's App home item brings you back to this screen. ${wayBack} Tap the wordmark on any screen here to return home.`,
    anchors: ["brand"],
  },
];

const WIDE = window.matchMedia("(min-width: 1100px)");
const SPOT_PAD = 6;

interface ActiveTour {
  id: string;
  steps: ResolvedStep[];
  index: number;
  screen: string;
  scrim: HTMLElement;
  spot: HTMLElement;
  card: HTMLElement;
  clock: number;
}

let active: ActiveTour | null = null;

export function isTourActive(): boolean {
  return active !== null;
}

function findAnchor(anchor: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  // A node that is laid out (even off screen, like a closed drawer's items)
  // can be lit; one that is display: none cannot.
  return node && node.getClientRects().length > 0 ? node : null;
}

function currentTarget(tour: ActiveTour): HTMLElement | null {
  const step = tour.steps[tour.index];
  return step && step.anchor ? findAnchor(step.anchor) : null;
}

// Lays the spotlight over the step's target and the card beside it. Called
// on every frame that matters (resize, scroll, the drawer sliding) and on a
// slow clock, since a home re-render replaces the very element being lit.
function position(): void {
  const tour = active;
  if (!tour) return;
  if (state.screenName !== tour.screen) {
    endTour();
    return;
  }
  const target = currentTarget(tour);
  const rect = target ? target.getBoundingClientRect() : null;
  tour.scrim.classList.toggle("dim", !rect);
  if (rect) {
    tour.spot.classList.remove("none");
    tour.spot.style.top = `${rect.top - SPOT_PAD}px`;
    tour.spot.style.left = `${rect.left - SPOT_PAD}px`;
    tour.spot.style.width = `${rect.width + SPOT_PAD * 2}px`;
    tour.spot.style.height = `${rect.height + SPOT_PAD * 2}px`;
  } else {
    tour.spot.classList.add("none");
  }
  const placed = placeCard(
    rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null,
    { width: tour.card.offsetWidth, height: tour.card.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  tour.card.style.top = `${placed.top}px`;
  tour.card.style.left = `${placed.left}px`;
  tour.card.dataset.side = placed.side;
}

function schedulePosition(): void {
  requestAnimationFrame(position);
}

function fillCard(tour: ActiveTour): void {
  const resolved = tour.steps[tour.index];
  if (!resolved) return;
  const last = tour.index === tour.steps.length - 1;
  const head = el("div", "tour-head");
  head.append(el("span", "eyebrow", `${tour.index + 1} of ${tour.steps.length}`));
  head.append(iconButton("close", "End the tour", () => endTour(), "tour-close"));
  const actions = el("div", "tour-actions");
  if (tour.index > 0) actions.append(button("quiet", "Back", () => step(-1)));
  const next = button("primary", last ? "Done" : "Next", () => step(1), last ? undefined : "chevronRight");
  actions.append(next);
  tour.card.replaceChildren(
    head,
    el("h3", "", resolved.step.title),
    el("p", "tour-body", resolved.body),
    actions,
  );
  next.focus({ preventScroll: true });
}

function showStep(tour: ActiveTour): void {
  const target = currentTarget(tour);
  // Drawer items need the drawer open on a phone; anything else needs it
  // closed so it does not sit over the page under the spotlight.
  const inDrawer = Boolean(target && drawerElement().contains(target));
  if (inDrawer && !WIDE.matches) openDrawer();
  else if (!inDrawer && isDrawerOpen()) closeDrawer();
  target?.scrollIntoView({ block: "center", inline: "nearest" });
  fillCard(tour);
  position();
  // The drawer slides for 340 ms; follow it in.
  setTimeout(schedulePosition, 120);
  setTimeout(schedulePosition, 380);
}

function step(delta: number): void {
  const tour = active;
  if (!tour) return;
  const next = tour.index + delta;
  if (next >= tour.steps.length) {
    endTour();
    return;
  }
  tour.index = Math.max(0, next);
  showStep(tour);
}

function onKey(event: KeyboardEvent): void {
  if (!active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    endTour();
  } else if (event.key === "ArrowRight" || event.key === "Enter") {
    event.preventDefault();
    step(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    step(-1);
  }
}

export function endTour(): void {
  const tour = active;
  if (!tour) return;
  active = null;
  markTourSeen(localStorage, tour.id);
  clearInterval(tour.clock);
  window.removeEventListener("resize", schedulePosition);
  window.removeEventListener("scroll", schedulePosition, true);
  document.removeEventListener("keydown", onKey, true);
  tour.scrim.remove();
  tour.spot.remove();
  tour.card.remove();
  if (!WIDE.matches) closeDrawer();
}

export function startTour(id: string, steps: readonly TourStep[]): void {
  endTour();
  const resolved = resolveSteps(steps, (anchor) => findAnchor(anchor) !== null);
  if (resolved.length === 0) return;
  const scrim = el("div", "tour-scrim");
  scrim.addEventListener("click", () => endTour());
  const spot = el("div", "tour-spot");
  const card = el("div", "tour-card panel ornate grain");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Guided tour");
  document.body.append(scrim, spot, card);
  active = {
    id,
    steps: resolved,
    index: 0,
    screen: state.screenName,
    scrim,
    spot,
    card,
    clock: window.setInterval(position, 400),
  };
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, true);
  document.addEventListener("keydown", onKey, true);
  showStep(active);
}

export function startAppTour(): void {
  startTour(APP_TOUR_ID, APP_TOUR_STEPS);
}

export function appTourSeen(): boolean {
  return tourSeen(localStorage, APP_TOUR_ID);
}

// First launch: once the home screen has painted and settled, walk through
// it. Anything that moved the player off home in the meantime (a deep
// link landing on a sign-in) waits for the next launch instead.
export function maybeStartAppTour(): void {
  if (appTourSeen()) return;
  setTimeout(() => {
    if (state.screenName === "home" && !isTourActive()) startAppTour();
  }, 600);
}
