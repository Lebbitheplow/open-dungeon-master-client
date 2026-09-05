// Types crossing the preload bridge between the shell UI and the main
// process. Pure declarations only: this file is shared by the CommonJS main
// build and the browser renderer build, so it must stay runtime-free.

export type SignupMode = "open" | "invite" | "closed";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// What /api/auth/providers reveals about a server before logging in.
export interface ServerProbe {
  origin: string;
  serverName: string;
  version: string;
  signupMode: SignupMode;
  discord: boolean;
  // The world's identity across addresses ("" on servers that predate it).
  // Device worlds get a fresh tunnel hostname every share session; this is
  // how the shell recognizes one it already has an account on.
  instanceId: string;
}

// A remembered server, minus its stored credential.
export interface ServerSummary {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  hasToken: boolean;
}

export interface LocalStatus {
  // "unavailable" means this build carries no bundled server payload.
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  origin: string;
  firstRun: boolean;
  hasAccount: boolean;
  // The on-device profile's name, "" until one exists. Shown on the home
  // screen so the default door says who it opens for.
  username: string;
  serverVersion: string;
  error: string;
  // Where friends on the same network reach a device-hosted world ("" when
  // not hosting or not on a network). Both shells share through a tunnel.
  lanOrigin: string;
}

// The offline-play setup wizard's AI step. "human" changes nothing on the
// server; campaigns simply run with a human Dungeon Master.
export interface AiSetup {
  choice: "openai" | "human";
  apiKey: string;
  model: string;
  utilityModel: string;
}

// firstSetup: the shell just auto-provisioned the local profile, so the
// renderer should offer the one-time AI choice before entering the world.
// needsName: a fresh phone world has no OS username to borrow, so the
// renderer asks for one before the profile is created.
export type ConnectResult =
  | { ok: true; firstSetup?: boolean; needsName?: boolean }
  | { ok: false; needsLogin: boolean; error: string };

// A tunnel sharing the local world at a public https address. "named" means
// a broker-issued play-CODE address; "quick" is the trycloudflare fallback.
export interface TunnelStatus {
  state: "stopped" | "starting" | "running" | "error";
  url: string;
  mode: "" | "named" | "quick";
  error: string;
}

// What a game page inside the shell learns about sharing through
// window.odmShell.share (the server's src/lib/shell-host.ts mirrors this).
// supported is false on pages of remote servers: only the shell's own world
// can be shared from here.
export interface ShellShareStatus extends TunnelStatus {
  supported: boolean;
  // The Wi-Fi address of a device-hosted world, "" when there is none.
  lanUrl: string;
}

// What the hardware scan learned; sizes in whole GB.
export interface HardwareInfo {
  platform: string;
  arch: string;
  ramGb: number;
  // 0 when no GPU signal was found. On unified-memory machines (Apple
  // Silicon) this equals ramGb.
  vramGb: number;
  gpuName: string;
  // Which GPU stack to install compute for; "" when no signal was found.
  gpuVendor: "" | "nvidia" | "amd" | "apple";
  unifiedMemory: boolean;
}

// One entry of the curated model catalog, sized against this machine.
export interface LocalAiTier {
  id: string;
  label: string;
  detail: string;
  sizeGb: number;
  needsGb: number;
  fits: boolean;
  recommended: boolean;
  installed: boolean;
}

export interface LocalAiStatus {
  supported: boolean;
  installedTierId: string;
  // Human label for the installed tier, for status display.
  installedLabel: string;
  // Whether the small summaries model sits beside the story model.
  utilityInstalled: boolean;
  running: boolean;
  busy: "" | "scanning" | "downloading" | "starting";
  progress: { label: string; percent: number } | null;
  error: string;
  // The local image generation stack, installed and removed independently.
  comfy: {
    installed: boolean;
    running: boolean;
    checkpoint: string;
    error: string;
  };
}

// How this build reached the machine; decides whether the app may replace
// itself ("appimage", "nsis") or must point at the real update channel.
export type InstallKind =
  | "appimage"
  | "flatpak"
  | "snap"
  | "managed"
  | "portable"
  | "nsis"
  | "mac"
  | "dev";

// "android" never comes out of detectInstallKind; it is the mobile shell
// identifying itself so the About card can skip the update controls.
export interface AppInfo {
  version: string;
  installKind: InstallKind | "android";
}

export interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  canSelfUpdate: boolean;
  // Human words for installs that cannot self-update ("flatpak update", ...).
  instruction: string;
}

// "available" is the once-per-run background check finding something; the
// rest narrate an explicit download started from the About card.
export interface UpdateProgress {
  state: "idle" | "available" | "downloading" | "ready" | "error";
  percent: number;
  latest: string;
  error: string;
}

// One campaign as the home screen lists it, from any host. playingAs is the
// player's character name there, null when they have none yet or run it.
export interface HomeCampaign {
  id: string;
  title: string;
  status: "lobby" | "active" | "ended";
  playerCount: number;
  maxPlayers: number;
  playingAs: string | null;
  coverUrl: string | null;
  updatedAt: string;
  role: "owner" | "player";
  dmMode: "ai" | "assisted" | "human";
}

