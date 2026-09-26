// Story memory: the embedding model the device world's bundled server uses
// for recall and lore search (the server's src/lib/embeddings.ts). The
// server reads EMBEDDING_MODEL and EMBEDDING_DTYPE once at start, records
// which model built the stored vectors, and after a change re-embeds the
// whole story in the background, so a switch needs only a restart.
// Pure decisions only; the main process and the tests share them.

export type StoryMemory = "english" | "multilingual";

// What each choice passes to the server; "" leaves the server's own default
// (MiniLM, English only).
export const STORY_MEMORY_MODELS: Readonly<Record<StoryMemory, { model: string; dtype: string }>> = {
  english: { model: "", dtype: "" },
  // 384-dim like the default, so the server's size check passes; q8 halves
  // the download at no measurable cost to recall.
  multilingual: { model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dtype: "q8" },
};

export function parseStoryMemory(raw: unknown): StoryMemory {
  return raw === "multilingual" ? "multilingual" : "english";
}

export function storyMemoryEnv(choice: StoryMemory): { EMBEDDING_MODEL: string; EMBEDDING_DTYPE: string } {
  const { model, dtype } = STORY_MEMORY_MODELS[choice];
  return { EMBEDDING_MODEL: model, EMBEDDING_DTYPE: dtype };
}

// The OS/CPU pairs whose desktop package carries the embedding runtime's
// binding (scripts/stage-desktop-payload.mjs). onnxruntime ships no Intel
// Mac build, and the phone payload leaves the runtime out, so elsewhere the
// server searches by keyword and there is no model to choose.
const RUNTIME_TARGETS = new Set(["linux/x64", "win32/x64", "darwin/arm64"]);

export function storyMemorySupported(platform: string, arch: string): boolean {
  return RUNTIME_TARGETS.has(`${platform}/${arch}`);
}

export interface StoryMemoryStatus {
  choice: StoryMemory;
  // Chosen, but the running world still uses the previous model until it
  // restarts (the change waits while a table or a share is live).
  pendingRestart: boolean;
  // What the main process can see using the world right now: a page of it
  // in the window (a table, or a visited host drawn through the portal) or
  // an online share. The shell screen adds its own native table on top.
  worldInUse: boolean;
}
