import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HardwareInfo, LocalAiStatus, LocalAiTier } from "../../shared/types";
import {
  catalogEntry,
  llamaArchiveUrl,
  presetFor,
  sizeTiers,
  LLAMA_TAG,
} from "./catalog";
import { scanHardware } from "./hardware";

const runFile = promisify(execFile);

// Installs and runs the local AI: a pinned llama.cpp build plus one curated
// model, laid out under userData/local-ai. The server preset is regenerated
// at every start so a hardware change (new GPU, more RAM) re-tunes the
// offload without a reinstall. Port 8001 is the ODM server's built-in
// default for local text AI; if something is already serving there (a
// self-managed llama-server), this manager leaves it alone and uses it.

const PORT = 8001;
const ORIGIN = `http://127.0.0.1:${PORT}`;

interface InstallState {
  tierId: string;
  file: string;
  llamaTag: string;
}

export class LocalAiManager {
  private child: ChildProcess | null = null;
  private busy: LocalAiStatus["busy"] = "";
  private progress: LocalAiStatus["progress"] = null;
  private error = "";
  private externalServer = false;
  private hardware: HardwareInfo | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly rootDir: string) {}

  private get binDir(): string {
    return path.join(this.rootDir, "bin");
  }
  private get modelsDir(): string {
    return path.join(this.rootDir, "models");
  }
  private get stateFile(): string {
    return path.join(this.rootDir, "state.json");
  }
  private get presetFile(): string {
    return path.join(this.rootDir, "models.ini");
  }
  private get logFile(): string {
    return path.join(this.rootDir, "llama-server.log");
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setProgress(label: string, percent: number): void {
    this.progress = { label, percent: Math.max(0, Math.min(100, Math.round(percent))) };
    this.emit();
  }

  private state(): InstallState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as InstallState;
      if (parsed?.tierId && fs.existsSync(path.join(this.modelsDir, parsed.file))) {
        return parsed;
      }
    } catch {
      // Not installed.
    }
    return null;
  }

  status(): LocalAiStatus {
    return {
      supported: llamaArchiveUrl(process.platform, process.arch) !== null,
      installedTierId: this.state()?.tierId ?? "",
      running: this.externalServer || (this.child !== null && this.child.exitCode === null),
      busy: this.busy,
      progress: this.progress,
      error: this.error,
    };
  }

  async scan(): Promise<{ hardware: HardwareInfo; tiers: LocalAiTier[] }> {
    this.hardware = await scanHardware();
    return {
      hardware: this.hardware,
      tiers: sizeTiers(this.hardware, this.state()?.tierId ?? ""),
    };
  }

  private llamaServerPath(): string | null {
    const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const stack = [this.binDir];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === name) return full;
      }
    }
    return null;
  }

  // Streams a URL to disk with progress and byte-range resume, so a 20GB
  // model survives a dropped connection without starting over.
  private async download(url: string, target: string, label: string): Promise<void> {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    const response = await fetch(url, {
      redirect: "follow",
      headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed (${response.status}) for ${label}.`);
    }
    const resumed = response.status === 206;
    if (!resumed && offset > 0) {
      fs.rmSync(partial, { force: true });
    }
    const total =
      Number(response.headers.get("content-length") || 0) + (resumed ? offset : 0);
    let done = resumed ? offset : 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, next) => {
        done += chunk.length;
        if (total > 0) this.setProgress(label, (done / total) * 100);
        next(null, chunk);
      },
    });
    if (!response.body) throw new Error(`Empty response for ${label}.`);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      counter,
      fs.createWriteStream(partial, { flags: resumed ? "a" : "w" }),
    );
    fs.renameSync(partial, target);
  }

  private async ensureLlama(): Promise<void> {
    if (this.llamaServerPath()) return;
    const url = llamaArchiveUrl(process.platform, process.arch);
    if (!url) throw new Error("Local AI is not supported on this platform yet.");
    const archive = path.join(this.rootDir, path.basename(url));
    this.setProgress("Downloading the AI engine (llama.cpp)", 0);
    await this.download(url, archive, "Downloading the AI engine (llama.cpp)");
    fs.rmSync(this.binDir, { recursive: true, force: true });
    fs.mkdirSync(this.binDir, { recursive: true });
    // bsdtar (shipped on Windows 10+ and macOS) and GNU tar both unpack
    // .tar.gz; bsdtar also reads the Windows .zip asset.
    await runFile("tar", ["-xf", archive, "-C", this.binDir]);
    fs.rmSync(archive, { force: true });
    if (!this.llamaServerPath()) {
      throw new Error("The llama.cpp archive did not contain llama-server.");
    }
  }

  async install(tierId: string): Promise<void> {
    if (this.busy) throw new Error("An install is already in progress.");
    const entry = catalogEntry(tierId);
    if (!entry) throw new Error("Unknown model choice.");
    this.busy = "downloading";
    this.error = "";
    this.emit();
    try {
      await this.stop();
      await this.ensureLlama();
      const modelPath = path.join(this.modelsDir, entry.file);
      if (!fs.existsSync(modelPath)) {
        this.setProgress(`Downloading ${entry.label} (${entry.sizeGb} GB)`, 0);
        await this.download(entry.url, modelPath, `Downloading ${entry.label}`);
      }
      const state: InstallState = { tierId, file: entry.file, llamaTag: LLAMA_TAG };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
      // Old tiers' files are kept until a different file is fully installed,
      // then swept, so a failed upgrade never deletes the working model.
      for (const file of fs.readdirSync(this.modelsDir)) {
        if (file !== entry.file && file.endsWith(".gguf")) {
          fs.rmSync(path.join(this.modelsDir, file), { force: true });
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.busy = "";
      this.progress = null;
      this.emit();
    }
  }

  // The model alias the ODM server should be configured to request.
  installedAlias(): string {
    const state = this.state();
    return state ? (catalogEntry(state.tierId)?.alias ?? "") : "";
  }

  private async portInUse(): Promise<boolean> {
    try {
      const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
      return response.status > 0;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    const state = this.state();
    if (!state || (this.child && this.child.exitCode === null)) return;
    if (await this.portInUse()) {
      // Someone already runs an AI server here (a hand-managed llama-server,
      // Ollama behind a proxy). Theirs wins; nothing to manage.
      this.externalServer = true;
      return;
    }
    const entry = catalogEntry(state.tierId);
    const bin = this.llamaServerPath();
    if (!entry || !bin) return;
    this.busy = "starting";
    this.emit();
    try {
      const hardware = this.hardware ?? (await scanHardware());
      this.hardware = hardware;
      fs.writeFileSync(
        this.presetFile,
        presetFor(entry, path.join(this.modelsDir, entry.file), hardware),
      );
      const log = fs.openSync(this.logFile, "a");
      const child = spawn(
        bin,
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(PORT),
          "--models-preset",
          this.presetFile,
          "--models-max",
          "1",
        ],
        {
          stdio: ["ignore", log, log],
          // The Vulkan build's shared libraries sit beside the binary.
          env: {
            ...process.env,
            LD_LIBRARY_PATH: `${path.dirname(bin)}:${process.env.LD_LIBRARY_PATH ?? ""}`,
          },
        },
      );
      fs.closeSync(log);
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.error = "The local AI server stopped (see llama-server.log).";
          this.emit();
        }
      });
      // Wait for the server process, not the model: the model loads in the
      // background and the first request simply waits for it.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (await this.portInUse()) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.busy = "";
      this.emit();
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.externalServer = false;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), 8000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    }
  }
}
