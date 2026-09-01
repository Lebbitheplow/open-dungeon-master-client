import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG,
  catalogEntry,
  llamaArchiveUrl,
  memoryBudgetGb,
  presetFor,
  sizeTiers,
} from "../dist/main/local-ai/catalog.js";

const gamingPc = {
  platform: "linux",
  arch: "x64",
  ramGb: 32,
  vramGb: 16,
  gpuName: "RTX 4080",
  unifiedMemory: false,
};

const smallLaptop = {
  platform: "win32",
  arch: "x64",
  ramGb: 16,
  vramGb: 0,
  gpuName: "",
  unifiedMemory: false,
};

const mac = {
  platform: "darwin",
  arch: "arm64",
  ramGb: 64,
  vramGb: 64,
  gpuName: "Apple Silicon",
  unifiedMemory: true,
};

test("llama archive URLs exist for the three shipped platforms only", () => {
  assert.ok(llamaArchiveUrl("linux", "x64")?.includes("ubuntu-vulkan-x64"));
  assert.ok(llamaArchiveUrl("win32", "x64")?.includes("win-vulkan-x64"));
  assert.ok(llamaArchiveUrl("darwin", "arm64")?.includes("macos-arm64"));
  assert.equal(llamaArchiveUrl("linux", "arm64"), null);
});

test("the ladder is ordered largest first and ends with the fallback", () => {
  for (let i = 1; i < CATALOG.length; i += 1) {
    assert.ok(CATALOG[i].sizeGb < CATALOG[i - 1].sizeGb);
  }
  assert.equal(CATALOG[CATALOG.length - 1].moe, false);
});

test("a 16GB VRAM gaming PC gets the standard story quant via MoE offload", () => {
  const tiers = sizeTiers(gamingPc, "");
  const recommended = tiers.find((tier) => tier.recommended);
  assert.equal(recommended?.id, "qwen-q4");
  assert.equal(tiers.find((tier) => tier.id === "qwen-q8")?.fits, false);
});

test("a small GPU-less laptop still fits something", () => {
  const budget = memoryBudgetGb(smallLaptop);
  assert.ok(budget < 12);
  const tiers = sizeTiers(smallLaptop, "");
  const recommended = tiers.find((tier) => tier.recommended);
  assert.equal(recommended?.id, "gemma-12b");
});

test("unified memory counts the whole pool", () => {
  const tiers = sizeTiers(mac, "");
  assert.equal(tiers.find((tier) => tier.recommended)?.id, "qwen-q8");
});

test("installed flag rides through", () => {
  const tiers = sizeTiers(gamingPc, "qwen-q4");
  assert.equal(tiers.find((tier) => tier.id === "qwen-q4")?.installed, true);
});

test("the preset carries the tuned recipe and offloads experts when needed", () => {
  const entry = catalogEntry("qwen-q4");
  const preset = presetFor(entry, "/models/x.gguf", gamingPc);
  assert.ok(preset.includes("[qwen3.6-35b]"));
  assert.ok(preset.includes("model = /models/x.gguf"));
  assert.ok(preset.includes("presence-penalty = 1.5"));
  assert.ok(preset.includes("reasoning-budget = 2048"));
  assert.ok(preset.includes("load-on-startup = true"));
  // 22GB file vs 16GB VRAM: experts spill to RAM.
  assert.ok(preset.includes("cpu-moe = true"));
});

test("no expert offload on unified memory or when VRAM holds the file", () => {
  const entry = catalogEntry("qwen-q8");
  assert.ok(!presetFor(entry, "/m.gguf", mac).includes("cpu-moe"));
  const bigCard = { ...gamingPc, vramGb: 48 };
  const q4 = catalogEntry("qwen-q4");
  assert.ok(!presetFor(q4, "/m.gguf", bigCard).includes("cpu-moe"));
});

test("the fallback preset is dense: no MoE keys, gemma sampling", () => {
  const entry = catalogEntry("gemma-12b");
  const preset = presetFor(entry, "/m.gguf", smallLaptop);
  assert.ok(preset.includes("[gemma-4-12b-qat]"));
  assert.ok(!preset.includes("cpu-moe"));
  assert.ok(!preset.includes("reasoning-budget"));
  assert.ok(preset.includes("top-k = 64"));
});
