// Remote servers: adding one, signing in or registering, connecting and
// forgetting, plus the error screen every flow falls back to. The
// behaviour here is unchanged from the single-file shell; only the frame
// around it moved.
import { backLink, formCard, intro, joinBanner, show } from "./chrome.js";
import { button, el, input } from "./dom.js";
import { renderHome } from "./home.js";
import { connectAt, refresh, state } from "./state.js";
import type { ServerProbe, ServerSummary } from "../shared/types";

export function renderError(message: string): void {
  state.screenName = "error";
  const card = formCard(el("h2", "", "Something went wrong"), el("p", "sub", message));
  card.append(button("secondary", "Back", () => void refresh().then(() => renderHome()), "arrowLeft"));
  show("narrow", intro("A snag on the road", ""), card);
}

export async function forgetServer(server: ServerSummary): Promise<void> {
  await window.odm.removeServer(server.id);
  await refresh();
  renderHome();
}

function longDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "the server's due date";
  return when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Deleting the player's account on one server, from the shell itself. The
// server keeps the rules (its grace period, whether a password is needed);
// this screen only asks, confirms, and tells the player what happens next.
export function renderDeleteAccount(server: ServerSummary): void {
  state.screenName = "delete-account";
  const name = server.name || server.origin;
  const form = el("form");
  const [passLabel, passField] = input("Your password", "password");
  passField.autocomplete = "current-password";
  const [confirmLabel, confirmField] = input('Type DELETE to confirm', "text");
  const error = el("p", "error");
  const submit = button("primary", "Delete my account", undefined, "trash");
  submit.type = "submit";
  submit.classList.add("block");
  submit.disabled = true;
  confirmField.addEventListener("input", () => {
    submit.disabled = confirmField.value.trim() !== "DELETE";
  });
  form.append(
    el(
      "p",
      "sub",
      `This deletes ${server.username} on ${name}: the campaigns you created there, your characters and your pictures. The server signs you out everywhere and erases the account after its grace period; signing in before then keeps it.`,
    ),
    passLabel,
    el("p", "hint", "Leave blank if you only ever sign in there with Discord."),
    confirmLabel,
    error,
    submit,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm
      .deleteAccount({ serverId: server.id, password: passField.value })
      .then(async (result) => {
        if (!result.ok) {
          submit.disabled = false;
          error.textContent = result.error;
          return;
        }
        await refresh();
        const { deletion } = result;
        const card = formCard(
          el("h2", "", deletion.purged ? "Account deleted" : "Deletion scheduled"),
          el(
            "p",
            "sub",
            deletion.purged
              ? `Your account on ${name} and everything it owned are gone.`
              : `${name} will erase your account on ${longDate(deletion.dueAt)}. You are signed out there. To keep it, sign in again before then and choose "Keep my account".`,
          ),
        );
        card.append(
          button("secondary", "Forget this server", () => void forgetServer(server), "close"),
          button("primary", "Home", () => renderHome(), "arrowLeft"),
        );
        show("narrow", intro(name, hostOfOrigin(server.origin)), card);
      });
  });
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro("Delete account", `${server.username} on ${name}`),
    formCard(form),
  );
  passField.focus();
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// path is the page to land on inside the server ("" for its root); see
// connectAt for how it travels today.
export async function connectServer(
  server: ServerSummary,
  btn: HTMLButtonElement,
  path = "",
): Promise<void> {
  btn.disabled = true;
  const result = await connectAt(server.id, state.joinIntent?.code, path);
  btn.disabled = false;
  if (result.ok) {
    state.joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    await signInTo(server.origin, server.username);
    return;
  }
  renderError(result.error);
}

// The sign-in screen for a known server, reached from a lapsed session or
// the home screen's Sign in button.
export async function signInTo(origin: string, username: string): Promise<void> {
  const probed = await window.odm.probeServer(origin);
  if (probed.ok) renderAuth(probed.probe, "login", username);
  else renderError(probed.error);
}

export async function scanInvite(btn: HTMLButtonElement, detail?: HTMLElement): Promise<void> {
  const scan = window.odm.scanInvite;
  if (!scan) return;
  btn.disabled = true;
  const result = await scan();
  btn.disabled = false;
  if (!result.ok) {
    if (detail) detail.textContent = result.error;
    else renderError(result.error);
  }
}

