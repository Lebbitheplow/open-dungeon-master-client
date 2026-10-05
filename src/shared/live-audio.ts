// Narration that is still being rendered (server issue 97). The server
// offers a passage the moment its first clip exists, at an address marked
// `live=1`, and answers it with the audio as it is made. A page in a browser
// plays that as it arrives; the apps fetch protected audio whole, with the
// player's token, and so would sit silent until the last clip landed. This
// is the part that can be decided without a DOM: which addresses to read as
// they arrive.

export function isLiveNarrationPath(path: string): boolean {
  if (!path.startsWith("/generated-audio/")) return false;
  const query = path.split("?")[1] ?? "";
  return new URLSearchParams(query).get("live") === "1";
}

// The bytes of a stream in the pieces a SourceBuffer takes one at a time.
// `append` resolves when the buffer is ready for the next piece.
export async function pump(
  body: ReadableStream<Uint8Array>,
  append: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    if (value && value.byteLength) {
      bytes += value.byteLength;
      await append(value);
    }
  }
}
