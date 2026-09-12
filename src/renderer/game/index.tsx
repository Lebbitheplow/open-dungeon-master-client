// The native game screens: the host's pages, drawn by the app itself from
// the same components the server's site is built from, fed by the host's
// API over the shell's session. Mounted by the shell (app.ts) into its own
// page column, so the app's topbar and menu stay above every screen.
//
// Routes map a host path to a page module; a path with no native page is
// handed back to the shell (onLeave), which opens it the old way.
import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "preact/compat";
import { render } from "preact";
import { DeviceSettings } from "@/components/DeviceSettings";
import { HostClient, type HostSession } from "../api/host.js";
import { GameRouter, matchRoute } from "./router.js";
import { setNavigation } from "./shims/next-navigation.js";
import { resolvedParams } from "./params.js";
import { installRuntime, uninstallRuntime } from "./runtime.js";
import { useSyncExternalStore } from "preact/compat";

type PageModule = { default: ComponentType<{ params: unknown; searchParams?: unknown }> };

interface Route {
  pattern: string;
  load: () => Promise<PageModule>;
}

// The host's pages, by path. Each is the server's own page component.
const ROUTES: Route[] = [
  { pattern: "/", load: () => import("@/app/page") },
  { pattern: "/campaigns/:campaignId", load: () => import("@/app/campaigns/[campaignId]/page") },
  {
    pattern: "/campaigns/:campaignId/character",
    load: () => import("@/app/campaigns/[campaignId]/character/page"),
  },
  { pattern: "/characters", load: () => import("@/app/characters/page") },
  { pattern: "/characters/new", load: () => import("@/app/characters/new/page") },
  { pattern: "/characters/:characterId", load: () => import("@/app/characters/[characterId]/page") },
  { pattern: "/workshop", load: () => import("@/app/workshop/page") },
  { pattern: "/workshop/:workshopId", load: () => import("@/app/workshop/[workshopId]/page") },
  { pattern: "/settings", load: () => import("@/app/settings/page") },
  { pattern: "/friends", load: () => import("@/app/friends/page") },
  { pattern: "/admin", load: () => import("@/app/admin/page") },
  { pattern: "/reference", load: () => import("@/app/reference/page") },
  { pattern: "/join/:code", load: () => import("@/app/join/[code]/page") },
];

const pages = new Map<string, ComponentType<{ params: unknown; searchParams?: unknown }>>();

function pageFor(route: Route): ComponentType<{ params: unknown; searchParams?: unknown }> {
  let page = pages.get(route.pattern);
  if (!page) {
    page = lazy(route.load);
    pages.set(route.pattern, page);
  }
  return page;
}

class Boundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function Spinner() {
  return (
    <main className="flex flex-1 items-center justify-center py-16">
      <span className="size-6 animate-spin rounded-full border-2 border-stone-600 border-t-amber-300" />
    </main>
  );
}

function GameApp({ router, onLeave }: { router: GameRouter; onLeave: (url: string) => void }) {
  const location = useSyncExternalStore(
    (listener) => router.subscribe(listener),
    () => router.location,
  );
  let matched: { route: Route; params: Record<string, string> } | null = null;
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, location.pathname);
    if (params) {
      matched = { route, params };
      break;
    }
  }
  if (!matched) {
    onLeave(location.pathname + location.search);
    return <Spinner />;
  }
  setNavigation(router, matched.params);
  const Page = pageFor(matched.route);
  const search = Object.fromEntries(new URLSearchParams(location.search));
  return (
    <Boundary
      key={`${matched.route.pattern}${JSON.stringify(matched.params)}${location.search}`}
      onError={(error) => {
        console.error("game page failed", error);
        onLeave(location.pathname + location.search);
      }}
    >
      <Suspense fallback={<Spinner />}>
        <Page params={resolvedParams(matched.params)} searchParams={resolvedParams(search)} />
      </Suspense>
    </Boundary>
  );
}

export interface GameMount {
  router: GameRouter;
  unmount(): void;
}

export interface GameOptions {
  session: HostSession;
  path: string;
  // A path with no native page, or a full URL off the host: the shell
  // opens it the old way (web view) or in the browser.
  onLeave(url: string): void;
}

// A plain anchor in a host page (not a next/link) would take the whole
// window to the address; inside the app it goes through the router
// instead. Downloads, new tabs, modifier clicks and hash links are left
// to the browser and the download bridge.
function linkTarget(event: MouseEvent, origin: string): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute("download")) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  const raw = anchor.getAttribute("href") ?? "";
  if (raw.startsWith("#")) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (raw.startsWith(`${origin}/`)) return raw.slice(origin.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return null;
}

export function mountGame(root: HTMLElement, options: GameOptions): GameMount {
  const client = new HostClient(options.session);
  installRuntime(client);
  const router = new GameRouter(options.path);
  router.onLeave = options.onLeave;
  const onClick = (event: MouseEvent): void => {
    const url = linkTarget(event, client.origin);
    if (url === null) return;
    event.preventDefault();
    router.push(url);
  };
  root.addEventListener("click", onClick);
  render(<GameApp router={router} onLeave={options.onLeave} />, root);
  return {
    router,
    unmount() {
      root.removeEventListener("click", onClick);
      render(null, root);
      uninstallRuntime();
    },
  };
}

// Loads a path's page module ahead of time (the shell calls this for the
// host home while its own home screen is idle). The lazy component is
// created too, so the first render finds it resolved.
export function prefetch(path: string): void {
  for (const route of ROUTES) {
    if (!matchRoute(route.pattern, path)) continue;
    pageFor(route);
    void route.load().catch(() => undefined);
    return;
  }
}

// The machine's audio and dice controls (the server's DeviceSettings), for
// the shell's own Settings screen: the same stores the table's hooks read,
// so a change here reaches a call or a table already running.
export function mountDeviceSettings(root: HTMLElement): () => void {
  render(<DeviceSettings />, root);
  return () => render(null, root);
}

declare global {
  interface Window {
    odmGame?: {
      mountGame: typeof mountGame;
      mountDeviceSettings: typeof mountDeviceSettings;
      prefetch: typeof prefetch;
    };
  }
}

window.odmGame = { mountGame, mountDeviceSettings, prefetch };
