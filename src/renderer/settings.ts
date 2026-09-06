// App settings, reachable from every screen: updates, the device world's
// switches (Story AI, its account page, sharing online with copy, share
// and QR), the home screen's hide-offline toggle, help and the tour, and
// the legal links. Servers keep their own account settings; this screen
// says so and points there.
import { backLink, intro, show, updateControls } from "./chrome.js";
import { button, chip, el, icon } from "./dom.js";
import type { IconName } from "./dom.js";
import { offlineToggle, renderHome } from "./home.js";
import { renderHelp } from "./help.js";
import { openLocal, shareRow } from "./local.js";
import { renderLocalAi } from "./local-ai.js";
import { DEVICE, isAndroid, refresh, state } from "./state.js";
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
    "How the screens of another server reach you.",
  );
  const line = row(
    "Load worlds through the app: the screens come from this app and only game data travels to the host. Hosts running an older server open their own pages regardless.",
    switchButton(portalOn ?? true, (next) => {
      portalOn = next;
      void window.odm.setPortalMode(next);
      renderSettings();
    }),
  );
  body.append(line);
  return card;
}

function homeSection(): HTMLElement {
  const { card, body } = section("scroll", "Home screen", "");
  body.append(row("Hide hosts that are offline", offlineToggle(() => renderSettings())));
  return card;
}

function helpSection(): HTMLElement {
  const { card, body } = section("help", "Help", "");
  body.append(
    row("Where everything lives and how to get around", button("secondary", "User guide", () => renderHelp(), "book")),
    row(
      "Walk through the home screen again",
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
  const { card, body } = section("link", "Legal", "");
  for (const [label, href] of [
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
  state.screenName = "settings";
  show(
    "mid",
    backLink("Home", () => renderHome()),
    intro("Settings", "The app, your device world, and the way home."),
    appSection(),
    deviceSection(),
    worldsSection(),
    homeSection(),
    helpSection(),
    serversNote(),
    legalSection(),
  );
}
