import type { CapacitorConfig } from "@capacitor/cli";

const NIGHT = "#0a0817";

const config: CapacitorConfig = {
  appId: "com.opendungeonmaster.app",
  appName: "Open Dungeon Master",
  webDir: "www",
  backgroundColor: NIGHT,
  android: {
    backgroundColor: NIGHT,
    // Android 15 draws apps edge to edge and the WebView cannot see the
    // system bars (no safe-area env values), so Capacitor keeps the manager
    // page between the status bar and the navigation bar; the window
    // background behind the bars is the same night color (styles.xml).
    adjustMarginsForEdgeToEdge: "force",
  },
};

export default config;
