import assert from "node:assert/strict";
import test from "node:test";
import { createSseParser } from "../dist/shared/sse.js";

function collect() {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  return { events, parser };
}

test("parses events the server's stream shape sends, ids included", () => {
  const { events, parser } = collect();
  parser.feed("id: 1\nevent: campaign_updated\ndata: {\"title\":\"x\"}\n\n");
  parser.feed("event: presence\ndata: {\"online\":[]}\n\n");
  assert.deepEqual(events, [
    { event: "campaign_updated", data: '{"title":"x"}', id: "1" },
    { event: "presence", data: '{"online":[]}', id: "1" },
  ]);
  assert.equal(parser.lastEventId(), "1");
});

test("chunks may split anywhere, even mid-line", () => {
  const { events, parser } = collect();
  const whole = "id: 7\nevent: roll_result\ndata: {\"a\":1}\n\n";
  for (const char of whole) parser.feed(char);
  assert.deepEqual(events, [{ event: "roll_result", data: '{"a":1}', id: "7" }]);
});

test("heartbeat comments dispatch nothing and multi-line data joins with newlines", () => {
  const { events, parser } = collect();
  parser.feed(": ping\n\n");
  parser.feed("data: one\ndata: two\n\n");
  assert.deepEqual(events, [{ event: "message", data: "one\ntwo", id: "" }]);
});

test("CRLF and CR line endings are accepted", () => {
  const { events, parser } = collect();
  parser.feed("event: a\r\ndata: 1\r\n\r\n");
  // A trailing lone CR is held back in case an LF follows; the next break
  // (here CRLF) releases the blank line that dispatches.
  parser.feed("event: b\rdata: 2\r\r\n");
  assert.deepEqual(
    events.map((event) => [event.event, event.data]),
    [
      ["a", "1"],
      ["b", "2"],
    ],
  );
});

test("a data line with no space after the colon keeps its value, an empty id is kept", () => {
  const { events, parser } = collect();
  parser.feed("id:\ndata:x\n\n");
  assert.deepEqual(events, [{ event: "message", data: "x", id: "" }]);
});
