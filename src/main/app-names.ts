// The app was Open Dungeon Master until October 2026, and installs from
// before the rename still carry that name's identifiers. A build knows both
// so it can update those installs, and move a flatpak across to the new id
// (updater.ts flatpakMoveCommand). The LEGACY_ ones go, with the release
// files published under the old names (release.yml), once those installs
// have moved.
export const APP_ID = "com.opengamemaster.client";
export const LEGACY_APP_ID = "com.opendungeonmaster.client";
// The package name (package.json): every release file's name starts with
// it, and it names the Linux program.
export const PACKAGE_NAME = "open-game-master-client";
export const LEGACY_PACKAGE_NAME = "open-dungeon-master-client";
