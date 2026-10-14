import { refusedAfter } from "../shared/broker";

type Publication = { published: string[]; refused: string[] };

export function createPublicUrlSync(deps: {
  token: () => string | null;
  origin: () => string;
  lanOrigin: () => string;
  status: () => { state: string; url: string };
  patch: (origin: string, token: string, settings: { publicUrl: string }) => Promise<unknown>;
  owned: (origin: string, token: string) => Promise<string[]>;
  publish: (input: { codes: readonly string[]; url: string; secretFor: (code: string) => string }) => Promise<Publication>;
  drop: (input: { codes: readonly string[]; secretFor: (code: string) => string }) => Promise<unknown>;
  publishedCodes: () => string[];
  setPublishedCodes: (codes: readonly string[]) => void;
  secretFor: (code: string) => string;
  refusedCodes: () => string[];
  setRefusedCodes: (codes: string[]) => void;
}): () => Promise<void> {
  const run = async (): Promise<void> => {
    const token = deps.token();
    const origin = deps.origin();
    if (!token || !origin) return;
    const status = deps.status();
    const live = status.state === "running" ? status.url : "";
    await deps.patch(origin, token, { publicUrl: live || deps.lanOrigin() }).catch(() => undefined);
    if (live) {
      const codes = await deps.owned(origin, token);
      const { published, refused } = await deps.publish({ codes, url: live, secretFor: deps.secretFor });
      deps.setRefusedCodes(refusedAfter(deps.refusedCodes(), { codes, published, refused }));
      deps.setPublishedCodes([...new Set([...published, ...deps.publishedCodes()])]);
      return;
    }
    deps.setRefusedCodes([]);
    const stale = deps.publishedCodes();
    deps.setPublishedCodes([]);
    if (stale.length > 0) await deps.drop({ codes: stale, secretFor: deps.secretFor });
  };
  let tail: Promise<void> = Promise.resolve();
  return () => {
    // A Stop sync must run after any PUT already on the wire, so its DELETE
    // cannot be undone by an older publish response.
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}
