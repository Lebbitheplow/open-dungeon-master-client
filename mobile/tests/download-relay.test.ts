import assert from "node:assert/strict";
import test from "node:test";
import {
  createDownloadRelay,
  fetchableUrl,
  sanitizeFilename,
  type DownloadRelayDeps,
  type NativeFetchResult,
} from "../src/download-relay";

// Recording fakes for the filesystem, the native streamer, the share sheet
// and the notice channel, so each test drives the message protocol end to
// end without a Capacitor runtime.

interface Harness {
  relay: ReturnType<typeof createDownloadRelay>;
  calls: string[];
  notices: string[];
}

const CACHE = "file:///data/user/0/com.opendungeonmaster.app/cache";

function makeHarness(
  overrides: Partial<DownloadRelayDeps> = {},
  fetched: Partial<NativeFetchResult> = {},
): Harness {
  const calls: string[] = [];
  const notices: string[] = [];
  const deps: DownloadRelayDeps = {
    async writeCache(path, base64) {
      calls.push(`write ${path} ${base64}`);
      return `${CACHE}/${path}`;
    },
    async clearCache(path) {
      calls.push(`clear ${path}`);
    },
    async fetchToCache(url, headers) {
      const sent = Object.entries(headers)
        .map(([name, value]) => `${name}=${value}`)
        .join(",");
      calls.push(`fetch ${url}${sent ? ` [${sent}]` : ""}`);
      return { size: 3, mime: "application/pdf", suggestedName: "", ...fetched };
    },
    async renameCache(from, to) {
      calls.push(`rename ${from} ${to}`);
      return `${CACHE}/${to}`;
    },
    async share(title, uri) {
      calls.push(`share ${title} ${uri}`);
    },
    notify: (message) => notices.push(message),
    ...overrides,
  };
  return { relay: createDownloadRelay(deps), calls, notices };
}

const HOST = "https://play.example.test";

const PDF_B64 = Buffer.from("%PDF-1.7").toString("base64");

function download(name: unknown, mime: unknown, data: unknown = PDF_B64) {
  return { type: "odm-download", name, mime, data };
}

test("sanitizeFilename strips separators, traversal and control characters", () => {
  assert.equal(sanitizeFilename("../../etc/passwd", ""), "etc-passwd");
  assert.equal(sanitizeFilename("..\\..\\win.ini", ""), "win.ini");
  assert.equal(sanitizeFilename("a\u0000b\u001fc.txt", ""), "abc.txt");
  assert.equal(sanitizeFilename("what?.json", ""), "what-.json");
  assert.equal(sanitizeFilename(".hidden", ""), "hidden");
  assert.equal(sanitizeFilename("trailing dots...", ""), "trailing dots");
});

test("sanitizeFilename adds an extension from the mime type only when one is missing", () => {
  assert.equal(sanitizeFilename("download", "application/pdf"), "download.pdf");
  assert.equal(sanitizeFilename("story", "text/html; charset=utf-8"), "story.html");
  assert.equal(sanitizeFilename("story", "application/vnd.oasis.opendocument.text"), "story.odt");
  assert.equal(sanitizeFilename("sheet.pdf", "application/pdf"), "sheet.pdf");
  assert.equal(sanitizeFilename("keep.odm-workshop.json", "application/json"), "keep.odm-workshop.json");
  assert.equal(sanitizeFilename("mystery", "application/x-unknown"), "mystery");
});

test("sanitizeFilename bounds the length while keeping the extension, and never returns empty", () => {
  const long = sanitizeFilename(`${"a".repeat(300)}.docx`, "");
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".docx"));
  assert.equal(sanitizeFilename("", "application/pdf"), "download.pdf");
  assert.equal(sanitizeFilename(undefined, undefined), "download");
  assert.equal(sanitizeFilename("///", "application/json"), "download.json");
});

test("non-download messages are left for other handlers", async () => {
  const h = makeHarness();
  assert.equal(await h.relay.handleMessage({ odmBle: "rpc", id: 1, method: "connect" }), false);
  assert.equal(await h.relay.handleMessage(null), false);
  assert.equal(await h.relay.handleMessage("odm-download"), false);
  assert.equal(await h.relay.handleMessage({ type: "something-else" }), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 0);
});

