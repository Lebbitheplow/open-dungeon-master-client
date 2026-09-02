import type {
  AiSetup,
  AppInfo,
  HardwareInfo,
  LocalAiStatus,
  LocalAiTier,
  LocalStatus,
  ServerProbe,
  ServerSummary,
  TunnelStatus,
  UpdateStatus,
} from "../shared/types";

// The shell UI: a small screen machine rendered into #app, dressed in the
// game's own arcane-night skin so opening a world never feels like leaving
// a launcher for a web page. Only type imports above, so the compiled file
// stays a classic script the page can load directly. All privileged work
// happens across window.odm.

const root = document.getElementById("app") as HTMLDivElement;

interface JoinIntent {
  origin: string;
  code: string;
  knownServerId: string;
}

let servers: ServerSummary[] = [];
let local: LocalStatus = {
  state: "unavailable",
  origin: "",
  firstRun: true,
  hasAccount: false,
  username: "",
  serverVersion: "",
  error: "",
  lanOrigin: "",
};
let tunnel: TunnelStatus = { state: "stopped", url: "", mode: "", error: "" };
let joinIntent: JoinIntent | null = null;
let screenName = "home";
let appInfo: AppInfo | null = null;
let updateStatus: UpdateStatus | null = null;
// One-line update state shown in the footer instead of the version.
let updateNote = "";

const isAndroid = window.odm.platform === "android";

// ---------- DOM helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Lucide outlines (ISC), the same icon set the game draws with.
const ICONS = {
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  play: '<path d="M6 3 20 12 6 21z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  download: '<path d="M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  // Discord's mark (Simple Icons, CC0), drawn filled rather than stroked.
  discord:
    '<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>',
} as const;

const FILLED_ICONS = new Set<keyof typeof ICONS>(["discord"]);

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (FILLED_ICONS.has(name)) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  svg.innerHTML = ICONS[name];
  return svg;
}

function chip(name: keyof typeof ICONS): HTMLElement {
  const wrap = el("span", "chip");
  wrap.append(icon(name));
  return wrap;
}

// The game's d20 loading die: the body tumbles while the face numbers
// cross-fade, so it reads as a roll landing rather than a spinner.
function spinner(big = false): HTMLElement {
  const wrap = el("span", big ? "spinner big" : "spinner");
  const faces = [20, 7, 13, 2, 18, 11]
    .map((n) => `<text class="face" x="12" y="12.6">${n}</text>`)
    .join("");
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<g class="body" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">' +
    '<path d="M12 2 L20.66 7 L20.66 17 L12 22 L3.34 17 L3.34 7 Z"/>' +
    '<path d="M12 6 L17 15 L7 15 Z" fill="currentColor" fill-opacity="0.12"/>' +
    '<path d="M12 6 L12 2 M12 6 L20.66 7 M12 6 L3.34 7 M17 15 L20.66 17 M7 15 L3.34 17 M17 15 L12 22 M7 15 L12 22"/>' +
    "</g>" +
    `<g fill="currentColor" font-size="6" font-weight="700" text-anchor="middle" dominant-baseline="central">${faces}</g>` +
    "</svg>";
  // Staggered through the CSSOM rather than a style attribute: the page's
  // CSP (style-src 'self') blocks inline style attributes, which left every
  // face on the same beat.
  wrap.querySelectorAll<SVGTextElement>("text.face").forEach((face, i) => {
    face.style.animationDelay = `${i * -0.4}s`;
  });
  return wrap;
}

function tile(big = false): HTMLElement {
  const wrap = el("span", big ? "tile big twinkle" : "tile");
  const img = el("img");
  img.src = "./story.png";
  img.alt = "";
  wrap.append(img);
  return wrap;
}

type ButtonKind = "primary" | "secondary" | "quiet" | "quiet danger";

function button(
  kind: ButtonKind,
  label: string,
  onClick?: (btn: HTMLButtonElement) => void,
  leading?: keyof typeof ICONS,
): HTMLButtonElement {
  const btn = el("button", `btn ${kind}`);
  btn.type = "button";
  if (leading) btn.append(icon(leading));
  btn.append(document.createTextNode(label));
  if (onClick) btn.addEventListener("click", () => onClick(btn));
  return btn;
}

function input(labelText: string, type: string, value = ""): [HTMLLabelElement, HTMLInputElement] {
  const wrap = el("label", "", labelText);
  const field = el("input");
  field.type = type;
  field.value = value;
  if (type === "text") {
    field.autocapitalize = "off";
    field.autocomplete = "off";
    field.spellcheck = false;
  }
  wrap.append(field);
  return [wrap, field];
}

