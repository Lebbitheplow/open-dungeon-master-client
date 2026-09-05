// The home base: continue where you left off, quick doors into the primary
// host, every campaign grouped under the host it lives on with its live
// status, the device world's sharing controls, and the footer. Decisions
// about what to show come from src/shared/home-view-logic.ts; this file
// only draws them.
import {
  buildGroups,
  heroLine,
  pickContinueCampaign,
  pickPrimaryHost,
  reconcileLocal,
} from "../shared/home-view-logic.js";
import type { CampaignRow, ContinuePick, HostGroup } from "../shared/home-view-logic.js";
import type { HomeFeed, HomeHost, ServerSummary } from "../shared/types";
import { footer, joinBanner, show } from "./chrome.js";
import { badge, button, chip, el, icon, iconButton, spinner, statusDot, tile } from "./dom.js";
import type { IconName } from "./dom.js";
import { renderLocalAi } from "./local-ai.js";
import { playLocal, shareRow } from "./local.js";
import { connectServer, renderAdd, scanInvite, signInTo } from "./servers.js";
import {
  DEVICE,
  hideOffline,
  isAndroid,
  refreshFeed,
  setHideOffline,
  state,
} from "./state.js";

const EMPTY_FEED: HomeFeed = { hosts: [], refreshedAt: "" };

function hostIcon(host: HomeHost): IconName {
  if (host.kind === "local") return isAndroid ? "globe" : "monitor";
  return host.kind === "tunnel" ? "link" : "server";
}

// The scheme is noise on a hero card; the host (and port, for LAN servers)
// is what a player recognizes.
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// Every door into a host goes through here: the device world starts if it
// sleeps, a server connects with its remembered session. path is the page
// to land on ("" for the root).
function openHost(host: HomeHost, path: string, btn: HTMLButtonElement | null): void {
  if (host.kind === "local") {
    void playLocal(btn, path);
    return;
  }
  const server = state.servers.find((entry) => entry.id === host.id);
  if (!server) {
    // The feed remembers a host the list no longer has (forgotten while
    // the cache was stale); adding it back is the honest next step.
    renderAdd(host.origin);
    return;
  }
  void connectServer(server, btn ?? el("button"), path);
}

function openCampaign(host: HomeHost, campaignId: string, btn: HTMLButtonElement | null): void {
  openHost(host, `/campaigns/${encodeURIComponent(campaignId)}`, btn);
}

// ---------- heroes ----------

function sourceChip(host: HomeHost, label: string): HTMLElement {
  const wrap = el("span", "source-chip");
  wrap.append(icon(hostIcon(host)), document.createTextNode(label), statusDot(host.status));
  return wrap;
}

function coverArt(url: string | null, className: string): HTMLElement {
  if (url) {
    const img = el("img", className);
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    return img;
  }
  const holder = el("span", `${className} placeholder`);
  holder.append(tile(className === "cont-art"));
  return holder;
}

function continueHero(pick: ContinuePick): HTMLElement {
  const { host, campaign } = pick;
  const wrap = el("section", "cont panel ornate");
  const cover = el("button", "cont-cover");
  cover.type = "button";
  cover.append(coverArt(campaign.coverUrl, "cont-art"));
  cover.append(sourceChip(host, host.kind === "local" ? "This device" : host.name || hostOf(host.origin)));
  const caption = el("span", "cont-caption");
  caption.append(el("span", "cont-title", campaign.title), el("span", "cont-line", heroLine(campaign)));
  cover.append(caption);
  cover.addEventListener("click", () => openCampaign(host, campaign.id, null));
  const actions = el("div", "cont-actions");
  actions.append(
    button("primary", "Enter world", (btn) => openCampaign(host, campaign.id, btn), "play"),
  );
  wrap.append(cover, actions);
  return wrap;
}

// The device world before it has a campaign to continue: first run,
// starting, a crash, or simply ready.
function localHero(): HTMLElement {
  const local = state.local;
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip(isAndroid ? "globe" : "monitor"));
  const body = el("div", "hero-body");
  const actions = el("div", "hero-actions");
  const who = el("p", "who");

  if (local.state === "error") {
    body.append(el("h2", "", DEVICE));
    who.textContent = local.error || "The offline world could not start.";
    body.append(who);
    actions.append(button("primary", "Try again", (btn) => void playLocal(btn), "play"));
    hero.append(body, actions);
    return hero;
  }

  if (local.firstRun) {
    body.append(el("h2", "", "Begin your world"));
    who.textContent = `No server needed. Your world lives on this ${isAndroid ? "device" : "computer"}, and friends can join from anywhere once you invite them.`;
    body.append(who);
    if (local.state === "starting") actions.append(spinner(), badge("Starting"));
    else actions.append(button("primary", "Start playing", (btn) => void playLocal(btn), "play"));
    hero.append(body, actions);
    return hero;
  }

  body.append(el("h2", "", DEVICE));
  if (local.username) {
    who.append(document.createTextNode("Playing as "), el("strong", "", local.username));
    who.append(
      document.createTextNode(
        local.serverVersion ? `. Offline world ready, server ${local.serverVersion}.` : ".",
      ),
    );
  } else {
    who.textContent = "Offline world ready.";
  }
  body.append(who);
  if (local.state === "starting") actions.append(spinner(), badge("Starting"));
  else actions.append(button("primary", "Enter your world", (btn) => void playLocal(btn), "play"));
  hero.append(body, actions);
  return hero;
}