test("a download clears the folder, writes the file and opens the share sheet", async () => {
  const h = makeHarness();
  const handled = await h.relay.handleMessage(download("aria-character-sheet.pdf", "application/pdf"));
  assert.equal(handled, true);
  const uri = "file:///data/user/0/com.opendungeonmaster.app/cache/odm-downloads/aria-character-sheet.pdf";
  assert.deepEqual(h.calls, [
    "clear odm-downloads",
    `write odm-downloads/aria-character-sheet.pdf ${PDF_B64}`,
    `share aria-character-sheet.pdf ${uri}`,
  ]);
  assert.deepEqual(h.notices, []);
});

test("the stored name is the sanitized one, extension included", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(download("../download", "application/json", Buffer.from("{}").toString("base64")));
  assert.ok(h.calls[1].startsWith("write odm-downloads/download.json "));
  assert.ok(h.calls[2].startsWith("share download.json "));
});

test("bad payloads are refused with a notice and never touch the disk", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(download("a.pdf", "application/pdf", ""));
  await h.relay.handleMessage(download("b.pdf", "application/pdf", 42));
  await h.relay.handleMessage(download("c.pdf", "application/pdf", "not base64!!"));
  await h.relay.handleMessage(download("d.pdf", "application/pdf", "A".repeat(56 * 1024 * 1024 + 4)));
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 4);
  assert.match(h.notices[0], /empty/);
  assert.match(h.notices[2], /corrupt/);
  assert.match(h.notices[3], /40 MB/);
});

test("a shim-side error is shown to the player as is", async () => {
  const h = makeHarness();
  assert.equal(
    await h.relay.handleMessage({ type: "odm-download-error", name: "x", message: "The server answered 403." }),
    true,
  );
  await h.relay.handleMessage({ type: "odm-download-error" });
  assert.deepEqual(h.notices, ["The server answered 403.", "The download failed."]);
});

test("backing out of the share sheet is silent; other failures are reported", async () => {
  const cancelled = makeHarness({
    async share() {
      throw new Error("Share canceled");
    },
  });
  await cancelled.relay.handleMessage(download("a.pdf", "application/pdf"));
  assert.deepEqual(cancelled.notices, []);

  const failed = makeHarness({
    async writeCache() {
      throw new Error("disk full");
    },
  });
  await failed.relay.handleMessage(download("a.pdf", "application/pdf"));
  assert.deepEqual(failed.notices, ["Could not save a.pdf. disk full"]);
  assert.ok(!failed.calls.some((call) => call.startsWith("share")));
});

test("a failing cache sweep does not stop the download", async () => {
  const h = makeHarness({
    async clearCache() {
      throw new Error("no such folder");
    },
  });
  await h.relay.handleMessage(download("a.pdf", "application/pdf"));
  assert.ok(h.calls.some((call) => call.startsWith("share a.pdf")));
  assert.deepEqual(h.notices, []);
});