function badge(label: string, live = false): HTMLElement {
  const wrap = el("span", live ? "badge live" : "badge");
  if (live) wrap.append(el("span", "dot"));
  wrap.append(document.createTextNode(label));
  return wrap;
}

function topbar(): HTMLElement {
  const bar = el("header", "topbar");
  const brand = el("button", screenName === "home" ? "brand" : "brand link");
  brand.type = "button";
  brand.append(tile(), el("span", "wordmark", "Open Dungeon Master"));
  if (screenName !== "home") {
    brand.addEventListener("click", () => void refresh().then(() => renderHome()));
    brand.title = "Back to the server list";
  }
  bar.append(brand);
  const meta = el("div", "meta");
  if (appInfo?.version) meta.append(el("span", "", `v${appInfo.version}`));
  bar.append(meta);
  return bar;
}

type Layout = "wide" | "narrow" | "mid";

function show(layout: Layout, ...nodes: (HTMLElement | null)[]): void {
  const screen = el("section", layout === "wide" ? "screen" : `screen ${layout}`);
  screen.append(...nodes.filter((node): node is HTMLElement => node !== null));
  root.replaceChildren(topbar(), screen);
  window.scrollTo({ top: 0 });
}

function backLink(label: string, target: () => void): HTMLButtonElement {
  const btn = el("button", "link back");
  btn.type = "button";
  btn.append(icon("arrowLeft"), document.createTextNode(label));
  btn.addEventListener("click", target);
  return btn;
}

// Title block for the focused screens: the twinkling story tile over an
// engraved heading, exactly how the game greets a signed-out visitor.
function intro(title: string, subtitle: string): HTMLElement {
  const wrap = el("div", "intro");
  wrap.append(tile(true));
  const text = el("div");
  text.append(el("h1", "", title));
  if (subtitle) text.append(el("p", "sub", subtitle));
  wrap.append(text);
  return wrap;
}

function formCard(...children: (HTMLElement | null)[]): HTMLElement {
  const card = el("div", "glass grain form-card");
  card.append(...children.filter((node): node is HTMLElement => node !== null));
  return card;
}

function joinBanner(): HTMLElement | null {
  if (!joinIntent) return null;
  const banner = el("div", "panel ornate banner");
  banner.append(chip("link"));
  const grow = el("div", "grow");
  grow.append(el("div", "detail", "You were invited to a campaign"));
  const line = el("div");
  line.append(el("span", "code", joinIntent.code), el("span", "detail", `  on ${joinIntent.origin}`));
  grow.append(line);
  banner.append(grow);
  return banner;
}

async function refresh(): Promise<void> {
  const data = await window.odm.listServers();
  servers = data.servers;
  local = data.local;
  tunnel = data.tunnel;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be refused; the selection trick still works.
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  const worked = document.execCommand("copy");
  area.remove();
  return worked;
}

// ---------- home ----------

// The device's own world is the default door: it sits first, largest, and
// names the profile it opens so nobody has to wonder who they are. On
// Android the world runs inside the app too (a bundled server), so the same
// card serves both, with the device named honestly.
const DEVICE = isAndroid ? "This device" : "This computer";

function localHero(): HTMLElement {
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip(isAndroid ? "globe" : "monitor"));
  const body = el("div", "hero-body");
  const actions = el("div", "hero-actions");
  const who = el("p", "who");

  if (local.state === "unavailable") {
    hero.classList.add("muted");
    body.append(el("h2", "", "Offline play"));
    who.textContent = "This build carries no offline world. Connect to a server below.";
    body.append(who);
    hero.append(body);
    return hero;
  }

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
    if (local.state === "starting") {
      actions.append(spinner(), badge("Starting"));
    } else {
      actions.append(button("primary", "Start playing", (btn) => void playLocal(btn), "play"));
    }
    hero.append(body, actions);
    return hero;
  }

  body.append(el("h2", "", DEVICE));
  if (local.username) {
    who.append(document.createTextNode("Playing as "));
    who.append(el("strong", "", local.username));
    who.append(
      document.createTextNode(
        local.serverVersion ? `. Offline world ready, server ${local.serverVersion}.` : ".",
      ),
    );
  } else {
    who.textContent = "Offline world ready.";
  }
  body.append(who);

  if (local.state === "starting") {
    actions.append(spinner(), badge("Starting"));
  } else {
    actions.append(
      button("secondary", "Story AI", () => renderLocalAi(true), "sparkles"),
      button("primary", "Enter your world", (btn) => void playLocal(btn), "play"),
    );
  }
  hero.append(body, actions);
  if (local.state === "running") hero.append(shareRow());
  return hero;
}