export function renderAdd(prefill: string): void {
  state.screenName = "add";
  const form = el("form");
  const [originLabel, originField] = input("Server address or invite link", "text", prefill);
  originField.placeholder = "play.example.com or http://192.168.1.50:3005";
  originField.inputMode = "url";
  const error = el("p", "error");
  const submit = button("primary", "Continue");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(originLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void (async () => {
      // A pasted invite link takes the exact deep-link path: auto-connect on
      // a known server, or a join-request event that re-renders this screen
      // with the banner and the origin filled in.
      if (await window.odm.openInviteLink(originField.value)) return;
      const result = await window.odm.probeServer(originField.value);
      submit.disabled = false;
      if (result.ok) {
        renderAuth(result.probe, "login", "");
      } else {
        error.textContent = result.error;
      }
    })();
  });
  const hint = el("p", "hint center", "An invite link or QR link pasted here works too.");
  const card = formCard(form, hint);
  // Where there is a camera: the server's own corner QR button shows its
  // address as a code, and an invite QR carries a room code as well. Both
  // land in the same flow as a paste.
  if (window.odm.scanInvite) {
    const scan = button("secondary", "Scan a QR code", (btn) => void scanInvite(btn, error), "qr");
    scan.classList.add("block");
    card.append(scan);
  }
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro("Add a server", "Where does your party gather?"),
    joinBanner(),
    card,
  );
  originField.focus();
}

function authTabs(
  probe: ServerProbe,
  active: "login" | "register",
  username: string,
): HTMLElement | null {
  if (probe.signupMode === "closed") return null;
  const tabs = el("div", "tabs");
  const loginTab = el("button", active === "login" ? "active" : "", "Sign in");
  loginTab.type = "button";
  const registerTab = el("button", active === "register" ? "active" : "", "Create account");
  registerTab.type = "button";
  loginTab.addEventListener("click", () => renderAuth(probe, "login", username));
  registerTab.addEventListener("click", () => renderAuth(probe, "register", username));
  tabs.append(loginTab, registerTab);
  return tabs;
}

export function renderAuth(
  probe: ServerProbe,
  mode: "login" | "register",
  presetUsername: string,
): void {
  state.screenName = "auth";
  const name = probe.serverName || new URL(probe.origin).host;
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", presetUsername);
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  form.append(userLabel, passLabel);
  let inviteField: HTMLInputElement | null = null;
  if (mode === "register" && probe.signupMode === "invite") {
    const [inviteLabel, field] = input("Account invite code", "text");
    field.placeholder = "ODM-XXXXXXXXXX";
    inviteField = field;
    form.append(inviteLabel);
    form.append(el("p", "hint", "This server is invite-only. Ask whoever runs it for a code."));
  }
  const error = el("p", "error");
  const submit = button("primary", mode === "login" ? "Sign in" : "Create account");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(error, submit);
  const landed = async (): Promise<void> => {
    state.joinIntent = null;
    await refresh();
    renderHome();
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const shared = {
      origin: probe.origin,
      username: userField.value.trim(),
      password: passField.value,
      joinCode: state.joinIntent?.code,
    };
    const call =
      mode === "login"
        ? window.odm.login(shared)
        : window.odm.register({ ...shared, inviteCode: inviteField?.value.trim() ?? "" });
    void call.then(async (result) => {
      submit.disabled = false;
      if (result.ok) await landed();
      else error.textContent = result.error;
    });
  });
  // Discord first when the server offers it: one tap, no password to
  // remember, and a brand-new account is created on the way if signups are
  // open. The password form stays underneath for everyone else.
  const leading: (HTMLElement | null)[] = [];
  if (probe.discord) {
    const discord = button(
      "secondary",
      "Sign in with Discord",
      (btn) => {
        btn.disabled = true;
        error.textContent = "";
        void window.odm
          .discordLogin({ origin: probe.origin, joinCode: state.joinIntent?.code })
          .then(async (result) => {
            btn.disabled = false;
            if (result.ok) await landed();
            else error.textContent = result.error;
          });
      },
      "discord",
    );
    discord.classList.add("block");
    leading.push(discord, el("div", "divider", "or with a password"));
  }
  const notes: HTMLElement[] = [];
  if (probe.signupMode === "closed" && mode === "login") {
    notes.push(el("p", "hint center", "This server is not accepting new accounts."));
  }
  const subtitle = `${probe.origin}${probe.version ? `, server ${probe.version}` : ""}`;
  show(
    "narrow",
    backLink("Back", () => renderAdd(probe.origin)),
    intro(name, subtitle),
    joinBanner(),
    formCard(...leading, authTabs(probe, mode, presetUsername), form, ...notes),
  );
  (presetUsername ? passField : userField).focus();
}
