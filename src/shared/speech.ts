import type { LocalSpeechStatus } from "./types";

// GET/POST /api/admin/speech on the device world, read defensively: a world
// older than the built-in engine answers 404 (handled by the caller) and a
// newer one may add fields.
const STATES = new Set(["idle", "installing", "ready", "error"]);
const ENGINES = new Set(["whisper", "builtin", "openai", "none"]);

export function speechStatusFrom(body: unknown): LocalSpeechStatus {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const builtin = (root.builtin && typeof root.builtin === "object" ? root.builtin : {}) as Record<string, unknown>;
  const status = String(builtin.status ?? "idle");
  const active = String(root.active ?? "none");
  const progress = Number(builtin.progress);
  return {
    installed: builtin.installed === true,
    status: (STATES.has(status) ? status : "idle") as LocalSpeechStatus["status"],
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
    error: String(builtin.error ?? ""),
    downloadMb: Number(builtin.downloadMb) > 0 ? Number(builtin.downloadMb) : 76,
    active: (ENGINES.has(active) ? active : "none") as LocalSpeechStatus["active"],
  };
}

// The one line the card says about what dictation uses now.
export function speechSummary(status: LocalSpeechStatus): string {
  if (status.status === "installing") {
    return `Downloading Whisper: ${Math.round(status.progress * 100)}%.`;
  }
  if (status.status === "error") {
    return `The download failed: ${status.error || "no reason given"}.`;
  }
  switch (status.active) {
    case "builtin":
      return "Installed. Dictation in your world writes down what you say, on this computer.";
    case "whisper":
      return "A Whisper service on this computer already writes down what you say.";
    case "openai":
      return `Dictation goes to OpenAI on your key. Install this (${status.downloadMb} MB) to keep it free and on this computer.`;
    default:
      return `Not installed. Speak summaries and notes instead of typing them: a ${status.downloadMb} MB download, runs on this computer.`;
  }
}
