import path from "node:path";
import { redactHome, reportFileInput } from "../shared/diagnostics";
import type { ReportSaveResult } from "../shared/types";

// Report a problem on the desktop (the server's ReportProblemDialog, from
// the game screens through window.odmShell.saveReport): the report file is
// saved where the tester picks in the system's save dialog, which starts in
// the Downloads folder under the server's own name for the file, so the
// issue form's file box finds it at once. Nothing is sent anywhere. The
// dialog and the disk are handed in, so tests run without Electron.

export interface ReportSaveDeps {
  downloadsDir(): string;
  home: string;
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(file: string, text: string): Promise<void>;
}

export async function saveReportFile(deps: ReportSaveDeps, input: unknown): Promise<ReportSaveResult> {
  const report = reportFileInput(input);
  if (!report) throw new Error("That is not a report file.");
  const choice = await deps.showSaveDialog({
    title: "Save the report",
    defaultPath: path.join(deps.downloadsDir(), report.name),
    filters: [{ name: "Report", extensions: ["json"] }],
  });
  if (choice.canceled || !choice.filePath) return { saved: false, name: "", where: "" };
  await deps.writeFile(choice.filePath, report.text);
  return {
    saved: true,
    name: path.basename(choice.filePath),
    where: redactHome(path.dirname(choice.filePath), deps.home),
  };
}
