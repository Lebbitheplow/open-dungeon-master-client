// The user guide: what each part of the shell is for and how to get around,
// in one scrollable screen, with the guided tour a tap away. Reachable
// from the topbar on every screen and from Settings.
import { backLink, intro, show } from "./chrome.js";
import { button, chip, el } from "./dom.js";
import type { IconName } from "./dom.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { isAndroid, refresh, state } from "./state.js";
import { startAppTour } from "./tour.js";

function section(iconName: IconName, title: string, ...paragraphs: string[]): HTMLElement {
  const card = el("section", "panel ornate grain guide-section");
  const head = el("div", "guide-head");
  head.append(chip(iconName), el("h3", "", title));
  card.append(head);
  for (const text of paragraphs) card.append(el("p", "", text));
  return card;
}

export function renderHelp(): void {
  state.screenName = "help";
  const device = isAndroid ? "phone" : "computer";
  const wayBack = isAndroid
    ? "On Android, the back gesture at a page's root closes that world too."
    : "On desktop, Ctrl+M brings you back from anywhere.";
  const scan = window.odm.scanInvite
    ? " Scan a QR code with the camera: a friend's invite, or the address code a server shows in its corner."
    : " An invite's QR code carries the same link; on a phone the app scans it.";
  const localAi = isAndroid
    ? ""
    : " On a desktop with a capable GPU, Story AI can also install a local model so nothing leaves your machine.";

  const actions = el("div", "guide-actions");
  actions.append(
    button("primary", "Replay the app tour", () => void refresh().then(() => {
      renderHome();
      startAppTour();
    }), "play"),
    button("secondary", "Settings", () => renderSettings(), "gear"),
  );

  show(
    "mid",
    backLink("Home", () => renderHome()),
    intro("User guide", "Where everything lives, and how to get around."),
    actions,
    section(
      "menu",
      "Getting around",
      `The menu (the three lines, or the rail on a wide window) lists your hosts and every door: adding a server, invites, Story AI, Settings and this guide. Tap the wordmark on any screen to return home.`,
      `Inside a world, open the account menu and choose App home to come back here. ${wayBack}`,
    ),
    section(
      "server",
      "Servers and invites",
      `Add a server by its address. Each server keeps its own accounts, so you sign in (or create an account) there; the app remembers the session and opens the server with one tap from then on.`,
      `An invite from a friend is a link or an eight-character room code. Paste either into Add a server and the app takes you straight to that table.${scan}`,
      `To leave a server behind, use the small buttons beside it in the menu: forget it on this device, or delete your account there for good.`,
      `When you enter a host, the app draws the screens itself and only game data travels to that server, so the controls are the same everywhere and a shared world costs less traffic. Hosts running an older server open their own pages instead. Settings has the switch.`,
    ),
    section(
      isAndroid ? "globe" : "monitor",
      `Your world on this ${device}`,
      `The app can host a world itself: no server needed. Enter it from the home screen and it wakes up; close the app and it sleeps. Your campaigns, characters and pictures stay on this ${device}.`,
      `Friends on the same Wi-Fi can join at the address shown in Settings. Share online and the app opens a public address so friends anywhere can join while the app runs. Copy the address, send it through your phone's share sheet, or show its QR code for a camera to scan.`,
    ),
    section(
      "sparkles",
      "AI narration",
      `Story AI decides who narrates the world on this ${device}: a human at the table, or an AI Dungeon Master billed to your own OpenAI API key.${localAi}`,
      `To play with an AI Dungeon Master on someone else's server, connect to a server that has AI enabled; its admin sets that up. Campaigns run by a human Dungeon Master work everywhere.`,
    ),
    section(
      "wand",
      "Workshop, characters, campaigns",
      `The quick tiles on the home screen open the pages you use most on whichever host you were last in. New campaign starts an adventure: pick a genre or a world pack, decide who narrates, and share the room code. Characters holds your adventurers and the creation wizard. The Workshop is the Dungeon Master's prep bench: maps, monsters, NPCs, lore and handouts.`,
    ),
    section(
      "play",
      "At the table",
      `Once you are in a campaign, the Help button in its header explains every control, and offers guided tours of the table: one for players and one for the Dungeon Master's console. Each runs once on its own and can be replayed from Help.`,
      `The dice button in the campaign header turns the 3D dice on or off; when on, every roll the server makes tumbles across the screen before the result lands in the chat.`,
    ),
    section(
      "gear",
      "Settings",
      `Settings gathers what belongs to the app itself: updates, sharing your world, Story AI, the hide-offline switch for the home screen, and the tour. Your account, avatar and password live on each server, under its own Settings page.`,
    ),
  );
}
