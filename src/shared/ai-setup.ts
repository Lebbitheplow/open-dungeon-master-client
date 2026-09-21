// The OpenAI door of Story AI, shared by both shells. The key belongs to the
// device: it is saved once in the device world's admin settings, where every
// campaign on the device follows it (the server applies that on a device
// world), so neither shell ever writes a key into a campaign.
import type { AiSetup, SavedAi } from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-5.1";

export const NO_SAVED_AI: SavedAi = { keySaved: false, model: "", utilityModel: "" };

function isOpenAi(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

// What the device already holds, read from the masked admin settings (the
// key itself never leaves the server, only whether one is set). A key for
// some other backend does not count: it could not pay for OpenAI.
export function savedAiFrom(body: unknown): SavedAi {
  const config = (body as { config?: { text?: Record<string, unknown>; harness?: Record<string, unknown> } } | null)
    ?.config;
  const text = config?.text;
  if (text?.provider === "harness" && typeof config?.harness?.id === "string" && config.harness.id) {
    return {
      ...NO_SAVED_AI,
      harnessId: config.harness.id,
      model: typeof config.harness.model === "string" ? config.harness.model : "",
      utilityModel: typeof config.harness.utilityModel === "string" ? config.harness.utilityModel : "",
    };
  }
  if (!text || text.provider !== "custom" || !isOpenAi(text.customBaseUrl)) return NO_SAVED_AI;
  if (text.hasCustomApiKey !== true) return NO_SAVED_AI;
  return {
    keySaved: true,
    model: typeof text.customModel === "string" ? text.customModel : "",
    utilityModel: typeof text.utilityModel === "string" ? text.utilityModel : "",
  };
}

// The admin settings patch for "AI via my OpenAI key". One key covers the
// storyteller, the utility model and the pictures. A blank key keeps the one
// the device already holds (the server reads an omitted key as "keep"), so
// changing the model never means pasting the key again.
export function openAiPatch(setup: AiSetup, saved: SavedAi): { patch: object } | { error: string } {
  const apiKey = setup.apiKey.trim().slice(0, 400);
  if (!apiKey && !saved.keySaved) return { error: "Enter the API key." };
  const model = setup.model.trim().slice(0, 200) || DEFAULT_MODEL;
  const utilityModel = setup.utilityModel.trim().slice(0, 200) || model;
  const key = <K extends string>(field: K) => (apiKey ? { [field]: apiKey } : {});
  return {
    patch: {
      text: {
        provider: "custom",
        customBaseUrl: OPENAI_BASE_URL,
        customModel: model,
        ...key("customApiKey"),
        utilityProvider: "custom",
        utilityBaseUrl: OPENAI_BASE_URL,
        utilityModel,
        ...key("utilityApiKey"),
      },
      images: { defaultBackend: "openai", ...key("openaiApiKey") },
    },
  };
}

// The admin settings patch for "an agent I already have": the device's server
// narrates every campaign with that program on its own sign-in. Pictures are
// left as they are: a local ComfyUI keeps painting, and without one the
// tables play with placeholder art. The program's own image tool is only
// offered after a test picture from the admin page, never from here.
export function harnessPatch(setup: AiSetup): { patch: object } | { error: string } {
  const harness = setup.harness;
  if (!harness || !["claude", "codex", "opencode", "grok"].includes(harness.id)) {
    return { error: "Choose a program first." };
  }
  return {
    patch: {
      harness: {
        id: harness.id,
        model: harness.model.trim().slice(0, 200),
        utilityModel: harness.utilityModel.trim().slice(0, 200),
      },
      text: { provider: "harness" },
    },
  };
}
