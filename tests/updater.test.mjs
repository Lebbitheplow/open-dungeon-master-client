import assert from "node:assert/strict";
import test from "node:test";
import {
  detectInstallKind,
  fetchLatestReleaseVersion,
  isNewerVersion,
  Updater,
  versionFromTag,
} from "../dist/main/updater.js";

const LINUX_OPT = "/opt/open-dungeon-master/open-dungeon-master-client";
const LINUX_USR = "/usr/lib/open-dungeon-master/open-dungeon-master-client";
const LINUX_HOME = "/home/kaleb/apps/odm/open-dungeon-master-client";
const WIN_EXE = "C:\\Users\\kaleb\\AppData\\Local\\Programs\\odm\\odm.exe";

test("an unpackaged run is dev no matter what the environment claims", () => {
  assert.equal(detectInstallKind({ APPIMAGE: "/x.AppImage" }, LINUX_OPT, "linux", false), "dev");
  assert.equal(detectInstallKind({}, WIN_EXE, "win32", false), "dev");
});

test("linux sandbox and bundle markers win over the install path", () => {
  // AppImage mounts under /tmp but the env var is the real signal.
  assert.equal(
    detectInstallKind({ APPIMAGE: "/home/kaleb/odm.AppImage" }, "/tmp/.mount_odm/odm", "linux", true),
    "appimage",
  );
  // Flatpak and snap expose the binary under /usr inside the sandbox; the
  // env markers must take precedence over the "managed" path check.
  assert.equal(detectInstallKind({ FLATPAK_ID: "com.odm.Client" }, LINUX_USR, "linux", true), "flatpak");
  assert.equal(detectInstallKind({ SNAP: "/snap/odm/1" }, LINUX_USR, "linux", true), "snap");
});

test("package-manager territory (/usr, /opt) reads as managed", () => {
  assert.equal(detectInstallKind({}, LINUX_OPT, "linux", true), "managed");
  assert.equal(detectInstallKind({}, LINUX_USR, "linux", true), "managed");
});

test("a linux binary outside /usr and /opt is a portable unpack", () => {
  assert.equal(detectInstallKind({}, LINUX_HOME, "linux", true), "portable");
});

test("windows splits on the portable marker, defaulting to nsis", () => {
  assert.equal(
    detectInstallKind({ PORTABLE_EXECUTABLE_DIR: "C:\\odm" }, WIN_EXE, "win32", true),
    "portable",
  );
  assert.equal(detectInstallKind({}, WIN_EXE, "win32", true), "nsis");
});

test("macOS is its own kind regardless of path", () => {
  assert.equal(detectInstallKind({}, "/Applications/ODM.app/Contents/MacOS/ODM", "darwin", true), "mac");
});

test("version compare handles unequal lengths and non-numeric junk", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.0.1", "0.1.0"), true);
  assert.equal(isNewerVersion("garbage", "0.1.0"), false);
});

test("release tags read as bare versions, junk as nothing", () => {
  assert.equal(versionFromTag("v0.9.0"), "0.9.0");
  assert.equal(versionFromTag("0.9.0"), "0.9.0");
  assert.equal(versionFromTag("nightly"), "");
  assert.equal(versionFromTag(undefined), "");
});

test("an install that cannot self-update still learns about a newer GitHub release", async () => {
  const updater = new Updater("portable", "0.7.4", async () => "0.9.0");
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.latest, "0.9.0");
  assert.equal(status.canSelfUpdate, false);
  assert.match(status.instruction, /releases page/);
  assert.match(status.releasesUrl, /github\.com\/.*\/releases\/latest$/);
});

test("matching or missing releases read as up to date", async () => {
  const same = await new Updater("managed", "0.9.0", async () => "0.9.0").checkForUpdates();
  assert.equal(same.available, false);
  const none = await new Updater("managed", "0.9.0", async () => "").checkForUpdates();
  assert.equal(none.available, false);
  assert.equal(none.latest, "0.9.0");
});

test("the startup check hands the renderer the full status", async () => {
  const updater = new Updater("flatpak", "0.8.1", async () => "0.9.0", 0);
  const heard = new Promise((resolve) => updater.onStatus(() => resolve(updater.progress())));
  updater.checkOnStartup();
  const progress = await heard;
  assert.equal(progress.state, "available");
  assert.equal(progress.latest, "0.9.0");
  assert.equal(progress.status.canSelfUpdate, false);
  assert.match(progress.status.instruction, /flatpak bundle/);
});

