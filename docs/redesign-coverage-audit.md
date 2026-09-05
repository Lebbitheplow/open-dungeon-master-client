# Redesign coverage audit

Audit of the mockup package against what the apps actually do today, so the new
look can be adopted without dropping features or showing controls a host or user
cannot use. Written 2026-09-04.

Sources:

- Mockups: `/NAS/Open Dungeon Master mobile redesign.zip` (Claude Design export).
  `ODM Mobile Directions.dc.html` holds the history (9 turns, 22 options, 1a to 9c).
  `ODM Prototype.dc.html` is the navigable build: 11 screens, three frames
  (Mobile 384x760, Foldable 880x660, Desktop 1180x720), three roles (Player, DM,
  Lead). `github.md` inside the zip is the designer's own screen-to-file map.
- Client shell: `src/renderer/app.ts` (14 screens), `mobile/src/*`, `src/main/*`.
- Server: `/home/lebbi/open-dungeon-master/src/app/*` (17 pages), `src/lib/capabilities.ts`,
  `src/lib/dm/viewer.ts` (roles), `src/lib/use-capabilities.ts` (client gates).

Legend for the tables: **Drawn** = a screen exists in the prototype or a
direction; **Pattern** = the directions name a reusable pattern but no screen;
**Missing** = nothing in the package.

## 1. Navigation model corrections

1. **Home is the landing screen, never sign-in.** The prototype boots on
   `signin`. The real order is: shell home (servers, device world) or the server
   dashboard. Sign-in appears only when: adding a new server, a stored session
   was rejected (`needsLogin`), a `/join/CODE` link targets a server without a
   session, or the device world lost its profile (`renderLocalAccount`).
2. **Two homes exist and the mockup merges them.** The shell's manager (servers,
   device world, tunnel, updater, Story AI setup) and the server dashboard
   (campaigns, workshop, join code) are separate pages today. Direction 2a puts
   campaigns from every host on one screen. That needs a new campaign-summary
   endpoint fetched per saved server with the stored token, a cached copy in the
   shell store for offline display, and a presence signal for "another player's
   app" hosts (broker last-seen or a health probe). Decide this before building
   the home; it is the single largest architectural item in the package.
3. **The drawer replaces the manager, not the account menu.** The mockup drawer
   holds hosts, add server, scan invite, account and settings. The server's
   `AccountMenu` (Characters, Friends, Settings, Admin, Help, Switch server,
   Log out) must survive inside server pages, and the shell drawer must also carry
   the shell-only entries listed in section 3.6.
4. **Lead tab is a design invention.** The real table has no Lead tab: lead tools
   are spread over the Party tab (invite block), Notes tab (approvals), the
   composer (Direct plus Private), and floor banners. Consolidating them into an
   amber "Lead" tab is fine but every item must be mapped (section 3.11).
5. **Roles are not three exclusive buckets.** `viewerCaps()` yields player, lead,
   dm (incl. co-DM), ai; plus owner and admin. A lead only steers the story when
   `dmMode === "ai"`; on human or assisted tables those powers move to the DM
   seat. The role switch in the prototype should be read as "capability sets",
   not seats.

## 2. Screens by form factor

| Screen | Mobile | Foldable | Desktop | Notes |
| --- | --- | --- | --- | --- |
| Sign in | Drawn | Drawn | Drawn | 9a, prototype |
| Home (host-aware) | Drawn | Drawn | Drawn | 2a, prototype; desktop rail |
| New campaign wizard | Drawn | Drawn | Drawn | 3a has 5 steps, prototype 3 |
| Character wizard | Drawn | Drawn | Drawn | 3b has 6 steps, prototype 4 |
| Workshop hub | Drawn | Drawn | Drawn | 4a |
| Workshop: Cast | Drawn | Drawn | Drawn | 4b; editor sheet not drawn |
| Workshop: Battle maps + editor | Drawn | Drawn | Drawn | 4c, 5b |
| Workshop: Region | Drawn | Drawn | Drawn | 6a |
| Workshop: Rules | Drawn | Drawn | Drawn | 6b |
| Workshop: Share | Drawn | Drawn | Drawn | 6c |
| Workshop: Storyboard, Encounters, Bestiary, Lore, Tables | Pattern | Pattern | Pattern | 5a says "fits 4b/4c" |
| Play table (player) | Drawn | Drawn | Drawn | 8a, 7a, 7b |
| Play table (DM console) | Drawn | Drawn | Drawn | 8b |
| Play table (lead) | Drawn | Drawn | Drawn | 8c |
| Voice menu | Drawn | Drawn | Drawn | sheet / dropdown / call bar |
| Character sheet modal | Drawn | Drawn | Drawn | prototype only |
| Invite and share | Drawn | Missing | Missing | 9b mobile only |
| Join via link | Drawn | Missing | Missing | 9c mobile only |
| Lobby | Missing | Missing | Missing | acknowledged unbuilt |
| Settings, Admin, Friends, Reference, Licenses/Terms/Privacy | Missing | Missing | Missing | |
| Characters library and character detail | Missing | Missing | Missing | quick tile has no target |
| Workshop shelf (list, new, import) | Missing | Missing | Missing | hub is one workshop |
| Shell: add server, error, device world states, Story AI setup, updater, BLE picker | Missing | Missing | Missing | shell-only |
| Table tabs: Map, Notes, Chat, Context, Setup | Missing | Missing | Missing | named in 7a rail only |

