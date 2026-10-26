import type { CapacitorConfig } from "@capacitor/cli";

const NIGHT = "#0a0817";

const config: CapacitorConfig = {
  appId: "com.opendungeonmaster.app",
  appName: "Open Dungeon Master",
  webDir: "www",
  backgroundColor: NIGHT,
  android: {
    backgroundColor: NIGHT,
    // The app draws edge to edge on every Android version (MainActivity
    // enables it; Android 15+ would anyway) and the WebView cannot see the
    // system bars (no safe-area env values), so MainActivity keeps the page
    // between the status bar and the navigation bar, and above the keyboard
    // while it is up; the window background behind the bars is the same
    // night color (styles.xml). Capacitor's own margins count only the bars,
    // so they are off: with them the keyboard covered the page's fields.
    adjustMarginsForEdgeToEdge: "disable",
    // The app's pages are https://localhost and a self-hosted server on a LAN
    // is plain http (the manifest allows cleartext for the same reason). The
    // app's own game screens ask that server for everything from this page,
    // and without this the WebView blocks all of it as mixed content: the
    // API calls and every picture ("requested an insecure image"). The web
    // view fallback never hit this, because there the page IS the server's.
    allowMixedContent: true,
  },
};

export default config;