async function playLocal(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const result = await window.odm.localPlay(joinIntent?.code);
  btn.disabled = false;
  if (result.ok) {
    if (result.needsName) {
      // A fresh device world: who is playing comes first, then who narrates.
      renderLocalName();
      return;
    }
    if (result.firstSetup) {
      // The shell just created the local profile; the only choice worth a
      // screen is who tells the story.
      renderLocalAi();
      return;
    }
    joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    renderLocalAccount("login");
  } else {
    await refresh();
    renderHome();
  }
}

// Sharing lives inside the local hero: it only means anything while the
// world runs, and it is a property of that world rather than a peer of it.
// Inviting players from a campaign lobby starts it too, so this row is the
// overview and the off switch more than the usual way in.
function shareRow(): HTMLElement {
  const row = el("div", "hero-actions stacked");
  if (tunnel.state === "running") {
    row.append(badge("Shared online", true));
    const address = el("span", "status-line", tunnel.url);
    row.append(address);
    const copy = button("secondary", "Copy link", () => {
      void copyText(tunnel.url).then((worked) => {
        copy.lastChild!.textContent = worked ? "Copied" : "Copy failed";
        setTimeout(() => (copy.lastChild!.textContent = "Copy link"), 1500);
      });
    }, "link");
    const stop = button("quiet", "Stop sharing", (btn) => {
      btn.disabled = true;
      void window.odm.shareStop();
    });
    row.append(copy, stop);
    return row;
  }
  if (tunnel.state === "starting") {
    row.append(spinner(), el("span", "status-line", "Opening a public address..."));
    return row;
  }
  const idle = local.lanOrigin
    ? `On your Wi-Fi at ${local.lanOrigin}. Share online, or invite players from a campaign lobby, and friends anywhere can join.`
    : "Friends can join from anywhere while the app runs. Inviting players from a campaign lobby shares it for you.";
  const line = el("span", "status-line", tunnel.state === "error" ? tunnel.error : idle);
  const start = button(
    "secondary",
    tunnel.state === "error" ? "Try sharing again" : "Share online",
    (btn) => {
      btn.disabled = true;
      void window.odm.shareStart().then(async (result) => {
        if (!result.ok) tunnel = { state: "error", url: "", mode: "", error: result.error };
        await refresh().catch(() => undefined);
        if (screenName === "home") renderHome();
      });
    },
    "globe",
  );
  row.append(line, start);
  return row;
}

// On Android the most recent server takes the hero spot: one tap continues
// where the player left off, and the rest wait in the list below.
function serverHero(server: ServerSummary): HTMLElement {
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip("server"));
  const body = el("div", "hero-body");
  body.append(el("h2", "", server.name || server.origin));
  const who = el("p", "who");
  who.append(document.createTextNode("Continue as "));
  who.append(el("strong", "", server.username));
  body.append(who, el("div", "origin", hostOf(server.origin)));
  const actions = el("div", "hero-actions");
  actions.append(
    button("quiet danger", "Forget", () => void forgetServer(server)),
    button("primary", "Enter", (btn) => void connectServer(server, btn), "play"),
  );
  hero.append(body, actions);
  return hero;
}

