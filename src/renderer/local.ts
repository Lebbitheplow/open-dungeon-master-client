// The device world: entering it (which starts it), the first-run name and
// the account screens, and the share row that shows the world's public
// address and the switch for it.
import { backLink, formCard, intro, show } from "./chrome.js";
import { badge, button, copyText, el, input, spinner } from "./dom.js";
import { renderHome } from "./home.js";
import { renderLocalAi } from "./local-ai.js";
import { localPlayAt, refresh, state } from "./state.js";

// Opens the device world, starting it first when it sleeps. path is the
// page to land on ("" for the world's root).
export async function playLocal(btn: HTMLButtonElement | null, path = ""): Promise<void> {
  if (btn) btn.disabled = true;
  const result = await localPlayAt(state.joinIntent?.code, path);
  if (btn) btn.disabled = false;
  if (result.ok) {
    if (result.needsName) {
      // A fresh device world: who is playing comes first, then who narrates.
      renderLocalName();
      return;
    }
    if (result.firstSetup) {
      // The shell just created the local profile; the only choice worth a
      // screen is who tells the story.
      renderLocalAi();
      return;
    }
    state.joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    renderLocalAccount("login");
  } else {
    await refresh();
    renderHome();
  }
}

export function openLocal(path: string): Promise<void> {
  return playLocal(null, path);
}

// Sharing only means anything while the world runs, and it is a property
// of that world rather than a peer of it. Inviting players from a campaign
// lobby starts it too, so this row is the overview and the off switch more
// than the usual way in.
export function shareRow(): HTMLElement {
  const row = el("div", "hero-actions stacked share-row");
  const tunnel = state.tunnel;
  if (tunnel.state === "running") {
    row.append(badge("Shared online", true));
    row.append(el("span", "status-line", tunnel.url));
    const copy = button("secondary", "Copy link", () => {
      void copyText(tunnel.url).then((worked) => {
        copy.lastChild!.textContent = worked ? "Copied" : "Copy failed";
        setTimeout(() => (copy.lastChild!.textContent = "Copy link"), 1500);
      });
    }, "link");
    const stop = button("quiet", "Stop sharing", (btn) => {
      btn.disabled = true;
      void window.odm.shareStop();
    });
    row.append(copy, stop);
    return row;
  }
  if (tunnel.state === "starting") {
    row.append(spinner(), el("span", "status-line", "Opening a public address..."));
    return row;
  }
  const idle = state.local.lanOrigin
    ? `On your Wi-Fi at ${state.local.lanOrigin}. Share online, or invite players from a campaign lobby, and friends anywhere can join.`
    : "Friends can join from anywhere while the app runs. Inviting players from a campaign lobby shares it for you.";
  const line = el("span", "status-line", tunnel.state === "error" ? tunnel.error : idle);
  const start = button(
    "secondary",
    tunnel.state === "error" ? "Try sharing again" : "Share online",
    (btn) => {
      btn.disabled = true;
      void window.odm.shareStart().then(async (result) => {
        if (!result.ok) state.tunnel = { state: "error", url: "", mode: "", error: result.error };
        await refresh().catch(() => undefined);
        if (state.screenName === "home") renderHome();
      });
    },
    "globe",
  );
  row.append(line, start);
  return row;
}

export function renderLocalAccount(mode: "create" | "login"): void {
  state.screenName = "local-account";
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", mode === "login" ? state.local.username : "");
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  const error = el("p", "error");
  const submit = button("primary", mode === "create" ? "Create" : "Sign in");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(userLabel, passLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const credentials = { username: userField.value.trim(), password: passField.value };
    const call =
      mode === "create"
        ? window.odm.localCreateAccount(credentials)
        : window.odm.localLogin(credentials);
    void call.then((result) => {
      submit.disabled = false;
      if (!result.ok) {
        error.textContent = result.error;
        return;
      }
      state.local = result.status;
      if (mode === "create") {
        renderLocalAi();
      } else {
        void window.odm.localPlay(state.joinIntent?.code);
      }
    });
  });
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro(
      mode === "create" ? "Create your account" : "Sign in to your world",
      mode === "create"
        ? "This account lives only on this computer and becomes the world's owner."
        : "Use the account you created for offline play.",
    ),
    formCard(form),
  );
  (mode === "login" && state.local.username ? passField : userField).focus();
}

// First launch of a device world: the name the table will know the player
// by. The shell mints and keeps the password, so this is the whole form.
export function renderLocalName(): void {
  state.screenName = "local-name";
  const form = el("form");
  const [nameLabel, nameField] = input("Your name", "text");
  nameField.placeholder = "How the table will know you";
  nameField.autocomplete = "username";
  nameField.maxLength = 24;
  const error = el("p", "error");
  const submit = button("primary", "Start playing", undefined, "play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(nameLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm
      .localCreateAccount({ username: nameField.value.trim(), password: "" })
      .then((result) => {
        submit.disabled = false;
        if (!result.ok) {
          error.textContent = result.error;
          return;
        }
        state.local = result.status;
        renderLocalAi();
      });
  });
  show(
    "narrow",
    backLink("Home", () => void refresh().then(() => renderHome())),
    intro(
      "Name your adventurer",
      "Your world lives on this device. Pick the name friends will see at the table; letters, digits, _ and - only.",
    ),
    formCard(form, el("p", "hint center", "You can add a password later in the game's settings.")),
  );
  nameField.focus();
}