// No device world in this build: the most recent server takes the hero
// spot so one tap continues where the player left off.
function serverHero(server: ServerSummary): HTMLElement {
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip("server"));
  const body = el("div", "hero-body");
  body.append(el("h2", "", server.name || server.origin));
  const who = el("p", "who");
  who.append(document.createTextNode("Continue as "), el("strong", "", server.username));
  body.append(who, el("div", "origin", hostOf(server.origin)));
  const actions = el("div", "hero-actions");
  actions.append(button("primary", "Enter", (btn) => void connectServer(server, btn), "play"));
  hero.append(body, actions);
  return hero;
}

function welcomeHero(): HTMLElement {
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip("globe"));
  const body = el("div", "hero-body");
  body.append(
    el("h2", "", "Gather your party"),
    el(
      "p",
      "who",
      window.odm.scanInvite
        ? "Connect to a self-hosted Open Dungeon Master, or scan an invite a friend sent you."
        : "Connect to a self-hosted Open Dungeon Master, or paste an invite link a friend sent you.",
    ),
  );
  const actions = el("div", "hero-actions");
  if (window.odm.scanInvite) {
    actions.append(button("secondary", "Scan invite", (btn) => void scanInvite(btn), "qr"));
  } else {
    actions.append(
      button("secondary", "Paste invite", () => renderAdd(state.joinIntent?.origin ?? ""), "link"),
    );
  }
  actions.append(button("primary", "Add a server", () => renderAdd(state.joinIntent?.origin ?? ""), "plus"));
  hero.append(body, actions);
  return hero;
}

function hero(pick: ContinuePick | null): HTMLElement[] {
  if (pick) return [el("h2", "eyebrow", "Continue"), continueHero(pick)];
  if (state.local.state === "unavailable") {
    const [latest] = state.servers;
    return [latest ? serverHero(latest) : welcomeHero()];
  }
  return [localHero()];
}

// ---------- quick tiles ----------

function quickTiles(primary: HomeHost | null): HTMLElement | null {
  // A world that has never started has no pages to open yet; its hero's
  // "Start playing" is the only door until then.
  if (!primary || (primary.kind === "local" && state.local.firstRun)) return null;
  const grid = el("div", "tiles");
  const add = (name: IconName, label: string, path: string): void => {
    const btn = el("button", "quick-tile panel");
    btn.type = "button";
    btn.append(chip(name), el("span", "", label));
    btn.addEventListener("click", () => openHost(primary, path, btn));
    grid.append(btn);
  };
  add("scroll", "New campaign", "/?new=1");
  add("user", "Characters", "/characters");
  add("wand", "Workshop", "/workshop");
  return grid;
}

// ---------- campaigns by host ----------

function offlineToggle(): HTMLElement {
  const on = hideOffline();
  const btn = el("button", on ? "toggle on" : "toggle");
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(on));
  const track = el("span", "track");
  track.append(el("span", "knob"));
  btn.append(document.createTextNode("Hide offline"), track);
  btn.addEventListener("click", () => {
    setHideOffline(!on);
    renderHome();
  });
  return btn;
}

function refreshButton(): HTMLElement {
  const btn = iconButton("refresh", "Refresh", () => {
    void refreshFeed().then(() => {
      if (state.screenName === "home") renderHome();
    });
    renderHome();
  }, state.feedRefreshing ? "spin" : "");
  btn.disabled = state.feedRefreshing;
  return btn;
}

function campaignRow(group: HostGroup, row: CampaignRow): HTMLElement {
  const { host } = group;
  const btn = el("button", "camp-row");
  btn.type = "button";
  if (row.action === "blocked") btn.classList.add("blocked");
  if (host.stale) btn.classList.add("stale");
  btn.append(coverArt(row.campaign.coverUrl, "camp-thumb"));
  const text = el("span", "grow");
  text.append(
    el("span", "camp-title", row.campaign.title),
    el("span", "camp-line", row.reason || row.line),
  );
  btn.append(text);
  if (row.action === "blocked") {
    btn.disabled = true;
    btn.append(el("span", "tag", "can't continue"));
    return btn;
  }
  btn.append(icon("chevronRight"));
  btn.addEventListener("click", () => {
    if (row.action === "signIn") void signInTo(host.origin, host.username);
    else openCampaign(host, row.campaign.id, btn);
  });
  return btn;
}

