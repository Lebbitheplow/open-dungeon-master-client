import assert from "node:assert/strict";
import test from "node:test";
import { detectInstallKind, isNewerVersion } from "../dist/main/updater.js";

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
