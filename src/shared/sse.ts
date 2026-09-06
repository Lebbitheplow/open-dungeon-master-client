// A server-sent events parser over raw text chunks, for the shell's own
// screens: the browser's EventSource cannot send an Authorization header,
// so the campaign stream is read through fetch and fed here. Follows the
// WHATWG event stream format: lines split on LF (CRLF and CR tolerated),
// "field: value" per line, a blank line dispatches, ":" lines are
// comments (the server's heartbeat), and "id" updates the last event id
// the client sends back on reconnect. Pure, so tests can feed it chunks.

export interface SseEvent {
  event: string;
  data: string;
  // The last id seen so far, "" until the stream sends one.
  id: string;
}

export interface SseParser {
  // Feeds one chunk of decoded text; may dispatch any number of events.
  feed(chunk: string): void;
  // The last event id seen, for the Last-Event-ID header on reconnect.
  lastEventId(): string;
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";
  let lastId = "";
  let eventName = "";
  let dataLines: string[] = [];
  let sawData = false;

  const dispatch = (): void => {
    if (sawData) {
      onEvent({ event: eventName || "message", data: dataLines.join("\n"), id: lastId });
    }
    eventName = "";
    dataLines = [];
    sawData = false;
  };

  const line = (text: string): void => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        sawData = true;
        break;
      case "id":
        // A NUL in an id is ignored per spec; nothing here sends one.
        if (!value.includes("\0")) lastId = value;
        break;
      default:
        // "retry" and unknown fields: nothing to do for this reader.
        break;
    }
  };

  return {
    feed(chunk) {
      buffer += chunk;
      let start = 0;
      for (;;) {
        const lf = buffer.indexOf("\n", start);
        const cr = buffer.indexOf("\r", start);
        let end: number;
        let skip: number;
        if (lf < 0 && cr < 0) break;
        if (cr >= 0 && (lf < 0 || cr < lf)) {
          end = cr;
          skip = buffer[cr + 1] === "\n" ? 2 : 1;
          // A lone CR at the very end of the buffer might be half a CRLF.
          if (skip === 1 && cr === buffer.length - 1) break;
        } else {
          end = lf;
          skip = 1;
        }
        line(buffer.slice(start, end));
        start = end + skip;
      }
      buffer = buffer.slice(start);
    },
    lastEventId: () => lastId,
  };
}
