// The navigation drawer: a slide-in panel on phones and tablets, a fixed
// left rail from 1100 px up (the CSS decides which; this file only fills
// it and tracks open or closed). It holds the profile, the Hosts list that
// replaced the old server-list screen, and the doors to everything else.
import { el, icon, iconButton, statusDot } from "./dom.js";
import { hostStatusLabel, relativeTime } from "../shared/home-view-logic.js";
import { renderLocalAi } from "./local-ai.js";
import { openLocal, playLocal } from "./local.js";
import { connectServer, forgetServer, renderAdd, renderDeleteAccount, scanInvite } from "./servers.js";
import { DEVICE, isAndroid, state } from "./state.js";
import type { HomeHost, ServerSummary } from "../shared/types";

const root = document.getElementById("app") as HTMLDivElement;
const drawer = el("aside", "drawer");
const scrim = el("div", "scrim");
const WIDE = window.matchMedia("(min-width: 1100px)");

export function createDrawer(): { drawer: HTMLElement; scrim: HTMLElement } {
  drawer.setAttribute("aria-label", "Navigation");
  scrim.addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  // Crossing the rail breakpoint while open would leave a phone-sized
  // drawer hanging over the page when the window shrinks again.
  WIDE.addEventListener("change", () => closeDrawer());
  return { drawer, scrim };
}

export function isDrawerOpen(): boolean {
  return !WIDE.matches && root.classList.contains("drawer-open");
}

export function openDrawer(): void {
  root.classList.add("drawer-open");
}

export function closeDrawer(): void {
  root.classList.remove("drawer-open");
}

export function toggleDrawer(): void {
  if (root.classList.contains("drawer-open")) closeDrawer();
  else openDrawer();
}

function feedHost(id: string): HomeHost | undefined {
  return state.feed?.hosts.find((host) => host.id === id);
}

function localDotStatus(): string {
  switch (state.local.state) {
    case "running":
      return "online";
    case "starting":
      return "starting";
    default:
      return "offline";
  }
}

function profile(): HTMLElement {
  const wrap = el("div", "drawer-profile");
  const name = state.local.state === "unavailable" ? "" : state.local.username;
  wrap.append(el("span", "avatar", (name || "?").slice(0, 1).toUpperCase()));
  const text = el("div", "grow");
  if (state.local.state === "unavailable") {
    text.append(el("div", "name", "No device world"), el("div", "detail", "Connect to a server to play"));
  } else {
    text.append(el("div", "name", name || "Adventurer"), el("div", "detail", "On this device"));
  }
  wrap.append(text);
  return wrap;
}

function navItem(
  iconName: Parameters<typeof icon>[0],
  label: string,
  onClick: (btn: HTMLButtonElement) => void,
): HTMLButtonElement {
  const btn = el("button", "nav-item");
  btn.type = "button";
  btn.append(icon(iconName), el("span", "grow", label));
  btn.addEventListener("click", () => {
    closeDrawer();
    onClick(btn);
  });
  return btn;
}

function hostRow(
  iconName: Parameters<typeof icon>[0],
  label: string,
  detail: string,
  status: string,
  onClick: (btn: HTMLButtonElement) => void,
): { row: HTMLElement; main: HTMLButtonElement } {
  const row = el("div", "host-row");
  const main = el("button", "host-main");
  main.type = "button";
  main.append(icon(iconName));
  const text = el("span", "grow");
  text.append(el("span", "name", label));
  if (detail) text.append(el("span", "detail", detail));
  main.append(text, statusDot(status));
  main.title = hostStatusLabel({ status } as HomeHost);
  main.addEventListener("click", () => {
    closeDrawer();
    onClick(main);
  });
  row.append(main);
  return { row, main };
}

function serverRow(server: ServerSummary): HTMLElement {
  const host = feedHost(server.id);
  const status = host?.status ?? (server.hasToken ? "offline" : "needsLogin");
  let detail = server.username;
  if (host && host.status !== "online" && host.lastSeenAt) {
    detail += ` · last seen ${relativeTime(host.lastSeenAt, Date.now())}`;
  }
  const { row } = hostRow("server", server.name || server.origin, detail, status, (btn) =>
    void connectServer(server, btn),
  );
  // Icon only: a word here squeezes the host name out of a 240 px rail.
  // Deleting the account there needs a live session; without one the
  // button explains itself on hover and the sign-in path is the row itself.
  const remove = iconButton(
    "trash",
    server.hasToken ? "Delete my account on this server" : "Sign in first to delete your account here",
    () => {
      closeDrawer();
      renderDeleteAccount(server);
    },
    "forget",
  );
  remove.disabled = !server.hasToken;
  row.append(remove);
  row.append(iconButton("close", "Forget this server", () => void forgetServer(server), "forget"));
  return row;
}

function hosts(): HTMLElement {
  const wrap = el("div", "drawer-hosts");
  wrap.append(el("div", "drawer-eyebrow", "Hosts"));
  if (state.local.state !== "unavailable") {
    const detail = state.local.username || (state.local.firstRun ? "Not started yet" : "");
    wrap.append(
      hostRow(isAndroid ? "globe" : "monitor", DEVICE, detail, localDotStatus(), (btn) =>
        void playLocal(btn),
      ).row,
    );
  }
  for (const server of state.servers) wrap.append(serverRow(server));
  return wrap;
}

function settingsItem(): HTMLElement {
  const wrap = el("div");
  const hint = el("p", "hint drawer-hint");
  wrap.append(
    navItem("sliders", "Account & settings", () => {
      if (state.local.state === "running") {
        void openLocal("/settings");
        return;
      }
      hint.textContent =
        state.local.state === "unavailable"
          ? "Your account lives on the server you play on. Open it and use the account menu there."
          : "Your device world must be running first. Enter it, then come back here.";
      wrap.append(hint);
      openDrawer();
    }),
  );
  return wrap;
}

// The privacy policy and terms, reachable from every screen: the policy must
// be readable inside the app, and the drawer is the one place that is always
// a tap away. Both hosts open it in the system browser: Electron through the
// window-open handler target=_blank triggers, Capacitor because any
// navigation off the app origin becomes an ACTION_VIEW intent.
function legal(): HTMLElement {
  const wrap = el("div", "drawer-legal");
  for (const [label, href] of [
    ["Privacy policy", "https://opendungeonmaster.com/privacy/"],
    ["Terms", "https://opendungeonmaster.com/terms/"],
  ] as const) {
    const link = el("a", "", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    wrap.append(link);
  }
  return wrap;
}

export function renderDrawer(): void {
  const items: HTMLElement[] = [profile(), hosts()];
  const nav = el("nav", "drawer-nav");
  nav.append(navItem("plus", "Add a server", () => renderAdd(state.joinIntent?.origin ?? "")));
  nav.append(
    window.odm.scanInvite
      ? navItem("qr", "Scan / paste invite", (btn) => void scanInvite(btn))
      : navItem("link", "Paste invite link", () => renderAdd(state.joinIntent?.origin ?? "")),
  );
  // Story AI is chosen on the world's first run; the door only makes sense
  // once that world exists.
  if (state.local.state !== "unavailable" && !state.local.firstRun) {
    nav.append(navItem("sparkles", "Story AI", () => renderLocalAi(true)));
  }
  nav.append(settingsItem());
  items.push(nav, legal());
  drawer.replaceChildren(...items);
}
