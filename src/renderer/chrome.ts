// The frame around every screen: the topbar with its hamburger and brand,
// the page column screens render into, the back link, intro block and form
// card, the invite banner, and the footer with the updater controls.
import { button, chip, el, icon, iconButton, spinner, tile } from "./dom.js";
import { renderDrawer, toggleDrawer } from "./drawer.js";
import { unmountGame } from "./game-screen.js";
import { renderHelp } from "./help.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { isAndroid, refresh, state } from "./state.js";

const root = document.getElementById("app") as HTMLDivElement;
// The column screens render into; the drawer and its scrim sit beside it.
const page = el("div", "page");
let lastScreen = "";
// A shell screen laid over a running world, if any (showOverlay).
let overlay: HTMLElement | null = null;
// Cleanups a screen registers for the moment it is replaced or its overlay
// closes: a microphone test still running, a mounted component. A screen
// registers them while it is being built, before show() is called, so
// they wait in `pending` and become the shown screen's on show; the
// previous screen's run at that moment.
let pendingHooks = new Set<() => void>();
let leaveHooks = new Set<() => void>();

export function onLeaveScreen(cleanup: () => void): void {
  pendingHooks.add(cleanup);
}

function runLeaveHooks(): void {
  const hooks = [...leaveHooks];
  leaveHooks = pendingHooks;
  pendingHooks = new Set();
  for (const hook of hooks) hook();
}

// Builds the shell once: drawer, scrim and page. Screens replace the page's
// children, so the drawer keeps its scroll and open state across renders.
export function mountShell(drawer: HTMLElement, scrim: HTMLElement): void {
  root.replaceChildren(drawer, scrim, page);
}

function goHome(): void {
  void refresh().then(() => renderHome());
}

// The frame's constant row: menu and wordmark on the left; on the right,
// Home (off the home screen), the user guide and Settings, so no screen is
// ever more than one tap from any of them.
function topbar(): HTMLElement {
  const bar = el("header", "topbar");
  const lead = el("div", "lead");
  const menu = iconButton("menu", "Menu", () => toggleDrawer(), "hamburger");
  menu.dataset.tour = "topbar-menu";
  lead.append(menu);
  const atHome = state.screenName === "home";
  const brand = el("button", atHome ? "brand" : "brand link");
  brand.type = "button";
  brand.dataset.tour = "brand";
  brand.append(tile(), el("span", "wordmark", "Open Dungeon Master"));
  if (!atHome) {
    brand.addEventListener("click", goHome);
    brand.title = "Back home";
  }
  lead.append(brand);
  bar.append(lead);
  const tools = el("div", "meta tools");
  tools.dataset.tour = "topbar-tools";
  if (!atHome) tools.append(iconButton("home", "Home", goHome));
  // Inside a world the guide and Settings open over it and their buttons
  // close them again; elsewhere they are screens of their own.
  const helpOpen = state.overlayName === "help";
  const settingsOpen = state.overlayName === "settings";
  if (state.screenName !== "help") {
    const help = iconButton("help", helpOpen ? "Close the guide" : "User guide", () =>
      helpOpen ? closeOverlay() : renderHelp(),
    );
    help.classList.toggle("active", helpOpen);
    tools.append(help);
  }
  if (state.screenName !== "settings") {
    const gear = iconButton("gear", settingsOpen ? "Close settings" : "Settings", () =>
      settingsOpen ? closeOverlay() : renderSettings(),
    );
    gear.classList.toggle("active", settingsOpen);
    tools.append(gear);
  }
  bar.append(tools);
  return bar;
}

function refreshTopbar(): void {
  page.querySelector(":scope > .topbar")?.replaceWith(topbar());
}

export function isOverlayOpen(): boolean {
  return overlay !== null;
}

