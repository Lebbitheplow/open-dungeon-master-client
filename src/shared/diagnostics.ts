import type { LocalAiStatus, VerifyReport } from "./types";

// The summary a player copies into a bug report (Settings, Troubleshooting):
// versions, the state of the device world, and whether the server files
// this app unpacked are the ones it shipped with. Plain text, a line per
// fact, and nothing a report should not carry: no names, keys, tokens, log
// lines or campaign text, and paths with the home folder shortened to ~.
// Both shells gather the facts; this lays them out, so the two read alike.

export interface DiagnosticFacts {
  app: { version: string; installKind: string; platform: string; arch: string; os: string; runtime: string };
  // The server payload this build ships, and the one unpacked on disk.
  payload: { serverVersion: string; builtAt: string } | null;
  runTree: { serverVersion: string; builtAt: string } | null;
  world: {
    state: string;
    error: string;
    firstRun: boolean;
    dbPresent: boolean;
    keyPresent: boolean;
    // The ids of the world packs installed in the device world.
    packs: string[];
  };
  // Saved servers, as a count: their addresses are the player's business.
  servers: number;
  // The local AI the app manages: what is installed, whether it answers,
  // and the last thing that went wrong with it. A world that opens fine
  // can still have no storyteller, and the summary used to say nothing
  // about that.
  localAi: Pick<LocalAiStatus, "installedLabel" | "installedTierId" | "running" | "external" | "endpoint" | "error" | "comfy"> | null;
  // The check of the unpacked files: null when this build has no manifest
  // to check against (a development run), "skipped" where it was not run.
  verify: VerifyReport | null | "skipped";
  paths: { userData: string; log: string };
}

// How many wrong files the summary names before it counts the rest.
const NAMED_FILES = 20;

// The word a player types to start over (Settings, Troubleshooting): the
// one action there that takes the world out of the app's hands.
export const RESET_PHRASE = "RESET";

export function redactHome(file: string, home: string): string {
  if (!home || !file.startsWith(home)) return file;
  return `~${file.slice(home.length)}`;
}

// One phrase for a check's outcome, for the summary and the Settings card.
export function describeVerify(report: VerifyReport | null): string {
  if (!report) return "no manifest to check against";
  if (!report.unpacked) return "not unpacked yet";
  const wrong = report.missing.length + report.changed.length;
  if (!wrong) return `all ${report.listed} files present${report.hashed ? " and intact" : ""}`;
  const parts: string[] = [];
  if (report.missing.length) parts.push(`${report.missing.length} missing`);
  if (report.changed.length) parts.push(`${report.changed.length} changed`);
  return `${parts.join(", ")} of ${report.listed}`;
}

// One line each for the story engine and the image engine.
export function describeLocalAi(ai: DiagnosticFacts["localAi"]): string[] {
  if (!ai) return ["Local AI: not available on this device"];
  const story = !ai.installedTierId
    ? "not installed"
    : `${ai.installedLabel || ai.installedTierId} (${ai.installedTierId}), ${
        ai.running ? (ai.external ? `answering at ${ai.endpoint}, started outside the app` : `running at ${ai.endpoint}`) : "stopped"
      }${ai.error ? ` (${ai.error})` : ""}`;
  const images = !ai.comfy.installed
    ? "not installed"
    : `ComfyUI ${ai.comfy.running ? "running" : "stopped"}${ai.comfy.checkpoint ? `, ${ai.comfy.checkpoint}` : ""}${ai.comfy.error ? ` (${ai.comfy.error})` : ""}`;
  return [`Local AI: ${story}`, `Image AI: ${images}`];
}

