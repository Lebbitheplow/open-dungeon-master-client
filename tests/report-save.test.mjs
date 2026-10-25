// Report a problem in the apps (the server's ReportProblemDialog, through
// window.odmShell): the desktop saves the report file where the tester
// picks, its save dialog starting in Downloads under the server's name for
// the file; backing out saves nothing; only a report file goes through, so
// the door writes nothing else; and the facts the app adds hold no address.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveReportFile } from "../dist/main/report-save.js";
import { MAX_REPORT_CHARS, reportAppFacts, reportFileInput } from "../dist/shared/diagnostics.js";

const REPORT = `${JSON.stringify({ kind: "odm-report", format: 1, readable: ["Open Dungeon Master report."] }, null, 2)}\n`;
const NAME = "odm-report-2026-10-24-10-00-00.json";

function deps(over = {}) {
  const asked = [];
  const written = [];
  return {
    asked,
    written,
    deps: {
      downloadsDir: () => "/home/tester/Downloads",
      home: "/home/tester",
      showSaveDialog: async (options) => {
        asked.push(options);
        return { canceled: false, filePath: path.join("/home/tester/Downloads", NAME) };
      },
      writeFile: async (file, text) => {
        written.push({ file, text });
      },
      ...over,
    },
  };
}

test("the save dialog starts in Downloads under the report's own name", async () => {
  const run = deps();
  const result = await saveReportFile(run.deps, { name: NAME, text: REPORT });
  assert.equal(run.asked.length, 1);
  assert.equal(run.asked[0].defaultPath, path.join("/home/tester/Downloads", NAME));
  assert.deepEqual(run.asked[0].filters, [{ name: "Report", extensions: ["json"] }]);
  assert.deepEqual(run.written, [{ file: path.join("/home/tester/Downloads", NAME), text: REPORT }]);
  assert.deepEqual(result, { saved: true, name: NAME, where: "~/Downloads" });
});

test("backing out of the dialog saves nothing", async () => {
  const run = deps({ showSaveDialog: async () => ({ canceled: true }) });
  assert.deepEqual(await saveReportFile(run.deps, { name: NAME, text: REPORT }), { saved: false, name: "", where: "" });
  assert.equal(run.written.length, 0);
});

test("the file lands where the tester picked, renamed or not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-report-save-"));
  try {
    const target = path.join(dir, "my report.json");
    const result = await saveReportFile(
      {
        downloadsDir: () => dir,
        home: "",
        showSaveDialog: async () => ({ canceled: false, filePath: target }),
        writeFile: (file, text) => fs.promises.writeFile(file, text, "utf8"),
      },
      { name: NAME, text: REPORT },
    );
    assert.equal(fs.readFileSync(target, "utf8"), REPORT);
    assert.deepEqual(result, { saved: true, name: "my report.json", where: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only a report file goes through the door", async () => {
  const run = deps();
  for (const input of [null, "text", { name: NAME }, { name: NAME, text: "" }, { name: NAME, text: "not json" }, { name: NAME, text: JSON.stringify({ kind: "other" }) }, { name: NAME, text: "null" }]) {
    await assert.rejects(saveReportFile(run.deps, input), /not a report file/);
  }
  await assert.rejects(saveReportFile(run.deps, { name: NAME, text: `"${"x".repeat(MAX_REPORT_CHARS)}"` }), /not a report file/);
  assert.equal(run.asked.length, 0);
  assert.equal(run.written.length, 0);
});

test("a name of any other shape is replaced by the report's own", () => {
  const now = new Date("2026-10-24T10:00:00.000Z");
  for (const name of ["../../.bashrc", "odm-report-x.json", "report.exe", "", 7]) {
    assert.equal(reportFileInput({ name, text: REPORT }, now).name, "odm-report-2026-10-24-10-00-00.json");
  }
  assert.equal(reportFileInput({ name: NAME, text: REPORT }, now).name, NAME);
});

test("the app's facts for a report are the summary's, plus how it shows the pages and whose world it is", () => {
  const app = { version: "0.22.0", installKind: "AppImage", platform: "linux", arch: "x64", os: "Linux 6.9", runtime: "Electron 44.9.3" };
  assert.deepEqual(reportAppFacts(app, true), { ...app, screens: "native", localWorld: true });
  assert.equal(reportAppFacts(app, false).localWorld, false);
  assert.deepEqual(Object.keys(reportAppFacts(app, false)).sort(), ["arch", "installKind", "localWorld", "os", "platform", "runtime", "screens", "version"]);
});