// Lays a shell screen over the world on show without taking the world
// down: the call, the event stream and the table keep running underneath.
// The same screen shown again keeps its scroll position.
export function showOverlay(name: "settings" | "help", ...nodes: (HTMLElement | null)[]): void {
  const previous = overlay;
  const keepScroll = previous && state.overlayName === name ? previous.scrollTop : 0;
  runLeaveHooks();
  previous?.remove();
  const sheet = el("div", `overlay ${name}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", name === "settings" ? "Settings" : "User guide");
  const panel = el("section", "screen mid overlay-panel");
  panel.append(...nodes.filter((node): node is HTMLElement => node !== null));
  sheet.append(panel);
  // Under the topbar and beside the drawer, whatever the window's shape.
  const bar = page.querySelector(":scope > .topbar");
  const top = bar ? bar.getBoundingClientRect().bottom : 0;
  sheet.style.setProperty("--overlay-top", `${Math.max(0, Math.round(top))}px`);
  sheet.style.setProperty("--overlay-left", `${Math.round(page.getBoundingClientRect().left)}px`);
  overlay = sheet;
  state.overlayName = name;
  page.append(sheet);
  sheet.scrollTop = keepScroll;
  refreshTopbar();
}

export function closeOverlay(): boolean {
  if (!overlay) return false;
  runLeaveHooks();
  overlay.remove();
  overlay = null;
  state.overlayName = "";
  refreshTopbar();
  return true;
}

export type Layout = "wide" | "narrow" | "mid" | "game";

// A screen re-rendering itself (a status event landing while it shows)
// keeps its scroll position and skips the entrance animation; only moving
// to another screen starts at the top.
export function show(layout: Layout, ...nodes: (HTMLElement | null)[]): void {
  // Leaving a world for any shell screen takes the native game down with
  // it; the game screen itself mounts after this call.
  if (layout !== "game") unmountGame();
  runLeaveHooks();
  overlay = null;
  state.overlayName = "";
  const same = lastScreen === state.screenName;
  lastScreen = state.screenName;
  const screen = el("section", layout === "wide" ? "screen" : `screen ${layout}`);
  if (same) screen.classList.add("still");
  screen.append(...nodes.filter((node): node is HTMLElement => node !== null));
  page.classList.toggle("game", layout === "game");
  page.replaceChildren(topbar(), screen);
  renderDrawer();
  // The backdrop breathes behind every shell screen; under a running
  // world it holds its last frame, so the table has the frame budget.
  if (layout === "game") window.odmTopo?.pause();
  else window.odmTopo?.resume();
  if (!same) window.scrollTo({ top: 0 });
}

export function backLink(label: string, target: () => void): HTMLButtonElement {
  const btn = el("button", "link back");
  btn.type = "button";
  btn.append(icon("arrowLeft"), document.createTextNode(label));
  btn.addEventListener("click", target);
  return btn;
}

// Title block for the focused screens: the twinkling story tile over an
// engraved heading, exactly how the game greets a signed-out visitor.
export function intro(title: string, subtitle: string): HTMLElement {
  const wrap = el("div", "intro");
  wrap.append(tile(true));
  const text = el("div");
  text.append(el("h1", "", title));
  if (subtitle) text.append(el("p", "sub", subtitle));
  wrap.append(text);
  return wrap;
}

export function formCard(...children: (HTMLElement | null)[]): HTMLElement {
  const card = el("div", "glass grain form-card");
  card.append(...children.filter((node): node is HTMLElement => node !== null));
  return card;
}

export function joinBanner(): HTMLElement | null {
  const intent = state.joinIntent;
  if (!intent) return null;
  const banner = el("div", "panel ornate banner");
  banner.append(chip("link"));
  const grow = el("div", "grow");
  if (intent.code) {
    grow.append(el("div", "detail", "You were invited to a campaign"));
    const line = el("div");
    line.append(el("span", "code", intent.code), el("span", "detail", `  on ${intent.origin}`));
    grow.append(line);
  } else {
    // A scanned server address: there is no room to join, only a server to
    // add, and the form below already holds its address.
    grow.append(el("div", "detail", "Adding a server"), el("div", "", intent.origin));
  }
  banner.append(grow);
  return banner;
}

export function loadingScreen(title: string, detail: string): HTMLElement {
  const wrap = el("div", "loading");
  wrap.append(spinner(true), el("h2", "", title), el("p", "sub", detail));
  return wrap;
}

function rerenderHome(): void {
  if (state.screenName === "home") renderHome();
}

// The update button: install when one is ready, otherwise check. Shared by
// the home footer and the Settings screen; rerender repaints whichever
// screen asked, once the answer lands in state.updateNote.
export function updateControls(rerender: () => void): HTMLElement {
  const update = state.updateStatus;
  if (update?.available && update.canSelfUpdate) {
    const install = button("primary", `Update to ${update.latest}`, (btn) => {
      btn.disabled = true;
      state.updateNote = "Starting the download...";
      void window.odm.updateInstall().then((result) => {
        if (!result.ok) {
          state.updateNote = result.error;
          rerender();
        }
      });
      rerender();
    }, "download");
    install.classList.add("quiet-size");
    return install;
  }
  return button("quiet", "Check for updates", (btn) => {
    btn.disabled = true;
    state.updateNote = "Checking...";
    void window.odm.updateCheck().then((result) => {
      if (result.ok) {
        state.updateStatus = result.update;
        state.updateNote = !result.update.available
          ? "You have the latest version."
          : result.update.canSelfUpdate
            ? `Version ${result.update.latest} is ready to install.`
            : `Update available: ${result.update.latest}. ${result.update.instruction}`;
      } else {
        state.updateNote = result.error;
      }
      rerender();
    });
    rerender();
  });
}

// Version, update state and the way home, in one quiet line at the bottom.
export function footer(): HTMLElement {
  const foot = el("footer", "foot");
  const version = state.appInfo?.version
    ? `Open Dungeon Master ${state.appInfo.version}`
    : "Open Dungeon Master";
  foot.append(el("span", "", state.updateNote || version));
  if (isAndroid) return foot;
  foot.append(updateControls(rerenderHome));
  foot.append(el("span", "", "Ctrl+M brings you back here from any world."));
  return foot;
}