test("downloads run one at a time so a sweep never removes a file mid-share", async () => {
  let release: (() => void) | null = null;
  const h = makeHarness({
    async share(title, uri) {
      h.calls.push(`share ${title} ${uri}`);
      if (title === "first.pdf") await new Promise<void>((resolve) => (release = resolve));
    },
  });
  const first = h.relay.handleMessage(download("first.pdf", "application/pdf"));
  const second = h.relay.handleMessage(download("second.pdf", "application/pdf"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(h.calls.some((call) => call.startsWith("share first.pdf")));
  assert.equal(h.calls.length, 3, "the second download waits for the first share to close");
  release?.();
  await Promise.all([first, second]);
  const order = h.calls.map((call) => call.split(" ")[0]);
  assert.deepEqual(order, ["clear", "write", "share", "clear", "write", "share"]);
});

// ---------- host files, streamed natively ----------

test("fetchableUrl takes web addresses only, and only the page's host when one is given", () => {
  assert.equal(fetchableUrl(`${HOST}/api/campaigns/c1/export?format=pdf`), `${HOST}/api/campaigns/c1/export?format=pdf`);
  assert.equal(fetchableUrl("http://192.168.1.9:3210/uploads/map.png", "http://192.168.1.9:3210"), "http://192.168.1.9:3210/uploads/map.png");
  assert.equal(fetchableUrl(`${HOST}/a.pdf`, "https://other.test"), "");
  assert.equal(fetchableUrl("blob:https://play.example.test/2b1c"), "");
  assert.equal(fetchableUrl("file:///etc/passwd"), "");
  assert.equal(fetchableUrl("javascript:alert(1)"), "");
  assert.equal(fetchableUrl(42), "");
  assert.equal(fetchableUrl(`${HOST}/${"a".repeat(5000)}`), "");
});

test("an address download is streamed with the page's cookies, renamed and shared", async () => {
  const h = makeHarness();
  const handled = await h.relay.handleMessage(
    { type: "odm-download-url", url: `${HOST}/api/campaigns/c1/export?format=pdf`, name: "the-sunken-keep.pdf" },
    { origin: HOST },
  );
  assert.equal(handled, true);
  assert.deepEqual(h.calls, [
    "clear odm-downloads",
    `fetch ${HOST}/api/campaigns/c1/export?format=pdf`,
    "rename odm-downloads/incoming.part odm-downloads/the-sunken-keep.pdf",
    `share the-sunken-keep.pdf ${CACHE}/odm-downloads/the-sunken-keep.pdf`,
  ]);
  assert.deepEqual(h.notices, []);
});

test("without a name from the link, the server's name wins, then the path, with the extension from the type", async () => {
  const fromServer = makeHarness({}, { suggestedName: "the-sunken-keep.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  await fromServer.relay.handleMessage({ type: "odm-download-url", url: `${HOST}/api/campaigns/c1/export?format=docx`, name: "" });
  assert.ok(fromServer.calls.some((call) => call.startsWith("share the-sunken-keep.docx ")));

  const fromPath = makeHarness({}, { mime: "image/png" });
  await fromPath.relay.handleMessage({ type: "odm-download-url", url: `${HOST}/uploads/dungeon-map`, name: "" });
  assert.ok(fromPath.calls.some((call) => call.startsWith("share dungeon-map.png ")));
});

test("an address off the page's host is refused before anything is fetched", async () => {
  const h = makeHarness();
  await h.relay.handleMessage(
    { type: "odm-download-url", url: "https://other.test/secret.pdf", name: "x.pdf" },
    { origin: HOST },
  );
  await h.relay.handleMessage({ type: "odm-download-url", url: "file:///etc/passwd", name: "x" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[0], /not from this server/);
});

test("a streamed file that failed or is too big is reported, not shared", async () => {
  const refused = makeHarness({
    async fetchToCache() {
      throw new Error("The server answered 403.");
    },
  });
  await refused.relay.handleMessage({ type: "odm-download-url", url: `${HOST}/api/campaigns/c1/export`, name: "" });
  assert.deepEqual(refused.notices, ["Could not save export. The server answered 403."]);
  assert.ok(!refused.calls.some((call) => call.startsWith("share")));

  const big = makeHarness({}, { size: 41 * 1024 * 1024 });
  await big.relay.handleMessage({ type: "odm-download-url", url: `${HOST}/big.bin`, name: "" });
  assert.match(big.notices[0], /40 MB/);
  assert.ok(!big.calls.some((call) => call.startsWith("rename")));
});

test("download() sends the caller's headers and reports whether the file arrived", async () => {
  const h = makeHarness();
  const ok = await h.relay.download(`${HOST}/uploads/handout.pdf`, "handout.pdf", { authorization: "Bearer tok" });
  assert.equal(ok, true);
  assert.equal(h.calls[1], `fetch ${HOST}/uploads/handout.pdf [authorization=Bearer tok]`);

  const cancelled = makeHarness({
    async share() {
      throw new Error("Share canceled");
    },
  });
  assert.equal(await cancelled.relay.download(`${HOST}/uploads/handout.pdf`, "handout.pdf", {}), true);
  assert.deepEqual(cancelled.notices, []);

  const failed = makeHarness({
    async fetchToCache() {
      throw new Error("Could not reach the host.");
    },
  });
  assert.equal(await failed.relay.download(`${HOST}/uploads/handout.pdf`, "handout.pdf", {}), false);
  assert.deepEqual(failed.notices, ["Could not save handout.pdf. Could not reach the host."]);
});
