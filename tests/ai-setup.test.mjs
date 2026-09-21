import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, NO_SAVED_AI, harnessPatch, openAiPatch, savedAiFrom } from "../dist/shared/ai-setup.js";

const setup = (apiKey, model = "", utilityModel = "") => ({ choice: "openai", apiKey, model, utilityModel });
const openAiConfig = (text) => ({
  config: { text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", ...text } },
});

test("one key covers the storyteller, the utility model and the pictures", () => {
  const built = openAiPatch(setup(" sk-1 "), NO_SAVED_AI);
  assert.equal(built.patch.text.customApiKey, "sk-1");
  assert.equal(built.patch.text.utilityApiKey, "sk-1");
  assert.equal(built.patch.images.openaiApiKey, "sk-1");
  assert.equal(built.patch.images.defaultBackend, "openai");
  assert.equal(built.patch.text.customModel, DEFAULT_MODEL);
  assert.equal(built.patch.text.utilityModel, DEFAULT_MODEL, "a blank utility model follows the storyteller");
});

test("a blank key is refused until the device holds one, then it means keep", () => {
  assert.deepEqual(openAiPatch(setup(""), NO_SAVED_AI), { error: "Enter the API key." });
  const built = openAiPatch(setup("", "gpt-5.4-mini", "gpt-5-nano"), { keySaved: true, model: "", utilityModel: "" });
  assert.equal(built.patch.text.customModel, "gpt-5.4-mini");
  assert.equal(built.patch.text.utilityModel, "gpt-5-nano");
  // Omitted, not blank: the server reads a missing key as keep and "" as clear.
  assert.equal("customApiKey" in built.patch.text, false);
  assert.equal("utilityApiKey" in built.patch.text, false);
  assert.equal("openaiApiKey" in built.patch.images, false);
});

test("the saved state is read from the masked settings", () => {
  assert.deepEqual(
    savedAiFrom(openAiConfig({ customModel: "gpt-5.1", utilityModel: "gpt-5-mini", hasCustomApiKey: true })),
    { keySaved: true, model: "gpt-5.1", utilityModel: "gpt-5-mini" },
  );
  assert.deepEqual(savedAiFrom(openAiConfig({ hasCustomApiKey: false })), NO_SAVED_AI);
  assert.deepEqual(savedAiFrom(null), NO_SAVED_AI);
  assert.deepEqual(savedAiFrom({}), NO_SAVED_AI);
});

test("a key for another backend is not an OpenAI key", () => {
  const local = { config: { text: { provider: "custom", customBaseUrl: "http://127.0.0.1:8001/v1", hasCustomApiKey: true } } };
  assert.deepEqual(savedAiFrom(local), NO_SAVED_AI);
  const lookalike = openAiConfig({ customBaseUrl: "https://api.openai.com.evil.example/v1", hasCustomApiKey: true });
  assert.deepEqual(savedAiFrom(lookalike), NO_SAVED_AI);
  const human = { config: { text: { provider: "none", customBaseUrl: "https://api.openai.com/v1", hasCustomApiKey: true } } };
  assert.deepEqual(savedAiFrom(human), NO_SAVED_AI);
});

test("an agent the device already has narrates every campaign, and no key is ever sent", () => {
  const built = harnessPatch({
    choice: "harness",
    apiKey: "",
    model: "",
    utilityModel: "",
    harness: { id: "claude", model: " sonnet ", utilityModel: "haiku" },
  });
  assert.deepEqual(built.patch, {
    harness: { id: "claude", model: "sonnet", utilityModel: "haiku" },
    text: { provider: "harness" },
  });
  assert.ok(!JSON.stringify(built.patch).includes("ApiKey"), "the agent's own sign-in is used, nothing else");
  assert.deepEqual(harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "" }), { error: "Choose a program first." });
  assert.deepEqual(
    harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", harness: { id: "bash", model: "", utilityModel: "" } }),
    { error: "Choose a program first." },
  );
});

test("a device narrating with an agent is read back as that agent, not as a key", () => {
  const saved = savedAiFrom({
    config: { text: { provider: "harness" }, harness: { id: "opencode", model: "llama/qwen3.6-35b", utilityModel: "" } },
  });
  assert.equal(saved.harnessId, "opencode");
  assert.equal(saved.model, "llama/qwen3.6-35b");
  assert.equal(saved.keySaved, false);
  assert.deepEqual(savedAiFrom({ config: { text: { provider: "harness" }, harness: { id: "" } } }), NO_SAVED_AI);
});
