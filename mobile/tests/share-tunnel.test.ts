import assert from "node:assert/strict";
import { test } from "node:test";
import { createShareTunnel, type ShareTunnelDeps, type SharePluginStatus } from "../src/share-tunnel";
import type { ShellEvent } from "../../src/shared/types";

// The share flow against a fake tunnel process, broker and edge.

const SESSION = {
  code: "ABCD1234",
  hostname: "play-abcd1234.opendungeonmaster.com",
  tunnelToken: "tok",
  secret: "shh",
};

function harness(overrides: {
  broker?: "ok" | "down" | "offshape";
  namedDns?: boolean;
  quickDns?: boolean;
  reachable?: boolean;
} = {}) {
  const broker = overrides.broker ?? "ok";
  const namedDns = overrides.namedDns ?? true;
  const quickDns = overrides.quickDns ?? true;
  const reachable = overrides.reachable ?? true;
  const plugin: SharePluginStatus = { available: true, running: false, url: "", mode: "" };
  const calls: string[] = [];
  const published: string[] = [];
  const events: ShellEvent[] = [];
  let clock = 0;
  const deps: ShareTunnelDeps = {
    plugin: {
      shareStatus: async () => ({ ...plugin }),
      shareStart: async (options) => {
        calls.push(options.token ? `named:${options.token}:${options.port}` : `quick:${options.port}`);
        plugin.running = true;
        plugin.url = options.token ? options.url ?? "" : "https://rare-fox.trycloudflare.com";
        return { url: plugin.url };
      },
      shareStop: async () => {
        calls.push("stop");
        plugin.running = false;
        plugin.url = "";
      },
    },
    fetchJson: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/session")) {
        if (broker === "down") return { status: 503, data: null };
        if (broker === "offshape") return { status: 200, data: { ...SESSION, hostname: "evil.example" } };
        return { status: 200, data: SESSION };
      }
      if (url.includes("/session/")) return { status: 204, data: null };
      if (url.startsWith("https://cloudflare-dns.com/")) {
        const named = url.includes("play-abcd1234");
        const answer = (named ? namedDns : quickDns) ? [{ data: "1.2.3.4" }] : [];
        return { status: 200, data: { Answer: answer } };
      }
      if (url.endsWith("/api/health")) return { status: reachable ? 200 : 502, data: null };
      throw new Error(`unexpected ${url}`);
    },
    brokerUrl: () => "",
    worldPort: async () => 3210,
    publish: async (url) => {
      published.push(url);
    },
    emit: (event) => events.push(event),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { tunnel: createShareTunnel(deps), calls, published, events, plugin };
}

test("a broker session becomes a named tunnel once DNS and the edge answer", async () => {
  const h = harness();
  const status = await h.tunnel.start();
  assert.equal(status.state, "running");
  assert.equal(status.mode, "named");
  assert.equal(status.url, "https://play-abcd1234.opendungeonmaster.com");
  assert.ok(h.calls.includes("named:tok:3210"));
  assert.ok(h.calls.some((call) => call.startsWith("GET https://cloudflare-dns.com/")));
  assert.ok(h.calls.includes("GET https://play-abcd1234.opendungeonmaster.com/api/health"));
  assert.deepEqual(h.published, ["https://play-abcd1234.opendungeonmaster.com"]);
  assert.equal(h.events.at(-1)?.kind, "tunnel-status");
});

test("a broker that is down means a quick tunnel", async () => {
  const h = harness({ broker: "down" });
  const status = await h.tunnel.start();
  assert.equal(status.state, "running");
  assert.equal(status.mode, "quick");
  assert.equal(status.url, "https://rare-fox.trycloudflare.com");
  assert.ok(h.calls.includes("quick:3210"));
  assert.ok(!h.calls.some((call) => call.startsWith("named:")));
});

test("a broker hostname off the official shape is refused, quick tunnel instead", async () => {
  const h = harness({ broker: "offshape" });
  const status = await h.tunnel.start();
  assert.equal(status.mode, "quick");
});

test("a named tunnel that never resolves is released and replaced by a quick one", async () => {
  const h = harness({ namedDns: false });
  const status = await h.tunnel.start();
  assert.equal(status.state, "running");
  assert.equal(status.mode, "quick");
  const stopIndex = h.calls.indexOf("stop");
  const releaseIndex = h.calls.findIndex((call) => call.startsWith("DELETE ") && call.includes("/session/ABCD1234"));
  const quickIndex = h.calls.indexOf("quick:3210");
  assert.ok(stopIndex >= 0 && releaseIndex > stopIndex && quickIndex > releaseIndex);
});

test("nothing reachable at all ends in an error with everything torn down", async () => {
  const h = harness({ namedDns: false, quickDns: false });
  const status = await h.tunnel.start();
  assert.equal(status.state, "error");
  assert.match(status.error, /DNS/);
  assert.equal(h.plugin.running, false);
  assert.equal(h.published.at(-1), "");
});

test("stop releases the broker session with its secret and clears the public address", async () => {
  const h = harness();
  await h.tunnel.start();
  const status = await h.tunnel.stop();
  assert.equal(status.state, "stopped");
  assert.ok(h.calls.includes("stop"));
  assert.ok(h.calls.some((call) => call === `DELETE https://odm-tunnel-broker.tunnel-broker.workers.dev/session/ABCD1234`));
  assert.deepEqual(h.published, ["https://play-abcd1234.opendungeonmaster.com", ""]);
});

test("a tunnel ended from the notification is noticed on the next status look", async () => {
  const h = harness();
  await h.tunnel.start();
  h.plugin.running = false;
  const status = await h.tunnel.status();
  assert.equal(status.state, "stopped");
  assert.equal(h.published.at(-1), "");
  assert.ok(h.calls.some((call) => call.startsWith("DELETE ")));
});

test("starting twice shares one attempt", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.tunnel.start(), h.tunnel.start()]);
  assert.equal(a.state, "running");
  assert.equal(b.state, "running");
  assert.equal(h.calls.filter((call) => call.startsWith("named:")).length, 1);
});
