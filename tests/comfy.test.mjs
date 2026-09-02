import assert from "node:assert/strict";
import test from "node:test";
import {
  installCommands,
  torchIndexUrl,
  venvPython,
  CHECKPOINT,
  COMFY_TAG,
} from "../dist/main/local-ai/comfy.js";

const nvidiaPc = {
  platform: "linux",
  arch: "x64",
  ramGb: 32,
  vramGb: 16,
  gpuName: "RTX 4080",
  gpuVendor: "nvidia",
  unifiedMemory: false,
};

const amdLinux = { ...nvidiaPc, gpuName: "Radeon RX 7800 XT", gpuVendor: "amd" };
const amdWindows = { ...amdLinux, platform: "win32" };
const cpuOnly = { ...nvidiaPc, vramGb: 0, gpuName: "", gpuVendor: "" };
const mac = {
  platform: "darwin",
  arch: "arm64",
  ramGb: 64,
  vramGb: 64,
  gpuName: "Apple Silicon",
  gpuVendor: "apple",
  unifiedMemory: true,
};

test("the torch index follows the GPU vendor", () => {
  assert.equal(torchIndexUrl(nvidiaPc), "https://download.pytorch.org/whl/cu124");
  assert.equal(torchIndexUrl(amdLinux), "https://download.pytorch.org/whl/rocm6.2");
  // No ROCm wheels exist for Windows; an AMD card there runs on CPU torch.
  assert.equal(torchIndexUrl(amdWindows), "https://download.pytorch.org/whl/cpu");
  assert.equal(torchIndexUrl(cpuOnly), "https://download.pytorch.org/whl/cpu");
  // macOS ships MPS in the default PyPI wheels.
  assert.equal(torchIndexUrl(mac), null);
});

test("install commands pin the tag and route pip through the venv", () => {
  const commands = installCommands("/root", "python3", nvidiaPc);
  assert.equal(commands.length, 4);
  const [clone, venv, torch, reqs] = commands;
  assert.equal(clone.bin, "git");
  assert.ok(clone.args.includes(COMFY_TAG));
  assert.ok(clone.args.includes("--depth"));
  assert.ok(clone.args.some((arg) => arg.endsWith("/ComfyUI")));
  assert.equal(venv.bin, "python3");
  assert.deepEqual(venv.args, ["-m", "venv", "/root/venv"]);
  assert.equal(torch.bin, "/root/venv/bin/python");
  assert.ok(torch.args.join(" ").includes("--index-url https://download.pytorch.org/whl/cu124"));
  assert.equal(reqs.bin, "/root/venv/bin/python");
  assert.ok(reqs.args.join(" ").endsWith("/root/ComfyUI/requirements.txt"));
});

test("mac installs default torch wheels with no extra index", () => {
  const torch = installCommands("/root", "python3", mac)[2];
  assert.ok(!torch.args.includes("--index-url"));
  assert.ok(torch.args.includes("torch"));
});

test("windows uses the Scripts venv layout", () => {
  assert.ok(venvPython("C:\\r", "win32").endsWith("python.exe"));
  assert.ok(venvPython("C:\\r", "win32").includes("Scripts"));
  assert.equal(venvPython("/r", "linux"), "/r/venv/bin/python");
});

test("the curated checkpoint is a pinned ungated SDXL file", () => {
  assert.ok(
    CHECKPOINT.url.startsWith("https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/"),
  );
  assert.ok(CHECKPOINT.file.endsWith(".safetensors"));
  assert.match(CHECKPOINT.sha256, /^[0-9a-f]{64}$/);
  assert.ok(CHECKPOINT.sizeGb > 6 && CHECKPOINT.sizeGb < 8);
});