function welcomeHero(): HTMLElement {
  const hero = el("div", "panel ornate grain hero");
  hero.append(chip("globe"));
  const body = el("div", "hero-body");
  body.append(el("h2", "", "Gather your party"));
  body.append(
    el(
      "p",
      "who",
      "Connect to a self-hosted Open Dungeon Master, or scan an invite a friend sent you.",
    ),
  );
  const actions = el("div", "hero-actions");
  if (window.odm.scanInvite) {
    actions.append(button("secondary", "Scan invite", (btn) => void scanInvite(btn), "qr"));
  }
  actions.append(button("primary", "Add a server", () => renderAdd(joinIntent?.origin ?? ""), "plus"));
  hero.append(body, actions);
  return hero;
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

async function forgetServer(server: ServerSummary): Promise<void> {
  await window.odm.removeServer(server.id);
  await refresh();
  renderHome();
}

// Card frame shared by every entry in the grid: icon chip beside the text,
// with the actions row appended by the caller underneath.
function cardShell(
  iconName: keyof typeof ICONS,
  name: string,
  detail: HTMLElement,
): { card: HTMLElement; actions: HTMLElement } {
  const card = el("div", "panel card hoverable");
  const head = el("div", "head");
  head.append(chip(iconName));
  const grow = el("div", "grow");
  grow.append(el("div", "name", name), detail);
  head.append(grow);
  const actions = el("div", "actions");
  card.append(head, actions);
  return { card, actions };
}

function serverCard(server: ServerSummary): HTMLElement {
  const { card, actions } = cardShell(
    "server",
    server.name || server.origin,
    el("div", "detail mono", `${server.username} @ ${server.origin}`),
  );
  actions.append(
    button("quiet danger", "Forget", () => void forgetServer(server)),
    button("primary", "Connect", (btn) => void connectServer(server, btn)),
  );
  return card;
}

async function connectServer(server: ServerSummary, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const result = await window.odm.connect(server.id, joinIntent?.code);
  btn.disabled = false;
  if (result.ok) {
    joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    const probed = await window.odm.probeServer(server.origin);
    if (probed.ok) {
      renderAuth(probed.probe, "login", server.username);
      return;
    }
  }
  renderError(result.error);
}

function actionCard(
  iconName: keyof typeof ICONS,
  name: string,
  detail: string,
  action: HTMLButtonElement,
): HTMLElement {
  const { card, actions } = cardShell(iconName, name, el("div", "detail", detail));
  actions.append(action);
  return card;
}

async function scanInvite(btn: HTMLButtonElement, detail?: HTMLElement): Promise<void> {
  const scan = window.odm.scanInvite;
  if (!scan) return;
  btn.disabled = true;
  const result = await scan();
  btn.disabled = false;
  if (!result.ok) {
    if (detail) detail.textContent = result.error;
    else renderError(result.error);
  }
}

// Version, update state and the way home, in one quiet line at the bottom.
function footer(): HTMLElement {
  const foot = el("footer", "foot");
  const version = appInfo?.version ? `Open Dungeon Master ${appInfo.version}` : "Open Dungeon Master";
  foot.append(el("span", "", updateNote || version));
  if (!isAndroid) {
    if (updateStatus?.available && updateStatus.canSelfUpdate) {
      const install = button("primary", `Update to ${updateStatus.latest}`, (btn) => {
        btn.disabled = true;
        updateNote = "Starting the download...";
        void window.odm.updateInstall().then((result) => {
          if (!result.ok) {
            updateNote = result.error;
            if (screenName === "home") renderHome();
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
          updateNote = "Checking...";
          void window.odm.updateCheck().then((result) => {
            if (result.ok) {
              updateStatus = result.update;
              updateNote = !result.update.available
                ? "You have the latest version."
                : result.update.canSelfUpdate
                  ? `Version ${result.update.latest} is ready to install.`
                  : `Update available: ${result.update.latest}. ${result.update.instruction}`;
            } else {
              updateNote = result.error;
            }
            if (screenName === "home") renderHome();
          });
          renderHome();
        }),
      );
    }
    foot.append(el("span", "", "Ctrl+M brings you back here from any world."));
  }
  return foot;
}

function renderHome(): void {
  screenName = "home";
  const nodes: (HTMLElement | null)[] = [joinBanner()];
  const cards = el("div", "cards");
  let listed = servers;

  if (isAndroid && local.state === "unavailable") {
    // No runtime for this device (unsupported CPU): connect-only, with the
    // most recent server up front.
    const [latest] = servers;
    if (latest) {
      nodes.push(serverHero(latest));
      listed = servers.slice(1);
    } else {
      nodes.push(welcomeHero());
    }
  } else if (local.state !== "unavailable" || servers.length === 0) {
    nodes.push(localHero());
  }

  const heading = el("h2", "eyebrow", listed.length ? "Servers" : "Connect");
  nodes.push(heading);
  for (const server of listed) cards.append(serverCard(server));
  cards.append(
    actionCard(
      "plus",
      "Add a server",
      "A self-hosted Open Dungeon Master, or a pasted invite link.",
      button("secondary", "Add", () => renderAdd(joinIntent?.origin ?? "")),
    ),
  );
  if (window.odm.scanInvite) {
    const detail = el("div", "detail", "Point the camera at a campaign invite code.");
    const { card, actions } = cardShell("qr", "Scan a QR invite", detail);
    actions.append(button("secondary", "Scan", (btn) => void scanInvite(btn, detail)));
    cards.append(card);
  }
  nodes.push(cards, footer());
  show("wide", ...nodes);
}

function renderError(message: string): void {
  screenName = "error";
  const card = formCard(el("h2", "", "Something went wrong"), el("p", "sub", message));
  card.append(button("secondary", "Back", () => void refresh().then(() => renderHome()), "arrowLeft"));
  show("narrow", intro("A snag on the road", ""), card);
}

// ---------- add / auth ----------

function renderAdd(prefill: string): void {
  screenName = "add";
  const form = el("form");
  const [originLabel, originField] = input("Server address", "text", prefill);
  originField.placeholder = "play.example.com or http://192.168.1.50:3005";
  originField.inputMode = "url";
  const error = el("p", "error");
  const submit = button("primary", "Continue");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(originLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void (async () => {
      // A pasted invite link takes the exact deep-link path: auto-connect on
      // a known server, or a join-request event that re-renders this screen
      // with the banner and the origin filled in.
      if (await window.odm.openInviteLink(originField.value)) return;
      const result = await window.odm.probeServer(originField.value);
      submit.disabled = false;
      if (result.ok) {
        renderAuth(result.probe, "login", "");
      } else {
        error.textContent = result.error;
      }
    })();
  });
  const hint = el("p", "hint center", "An invite link or QR link pasted here works too.");
  show(
    "narrow",
    backLink("Servers", () => renderHome()),
    intro("Add a server", "Where does your party gather?"),
    joinBanner(),
    formCard(form, hint),
  );
  originField.focus();
}

function authTabs(
  probe: ServerProbe,
  active: "login" | "register",
  username: string,
): HTMLElement | null {
  if (probe.signupMode === "closed") return null;
  const tabs = el("div", "tabs");
  const loginTab = el("button", active === "login" ? "active" : "", "Sign in");
  loginTab.type = "button";
  const registerTab = el("button", active === "register" ? "active" : "", "Create account");
  registerTab.type = "button";
  loginTab.addEventListener("click", () => renderAuth(probe, "login", username));
  registerTab.addEventListener("click", () => renderAuth(probe, "register", username));
  tabs.append(loginTab, registerTab);
  return tabs;
}

function renderAuth(probe: ServerProbe, mode: "login" | "register", presetUsername: string): void {
  screenName = "auth";
  const name = probe.serverName || new URL(probe.origin).host;
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", presetUsername);
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  form.append(userLabel, passLabel);
  let inviteField: HTMLInputElement | null = null;
  if (mode === "register" && probe.signupMode === "invite") {
    const [inviteLabel, field] = input("Account invite code", "text");
    field.placeholder = "ODM-XXXXXXXXXX";
    inviteField = field;
    form.append(inviteLabel);
    form.append(
      el("p", "hint", "This server is invite-only. Ask whoever runs it for a code."),
    );
  }
  const error = el("p", "error");
  const submit = button("primary", mode === "login" ? "Sign in" : "Create account");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const shared = {
      origin: probe.origin,
      username: userField.value.trim(),
      password: passField.value,
      joinCode: joinIntent?.code,
    };
    const call =
      mode === "login"
        ? window.odm.login(shared)
        : window.odm.register({ ...shared, inviteCode: inviteField?.value.trim() ?? "" });
    void call.then(async (result) => {
      submit.disabled = false;
      if (result.ok) {
        joinIntent = null;
        await refresh();
        renderHome();
      } else {
        error.textContent = result.error;
      }
    });
  });
  // Discord first when the server offers it: one tap, no password to
  // remember, and a brand-new account is created on the way if signups are
  // open. The password form stays underneath for everyone else.
  const leading: (HTMLElement | null)[] = [];
  if (probe.discord) {
    const discord = button(
      "secondary",
      "Sign in with Discord",
      (btn) => {
        btn.disabled = true;
        error.textContent = "";
        void window.odm
          .discordLogin({ origin: probe.origin, joinCode: joinIntent?.code })
          .then(async (result) => {
            btn.disabled = false;
            if (result.ok) {
              joinIntent = null;
              await refresh();
              renderHome();
            } else {
              error.textContent = result.error;
            }
          });
      },
      "discord",
    );
    discord.classList.add("block");
    leading.push(discord, el("div", "divider", "or with a password"));
  }
  const notes: HTMLElement[] = [];
  if (probe.signupMode === "closed" && mode === "login") {
    notes.push(el("p", "hint center", "This server is not accepting new accounts."));
  }
  const subtitle = `${probe.origin}${probe.version ? `, server ${probe.version}` : ""}`;
  show(
    "narrow",
    backLink("Servers", () => renderAdd(probe.origin)),
    intro(name, subtitle),
    joinBanner(),
    formCard(...leading, authTabs(probe, mode, presetUsername), form, ...notes),
  );
  (presetUsername ? passField : userField).focus();
}

