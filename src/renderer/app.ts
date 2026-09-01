import type {
  AiSetup,
  HardwareInfo,
  LocalAiTier,
  LocalStatus,
  ServerProbe,
  ServerSummary,
  TunnelStatus,
} from "../shared/types";

// The shell UI: a small screen machine rendered into #app. Only type imports
// above, so the compiled file stays a classic script the page can load
// directly. All privileged work happens across window.odm.

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
  serverVersion: "",
  error: "",
};
let tunnel: TunnelStatus = { state: "stopped", url: "", mode: "", error: "" };
let joinIntent: JoinIntent | null = null;
let screenName = "home";

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

function input(labelText: string, type: string, value = ""): [HTMLLabelElement, HTMLInputElement] {
  const wrap = el("label", "", labelText);
  const field = el("input");
  field.type = type;
  field.value = value;
  wrap.append(field);
  return [wrap, field];
}

function show(...nodes: (HTMLElement | null)[]): void {
  root.replaceChildren(...nodes.filter((node): node is HTMLElement => node !== null));
}

function backButton(label: string, target: () => void): HTMLButtonElement {
  const btn = el("button", "ghost back", label);
  btn.addEventListener("click", target);
  return btn;
}

function joinBanner(): HTMLElement | null {
  if (!joinIntent) return null;
  const banner = el("div", "banner");
  banner.append(el("div", "", "You were invited to a campaign:"));
  const code = el("span", "code", joinIntent.code);
  const line = el("div");
  line.append(code, el("span", "detail", `  on ${joinIntent.origin}`));
  banner.append(line);
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

function localCard(): HTMLElement {
  const card = el("div", "card");
  const grow = el("div", "grow");
  grow.append(el("div", "name", "Play on this computer"));
  const detail =
    local.state === "unavailable"
      ? "This build has no offline play payload."
      : local.state === "error"
        ? local.error
        : local.firstRun
          ? "No server needed. Your world lives on this machine."
          : `Offline world ready${local.serverVersion ? ` (server ${local.serverVersion})` : ""}.`;
  grow.append(el("div", "detail", detail));
  card.append(grow);
  if (local.state === "starting") {
    card.append(el("span", "badge", "Starting"));
  } else if (local.state !== "unavailable") {
    const btn = el("button", "primary", local.firstRun ? "Set up offline play" : "Play offline");
    btn.addEventListener("click", () => void playLocal(btn));
    card.append(btn);
  }
  return card;
}

async function playLocal(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const wasFirstRun = local.firstRun;
  const result = await window.odm.localPlay(joinIntent?.code);
  btn.disabled = false;
  if (result.ok) return;
  if (result.needsLogin) {
    renderLocalAccount(wasFirstRun ? "create" : "login");
  } else {
    await refresh();
    renderHome();
  }
}

function shareCard(): HTMLElement {
  const card = el("div", "card");
  const grow = el("div", "grow");
  grow.append(el("div", "name", "Share this world online"));
  card.append(grow);
  if (tunnel.state === "running") {
    grow.append(el("div", "detail", tunnel.url));
    const copy = el("button", "ghost", "Copy link");
    copy.addEventListener("click", () => {
      void copyText(tunnel.url).then((worked) => {
        copy.textContent = worked ? "Copied" : "Copy failed";
        setTimeout(() => (copy.textContent = "Copy link"), 1500);
      });
    });
    const stop = el("button", "quiet", "Stop");
    stop.addEventListener("click", () => {
      stop.disabled = true;
      void window.odm.shareStop();
    });
    card.append(copy, stop);
  } else if (tunnel.state === "starting") {
    grow.append(el("div", "detail", "Opening a public address..."));
    card.append(el("span", "badge", "Starting"));
  } else {
    grow.append(
      el(
        "div",
        "detail",
        tunnel.state === "error"
          ? tunnel.error
          : "Friends join from anywhere in their browser. The address lives while the app runs.",
      ),
    );
    const start = el("button", "ghost", tunnel.state === "error" ? "Try again" : "Share online");
    start.addEventListener("click", () => {
      start.disabled = true;
      void window.odm.shareStart().then(async (result) => {
        if (!result.ok) tunnel = { state: "error", url: "", mode: "", error: result.error };
        await refresh().catch(() => undefined);
        if (screenName === "home") renderHome();
      });
    });
    card.append(start);
  }
  return card;
}

function serverCard(server: ServerSummary): HTMLElement {
  const card = el("div", "card");
  const grow = el("div", "grow");
  grow.append(el("div", "name", server.name || server.origin));
  grow.append(el("div", "detail", `${server.username} @ ${server.origin}`));
  card.append(grow);
  const connect = el("button", "primary", "Connect");
  connect.addEventListener("click", () => void connectServer(server, connect));
  const remove = el("button", "quiet", "Forget");
  remove.addEventListener("click", () => {
    void window.odm.removeServer(server.id).then(async () => {
      await refresh();
      renderHome();
    });
  });
  card.append(connect, remove);
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

function renderHome(): void {
  screenName = "home";
  const title = el("h1", "", "Open Dungeon Master");
  const sub = el(
    "p",
    "sub",
    window.odm.platform === "android"
      ? "Pick a server to play."
      : "Pick a server, or play offline. Ctrl+M brings you back here.",
  );
  const cards = el("div", "cards");
  // Connect-only shells (Android) have no bundled server; skip the dead card.
  if (!(window.odm.platform === "android" && local.state === "unavailable")) {
    cards.append(localCard());
  }
  if (window.odm.platform === "desktop" && local.state === "running") {
    cards.append(shareCard());
  }
  for (const server of servers) cards.append(serverCard(server));
  const addCard = el("div", "card");
  const grow = el("div", "grow");
  grow.append(el("div", "name", "Add a server"));
  grow.append(el("div", "detail", "Connect to a self-hosted Open Dungeon Master."));
  addCard.append(grow);
  const addBtn = el("button", "ghost", "Add");
  addBtn.addEventListener("click", () => renderAdd(joinIntent?.origin ?? ""));
  addCard.append(addBtn);
  cards.append(addCard);
  show(title, sub, joinBanner(), cards);
}

function renderError(message: string): void {
  const title = el("h1", "", "Something went wrong");
  const body = el("p", "sub", message);
  show(title, body, backButton("Back", () => renderHome()));
}

// ---------- add / auth ----------

function renderAdd(prefill: string): void {
  screenName = "add";
  const title = el("h2", "", "Add a server");
  const form = el("form");
  const [originLabel, originField] = input("Server address", "text", prefill);
  originField.placeholder = "play.example.com or http://192.168.1.50:3005";
  const error = el("p", "error");
  const submit = el("button", "primary", "Continue");
  submit.type = "submit";
  form.append(originLabel, submit, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm.probeServer(originField.value).then((result) => {
      submit.disabled = false;
      if (result.ok) {
        renderAuth(result.probe, "login", "");
      } else {
        error.textContent = result.error;
      }
    });
  });
  show(backButton("Back", () => renderHome()), title, joinBanner(), form);
}

function authTabs(
  probe: ServerProbe,
  active: "login" | "register",
  username: string,
): HTMLElement | null {
  if (probe.signupMode === "closed") return null;
  const tabs = el("div", "tabs");
  const loginTab = el("button", active === "login" ? "active" : "", "Sign in");
  const registerTab = el("button", active === "register" ? "active" : "", "Create account");
  loginTab.addEventListener("click", () => renderAuth(probe, "login", username));
  registerTab.addEventListener("click", () => renderAuth(probe, "register", username));
  tabs.append(loginTab, registerTab);
  return tabs;
}

function renderAuth(probe: ServerProbe, mode: "login" | "register", presetUsername: string): void {
  screenName = "auth";
  const name = probe.serverName || new URL(probe.origin).host;
  const title = el("h2", "", mode === "login" ? `Sign in to ${name}` : `Join ${name}`);
  const sub = el(
    "p",
    "sub",
    `${probe.origin}${probe.version ? ` (server ${probe.version})` : ""}`,
  );
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", presetUsername);
  const [passLabel, passField] = input("Password", "password");
  form.append(userLabel, passLabel);
  let inviteField: HTMLInputElement | null = null;
  if (mode === "register" && probe.signupMode === "invite") {
    const [inviteLabel, field] = input("Account invite code", "text");
    field.placeholder = "ODM-XXXXXXXXXX";
    inviteField = field;
    form.append(inviteLabel);
  }
  const error = el("p", "error");
  const submit = el("button", "primary", mode === "login" ? "Sign in" : "Create account");
  submit.type = "submit";
  form.append(submit, error);
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
  const discordNote = probe.discord
    ? el("p", "hint", "This server also offers Discord sign-in; in the app, use a password account.")
    : null;
  show(
    backButton("Back", () => renderAdd(probe.origin)),
    title,
    sub,
    joinBanner(),
    authTabs(probe, mode, presetUsername),
    form,
    discordNote,
  );
}

// ---------- offline play ----------

function renderLocalAccount(mode: "create" | "login"): void {
  screenName = "local-account";
  const title = el("h2", "", mode === "create" ? "Create your account" : "Sign in to your world");
  const sub = el(
    "p",
    "sub",
    mode === "create"
      ? "This account lives only on this computer and becomes the world's owner."
      : "Use the account you created for offline play.",
  );
  const form = el("form");
  const [userLabel, userField] = input("Username", "text");
  const [passLabel, passField] = input("Password", "password");
  const error = el("p", "error");
  const submit = el("button", "primary", mode === "create" ? "Create" : "Sign in");
  submit.type = "submit";
  form.append(userLabel, passLabel, submit, error);
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
  show(backButton("Back", () => renderHome()), title, sub, form);
}

function renderLocalAi(): void {
  screenName = "local-ai";
  const title = el("h2", "", "Who runs your games?");
  const sub = el(
    "p",
    "sub",
    "You can change this any time in the server settings inside the app.",
  );
  const choices = el("div", "choices");

  const human = el("button", "choice");
  human.append(
    el("span", "title", "A human Dungeon Master"),
    el("span", "desc", "No AI at all. You or a friend runs the table."),
  );
  human.addEventListener("click", () => void finishAi({ choice: "human", apiKey: "", model: "", utilityModel: "" }));

  const openai = el("button", "choice");
  openai.append(
    el("span", "title", "AI Dungeon Master via your OpenAI API key"),
    el("span", "desc", "Narration and image generation billed to your key. No GPU needed."),
  );
  openai.addEventListener("click", () => renderOpenAiForm());

  const localAi = el("button", "choice");
  localAi.append(
    el("span", "title", "Local AI on this machine"),
    el("span", "desc", "Free and private: a guided install sized to your hardware. Needs a beefy machine."),
  );
  localAi.addEventListener("click", () => void startLocalAiFlow());

  choices.append(human, openai, localAi);
  show(title, sub, choices);
}

// ---------- local AI installer ----------

async function startLocalAiFlow(): Promise<void> {
  screenName = "local-ai-scan";
  show(
    el("h2", "", "Checking this machine"),
    el("p", "sub", "Measuring memory and graphics hardware..."),
  );
  const result = await window.odm.localAiScan();
  if (!result.ok) {
    renderError(result.error);
    return;
  }
  renderLocalAiTiers(result.hardware, result.tiers);
}

function renderLocalAiTiers(hardware: HardwareInfo, tiers: LocalAiTier[]): void {
  screenName = "local-ai-tiers";
  const title = el("h2", "", "Pick your storyteller");
  const gpu = hardware.gpuName || "This machine";
  const memory = hardware.unifiedMemory
    ? `${hardware.ramGb} GB unified memory`
    : `${hardware.vramGb} GB graphics memory, ${hardware.ramGb} GB RAM`;
  const sub = el("p", "sub", `${gpu}: ${memory}. Greyed-out choices need more memory.`);
  const choices = el("div", "choices");
  for (const tier of tiers) {
    const button = el("button", "choice");
    button.disabled = !tier.fits;
    const suffix = tier.installed
      ? " (installed)"
      : tier.recommended
        ? " (recommended)"
        : "";
    button.append(
      el("span", "title", `${tier.label}${suffix}`),
      el(
        "span",
        "desc",
        `${tier.detail} ${tier.sizeGb} GB download${
          tier.fits ? "" : `; needs about ${tier.needsGb} GB of memory`
        }.`,
      ),
    );
    if (tier.fits) {
      button.addEventListener("click", () => renderLocalAiInstall(tier));
    }
    choices.append(button);
  }
  show(backButton("Back", () => renderLocalAi()), title, sub, choices);
}

let aiProgress: { fill: HTMLElement; label: HTMLElement } | null = null;

function renderLocalAiInstall(tier: LocalAiTier): void {
  screenName = "local-ai-install";
  const title = el("h2", "", `Setting up ${tier.label.toLowerCase()}`);
  const sub = el(
    "p",
    "sub",
    "Keep the app open. Large downloads resume where they left off if interrupted.",
  );
  const bar = el("div", "progress");
  const fill = el("div", "progress-fill");
  bar.append(fill);
  const label = el("p", "hint", "Starting...");
  const error = el("p", "error");
  aiProgress = { fill, label };
  show(title, sub, bar, label, error);
  void window.odm.localAiInstall(tier.id).then((result) => {
    aiProgress = null;
    if (result.ok) {
      void window.odm.localPlay(joinIntent?.code);
      joinIntent = null;
    } else {
      error.textContent = result.error;
      show(
        backButton("Back", () => void startLocalAiFlow()),
        title,
        el("p", "error", result.error),
      );
    }
  });
}

function renderOpenAiForm(): void {
  screenName = "local-ai-openai";
  const title = el("h2", "", "Connect your OpenAI API key");
  const sub = el("p", "sub", "The key is stored by your local server and never shared with players.");
  const form = el("form");
  const [keyLabel, keyField] = input("API key", "password");
  keyField.placeholder = "sk-...";
  const [modelLabel, modelField] = input("Dungeon Master model", "text", "gpt-5.1");
  const [utilityLabel, utilityField] = input("Utility model (cheaper, for summaries)", "text", "gpt-5-mini");
  const error = el("p", "error");
  const submit = el("button", "primary", "Save and play");
  submit.type = "submit";
  form.append(keyLabel, modelLabel, utilityLabel, submit, error);
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
  show(backButton("Back", () => renderLocalAi()), title, sub, form);
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
  } else if (event.kind === "local-status") {
    local = event.status;
    if (screenName === "home") renderHome();
  } else if (event.kind === "tunnel-status") {
    tunnel = event.status;
    if (screenName === "home") renderHome();
  } else if (event.kind === "local-ai-progress") {
    if (screenName === "local-ai-install" && aiProgress && event.status.progress) {
      aiProgress.fill.style.width = `${event.status.progress.percent}%`;
      aiProgress.label.textContent = `${event.status.progress.label} (${event.status.progress.percent}%)`;
    }
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

void refresh().then(() => renderHome());
