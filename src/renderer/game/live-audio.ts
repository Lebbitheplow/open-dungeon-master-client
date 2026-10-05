// Plays narration while the server is still making it (server issue 97).
// The apps reach protected audio with the player's token, which an audio
// element cannot send, so it is normally fetched whole and handed over as a
// blob: fine for a finished file, but a passage still being rendered would
// stay silent until its last clip. A live passage is instead fetched as a
// stream and fed to the element through a MediaSource, so the first line is
// heard as soon as it exists, as it is in a browser.
import { pump } from "../../shared/live-audio.js";

const MIME = "audio/mpeg";

export function canStreamAudio(): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(MIME);
}

function appendTo(buffer: SourceBuffer, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      reject(new Error("The audio could not be buffered."));
    };
    buffer.addEventListener("updateend", done);
    buffer.addEventListener("error", failed);
    try {
      // A copy with a buffer of its own: a fetch chunk may be a view.
      buffer.appendBuffer(chunk.slice().buffer);
    } catch (error) {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      reject(error);
    }
  });
}

// An address the element can be given at once. The stream is fetched (with
// whatever `load` adds: the token) once the element opens it. A stream that
// fails ends the source in error, which the element reports the way it
// reports any audio it could not play.
export function liveAudioUrl(load: () => Promise<Response>): string {
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  // The element holds the source from the moment it opens; the address is
  // only needed until then. An element that never opens it (its src was
  // changed first) lets go of it here too.
  const release = setTimeout(() => URL.revokeObjectURL(url), 60_000);
  source.addEventListener(
    "sourceopen",
    () => {
      clearTimeout(release);
      URL.revokeObjectURL(url);
      void (async () => {
        try {
          const buffer = source.addSourceBuffer(MIME);
          // Clip after clip, each starting where the last one ended.
          buffer.mode = "sequence";
          const response = await load();
          if (!response.ok || !response.body) throw new Error(`Narration answered ${response.status}.`);
          await pump(response.body, (chunk) => appendTo(buffer, chunk));
          if (source.readyState === "open") source.endOfStream();
        } catch {
          if (source.readyState === "open") {
            try {
              source.endOfStream("network");
            } catch {
              /* already closed */
            }
          }
        }
      })();
    },
    { once: true },
  );
  return url;
}