// ---------- offline play ----------

function renderLocalAccount(mode: "create" | "login"): void {
  screenName = "local-account";
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", mode === "login" ? local.username : "");
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  const error = el("p", "error");
  const submit = button("primary", mode === "create" ? "Create" : "Sign in");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(userLabel, passLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const credentials = { username: userField.value.trim(), password: passField.value };
    const call =
      mode === "create"
        ? window.odm.localCreateAccount(credentials)
        : window.odm.localLogin(credentials);
    void call.then((result) => {
      submit.disabled = false;
      if (!result.ok) {
        error.textContent = result.error;
        return;
      }
      local = result.status;
      if (mode === "create") {
        renderLocalAi();
      } else {
        void window.odm.localPlay(joinIntent?.code);
      }
    });
  });
  show(
    "narrow",
    backLink("Servers", () => renderHome()),
    intro(
      mode === "create" ? "Create your account" : "Sign in to your world",
      mode === "create"
        ? "This account lives only on this computer and becomes the world's owner."
        : "Use the account you created for offline play.",
    ),
    formCard(form),
  );
  (mode === "login" && local.username ? passField : userField).focus();
}

// First launch of a device world: the name the table will know the player
// by. The shell mints and keeps the password, so this is the whole form.
function renderLocalName(): void {
  screenName = "local-name";
  const form = el("form");
  const [nameLabel, nameField] = input("Your name", "text");
  nameField.placeholder = "How the table will know you";
  nameField.autocomplete = "username";
  nameField.maxLength = 24;
  const error = el("p", "error");
  const submit = button("primary", "Start playing", undefined, "play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(nameLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm
      .localCreateAccount({ username: nameField.value.trim(), password: "" })
      .then((result) => {
        submit.disabled = false;
        if (!result.ok) {
          error.textContent = result.error;
          return;
        }
        local = result.status;
        renderLocalAi();
      });
  });
  show(
    "narrow",
    backLink("Servers", () => void refresh().then(() => renderHome())),
    intro(
      "Name your adventurer",
      "Your world lives on this device. Pick the name friends will see at the table; letters, digits, _ and - only.",
    ),
    formCard(form, el("p", "hint center", "You can add a password later in the game's settings.")),
  );
  nameField.focus();
}

