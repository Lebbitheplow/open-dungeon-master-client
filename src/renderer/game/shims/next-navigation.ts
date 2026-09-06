// "next/navigation" for the game screens, backed by the GameRouter. The
// current router and route params are set by the game root before any
// page renders; hooks subscribe so a navigation re-renders the callers.
import { useSyncExternalStore } from "preact/compat";
import type { GameRouter } from "../router.js";

let current: GameRouter | null = null;
let currentParams: Record<string, string> = {};

export function setNavigation(router: GameRouter, params: Record<string, string>): void {
  current = router;
  currentParams = params;
}

function router(): GameRouter {
  if (!current) throw new Error("The game router is not mounted.");
  return current;
}

function subscribe(listener: () => void): () => void {
  return router().subscribe(listener);
}

export function useRouter() {
  const active = router();
  return {
    push: (url: string) => active.push(url),
    replace: (url: string) => active.replace(url),
    back: () => {
      active.back();
    },
    forward: () => undefined,
    refresh: () => active.refresh(),
    prefetch: () => undefined,
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => router().location.pathname);
}

// Stable per search string, so effects keyed on the object do not loop.
let cachedSearch = "";
let cachedParams = new URLSearchParams();

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => router().location.search);
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedParams = new URLSearchParams(search);
  }
  return cachedParams;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return currentParams as T;
}

export function redirect(url: string): never {
  router().replace(url);
  throw new Error("redirect");
}

export function notFound(): never {
  router().replace("/");
  throw new Error("notFound");
}
