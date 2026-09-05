// The frame around every screen: the topbar with its hamburger and brand,
// the page column screens render into, the back link, intro block and form
// card, the invite banner, and the footer with the updater controls.
import { button, chip, el, icon, iconButton, spinner, tile } from "./dom.js";
import { renderDrawer, toggleDrawer } from "./drawer.js";
import { renderHome } from "./home.js";
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

function topbar(): HTMLElement {
  const bar = el("header", "topbar");
  const lead = el("div", "lead");
  lead.append(iconButton("menu", "Menu", () => toggleDrawer(), "hamburger"));
  const brand = el("button", state.screenName === "home" ? "brand" : "brand link");
  brand.type = "button";
  brand.append(tile(), el("span", "wordmark", "Open Dungeon Master"));
  if (state.screenName !== "home") {
    brand.addEventListener("click", () => void refresh().then(() => renderHome()));
    brand.title = "Back home";
  }
  lead.append(brand);
  bar.append(lead);
  const meta = el("div", "meta");
  if (state.appInfo?.version) meta.append(el("span", "", `v${state.appInfo.version}`));
  bar.append(meta);
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
  grow.append(el("div", "detail", "You were invited to a campaign"));
  const line = el("div");
  line.append(el("span", "code", intent.code), el("span", "detail", `  on ${intent.origin}`));
  grow.append(line);
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

// Version, update state and the way home, in one quiet line at the bottom.
export function footer(): HTMLElement {
  const foot = el("footer", "foot");
  const version = state.appInfo?.version
    ? `Open Dungeon Master ${state.appInfo.version}`
    : "Open Dungeon Master";
  foot.append(el("span", "", state.updateNote || version));
  if (isAndroid) return foot;
  const update = state.updateStatus;
  if (update?.available && update.canSelfUpdate) {
    const install = button("primary", `Update to ${update.latest}`, (btn) => {
      btn.disabled = true;
      state.updateNote = "Starting the download...";
      void window.odm.updateInstall().then((result) => {
        if (!result.ok) {
          state.updateNote = result.error;
          rerenderHome();
        }
      });
      renderHome();
    }, "download");
    install.classList.add("quiet-size");
    foot.append(install);
  } else {
    foot.append(
      button("quiet", "Check for updates", (btn) => {
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
          rerenderHome();
        });
        renderHome();
      }),
    );
  }
  foot.append(el("span", "", "Ctrl+M brings you back here from any world."));
  return foot;
}
