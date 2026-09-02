import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeableHref,
  bytesToB64,
  createDownloadShim,
  deriveFilename,
  filenameFromDisposition,
  findDownloadAnchor,
  noticeText,
  type AnchorLike,
  type ClickLike,
  type ResponseLike,
} from "../src/download-shim-core";

// A fake page: anchors are plain objects shaped like the DOM nodes the shim
// walks, fetch is scripted per URL, and the plugin channel records posts.
// Each test mirrors one of the game's real export paths.

const ORIGIN = "https://play.example.test";

interface FakeResponse {
  status?: number;
  body?: Uint8Array;
  headers?: Record<string, string>;
}

interface Harness {
  shim: ReturnType<typeof createDownloadShim>;
  posted: Record<string, unknown>[];
  fetched: string[];
  bodiesRead: number;
  channelPresent: boolean;
}

function makeHarness(responses: Record<string, FakeResponse>): Harness {
  const harness = {
    posted: [] as Record<string, unknown>[],
    fetched: [] as string[],
    bodiesRead: 0,
    channelPresent: true,
  } as Harness;
  harness.shim = createDownloadShim({
    origin: ORIGIN,
    async fetch(url) {
      harness.fetched.push(url);
      const scripted = responses[url];
      if (!scripted) throw new Error("Failed to fetch");
      const headers = new Map(
        Object.entries(scripted.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const status = scripted.status ?? 200;
      const response: ResponseLike = {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
        async arrayBuffer() {
          harness.bodiesRead += 1;
          const body = scripted.body ?? new Uint8Array();
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
      };
      return response;
    },
    channel: () =>
      harness.channelPresent ? { postMessage: (message) => harness.posted.push(message) } : null,
  });
  return harness;
}

function anchor(
  attrs: Record<string, string>,
  parent: AnchorLike | null = null,
): AnchorLike {
  const href = attrs.href ?? "";
  return {
    tagName: "A",
    href: href ? new URL(href, ORIGIN).href : "",
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: parent,
  };
}

function click(target: unknown, extra: Partial<ClickLike> = {}): ClickLike & { prevented: boolean } {
  const event = {
    target,
    defaultPrevented: false,
    button: 0,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...extra,
  };
  return event;
}

// The shim's fetch and post run after onClick returns; a macrotask turn
// drains every await between them.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const decodeB64 = (data: string): Uint8Array => Uint8Array.from(Buffer.from(data, "base64"));

test("findDownloadAnchor walks up from a nested target and skips plain links", () => {
  const download = anchor({ href: "/x.pdf", download: "" });
  const icon = { tagName: "SVG", parentElement: download };
  assert.equal(findDownloadAnchor(icon), download);
  assert.equal(findDownloadAnchor({ tagName: "DIV", parentElement: null }), null);
  assert.equal(findDownloadAnchor(anchor({ href: "/page" })), null, "no download attribute");
  assert.equal(findDownloadAnchor(null), null);
});

test("bridgeableHref accepts blob: and same-origin http(s), nothing else", () => {
  assert.equal(bridgeableHref("blob:https://play.example.test/abc", ORIGIN), "blob:https://play.example.test/abc");
  assert.equal(bridgeableHref("/api/campaigns/1/export?format=odt", ORIGIN), `${ORIGIN}/api/campaigns/1/export?format=odt`);
  assert.equal(bridgeableHref(`${ORIGIN}/img/a.png`, ORIGIN), `${ORIGIN}/img/a.png`);
  assert.equal(bridgeableHref("https://elsewhere.test/a.png", ORIGIN), "");
  assert.equal(bridgeableHref("javascript:alert(1)", ORIGIN), "");
  assert.equal(bridgeableHref("mailto:x@y.z", ORIGIN), "");
  assert.equal(bridgeableHref("", ORIGIN), "");
  assert.equal(bridgeableHref(undefined, ORIGIN), "");
});

test("filenameFromDisposition reads quoted, bare and RFC 5987 forms", () => {
  assert.equal(filenameFromDisposition('attachment; filename="tale-of-two.odt"'), "tale-of-two.odt");
  assert.equal(filenameFromDisposition("attachment; filename=story.html"), "story.html");
  assert.equal(
    filenameFromDisposition("attachment; filename=\"fallback.txt\"; filename*=UTF-8''caf%C3%A9%20notes.txt"),
    "café notes.txt",
  );
  assert.equal(filenameFromDisposition('inline; filename="a\\"b.txt"'), 'a"b.txt');
  assert.equal(filenameFromDisposition(null), "");
  assert.equal(filenameFromDisposition("inline"), "");
});

test("deriveFilename prefers the download attribute, then the header, then the path", () => {
  assert.equal(deriveFilename("sheet.pdf", 'attachment; filename="x.pdf"', `${ORIGIN}/y.pdf`), "sheet.pdf");
  assert.equal(deriveFilename("", 'attachment; filename="x.pdf"', `${ORIGIN}/y.pdf`), "x.pdf");
  assert.equal(deriveFilename("", null, `${ORIGIN}/dir/my%20map.png?x=1`), "my map.png");
  assert.equal(deriveFilename("", null, "blob:https://play.example.test/0f2c"), "download");
  assert.equal(deriveFilename("  ", null, `${ORIGIN}/`), "download");
});

test("bytesToB64 matches Node's encoder across chunk boundaries", () => {
  const sizes = [0, 1, 2, 3, 0x5fff, 0x6000, 0x6001, 0x6000 * 3 + 2];
  for (const size of sizes) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    assert.equal(bytesToB64(bytes), Buffer.from(bytes).toString("base64"), `size ${size}`);
  }
});

test("a blob download (character-sheet PDF) is fetched and posted with its name", async () => {
  const url = "blob:https://play.example.test/2b1c";
  const body = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
  const h = makeHarness({ [url]: { body, headers: { "Content-Type": "application/pdf" } } });
  const event = click(anchor({ href: url, download: "aria-character-sheet.pdf" }));
  h.shim.onClick(event);
  assert.equal(event.prevented, true, "the browser's dead-end download is stopped");
  await settle();
  assert.deepEqual(h.fetched, [url]);
  assert.equal(h.posted.length, 1);
  const detail = h.posted[0].detail as { type: string; name: string; mime: string; data: string };
  assert.equal(detail.type, "odm-download");
  assert.equal(detail.name, "aria-character-sheet.pdf");
  assert.equal(detail.mime, "application/pdf");
  assert.deepEqual(decodeB64(detail.data), body);
});

test("a server export with an empty download attribute takes the header's name", async () => {
  const href = `${ORIGIN}/api/campaigns/c1/export?format=docx`;
  const h = makeHarness({
    [href]: {
      body: Uint8Array.from([1, 2, 3]),
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary",
        "Content-Disposition": 'attachment; filename="the-sunken-keep.docx"',
      },
    },
  });
  // ExportMenu sets anchor.download = "" and clicks a child-less anchor.
  const event = click(anchor({ href: "/api/campaigns/c1/export?format=docx", download: "" }));
  h.shim.onClick(event);
  await settle();
  const detail = h.posted[0].detail as { name: string; mime: string };
  assert.equal(detail.name, "the-sunken-keep.docx");
  assert.equal(
    detail.mime,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "parameters are stripped",
  );
});

test("a tap on an icon inside the anchor still counts", async () => {
  const url = `${ORIGIN}/uploads/map.png`;
  const h = makeHarness({ [url]: { body: Uint8Array.from([9]), headers: { "content-type": "image/png" } } });
  const link = anchor({ href: url, download: "dungeon-map.png" });
  const event = click({ tagName: "svg", parentElement: link });
  h.shim.onClick(event);
  assert.equal(event.prevented, true);
  await settle();
  assert.equal((h.posted[0].detail as { name: string }).name, "dungeon-map.png");
});

test("clicks the shim must leave alone: no channel, cross-origin, no download, claimed, secondary button", async () => {
  const h = makeHarness({});
  h.channelPresent = false;
  const noChannel = click(anchor({ href: "/a.pdf", download: "a.pdf" }));
  h.shim.onClick(noChannel);
  h.channelPresent = true;
  const foreign = click(anchor({ href: "https://cdn.example.net/a.pdf", download: "a.pdf" }));
  h.shim.onClick(foreign);
  const plain = click(anchor({ href: "/campaigns/1" }));
  h.shim.onClick(plain);
  const claimed = click(anchor({ href: "/a.pdf", download: "a.pdf" }), { defaultPrevented: true });
  h.shim.onClick(claimed);
  const middle = click(anchor({ href: "/a.pdf", download: "a.pdf" }), { button: 1 });
  h.shim.onClick(middle);
  await settle();
  for (const event of [noChannel, foreign, plain, claimed, middle]) {
    assert.equal(event.prevented, false);
  }
  assert.equal(h.fetched.length, 0);
  assert.equal(h.posted.length, 0);
});

test("oversize files are refused before the body is read, or after when the header lies", async () => {
  const declared = `${ORIGIN}/big-declared.bin`;
  const undeclared = `${ORIGIN}/big-undeclared.bin`;
  const h = makeHarness({
    [declared]: { body: new Uint8Array(1), headers: { "content-length": String(41 * 1024 * 1024) } },
    [undeclared]: { body: new Uint8Array(40 * 1024 * 1024 + 1) },
  });
  h.shim.onClick(click(anchor({ href: declared, download: "" })));
  await settle();
  assert.equal(h.bodiesRead, 0, "content-length alone rejects it");
  h.shim.onClick(click(anchor({ href: undeclared, download: "" })));
  await settle();
  assert.equal(h.bodiesRead, 1);
  assert.equal(h.posted.length, 2);
  for (const message of h.posted) {
    const detail = message.detail as { type: string; name: string; message: string };
    assert.equal(detail.type, "odm-download-error");
    assert.match(detail.message, /40 MB/);
  }
  assert.equal((h.posted[0].detail as { name: string }).name, "big-declared.bin");
});

test("failed fetches report an error instead of a file", async () => {
  const denied = `${ORIGIN}/api/campaigns/c1/export?format=html`;
  const h = makeHarness({ [denied]: { status: 403 } });
  h.shim.onClick(click(anchor({ href: denied, download: "" })));
  h.shim.onClick(click(anchor({ href: `${ORIGIN}/missing.json`, download: "bundle.json" })));
  await settle();
  const first = h.posted[0].detail as { type: string; message: string };
  assert.equal(first.type, "odm-download-error");
  assert.match(first.message, /403/);
  const second = h.posted[1].detail as { type: string; name: string; message: string };
  assert.equal(second.type, "odm-download-error");
  assert.equal(second.name, "bundle.json");
  assert.equal(second.message, "Failed to fetch");
});

test("handleAnchor covers detached anchors (workshop bundle) and reports whether it took over", async () => {
  const url = "blob:https://play.example.test/77aa";
  const h = makeHarness({ [url]: { body: Uint8Array.from([123, 125]), headers: { "content-type": "application/json" } } });
  const detached = anchor({ href: url, download: "keep.odm-workshop.json" });
  assert.equal(h.shim.handleAnchor(detached), true);
  assert.equal(h.shim.handleAnchor(anchor({ href: "https://other.test/x", download: "x" })), false);
  h.channelPresent = false;
  assert.equal(h.shim.handleAnchor(anchor({ href: url, download: "again.json" })), false);
  await settle();
  assert.equal(h.posted.length, 1);
  assert.equal((h.posted[0].detail as { name: string }).name, "keep.odm-workshop.json");
});

test("noticeText only surfaces the shell's download notices", () => {
  assert.equal(noticeText({ type: "odm-download-notice", message: "Could not save x." }), "Could not save x.");
  assert.equal(noticeText({ type: "odm-download-notice", message: "x".repeat(300) }).length, 200);
  assert.equal(noticeText({ odmBle: "reply", id: 1 }), "");
  assert.equal(noticeText(null), "");
  assert.equal(noticeText({ type: "odm-download-notice", message: 5 }), "");
});