function choice(
  iconName: keyof typeof ICONS,
  title: string,
  desc: string,
  onClick?: () => void,
  tag = "",
): HTMLButtonElement {
  const btn = el("button", "panel ornate choice");
  btn.type = "button";
  btn.append(chip(iconName));
  const text = el("span", "text");
  const heading = el("span", "title", title);
  if (tag) heading.append(el("span", "tag", tag));
  text.append(heading, el("span", "desc", desc));
  btn.append(text);
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}

function renderLocalAi(fromHome = false, aiStatus: LocalAiStatus | null = null): void {
  screenName = "local-ai";
  if (fromHome && !aiStatus) {
    // The entry screen doubles as the status view; fetch once, then re-render
    // with the installed-components card filled in.
    void window.odm.localAiStatus().then((status) => {
      if (screenName === "local-ai") renderLocalAi(true, status);
    });
  }
  const choices = el("div", "choices");
  choices.append(
    choice("user", "A human Dungeon Master", "No AI at all. You or a friend runs the table.", () =>
      void finishAi({ choice: "human", apiKey: "", model: "", utilityModel: "" }),
    ),
    choice(
      "key",
      "AI Dungeon Master via your OpenAI API key",
      "Narration and image generation billed to your key. No GPU needed.",
      () => renderOpenAiForm(),
    ),
  );
  // Local models need a desktop GPU; a phone gets the two doors above.
  if (!isAndroid) {
    choices.append(
      choice(
        "cpu",
        "Local AI on this machine",
        "Free and private: a guided install sized to your hardware. Needs a beefy machine.",
        () => void startLocalAiFlow(),
      ),
    );
  }
  show(
    "mid",
    fromHome ? backLink("Servers", () => renderHome()) : null,
    intro(
      "Who runs your games?",
      "You can change this any time from the Story AI button on the home screen.",
    ),
    localAiStatusCard(aiStatus),
    choices,
  );
}

// What is installed on this machine right now, with per-component removal.
function localAiStatusCard(status: LocalAiStatus | null): HTMLElement | null {
  if (!status || (!status.installedTierId && !status.comfy.installed)) return null;
  const card = el("div", "panel card");
  const head = el("div", "head");
  head.append(chip("cpu"));
  const grow = el("div", "grow");
  grow.append(el("div", "name", "Installed on this machine"));
  if (status.installedTierId) {
    const utility = status.utilityInstalled ? " + utility model" : "";
    grow.append(
      el(
        "div",
        "detail",
        `${status.installedLabel || "Story model"}${utility}: ${status.running ? "running" : "stopped"}.`,
      ),
    );
  }
  if (status.comfy.installed) {
    grow.append(
      el(
        "div",
        "detail",
        `Image generation (ComfyUI): ${status.comfy.running ? "running" : "stopped"}.`,
      ),
    );
  }
  head.append(grow);
  card.append(head);
  const actions = el("div", "actions");
  const uninstall = (label: string, component: "text" | "images", prompt: string): void => {
    actions.append(
      button("quiet danger", label, (btn) => {
        if (!confirm(prompt)) return;
        btn.disabled = true;
        void window.odm.localAiUninstall(component).then((result) => {
          if (result.ok) renderLocalAi(true, result.status);
          else renderError(result.error);
        });
      }),
    );
  };
  if (status.installedTierId) {
    uninstall(
      "Uninstall story AI",
      "text",
      "Delete the local story model and AI engine? Your campaigns stay; the AI stops until you set one up again.",
    );
  }
  if (status.comfy.installed) {
    uninstall(
      "Uninstall image AI",
      "images",
      "Delete ComfyUI and the image model? Existing campaign art stays.",
    );
  }
  card.append(actions);
  card.style.marginBottom = "1.25rem";
  return card;
}