// A place the player has campaigns: the device world ("local"), a saved
// server, or another player's app reached through a tunnel address. stale
// means the campaigns did not come from this refresh (the host was not
// reachable, so the last remembered list is shown).
export interface HomeHost {
  id: string;
  kind: "local" | "server" | "tunnel";
  name: string;
  origin: string;
  username: string;
  status: "online" | "offline" | "needsLogin" | "starting" | "unavailable";
  lastSeenAt: string | null;
  stale: boolean;
  error: string;
  campaigns: HomeCampaign[];
}

// refreshedAt is "" for a feed served from the cache before any refresh.
export interface HomeFeed {
  hosts: HomeHost[];
  refreshedAt: string;
}

export type ShellEvent =
  | { kind: "show-manager" }
  // The platform back gesture (Android): leave the current screen for home,
  // or, from home, leave the app.
  | { kind: "back" }
  | { kind: "join-request"; origin: string; code: string; knownServerId: string }
  | { kind: "local-status"; status: LocalStatus }
  | { kind: "tunnel-status"; status: TunnelStatus }
  | { kind: "local-ai-progress"; status: LocalAiStatus }
  | { kind: "update-progress"; progress: UpdateProgress }
  // After every feed refresh, including the ones a local-status or
  // tunnel-status change sets off.
  | { kind: "home-feed"; feed: HomeFeed };

// What a server answers when the player deletes their account there. The
// server signs the account out everywhere and erases it after graceDays
// (at once when purged is true); signing in before dueAt keeps it.
export interface AccountDeletionResult {
  dueAt: string;
  graceDays: number;
  purged: boolean;
}

export interface OdmBridge {
  // Lets the shared shell UI adapt copy and layout per shell.
  platform: "desktop" | "android";
  listServers(): Promise<{ servers: ServerSummary[]; local: LocalStatus; tunnel: TunnelStatus }>;
  probeServer(origin: string): Promise<Result<{ probe: ServerProbe }>>;
  login(input: {
    origin: string;
    username: string;
    password: string;
    joinCode?: string;
  }): Promise<Result<{ server: ServerSummary }>>;
  register(input: {
    origin: string;
    username: string;
    password: string;
    inviteCode: string;
    joinCode?: string;
  }): Promise<Result<{ server: ServerSummary }>>;
  // Sign in through the server's Discord OAuth in a web view; the shell
  // harvests the session the callback plants and remembers the server like
  // a password login would. Only offered when the probe says discord: true.
  discordLogin(input: { origin: string; joinCode?: string }): Promise<Result<{ server: ServerSummary }>>;
  // `path` lands on a page of the host (a campaign, /characters, /?new=1)
  // instead of the root; a join code takes precedence. Sanitized in
  // src/shared/open-path.ts before it touches a URL.
  connect(serverId: string, joinCode?: string, path?: string): Promise<ConnectResult>;
  // Android only: the back gesture on the home screen leaves the app.
  leaveApp?(): Promise<void>;
  // Feeds a pasted invite link (odm:// or the https /j shape) into the same
  // flow as a clicked deep link. False means the text was not an invite link.
  openInviteLink(raw: string): Promise<boolean>;
  // Present only where a camera scanner exists (Android). Scans one QR code
  // and routes a recognized invite into the join flow, or a bare server
  // address (the server's own corner QR button) into the add-server flow.
  scanInvite?(): Promise<Result>;
  removeServer(serverId: string): Promise<void>;
  // Deletes the player's account on one remote server (the server's own
  // grace period applies). The stored session is dropped; the entry stays so
  // a sign-in before the due date can still keep the account.
  deleteAccount(input: {
    serverId: string;
    password: string;
  }): Promise<Result<{ deletion: AccountDeletionResult }>>;
  // The home screen's campaigns across hosts: homeFeed asks every host
  // (6 s cap each) and pushes a home-feed event; homeFeedCached answers at
  // once from the last refresh or the persisted cache.
  homeFeed(): Promise<HomeFeed>;
  homeFeedCached(): Promise<HomeFeed>;
  localStart(): Promise<Result<{ status: LocalStatus }>>;
  localCreateAccount(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>>;
  localLogin(input: { username: string; password: string }): Promise<Result<{ status: LocalStatus }>>;
  localConfigureAi(setup: AiSetup): Promise<Result>;
  localPlay(joinCode?: string, path?: string): Promise<ConnectResult>;
  shareStart(): Promise<Result<{ tunnel: TunnelStatus }>>;
  shareStop(): Promise<Result<{ tunnel: TunnelStatus }>>;
  localAiScan(): Promise<Result<{ hardware: HardwareInfo; tiers: LocalAiTier[] }>>;
  // warning is "" or a sentence: the install worked but wiring the world's
  // settings to it failed and needs a hand.
  localAiInstall(tierId: string): Promise<Result<{ status: LocalAiStatus; warning: string }>>;
  localAiInstallComfy(): Promise<Result<{ status: LocalAiStatus; warning: string }>>;
  localAiUninstall(component: "text" | "images"): Promise<Result<{ status: LocalAiStatus }>>;
  localAiStatus(): Promise<LocalAiStatus>;
  appInfo(): Promise<AppInfo>;
  updateCheck(): Promise<Result<{ update: UpdateStatus }>>;
  updateInstall(): Promise<Result>;
  onEvent(listener: (event: ShellEvent) => void): void;
}