function hostGroup(group: HostGroup): HTMLElement {
  const { host } = group;
  const wrap = el("section", `host-group ${host.status}`);
  const head = el("div", "host-head");
  head.append(icon(hostIcon(host)), el("span", "host-name", group.label));
  const status = el("span", `host-status ${host.status}`);
  status.append(statusDot(host.status), document.createTextNode(group.statusLabel));
  head.append(status);
  if (group.lastSeen) head.append(el("span", "host-seen", group.lastSeen));
  head.append(el("span", "rule"));
  if (host.status === "needsLogin") {
    const signIn = button("secondary", "Sign in", () => void signInTo(host.origin, host.username), "logIn");
    signIn.classList.add("small");
    head.append(signIn);
  }
  wrap.append(head);
  const grid = el("div", "camp-grid");
  if (group.rows.length === 0) {
    grid.append(
      el(
        "p",
        "camp-empty",
        host.kind !== "local"
          ? "No campaigns on this host yet."
          : state.local.firstRun
            ? "Your first campaign appears here once your world begins."
            : "No campaigns here yet. Start one with New campaign above.",
      ),
    );
  }
  for (const row of group.rows) grid.append(campaignRow(group, row));
  wrap.append(grid);
  return wrap;
}

function campaigns(feed: HomeFeed): HTMLElement[] {
  const head = el("div", "eyebrow-row");
  head.append(el("h2", "eyebrow", "Campaigns"));
  const controls = el("div", "controls");
  controls.append(offlineToggle(), refreshButton());
  head.append(controls);
  const nodes: HTMLElement[] = [head];
  const groups = buildGroups(feed, { hideOffline: hideOffline(), deviceName: DEVICE, now: Date.now() });
  if (groups.length === 0) {
    const empty = el("div", "panel camp-none");
    if (!state.feed) empty.append(spinner(), el("span", "", "Looking for your campaigns..."));
    else if (feed.hosts.length === 0) empty.append(el("span", "", "Add a server or begin your world, and your campaigns gather here."));
    else empty.append(el("span", "", "Every remote host is offline right now. Turn off Hide offline to see them."));
    nodes.push(empty);
    return nodes;
  }
  for (const group of groups) nodes.push(hostGroup(group));
  if (feed.hosts.some((host) => host.kind === "tunnel" && host.status === "offline")) {
    nodes.push(
      el(
        "p",
        "hint",
        "Campaigns hosted on another player's device only appear playable while that app is online. You'll be able to rejoin the moment their host comes back.",
      ),
    );
  }
  return nodes;
}

// ---------- the device world's own controls ----------

function deviceBlock(localIsHero: boolean): HTMLElement[] {
  const local = state.local;
  if (local.state === "unavailable" || local.firstRun) return [];
  const block = el("div", "panel ornate grain device-block");
  const head = el("div", "device-head");
  head.append(chip(isAndroid ? "globe" : "monitor"));
  const grow = el("div", "grow");
  grow.append(el("div", "name", local.username ? `Playing as ${local.username}` : DEVICE));
  const detail =
    local.state === "running"
      ? local.serverVersion
        ? `Your world is awake, server ${local.serverVersion}.`
        : "Your world is awake."
      : local.state === "starting"
        ? "Waking your world..."
        : local.state === "error"
          ? local.error || "The offline world could not start."
          : "Asleep until you enter it. Friends can join once it is awake and shared.";
  grow.append(el("div", "detail", detail));
  head.append(grow);
  const actions = el("div", "actions");
  if (local.state !== "starting") {
    actions.append(button("secondary", "Story AI", () => renderLocalAi(true), "sparkles"));
    if (!localIsHero) {
      actions.append(button("primary", "Enter your world", (btn) => void playLocal(btn), "play"));
    }
  }
  head.append(actions);
  block.append(head);
  if (local.state === "running") block.append(shareRow());
  return [el("h2", "eyebrow", DEVICE), block];
}

export function renderHome(): void {
  state.screenName = "home";
  const feed = reconcileLocal(state.feed ?? EMPTY_FEED, state.local);
  const pick = pickContinueCampaign(feed);
  const primary = pickPrimaryHost(feed, pick);
  const localIsHero = !pick && state.local.state !== "unavailable";
  show(
    "wide",
    joinBanner(),
    ...hero(pick),
    quickTiles(primary),
    ...campaigns(feed),
    ...deviceBlock(localIsHero),
    footer(),
  );
}
