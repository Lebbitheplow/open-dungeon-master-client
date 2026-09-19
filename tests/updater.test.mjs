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
  assert.match(progress.status.instruction, /flatpak update/);
});

test("fetchLatestReleaseVersion reads the tag and treats 404 as no release", async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.9.0" }) });
  assert.equal(await fetchLatestReleaseVersion(ok), "0.9.0");
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await fetchLatestReleaseVersion(missing), "");
  const broken = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchLatestReleaseVersion(broken), /503/);
});

test("packageAssetName picks the one release file an install updates from", async () => {
  const { packageAssetName } = await import("../dist/main/updater.js");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "rpm"), "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "deb"), "open-dungeon-master-client-0.12.1-amd64.deb");
  assert.equal(packageAssetName("0.12.1", "portable", "linux", "x64", ""), "open-dungeon-master-client-0.12.1-x64.tar.gz");
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "arm64", ""), "open-dungeon-master-client-0.12.1-arm64-mac.dmg");
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "x64", ""), "open-dungeon-master-client-0.12.1-x64-mac.dmg");
  // No package manager we know, a store install, another architecture: the app says where to go instead.
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", ""), "");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", "rpm"), "");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "arm64", "deb"), "");
  assert.equal(packageAssetName("0.12.1", "portable", "win32", "x64", ""), "");
});

test("a package install downloads its file and hands it to the system", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "odm-update-"));
  const opened = [];
  const asked = [];
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, {
    format: "rpm",
    platform: "linux",
    arch: "x64",
    downloadsDir: () => folder,
    open: async (file) => void opened.push(file),
    reveal: () => undefined,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } });
    },
  });
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.canSelfUpdate, false);
  assert.equal(status.canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.deepEqual(asked, ["https://github.com/Lebbitheplow/open-dungeon-master-client/releases/download/v0.12.1/open-dungeon-master-client-0.12.1-x86_64.rpm"]);
  assert.deepEqual(opened, [file]);
  assert.equal((await fsp.readFile(file)).length, 4);
  assert.equal(updater.progress().state, "ready");
  assert.match(updater.progress().message, /installer/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a failed package download leaves no partial file and says why", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "odm-update-"));
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, {
    format: "deb",
    platform: "linux",
    arch: "x64",
    downloadsDir: () => folder,
    open: async () => undefined,
    reveal: () => undefined,
    fetchImpl: async () => new Response("no", { status: 404 }),
  });
  await assert.rejects(() => updater.downloadAndInstall(), /404/);
  assert.equal(updater.progress().state, "error");
  assert.deepEqual(await fsp.readdir(folder), []);
  await fsp.rm(folder, { recursive: true, force: true });
});
