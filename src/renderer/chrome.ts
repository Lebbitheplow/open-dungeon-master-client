// The frame around every screen: the topbar with its hamburger and brand,
// the page column screens render into, the back link, intro block and form
// card, the invite banner, and the footer with the updater controls.
import { button, chip, el, icon, iconButton, spinner, tile } from "./dom.js";
import { renderDrawer, toggleDrawer } from "./drawer.js";
import { renderHelp } from "./help.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { isAndroid, refresh, state } from "./state.js";

const root = document.getElementById("app") as HTMLDivElement;
// The column screens render into; the drawer and its scrim sit beside it.
const page = el("div", "page");
let lastScreen = "";

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
  if (state.screenName !== "help") tools.append(iconButton("help", "User guide", () => renderHelp()));
  if (state.screenName !== "settings") {
    tools.append(iconButton("gear", "Settings", () => renderSettings()));
  }
  bar.append(tools);
  return bar;
}

export type Layout = "wide" | "narrow" | "mid";

// A screen re-rendering itself (a status event landing while it shows)
// keeps its scroll position and skips the entrance animation; only moving
// to another screen starts at the top.
export function show(layout: Layout, ...nodes: (HTMLElement | null)[]): void {
  const same = lastScreen === state.screenName;
  lastScreen = state.screenName;
  const screen = el("section", layout === "wide" ? "screen" : `screen ${layout}`);
  if (same) screen.classList.add("still");
  screen.append(...nodes.filter((node): node is HTMLElement => node !== null));
  page.replaceChildren(topbar(), screen);
  renderDrawer();
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