test("fetchLatestReleaseVersion reads the tag and treats 404 as no release", async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.9.0" }) });
  assert.equal(await fetchLatestReleaseVersion(ok), "0.9.0");
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await fetchLatestReleaseVersion(missing), "");
  const broken = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchLatestReleaseVersion(broken), /503/);
});

// A stand-in for the machine: records what the updater asked it to do.
function fakeHost(overrides = {}) {
  const log = { opened: [], revealed: [], ran: [], relaunched: [] };
  const host = {
    format: "rpm",
    platform: "linux",
    arch: "x64",
    execPath: "/opt/Open Dungeon Master/open-dungeon-master-client",
    appImagePath: "",
    downloadsDir: () => "",
    open: async (file) => void log.opened.push(file),
    reveal: (file) => void log.revealed.push(file),
    has: async () => true,
    writable: async () => true,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return { code: 0, stderr: "" };
    },
    relaunch: (execPath) => void log.relaunched.push(execPath ?? ""),
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } }),
    ...overrides,
  };
  return { host, log };
}

async function tempFolder() {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return fsp.mkdtemp(path.join(os.tmpdir(), "odm-update-"));
}

test("packageAssetName picks the one release file an install updates from", async () => {
  const { packageAssetName } = await import("../dist/main/updater.js");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "rpm"), "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "deb"), "open-dungeon-master-client-0.12.1-amd64.deb");
  assert.equal(packageAssetName("0.12.1", "portable", "linux", "x64", ""), "open-dungeon-master-client-0.12.1-x64.tar.gz");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", "rpm"), "open-dungeon-master-client-0.12.1-x86_64.flatpak");
  // The zip unpacks into a bundle the app can swap in; the dmg would need mounting.
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "arm64", ""), "open-dungeon-master-client-0.12.1-arm64-mac.zip");
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "x64", ""), "open-dungeon-master-client-0.12.1-x64-mac.zip");
  // No package manager we know, a store install, another architecture: the app says where to go instead.
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", ""), "");
  assert.equal(packageAssetName("0.12.1", "snap", "linux", "x64", "rpm"), "");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "arm64", "deb"), "");
  assert.equal(packageAssetName("0.12.1", "portable", "win32", "x64", ""), "");
});

