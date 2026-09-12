// The shell UI's entry point: mounts the frame, wires the bridge's events
// to the screens, and paints the home. The screens themselves live in the
// sibling modules; all privileged work happens across window.odm.
import { closeOverlay, mountShell } from "./chrome.js";
import { closeDrawer, createDrawer, isDrawerOpen } from "./drawer.js";
import { renderHome } from "./home.js";
import { aiProgress } from "./local-ai.js";
import { renderAdd, renderAuth } from "./servers.js";
import { gameBack, isGameShowing, preloadGame } from "./game-screen.js";
import { renderSettings } from "./settings.js";
import { refresh, refreshFeed, state, tunnelWatchers } from "./state.js";
import { endTour, isTourActive, maybeStartAppTour } from "./tour.js";

const { drawer, scrim } = createDrawer();
mountShell(drawer, scrim);

function goHome(): void {
  void refresh().then(() => renderHome());
}

function rerenderHome(): void {
  if (state.screenName === "home") renderHome();
}

// Screens that show live status (the device world, the tunnel) repaint in
// place when it changes; the others keep what they have.
function rerenderLive(): void {
  if (state.screenName === "home") renderHome();
  else if (state.screenName === "settings") renderSettings();
}

window.odm.onEvent((event) => {
  if (event.kind === "show-manager") {
    goHome();
    void refreshFeed();
  } else if (event.kind === "back") {
    // Android's back gesture: a running tour ends first, then an open
    // drawer closes, any inner screen returns home, and home leaves the
    // app, the way a root screen should.
    if (isTourActive()) endTour();
    else if (isDrawerOpen()) closeDrawer();
    else if (closeOverlay()) return;
    else if (isGameShowing() && gameBack()) return;
    else if (state.screenName === "home") void window.odm.leaveApp?.();
    else goHome();
  } else if (event.kind === "local-status") {
    state.local = event.status;
    rerenderLive();
  } else if (event.kind === "tunnel-status") {
    state.tunnel = event.status;
    for (const watcher of tunnelWatchers) watcher();
    rerenderLive();
  } else if (event.kind === "home-feed") {
    state.feed = event.feed;
    rerenderHome();
  } else if (event.kind === "local-ai-progress") {
    const installing =
      state.screenName === "local-ai-install" || state.screenName === "local-ai-comfy-install";
    const bar = aiProgress.current;
    if (installing && bar && event.status.progress) {
      bar.fill.style.width = `${event.status.progress.percent}%`;
      bar.label.textContent = `${event.status.progress.label} (${event.status.progress.percent}%)`;
    }
  } else if (event.kind === "update-progress") {
    const progress = event.progress;
    if (progress.state === "available") {
      // The background check found something; the button click fills in the
      // full status (can this install self-update, which instruction).
      state.updateNote = `Version ${progress.latest} is available.`;
    } else if (progress.state === "downloading") {
      state.updateNote = `Downloading update... ${progress.percent}%`;
    } else if (progress.state === "ready") {
      state.updateNote = "Restarting to install the update...";
    } else if (progress.state === "error") {
      state.updateNote = progress.error;
    }
    rerenderLive();
  } else if (event.kind === "join-request") {
    // A second pass at the same server (the address alone, once the code
    // has already brought us here) must not wipe the code: it is the whole
    // invitation, and losing it is what made a joiner meet "this server
    // needs an invite code" straight after typing one.
    const carried =
      !event.code && state.joinIntent?.origin === event.origin ? state.joinIntent.code : event.code;
    state.joinIntent = {
      origin: event.origin,
      code: carried,
      knownServerId: event.knownServerId,
    };
    void refresh().then(() => {
      if (event.knownServerId) {
        const known = state.servers.find((server) => server.id === event.knownServerId);
        if (known) {
          void window.odm.probeServer(known.origin).then((probed) => {
            if (probed.ok) renderAuth(probed.probe, "login", known.username);
            else renderHome();
          });
          return;
        }
      }
      // The address is known either way, so nobody is sent back to the
      // form to type it again. A world an app is hosting opens on joining,
      // since there is no account to sign in to yet and no password to
      // have; a server someone runs opens on sign-in, where a returning
      // player belongs, with Create account one tap away.
      void window.odm.probeServer(event.origin).then((probed) => {
        if (!probed.ok) {
          renderAdd(event.origin);
          return;
        }
        renderAuth(probed.probe, probed.probe.deviceWorld ? "register" : "login", "");
      });
    });
  }
});

void window.odm.appInfo().then((info) => {
  state.appInfo = info;
  rerenderHome();
});

// The remembered feed paints at once; the fresh one lands as a home-feed
// event once every host has answered.
void window.odm
  .homeFeedCached()
  .then((feed) => {
    state.feed = feed;
    rerenderHome();
  })
  .catch(() => undefined);
void refresh().then(() => {
  renderHome();
  void refreshFeed();
  maybeStartAppTour();
  // Once the home screen is up, the game bundle loads in the background so
  // entering a world does not start with a blank page.
  setTimeout(preloadGame, 1000);
});
