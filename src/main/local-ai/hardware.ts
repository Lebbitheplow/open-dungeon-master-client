import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HardwareInfo } from "../../shared/types";

const run = promisify(execFile);

// A best-effort hardware scan in the llmfit spirit: enough signal to pick a
// model tier, honest zeros where a platform hides the numbers. Getting VRAM
// slightly wrong is survivable because the MoE catalog can spill experts to
// RAM; the tier picker leans on the combined budget, not VRAM alone.

async function linuxVramGb(): Promise<{ vramGb: number; gttGb: number; gpuName: string }> {
  // amdgpu exposes both pools in sysfs. On APUs the VRAM number is only the
  // BIOS carve-out (often 512MB-4GB) while the GTT pool is the real capacity:
  // system RAM the GPU addresses directly, which is what llama.cpp actually
  // fills with ngl 99 on these machines.
  let best = 0;
  let gtt = 0;
  try {
    for (const card of fs.readdirSync("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      const device = path.join("/sys/class/drm", card, "device");
      try {
        const bytes = Number(fs.readFileSync(path.join(device, "mem_info_vram_total"), "utf8"));
        if (Number.isFinite(bytes)) best = Math.max(best, bytes / 1024 ** 3);
      } catch {
        // This card does not expose it; keep looking.
      }
      try {
        const bytes = Number(fs.readFileSync(path.join(device, "mem_info_gtt_total"), "utf8"));
        if (Number.isFinite(bytes)) gtt = Math.max(gtt, bytes / 1024 ** 3);
      } catch {
        // Not amdgpu.
      }
    }
  } catch {
    // No DRM at all (headless VM); fall through to nvidia-smi.
  }
  let gpuName = "";
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.total,name",
      "--format=csv,noheader,nounits",
    ]);
    const [mem, ...name] = (stdout.split("\n")[0] ?? "").split(",");
    const gb = Number(mem) / 1024;
    if (Number.isFinite(gb)) best = Math.max(best, gb);
    gpuName = name.join(",").trim();
  } catch {
    // No NVIDIA tooling; the sysfs number stands.
  }
  return { vramGb: best, gttGb: gtt, gpuName };
}

async function windowsVramGb(): Promise<{ vramGb: number; gttGb: number; gpuName: string }> {
  // AdapterRAM is a 32-bit field on many drivers, so it understates big
  // cards; nvidia-smi corrects that where present. Understating is safe
  // here: the budget falls back to RAM-assisted MoE offload.
  let vramGb = 0;
  let gpuName = "";
  try {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json",
    ]);
    const parsed = JSON.parse(stdout) as { Name?: string; AdapterRAM?: number };
    gpuName = parsed.Name ?? "";
    if (Number.isFinite(parsed.AdapterRAM)) vramGb = (parsed.AdapterRAM as number) / 1024 ** 3;
  } catch {
    // No signal; RAM budget it is.
  }
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const gb = Number(stdout.split("\n")[0]) / 1024;
    if (Number.isFinite(gb)) vramGb = Math.max(vramGb, gb);
  } catch {
    // Not an NVIDIA machine.
  }
  return { vramGb, gttGb: 0, gpuName };
}

export async function scanHardware(): Promise<HardwareInfo> {
  const ramGb = os.totalmem() / 1024 ** 3;
  const base: HardwareInfo = {
    platform: process.platform,
    arch: process.arch,
    ramGb: Math.round(ramGb),
    vramGb: 0,
    gpuName: "",
    unifiedMemory: false,
  };
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { ...base, vramGb: Math.round(ramGb), gpuName: "Apple Silicon", unifiedMemory: true };
  }
  const probe =
    process.platform === "linux"
      ? await linuxVramGb()
      : process.platform === "win32"
        ? await windowsVramGb()
        : { vramGb: 0, gttGb: 0, gpuName: "" };
  // Unified memory two ways: a big carve-out that IS most of RAM, or an AMD
  // APU whose GTT pool (GPU-addressable system RAM) dwarfs its carve-out.
  const unified =
    (probe.vramGb > 0 && probe.vramGb >= ramGb * 0.6) ||
    (probe.gttGb >= ramGb * 0.4 && probe.vramGb < ramGb * 0.3);
  return {
    ...base,
    vramGb: Math.round(unified ? ramGb : probe.vramGb),
    gpuName: probe.gpuName,
    unifiedMemory: unified,
  };
}