// ---------- local AI installer ----------

function loadingScreen(title: string, detail: string): HTMLElement {
  const wrap = el("div", "loading");
  wrap.append(spinner(true), el("h2", "", title), el("p", "sub", detail));
  return wrap;
}

async function startLocalAiFlow(): Promise<void> {
  screenName = "local-ai-scan";
  show("narrow", loadingScreen("Checking this machine", "Measuring memory and graphics hardware..."));
  const result = await window.odm.localAiScan();
  if (!result.ok) {
    renderError(result.error);
    return;
  }
  renderLocalAiTiers(result.hardware, result.tiers);
}

function renderLocalAiTiers(hardware: HardwareInfo, tiers: LocalAiTier[]): void {
  screenName = "local-ai-tiers";
  const gpu = hardware.gpuName || "This machine";
  const memory = hardware.unifiedMemory
    ? `${hardware.ramGb} GB unified memory`
    : `${hardware.vramGb} GB graphics memory, ${hardware.ramGb} GB RAM`;
  const choices = el("div", "choices");
  for (const tier of tiers) {
    const tag = tier.installed ? "installed" : tier.recommended ? "recommended" : "";
    const desc = `${tier.detail} ${tier.sizeGb} GB download${
      tier.fits ? "" : `; needs about ${tier.needsGb} GB of memory`
    }.`;
    const btn = choice(
      "sparkles",
      tier.label,
      desc,
      tier.fits ? () => renderLocalAiInstall(tier) : undefined,
      tag,
    );
    btn.disabled = !tier.fits;
    choices.append(btn);
  }
  show(
    "mid",
    backLink("Story AI", () => renderLocalAi()),
    intro("Pick your storyteller", `${gpu}: ${memory}. Greyed-out choices need more memory.`),
    choices,
  );
}

let aiProgress: { fill: HTMLElement; label: HTMLElement } | null = null;

function progressCard(label: HTMLElement): { card: HTMLElement; fill: HTMLElement } {
  const card = el("div", "glass grain form-card");
  const bar = el("div", "progress");
  const fill = el("div", "progress-fill");
  bar.append(fill);
  card.append(bar, label);
  return { card, fill };
}

function renderLocalAiInstall(tier: LocalAiTier): void {
  screenName = "local-ai-install";
  const label = el("p", "hint", "Starting...");
  const { card, fill } = progressCard(label);
  aiProgress = { fill, label };
  show(
    "narrow",
    intro(
      `Setting up ${tier.label.toLowerCase()}`,
      "Keep the app open. Large downloads resume where they left off if interrupted.",
    ),
    card,
  );
  void window.odm.localAiInstall(tier.id).then((result) => {
    aiProgress = null;
    if (!result.ok) {
      show(
        "narrow",
        backLink("Story AI", () => void startLocalAiFlow()),
        intro(`Setting up ${tier.label.toLowerCase()}`, ""),
        formCard(el("p", "error", result.error)),
      );
      return;
    }
    // Next stop: images, unless ComfyUI is already there. A wiring warning
    // rides along so it is seen before the world swallows the screen.
    if (result.status.comfy.installed) {
      if (result.warning) renderWarning(result.warning);
      else void enterLocalWorld();
    } else {
      renderComfyOffer(result.warning);
    }
  });
}

async function enterLocalWorld(): Promise<void> {
  await window.odm.localPlay(joinIntent?.code);
  joinIntent = null;
}

// Success with a caveat: something installed fine but its settings PATCH
// failed. One screen, one Continue, no pretending it fully worked.
function renderWarning(warning: string): void {
  screenName = "local-ai-warning";
  const card = formCard(el("p", "error", warning));
  const cont = button("primary", "Continue", () => void enterLocalWorld(), "play");
  cont.classList.add("block");
  card.append(cont);
  show("narrow", intro("Installed, with one loose end", ""), card);
}

function renderComfyOffer(warning: string): void {
  screenName = "local-ai-comfy";
  const choices = el("div", "choices");
  choices.append(
    choice(
      "image",
      "Install image generation (ComfyUI)",
      "One big download now; scene images in your campaigns from then on.",
      () => renderComfyInstall(),
    ),
    choice("play", "Skip for now", "Play with the story model only. You can add images later.", () =>
      void enterLocalWorld(),
    ),
  );
  show(
    "mid",
    intro(
      "Add local image generation?",
      "ComfyUI with the Stable Diffusion XL model paints scene art on your GPU, free and private. About 15 GB all told (Python packages included); needs Python 3 and Git installed. You can remove it later from the Story AI screen.",
    ),
    warning ? el("p", "error", warning) : null,
    choices,
  );
}