export function diagnosticSummary(facts: DiagnosticFacts, now = new Date()): string {
  const { app, payload, runTree, world, verify } = facts;
  const stale = payload && runTree && payload.builtAt !== runTree.builtAt;
  const lines = [
    `Open Game Master ${app.version} (${app.installKind}) on ${app.platform} ${app.arch}, ${app.os}, ${app.runtime}`,
    `Written ${now.toISOString()}`,
    `Bundled server: ${payload ? `${payload.serverVersion} built ${payload.builtAt}` : "none"}`,
    `Unpacked server: ${runTree ? `${runTree.serverVersion} built ${runTree.builtAt}` : "not unpacked yet"}${stale ? " (not the bundled build; the next start replaces it)" : ""}`,
    `Server files: ${verify === "skipped" ? "not checked" : describeVerify(verify)}`,
    `World: ${world.state}${world.error ? ` (${world.error})` : ""}${world.firstRun ? ", never entered" : ""}`,
    `World data: database ${world.dbPresent ? "present" : "absent"}, key ${world.keyPresent ? "present" : "absent"}, installed world packs ${world.packs.length ? world.packs.join(", ") : "none"}`,
    `Saved servers: ${facts.servers}`,
    ...describeLocalAi(facts.localAi),
    `Data folder: ${facts.paths.userData}`,
    `Log: ${facts.paths.log}`,
  ];
  if (verify && verify !== "skipped") {
    const named = [...verify.missing.map((file) => `missing ${file}`), ...verify.changed.map((file) => `changed ${file}`)];
    for (const line of named.slice(0, NAMED_FILES)) lines.push(`  ${line}`);
    if (named.length > NAMED_FILES) lines.push(`  and ${named.length - NAMED_FILES} more`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- Report a problem ----
// The server's Report a problem (its ReportProblemDialog, the server
// admin's alone) saves one JSON file for a GitHub bug report. In the game
// screens the page hands that file to
// the app (window.odmShell.saveReport) and asks the app about itself
// (reportFacts): the facts the server cannot see. The same facts as the
// summary's first line, plus how the app shows the pages and whether the
// table is the device's own world. Never an address, a path or a key; the
// file itself is only ever saved where the person picks.

export type AppFacts = DiagnosticFacts["app"];

// The local AI the app manages, as a report file names it: each engine,
// its model and whether it runs, never where it answers. Most reported
// problems turn out to be the model, so the report says which one.
export interface ReportLocalAi {
  localStory: string;
  localImages: string;
}

export function reportLocalAi(ai: DiagnosticFacts["localAi"], home = ""): ReportLocalAi | null {
  if (!ai) return null;
  // An engine's error can quote a path anywhere in it, not only at the start.
  const error = (text: string) => (text ? ` (${home ? text.split(home).join("~") : text})` : "");
  const localStory = !ai.installedTierId
    ? "not installed"
    : `${ai.installedLabel || ai.installedTierId} (${ai.installedTierId}), ${
        ai.running ? (ai.external ? "answering, started outside the app" : "running") : "stopped"
      }${error(ai.error)}`;
  const localImages = !ai.comfy.installed
    ? "not installed"
    : `ComfyUI ${ai.comfy.running ? "running" : "stopped"}${ai.comfy.checkpoint ? `, ${ai.comfy.checkpoint}` : ""}${error(ai.comfy.error)}`;
  return { localStory, localImages };
}

export interface ReportAppFacts extends AppFacts, Partial<ReportLocalAi> {
  screens: "native";
  localWorld: boolean;
}

export function reportAppFacts(app: AppFacts & Partial<ReportLocalAi>, localWorld: boolean): ReportAppFacts {
  return {
    version: app.version,
    installKind: app.installKind,
    platform: app.platform,
    arch: app.arch,
    os: app.os,
    runtime: app.runtime,
    ...(typeof app.localStory === "string" ? { localStory: app.localStory } : {}),
    ...(typeof app.localImages === "string" ? { localImages: app.localImages } : {}),
    screens: "native",
    localWorld,
  };
}

// A report is text well under this; the cap only stops a page from handing
// the app something else entirely.
export const MAX_REPORT_CHARS = 8 * 1024 * 1024;
// The server's own name for the file (src/lib/report-bundle.ts reportFileName).
const REPORT_NAME = /^odm-report-[0-9-]{1,40}\.json$/;

export function defaultReportName(now = new Date()): string {
  return `odm-report-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
}

// What a page asked the app to save, checked: the text must be a report
// file (JSON of kind "odm-report"), and a name of any other shape is
// replaced, so the door cannot write other files or other names. Null when
// it is not a report.
export function reportFileInput(input: unknown, now = new Date()): { name: string; text: string } | null {
  const raw = input as { name?: unknown; text?: unknown } | null;
  if (!raw || typeof raw !== "object" || typeof raw.text !== "string") return null;
  if (!raw.text || raw.text.length > MAX_REPORT_CHARS) return null;
  try {
    const parsed = JSON.parse(raw.text) as { kind?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || parsed.kind !== "odm-report") return null;
  } catch {
    return null;
  }
  const name = typeof raw.name === "string" && REPORT_NAME.test(raw.name) ? raw.name : defaultReportName(now);
  return { name, text: raw.text };
}