Foldable: the prototype treats the open fold as a tablet (the `isWide` branch)
with a painted crease. No layout is hinge-aware. Adopt that rule: open fold =
tablet layout, closed fold = phone, and keep the rail and bottom bar from
straddling the crease (test with the Android window-size classes; a posture API
is optional).

## 3. Screen-by-screen gaps

### 3.1 Sign in (9a, prototype)

Covered: username, password, log in / create account toggle, Discord button,
invite-code field on invite-only registration (locked when it came from a link),
temp-password reset step, TOS line. Gaps:

- Error banners from `?error=` (discord, signups_disabled, invite_required,
  invite_invalid) and inline validation copy.
- `signupMode === "closed"`: hide the create-account link, show "not accepting
  new accounts".
- Shell variant subtitle "{origin}, server {version}" and the join banner ("You
  were invited to a campaign, code X on host Y") above the form.
- Device world account screens: "Name your adventurer" (no password) and "Sign
  in to your world". These are not server sign-ins and should not look like one.
- Forced password change after an admin reset (`ForcedPasswordChange`).

### 3.2 Home (2a, prototype)

Covered: continue hero with source chip, quick tiles (New campaign, Characters,
Workshop), campaigns grouped by host with live dots, offline host dashed out,
hide-offline toggle, drawer with hosts, add server, scan invite, account. Gaps:

- Dashboard items with no home in the mockup: Solo adventure, Join with a room
  code input, campaign tile Export (HTML/ODT/DOCX), Duplicate (steersStory),
  Delete (owner), the `ended` status, NotificationBell, How to play, footer
  links.
- Cover art does not exist as a campaign field. Options: latest scene
  illustration, uploaded cover, or a themed placeholder. Any AI fill is gated on
  `images.configured`; upload must always be offered.
- Device world hero states: unavailable ("no offline world in this build"),
  error with Try again, first run ("Begin your world"), starting spinner,
  running with "Playing as X, server v". Plus the Story AI button (desktop and
  Android) and the share row (Shared online, Copy link, Stop sharing, LAN hint,
  Try sharing again).
- Server card actions: Forget, Connect, and the `needsLogin` path.
- Footer: version, Check for updates / Update to X (desktop, self-updating
  installs only), per-install-kind instructions, Ctrl+M hint.
- Presence semantics for "Dave's table": define what "online" means for a
  tunnel host and how long "last seen" is trusted.

### 3.3 New campaign wizard (3a, prototype)

3a is close to the real dialog; the prototype collapses it to three steps and
drops the assisted DM mode, world packs, and most toggles. Build from 3a and add:

- Solo adventure variant (no players count, no invite, needs story model).
- DM modes: ai, assisted ("You run it, with AI help"), human. Hide ai and
  assisted when `story.configured` is false and force human; warn when
  `story.reachable` is false.
- Pre-built world pack select (grouped by franchise, unofficial notice), hidden
  when no packs are installed.
- Toggles missing from the prototype: Sound follows the scene, Item offers,
  Romance (only when Bonds on), Outcome check, Mid-game joining, Held responses.
- Voice chat block: enabled, turn floor (ignored / shown / enforced),
  proximity, hearing range, whisper and shout, walls muffle, downed go deaf.
  Hide the block when the server reports `voice.enabled === false`.
- AI allies mode plus "party members at once" and "guests at once" caps.
- Bring in prep (content import picker) and World setup (starting lore drafts).
- Full variant rules set and rest variant (see 3.9), house rules text.
- Gates inside the wizard: Voice narration only when `tts.configured`; Maps only
  when `images.configured`; Length, AI story setup, Living world, Outcome check
  only when the AI narrates; Narrator voice only when narration is on.
- Cover art step is new scope (see 3.2).

### 3.4 Character wizard (3b, prototype)

Covered in 3b: name, role (PC / companion), level, background, alignment,
ancestry with racial picks, class, subclass, fighting style, class skills,
ability method, hit points, spells, equipment, portrait, backstory, feats,
derived stats. The prototype keeps four steps. Gaps:

- Gender, random-name seed chips, bonus languages, racial ASI/cantrip/tool
  choices, ASI-or-feat editor at qualifying levels, appearance text.
- Point-buy "N points left" readout and Roll all.
- Equipment: class kit versus roll for gold.
- In-campaign variants: create, `?mode=edit`, `?mode=replace`, level locked to
  the campaign, "changing your character clears your ready status".
- Portrait: "let the AI paint one" only when `images.configured`; upload always.
- Library actions around the wizard: import bundle, export bundle, PDF,
  duplicate, delete (all undrawn, see 3.12).

### 3.5 Workshop hub (4a) and shelf

Covered: target party bar, twelve system cards with counts (Party and Homebrew
joined the ten on 2026-09-05), help. Gaps:

- Shelf page: workshop list, New workshop form (name, party size, level),
  Import bundle, Duplicate, Delete.
- Hub header actions 5a promises but 4a does not show: rename (inline pencil),
  duplicate, delete, import a bundle.

### 3.6 Workshop systems

- **Cast (4b):** rows drawn; the editor sheet is not. Editor fields: name,
  attitude, location, aliases, first-notice line, personality sliders, three
  goals, relations, Save, Add/Replace face, Paint one, Set aside / Bring back,
  Duplicate, Forget. Gates: every Suggest button on `story.configured`; Paint
  one on `images.configured`.
- **Battle maps (4c, 5b):** complete for brushes, stamps, themes, ambient,
  backdrop sliders, tokens. Missing: generator hint input, Size fields, notes,
  seed readout, Keep the board, Open it as a scene (campaigns only), Duplicate,
  Forget, tooltips on long-press. Added on the server 2026-09-05 and not in
  the mockup: shape tools (line, rectangle, ellipse, fill) with drag preview,
  undo and redo, brush radius, lights with presets, labels, props, doors,
  light zones, ambience cues and a DM-only overlay image. Hotkeys are desktop
  only; on a phone the toolbox is the whole path, and every tool is a tap.
- **Region (6a):** prototype lacks Move a place, Party is in transit, Clear
  pins, Rename while holding, stranded-location warning. The AI "describe"
  authoring block below the map is gated on `story.configured`. Added on the
  server 2026-09-05: Draw a line (road, river, border, tapped point by point
  with Finish, Undo a point, Cancel and an optional name), Write a label
  (place or region size), Erase (lines, labels, pins), a picture in place of
  the tiles, Read an Azgaar map (one or more GeoJSON files, with a size
  pick), Save as PNG, and a size select on Roll a world. Pinch zoom and drag
  pan are unchanged. On phones the file pickers open the system chooser.
- **Party (new system, 2026-09-05):** the target party restated, the roster
  of pregens with a level mismatch chip, Add from the library (select),
  Build a new one (links to the character wizard), take off the roster.
- **Homebrew (new system, 2026-09-05):** items, spells, feats, backgrounds,
  species and subclasses, each started from a catalog pick, with a
  validator readout. Long forms; on phones they should open in a sheet.
- **Lore (server 2026-09-05):** visibility toggle (the table reads it, or
  only the DM), picture upload as a handout, markdown body with `[[links]]`
  that open the linked entry.
- **Tables (server 2026-09-05):** Draw without replacement checkbox with a
  reset showing the dealt count, `x3` weights and `@table`, `@monster`,
  `@item`, `@npc` rows, and a roll result that shows the chain.
- **Share (server 2026-09-05):** the import preview is a row of ticks, one
  per kind, and house rules are one of them.
- **Rules (6b):** missing Crit damage mods toggle, rule-section on/off and pin
  buttons, ruleset delete, Unsaved changes marker, read-only summary for
  non-authorities.
- **Share (6c):** complete; add the refusals and warnings result lists after a
  world pack compile.
- **Storyboard, Encounters, Bestiary, Lore, Tables:** no screens. Each has a
  bespoke editor (beat kinds and links, roster shorthand and CR budget, monster
  block with derived CR, lore entry with tags, table rows with coverage check
  and monster lookup). Tables' Draft row is gated on `story.configured`;
  Storyboard suggestions are deterministic and must not be hidden.

### 3.7 Play table, player (8a, 7a, 7b)

Covered: header with voice and dice, message list with rolls, Do / Say / OOC,
mic, bottom tabs, Party, Battle, Story. Gaps:

- Header controls: 3D dice toggle, narration audio (only when `ttsEnabled`),
  ambience audio (only when ambience is on and installed), Help, All campaigns.
- Above the composer: pending real-dice card, floor banners, story nudge, new
  adventurer banner, Ask dock, item proposal bar, utility call strip, DM cover
  notice, character gate (no sheet yet).
- Blocked-input states: opening narration playing, floor held, not your turn,
  spotlight elsewhere; OOC always allowed.
- Message actions: replay narration, lore check, pin memory; lead/DM only:
  renarrate, continue, variant take, edit, pin as fact.
- Tabs not drawn: Map (overworld plus scene map with upload and AI redraw),
  Notes (four sections), Chat (DM whisper plus side chat, unread badge),
  Context, Setup, and the Story sub-tabs (Chapters, Facts, Log) and Party
  sub-tabs (Roster, Bonds when relationships are on).
- Party card extras: portrait upload, Physical dice toggle, Dice sources
  (Pixels BLE), Save to library, Request or Build a companion.
- Battle: board controls (move, place, measure, point), enlarge, initiative
  panel. Battle tab only exists while a map is deployed.
- Level-up dialog, lore check dialog, renarrate dialog, image lightbox.

### 3.8 Play table, DM (8b)

Covered: floor control, waiting queue with "what should I press", rulings rail
with categories, Narrate / OOC composer, Context tab. Gaps:

- The real rail is Assist, Combat, Party, World, Social, Story, Table, Maps,
  Cast, Bestiary, Storyboard, Tables. The mockup's "Rolls / Loot" naming must
  map onto those categories.
- Beat composer, delegation panel (assisted mode: monsters, narration, cover),
  odds panel, NPC review, whisper panel, map studio.
- Adjudication forms (about 80 actions) open inline; the "Illustrate" action is
  hidden when `images.configured` is false.
- Co-DM: same console, but seat reassignment is primary-DM only.

### 3.9 Play table, lead (8c)

Covered: Direct composer with Private toggle and presets, give the floor,
open / hold, note approvals, invite code, mid-game joining, transfer lead. Gaps:

- Director presets are seven: Combat, Place, Social, Romance, Mystery, Weird,
  Windfall.
- Invite block also has copy link and a QR button; New code is a confirm.
- Transfer lead lives on a character's menu (Make party lead); Adjust stats
  and Dismiss companion sit beside it.
- Lead powers depend on `dmMode`: on human tables these belong to the DM seat.
  The amber Lead tab must render for whoever has `steersStory`, and the invite
  and edit-details block for `isLead` regardless.

### 3.10 Voice (all table screens)

Covered: join, mute, deafen, raise hand, settings, breakout rooms, per-peer
volume. Gaps:

- Say range select (Whisper / Normal / Shout) when proximity is on.
- Push-to-talk mode: Hold / Talking button and the backtick binding; Open mic
  versus Push to talk in settings.
- Force-muted, self-muted, speaking, connecting peer states; move-to-room per
  peer (steersStory); close room; Recall.
- Off state with reason ("server has voice off" versus "turn it on in campaign
  settings"), reconnecting and error lines, floor note under strict floor.
- Raise hand only shows when the floor blocks you and never for the DM seat.

### 3.11 Lead tab mapping

| Mockup item | Real control |
| --- | --- |
| Give the floor / spotlight picker | "Give the floor" adjudication (Story category) plus FloorBanners release |
| Open floor / Hold | FloorControl (DM console) |
| Notes to approve | NotesPanel "Suggestions awaiting you" |
| Invite code, copy, QR, New code | Party tab "New players" block, InviteShareDialog |
| Mid-game joining toggle | Same block, `joinOpen` |
| Transfer lead | CharacterMenu "Make party lead" |
| Direct + Private | Composer Direct pill, DirectorPresets, Private switch |

### 3.12 Undrawn pages that must get the new skin

- Lobby: room code card (hidden when solo), game settings, rules, lore, bring in
  prep, physical dice opt-in, voice panel, schedule, party list with DM / co-DM
  / lead / owner badges, make lead, make DM, make co-DM, ready state, companions
  (lead), action block per role, Begin the adventure (owner, gated on all ready
  with sheets), Delete this campaign (owner). Opening the lobby auto-starts the
  tunnel in a shell.
- Characters library and detail: import, new, portrait states, duplicate,
  delete, export bundle, PDF, story-so-far timeline.
- Settings: avatar crop, password or set a password, Discord link (only when
  Discord is available or already linked), admin shortcut, delete account
  (password, or type DELETE), about with server name and version.
- Admin: Server, Accounts (sign-up mode, invites), text and utility models,
  image backends, speech, voice chat, Discord; Campaign plugins; Users (reset
  password, delete).
- Friends, notification bell, reference (4 modes, 9 tabs), licenses, privacy,
  terms, and the three help dialogs.
- Shell-only: Add a server (address input, pasted invite link), error screen,
  Story AI chooser (human, OpenAI key, local model on desktop), hardware tier
  picker, install progress, ComfyUI offer, uninstall confirms, OpenAI key form,
  BLE picker window, Android QR scan errors, download shim toasts.

## 4. Gating matrix

Rule from the 2026-09 pre-release audit: hide, do not disable. A `null`
capabilities answer offers everything.

| Condition | Source | Hides or changes |
| --- | --- | --- |
| No story model | `capabilities.story.configured` | ai and assisted DM modes, Suggest, Draft, Describe, arc plotting, solo adventure |
| Story model unreachable | `story.reachable` | warning only |
| No image backend | `images.configured` | Maps toggle, Illustrate, Redraw map, Paint one, portrait generation, any AI cover art |
| No TTS | `tts.configured` | Voice narration toggle, narrator voice, narration audio control |
| No STT | `stt.configured` | push-to-talk transcription mic in the composer |
| Voice off on server | `voice.enabled` | whole voice UI shows the off state; wizard voice block |
| Voice mode mesh | `voice.mode` | no UI change; tunnel hosts are forced to mesh |
| Discord not configured | `/api/auth/providers.discord` | Discord sign-in, Settings Discord card (unless already linked) |
| Sign-ups invite / closed | `signupMode` | invite code field; create-account link replaced |
| No world packs | `/api/worlds` empty | world pack select |
| Ambience not installed | `ambience.installed` | ambience audio control |
| Campaign dmMode human | campaign | AI story setup, length, living world, outcome check, AI allies, Context moves to DM |
| Campaign dmMode assisted | campaign | delegation panel on the console |
| Solo campaign | `maxPlayers === 1` | invite, lobby room code, voice, schedule, players count |
| Campaign status | lobby / active / ended | lobby page versus table; ended tiles are read-only |
| Relationships off | game settings | Bonds sub-tab |
| No battle map deployed | session state | Battle tab |
| Dice policy digital | campaign | physical dice toggle, pending roll card |
| `caps.adjudicates` | seat | DM tab and console, board direction, initiative editing |
| `caps.secretStory` | seat and dmMode | Context tab |
| `steersStory` | seat and dmMode | Direct, floor release, approvals, facts and lore editing, message edits, breakout rooms, Setup panels, Adjust stats |
| `isLead` | seat | Edit details, invite block, New code, schedule editing, companions |
| owner | seat | Begin the adventure, Delete campaign, tile Delete |
| `user.isAdmin` | account | Admin panel entries |
| Platform android | shell | no local AI install, no updater, QR scan and back gesture present |
| Platform desktop | shell | local AI tiers, updater, BLE picker window, Ctrl+M |
| Plain browser (no `window.odmShell`) | shell | no Switch server, no Share online row, BLE needs the Chromium flag |
| Local world unavailable | shell `local.state` | device world hero replaced |
| Tunnel state | shell `tunnel.state` | share row and lobby Share online row |
| `share.supported` | shell | Share online only while the local world's page is on top |
| Self-updating install | `installKind` appimage or nsis | Update button versus instructions |

## 5. AI and no-AI campaigns

Two different questions, both must be handled:

1. **Does the server have AI?** Capabilities. Governs generation controls
   everywhere, including the workshop, and whether AI DM modes can be chosen.
2. **Does this campaign use an AI DM?** `dmMode`. Governs narrator settings,
   who holds `steersStory` and `secretStory`, whether the composer offers
   Narrate, and which stages and reminders appear in Setup.

Deterministic helpers must never be hidden as if they were AI: storyboard
suggestions, the encounter CR budget, bestiary rating math, the map generator,
table coverage checks, the Assist rail's rule lookup.

The device world adds a third source: the shell's Story AI choice (human,
OpenAI key, local model) writes the server's admin settings, so the same
capability gates apply once the world is running.

## 6. Carrying the design to the server app

The palette, Cinzel, glass panels, gold brackets and topo canvas are already
shared between the shells and the server. What the redesign changes on the
server side is structure, not tokens:

- Dashboard becomes the home-base layout (hero, quick tiles, grouped list).
  Inside a plain browser there is exactly one host, so the group header
  collapses.
- CreateCampaignDialog and CharacterBuilder become stepped wizards with a
  progress bar; keep every field, move power-user options to an Advanced step.
- Workshop tab row becomes the hub plus list and gallery patterns.
- SessionView gains the icon rail with a permanent context column on desktop,
  bottom tab bar on phones, voice as dropdown, sheet, or call bar.
- New shared primitives to add in `src/lib/ui.tsx`: bottom tab bar, slide-up
  sheet, wizard stepper, icon rail, drawer, host chip with status dot.
- The shell should inject the host list into server pages through
  `window.odmShell` rather than duplicating server chrome.

## 7. Suggested order of work

1. Decisions: the cross-host home (section 1.2), Lead tab consolidation, cover
   art source, whether the shell drawer or the server menu owns account items.
2. Shared primitives and tokens in the server, mirrored in `style.css`.
3. Server dashboard and the two wizards, with the gates in section 4.
4. Workshop hub, shelf, list and gallery patterns, then the five undrawn
   systems.
5. Play table rail, bottom bar, Lead tab, voice surfaces.
6. Undrawn pages: lobby first (the wizard lands there), then characters,
   settings, admin, friends, reference.
7. Shell: home with device world states, add server, sign-in reorder, Story AI
   flow, updater footer, error screen.
8. Foldable pass on every screen, then a gating pass on a no-AI host, an
   invite-only host, a human-DM table, a solo table, and a plain browser.

## 8. Build status (2026-09-04)

Decisions taken: cross-host home is built natively in the shells; the Lead
tab is built; cover art is AI painted or uploaded; servers keep their own
accounts and the shell's drawer owns only the on-device profile.

Built, uncommitted, in the server repo (tsc clean, lint at 11 preexisting
warnings, 152 test suites, production build passes):

- Lead tab (`src/lib/dm/table-tabs.ts`, LeadPanel, LeadFloorControl), with
  the invite block moved out of Party. Ember accent, pending-notes badge.
- Cover art: `cover_json` column, cover route (GET, PATCH upload, POST paint
  gated on images, DELETE), `CampaignCover` component, Edit details section,
  lobby header, dashboard tiles and hero. GET /api/campaigns adds `playingAs`.
- Join preview route (code scoped, throttled per address) feeding the 9c page.
- Shared primitives: Wizard, Sheet, IconRail, Drawer, HostChip, QuickTile,
  HeroCard, SegmentedControl, Ribbon, PageShell.
- Dashboard as home base with `?new=1` and `?new=solo`; campaign wizard in six
  steps; character wizard in six steps; library and detail restyle.
- Workshop shelf tiles, hub with counts and `?system=` views, Cast rows and
  battle-map gallery as opt-in layouts on the shared panels.
- Play table: vertical icon rail with permanent context column, extracted
  header, voice as a bottom sheet on phones, Only you and Lead only ribbons,
  lobby restyle with cover.
- Auth form, join page, settings, admin, friends, reference, licenses,
  privacy and terms on the PageShell.

Built, uncommitted, in the client repo (lint clean, 77 desktop and 63 Android
tests, Android www bundle builds):

- Home feed data layer on both shells (`src/shared/home-feed-logic.ts`,
  IPC `home:feed` and `home:feed-cached`, persisted cache, presence).
- Renderer split into modules; host-aware home with continue hero, quick
  tiles, grouped campaigns, hide-offline toggle, drawer and desktop rail.
- `connect` and `localPlay` accept a sanitized inner path
  (`src/shared/open-path.ts`) so the home lands on a campaign or page.

Workshop parity pass (2026-09-05), server repo, uncommitted, tsc and lint
clean, full suite green: everything in `docs/workshop-parity-audit.md`
section 6 (shape tools, undo, lights, homebrew editors, stat block extras,
scene layer, lore handouts and links, table weights and nesting, region
lines, labels, backdrop, Azgaar import, PNG export, pregens, Party card,
selective bundle import). All of it is web UI the shells already render;
the desktop app picks it up after a server commit and `npm run
bundle-server`, Android after the www bundle. Device testing of the new
tools on phones and foldables has not happened yet.

Payload trim (2026-09-05): the desktop and Android bundlers now share
`scripts/prune-server-payload.mjs`, which keeps only what the server reaches
at runtime. The repo's docs and plans, sources, scripts, workers, CI and
Docker files and agent notes no longer ship in any install.

Still open after this pass:

- Device testing: none of this has run on a phone or foldable; the desktop
  home was smoke-tested in Electron at phone, tablet and desktop widths.
- The desktop app only sees server changes after a server commit and
  `npm run bundle-server`.
- Workshop systems, second pass (same day): Storyboard board (cards, kind
  chips, link chips, leads-to counts, editor in a sheet, suggestions and
  compile as collapsible cards, right column on desktop); Lore rows (search,
  category chip, first line, tag chips, editor sheet, read-only sheet for
  non-leads); Encounters rows (roster summary, battlefield, map name,
  difficulty pill, CR budget bar with threshold ticks from the same encounter
  math the workbench uses, "How hard is this?" collapsible workbench, editor
  sheet that also edits saved fights via PATCH); Bestiary rows (CR pill, AC
  and HP, swings and Dex, rating marker, collapsible Build a monster, full
  editor in a full-height sheet with two columns on desktop); Tables rows
  (dN pill, row count, coverage badge, inline Roll, editor sheet that edits
  saved tables via PATCH, collapsible monster lookup in a right column). All
  opt-in `layout` props; the in-play DM console keeps its defaults.
- Voice: the desktop rail no longer wiggles the chat icon on unread (dot and
  badge remain). The header lost its small pixel tile by design.
- Files over 500 lines that predate this work were left as they were:
  AdminSettingsPanel, globals.css, db/campaigns.ts, db/core.ts, db/sheets.ts,
  and on the client ipc.ts and bridge.ts.
- Cover art placement in the shell's hero uses the absolute URL the host
  returns; a device world that changes port shows a stale cover until the
  next refresh.

Surfaces the mockup draws or implies that have not had a redesign pass yet,
in suggested order:

- Character sheet modal (prototype draws it: header stats, conditions, six
  ability tiles, saves, skills, hit dice and resource steppers, equipment,
  features, Download PDF, Adjust). `CharacterSheetDialog.tsx` has every
  control already; it needs the tile layout and a full-height sheet on phones.
- Invite and share dialog (9b): `InviteShareDialog.tsx` has QR, code, URL,
  copy link, copy code, Share, Share online and New code; restyle to 9b and
  add the foldable and desktop variants the mockup never drew.
- The `/j` invite interstitial (workers/j-redirector) and the PWA manifest
  still use the previous palette (`#181420`, system font); both should move to
  the night and gold tokens so a shared link looks like the app.
- In-play dialogs that never appear in the mockup but sit on redesigned
  screens: LevelUpDialog, LeadEditDialog, CharacterNotesDialog, LoreCheckDialog,
  RenarrateDialog, DiceSourcesDialog, CompanionBuilderDialog (pass a className
  to size the wizard inside its scroll area), and the three help dialogs.
  They use the theme tokens already; a pass with Ribbon headers and Sheet on
  phones would finish the set.
- DM adjudication forms (`DmActionForm.tsx`) on phones: the mockup suggests
  expanding a ruling as its own sheet.
- The shell's Bluetooth picker window and the Story AI screens were moved
  verbatim; they match the old skin, which is the same palette, but have not
  been re-laid-out for the drawer era.
- Device and foldable testing of everything above.
