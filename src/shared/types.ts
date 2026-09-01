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
  serverVersion: string;
  error: string;
}

// The offline-play setup wizard's AI step. "human" changes nothing on the
// server; campaigns simply run with a human Dungeon Master.
export interface AiSetup {
  choice: "openai" | "human";
  apiKey: string;
  model: string;
  utilityModel: string;
}

export type ConnectResult = { ok: true } | { ok: false; needsLogin: boolean; error: string };

// A tunnel sharing the local world at a public https address. "named" means
// a broker-issued CODE.play address; "quick" is the trycloudflare fallback.
export interface TunnelStatus {
  state: "stopped" | "starting" | "running" | "error";
  url: string;
  mode: "" | "named" | "quick";
  error: string;
}

export type ShellEvent =
  | { kind: "show-manager" }
  | { kind: "join-request"; origin: string; code: string; knownServerId: string }
  | { kind: "local-status"; status: LocalStatus }
  | { kind: "tunnel-status"; status: TunnelStatus };

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
  connect(serverId: string, joinCode?: string): Promise<ConnectResult>;
  removeServer(serverId: string): Promise<void>;
  localStart(): Promise<Result<{ status: LocalStatus }>>;
  localCreateAccount(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>>;
  localLogin(input: { username: string; password: string }): Promise<Result<{ status: LocalStatus }>>;
  localConfigureAi(setup: AiSetup): Promise<Result>;
  localPlay(joinCode?: string): Promise<ConnectResult>;
  shareStart(): Promise<Result<{ tunnel: TunnelStatus }>>;
  shareStop(): Promise<Result<{ tunnel: TunnelStatus }>>;
  onEvent(listener: (event: ShellEvent) => void): void;
}
