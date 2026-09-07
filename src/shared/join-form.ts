// What the sign-in screen offers, decided in one place so it can be tested
// without a browser.
//
// The rule is who is hosting, not how the player arrived. A world one of
// the apps is hosting has no password anyone could type: the app makes one
// up and keeps it, so asking for one is a dead end, and its guests are not
// gated. A server someone runs keeps passwords and whatever signup rule its
// owner chose, and the app follows it.
import type { SignupMode } from "./types";

export interface JoinFormShape {
  // A password box for the player to fill in.
  password: boolean;
  // The server's own account invite code (never a campaign room code).
  accountInvite: boolean;
  // Sign in / Create account tabs.
  tabs: boolean;
  submit: string;
}

export function joinFormShape(input: {
  deviceWorld: boolean;
  signupMode: SignupMode;
  mode: "login" | "register";
  hasRoomCode: boolean;
}): JoinFormShape {
  if (input.deviceWorld) {
    return { password: false, accountInvite: false, tabs: false, submit: "Join the table" };
  }
  const tabs = input.signupMode !== "closed";
  if (input.mode === "login") {
    return { password: true, accountInvite: false, tabs, submit: "Sign in" };
  }
  return {
    password: true,
    // A live room code vouches for a signup on an invite-only server, so
    // someone who arrived with one is not asked for an account code too.
    accountInvite: input.signupMode === "invite" && !input.hasRoomCode,
    tabs,
    submit: "Create account",
  };
}
