// The shell UI's entry point: mounts the frame, wires the bridge's events
// to the screens, and paints the home. The screens themselves live in the
// sibling modules; all privileged work happens across window.odm.
import { mountShell } from "./chrome.js";
import { closeDrawer, createDrawer, isDrawerOpen } from "./drawer.js";
import { renderHome } from "./home.js";
import { aiProgress } from "./local-ai.js";
import { renderAdd, renderAuth } from "./servers.js";
import { refresh, refreshFeed, state } from "./state.js";

const { drawer, scrim } = createDrawer();
mountShell(drawer, scrim);

function goHome(): void {
  void refresh().then(() => renderHome());
}

function rerenderHome(): void {
  if (state.screenName === "home") renderHome();
}

window.odm.onEvent((event) => {
  if (event.kind === "show-manager") {
    goHome();
    void refreshFeed();
  } else if (event.kind === "back") {
    // Android's back gesture: an open drawer closes first, any inner screen
    // returns home, and home leaves the app, the way a root screen should.
    if (isDrawerOpen()) closeDrawer();
    else if (state.screenName === "home") void window.odm.leaveApp?.();
    else goHome();
  } else if (event.kind === "local-status") {
    state.local = event.status;
    rerenderHome();
  } else if (event.kind === "tunnel-status") {
    state.tunnel = event.status;
    rerenderHome();
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
    rerenderHome();
  } else if (event.kind === "join-request") {
    state.joinIntent = { origin: event.origin, code: event.code, knownServerId: event.knownServerId };
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
      // A scanned server address (no room code) skips the address form: the
      // address is already known, so go straight to that server's sign-in,
      // and fall back to the form only when the server does not answer.
      if (!event.code) {
        void window.odm.probeServer(event.origin).then((probed) => {
          if (probed.ok) renderAuth(probed.probe, "login", "");
          else renderAdd(event.origin);
        });
        return;
      }
      renderAdd(event.origin);
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
});