function renderComfyInstall(): void {
  screenName = "local-ai-comfy-install";
  const label = el("p", "hint", "Starting...");
  const { card, fill } = progressCard(label);
  aiProgress = { fill, label };
  show(
    "narrow",
    intro(
      "Setting up image generation",
      "Keep the app open. The big downloads resume where they left off if interrupted.",
    ),
    card,
  );
  void window.odm.localAiInstallComfy().then((result) => {
    aiProgress = null;
    if (!result.ok) {
      show(
        "narrow",
        backLink("Back", () => renderComfyOffer("")),
        intro("Setting up image generation", ""),
        formCard(el("p", "error", result.error)),
      );
      return;
    }
    if (result.warning) renderWarning(result.warning);
    else void enterLocalWorld();
  });
}

function renderOpenAiForm(): void {
  screenName = "local-ai-openai";
  const form = el("form");
  const [keyLabel, keyField] = input("API key", "password");
  keyField.placeholder = "sk-...";
  const [modelLabel, modelField] = input("Dungeon Master model", "text", "gpt-5.1");
  const [utilityLabel, utilityField] = input("Utility model (cheaper, for summaries)", "text", "gpt-5-mini");
  const error = el("p", "error");
  const submit = button("primary", "Save and play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(keyLabel, modelLabel, utilityLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const setup: AiSetup = {
      choice: "openai",
      apiKey: keyField.value.trim(),
      model: modelField.value.trim(),
      utilityModel: utilityField.value.trim(),
    };
    void finishAi(setup).catch(() => undefined).then(() => {
      submit.disabled = false;
    });
  });
  show(
    "narrow",
    backLink("Story AI", () => renderLocalAi()),
    intro(
      "Connect your OpenAI API key",
      "The key is stored by your local server and never shared with players.",
    ),
    formCard(form),
  );
  keyField.focus();
}

async function finishAi(setup: AiSetup): Promise<void> {
  const result = await window.odm.localConfigureAi(setup);
  if (!result.ok) {
    renderError(result.error);
    return;
  }
  await window.odm.localPlay(joinIntent?.code);
  joinIntent = null;
}

// ---------- events and boot ----------

window.odm.onEvent((event) => {
  if (event.kind === "show-manager") {
    void refresh().then(() => renderHome());
  } else if (event.kind === "back") {
    // Android's back gesture: any inner screen returns home; home leaves
    // the app, the way a root screen should.
    if (screenName === "home") void window.odm.leaveApp?.();
    else void refresh().then(() => renderHome());
  } else if (event.kind === "local-status") {
    local = event.status;
    if (screenName === "home") renderHome();
  } else if (event.kind === "tunnel-status") {
    tunnel = event.status;
    if (screenName === "home") renderHome();
  } else if (event.kind === "local-ai-progress") {
    const installing = screenName === "local-ai-install" || screenName === "local-ai-comfy-install";
    if (installing && aiProgress && event.status.progress) {
      aiProgress.fill.style.width = `${event.status.progress.percent}%`;
      aiProgress.label.textContent = `${event.status.progress.label} (${event.status.progress.percent}%)`;
    }
  } else if (event.kind === "update-progress") {
    const progress = event.progress;
    if (progress.state === "available") {
      // The background check found something; the button click fills in the
      // full status (can this install self-update, which instruction).
      updateNote = `Version ${progress.latest} is available.`;
    } else if (progress.state === "downloading") {
      updateNote = `Downloading update... ${progress.percent}%`;
    } else if (progress.state === "ready") {
      updateNote = "Restarting to install the update...";
    } else if (progress.state === "error") {
      updateNote = progress.error;
    }
    if (screenName === "home") renderHome();
  } else if (event.kind === "join-request") {
    joinIntent = { origin: event.origin, code: event.code, knownServerId: event.knownServerId };
    void refresh().then(() => {
      if (event.knownServerId) {
        const known = servers.find((server) => server.id === event.knownServerId);
        if (known) {
          void window.odm.probeServer(known.origin).then((probed) => {
            if (probed.ok) renderAuth(probed.probe, "login", known.username);
            else renderHome();
          });
          return;
        }
      }
      renderAdd(event.origin);
    });
  }
});

void window.odm.appInfo().then((info) => {
  appInfo = info;
  if (screenName === "home") renderHome();
});
void refresh().then(() => renderHome());