test("an rpm install downloads the package, installs it through pkexec and restarts", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const asked = [];
  const { host, log } = fakeHost({
    downloadsDir: () => folder,
    // dnf is there, so it wins over rpm.
    has: async (command) => ["pkexec", "dnf", "rpm"].includes(command),
    fetchImpl: async (url) => {
      asked.push(String(url));
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } });
    },
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.canSelfUpdate, false);
  assert.equal(status.canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.deepEqual(asked, ["https://github.com/Lebbitheplow/open-dungeon-master-client/releases/download/v0.12.1/open-dungeon-master-client-0.12.1-x86_64.rpm"]);
  assert.deepEqual(log.ran, [["pkexec", "dnf", "install", "-y", file]]);
  assert.deepEqual(log.relaunched, [""]);
  assert.deepEqual(log.opened, []);
  // The package is gone from Downloads once it is installed.
  assert.deepEqual(await fsp.readdir(folder), []);
  assert.equal(updater.progress().state, "ready");
  assert.match(updater.progress().message, /Restarting/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a deb install goes through apt-get without prompts", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    has: async (command) => ["pkexec", "apt-get", "dpkg"].includes(command),
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].slice(0, 5), ["pkexec", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install"]);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a closed password prompt keeps the package and says so; a failed install quotes the reason", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  let answer = { code: 126, stderr: "" };
  const { host, log } = fakeHost({
    downloadsDir: () => folder,
    run: async () => answer,
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /cancelled/);
  assert.equal(updater.progress().state, "error");
  assert.equal((await fsp.readdir(folder)).length, 1);
  assert.deepEqual(log.relaunched, []);
  answer = { code: 1, stderr: "Error: Transaction failed\nnothing provides libfoo\n" };
  await assert.rejects(() => updater.downloadAndInstall(), /nothing provides libfoo/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("without pkexec the package is handed to the system's installer", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({ downloadsDir: () => folder, has: async (command) => command === "dnf" });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.opened, [path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.rpm")]);
  assert.deepEqual(log.ran, []);
  assert.deepEqual(log.relaunched, []);
  assert.match(updater.progress().message, /installer/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a tar.gz install unpacks over itself and restarts, or reveals the archive when it cannot", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    execPath: "/home/kaleb/apps/odm/open-dungeon-master-client",
    downloadsDir: () => folder,
  });
  const updater = new Updater("portable", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x64.tar.gz");
  assert.deepEqual(log.ran, [["tar", "-xzf", file, "-C", "/home/kaleb/apps/odm", "--strip-components=1"]]);
  assert.deepEqual(log.relaunched, [""]);
  assert.equal(updater.progress().state, "ready");

  const readOnly = fakeHost({ format: "", execPath: host.execPath, downloadsDir: () => folder, writable: async () => false });
  const stuck = new Updater("portable", "0.12.0", async () => "0.12.1", 0, readOnly.host);
  await stuck.downloadAndInstall();
  assert.deepEqual(readOnly.log.ran, []);
  assert.deepEqual(readOnly.log.revealed, [file]);
  assert.match(stuck.progress().message, /Unpack it/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a Mac install swaps the bundle from the release zip", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const apps = path.join(folder, "Applications");
  const bundle = path.join(apps, "Open Dungeon Master.app");
  await fsp.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await fsp.writeFile(path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"), "old");
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "arm64",
    format: "",
    execPath: path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"),
    downloadsDir: () => folder,
    // ditto stands in: it drops a new bundle into the staging folder.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      const staging = args[args.length - 1];
      await fsp.mkdir(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS"), { recursive: true });
      await fsp.writeFile(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS", "Open Dungeon Master"), "new");
      return { code: 0, stderr: "" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const zip = path.join(folder, "open-dungeon-master-client-0.12.1-arm64-mac.zip");
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].slice(0, 4), ["ditto", "-x", "-k", zip]);
  assert.equal(await fsp.readFile(path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"), "utf8"), "new");
  // No staging folder or retired bundle left beside it.
  assert.deepEqual(await fsp.readdir(apps), ["Open Dungeon Master.app"]);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a flatpak bundle is handed to the software center", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({ format: "", downloadsDir: () => folder });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  assert.equal((await updater.checkForUpdates()).canDownload, true);
  await updater.downloadAndInstall();
  assert.deepEqual(log.opened, [path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.flatpak")]);
  assert.deepEqual(log.relaunched, []);
  assert.match(updater.progress().message, /software center/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("replaceAppImage keeps a renamed file's name and replaces a versioned one", async () => {
  const { replaceAppImage } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const renamed = path.join(folder, "odm.AppImage");
  await fsp.writeFile(renamed, "old");
  const fresh = path.join(folder, "pending", "open-dungeon-master-client-0.12.1-x86_64.AppImage");
  await fsp.mkdir(path.dirname(fresh), { recursive: true });
  await fsp.writeFile(fresh, "new");
  assert.equal(await replaceAppImage(renamed, fresh), renamed);
  assert.equal(await fsp.readFile(renamed, "utf8"), "new");
  assert.equal(((await fsp.stat(renamed)).mode & 0o111) !== 0, true);

  const versioned = path.join(folder, "open-dungeon-master-client-0.12.0-x86_64.AppImage");
  await fsp.writeFile(versioned, "old");
  await fsp.writeFile(fresh, "new");
  const destination = await replaceAppImage(versioned, fresh);
  assert.equal(destination, path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.AppImage"));
  assert.equal(await fsp.readFile(destination, "utf8"), "new");
  await assert.rejects(() => fsp.stat(versioned));
  await fsp.rm(folder, { recursive: true, force: true });
});

test("the startup check waits for the page and keeps its find for a late page", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0);
  let seen = null;
  updater.onStatus(() => {
    seen = updater.progress();
  });
  let pageReady;
  const ready = new Promise((resolve) => {
    pageReady = resolve;
  });
  updater.checkOnStartup(ready);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen, null);
  assert.equal(updater.lastFound(), null);
  pageReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.state, "available");
  assert.equal(updater.lastFound().latest, "0.12.1");
});

test("a failed package download leaves no partial file and says why", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    fetchImpl: async () => new Response("no", { status: 404 }),
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /404/);
  assert.equal(updater.progress().state, "error");
  assert.deepEqual(await fsp.readdir(folder), []);
  await fsp.rm(folder, { recursive: true, force: true });
});
