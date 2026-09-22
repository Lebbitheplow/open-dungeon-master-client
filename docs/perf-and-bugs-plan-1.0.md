# Performance and bug plan before 1.0.0

Written 2026-09-21 from three read-only audits (Android native layer, app shell renderer, game pages in the server repo) plus spot checks. Nothing here has been run on a real phone yet. Line numbers are from client 0.13.0 (`78964c3`) and server 0.22.0 (`82463c5`); re-read each file before editing, since lines drift.

Verified 2026-09-22 against the same commits, one read-only pass per section. Every claim was traced in code. Outright errors are corrected inline below; additions and downgrades sit in a "Verified" block at the end of each section. Summary of the pass:
- Framework questions from the original ask: the Android WebView already runs hardware accelerated (no manifest override, target SDK 36), Electron sets no GPU-disabling switches, and both game bundles are minified. There is no framework or GPU switch left to flip; the wins are in the items below.
- The React Compiler is not enabled in the server's Next build or in the client's esbuild/Preact bundle (only the compiler's lint rules run, via `eslint-plugin-react-hooks` 7). Every "new function every render" claim in section B is therefore real, and manual `memo`/`useMemo` is the only lever.
- Section C has one structural miss: `scripts/bundle-server.mjs:93` copies the server's whole `public/` into the payload, and the vendored copy on disk is still 0.17.0 from before the art landed (server commit `6998905`, 2026-09-18). The next payload rebuild ships about 45 MB of built-in art inside both apps by itself. C1 as written would ship it a second time.
- Dropped as non-issues: BoardFx (D1), `toBlob` being synchronous (D4), the `shareStart` IOException gap having any live effect (A10), and E9 today (the colliding keyframes are value-identical).

Kaleb's decision, 2026-09-22 evening: nothing visible may be reduced. Every animation and effect stays on for every device and every connected player. Reverted accordingly: dice shadows stay on for touch devices (D5), the contour background keeps animating under the table on the website (D2 server half not done), and every route change crossfades, query-only changes included (D3 keeps only the scoped snapshot, which does not change the look). Do not re-propose these three.

Implemented 2026-09-22, uncommitted in both repos. Everything above is done except the three reverted items and: campaign_events pruning (D6, skipped: a reconnect with an old Last-Event-ID would silently miss pruned rows; safe only once the events route detects a gap below the oldest retained seq and forces a snapshot), the `0.0.0.0` bind and LAN foreground service (A10, Kaleb's call), the real `public/` backfill of picture variants (`scripts/backfill-image-variants.mjs`, about a minute, waiting for a go), and payload art duplication (C1 ships about 32 MB of art next to the game bundle on both platforms while the server payload carries the same art; resolve with payload pruning later). Verified: both repos' full suites, lint and typecheck; headless Electron against the modified server (host home, table over the live stream, painted board, `?w=` variants, remount without re-download, pixel comparisons of the shell and the campaign wizard); Android emulator drive of the plugin (stop during start answers in about 100 ms, cloudflared and Node crash events, notification Stop action, no ANR). Not verified: a real phone, a tunnel, WebView older than 120, a streaming AI DM turn against the draft store, real dice hardware, iOS media Range playback.

Repos:
- Client (Electron + Capacitor shells): `/home/lebbi/open-dungeon-master-client`
- Server (Next.js, whose page components the client bundles with Preact shims): `/home/lebbi/open-dungeon-master`

## Rules that apply to every item

- Do not push, tag, or release anything unless Kaleb asks. When he does, push server main before any client tag, because release.yml builds the game bundle and the phone payload from server main.
- Never point the app at dungeon.lebbi.org.
- The app's game screens are the app's own bundled code talking to the host over the API. New behaviour goes in the server page components (shared by web and apps) or the client runtime/shims (`src/renderer/game/`), never in copies of server pages. Do not propose moving the shell into the web UI.
- The shell's contour backdrop (`topo.ts`) keeps animating on every shell screen where it is visible. Kaleb objected to pausing it off home. Only a running world may stop it.
- Kaleb chose not to do these now: "make low effects turn on for phones" and "stop the dust layer". Leave `effects-mode.ts` detection and `.ambient-dust` alone.
- Kaleb also chose not to do APK splits or payload pruning now (old item 10). Leave `build.gradle` splits and `bundle-android-payload.mjs` alone.
- Do not revert `cache: "reload"` in `HostClient.objectUrl` (`src/renderer/api/host.ts:83`). It exists because Cloudflare drops `Vary: Origin`, so the WebView cache can hold a copy with no CORS header (commit `b165ab4`). Any caching change must keep that fix working.
- Tests after every change: client `npm test` and `npm run lint`; mobile tests and typecheck under `mobile/`; server `npx tsc --noEmit`, `npm run lint`, `npm test`. Headless UI checks: see the Electron harness notes (`--ozone-platform=headless`, `/tmp/odm-shots/*.cjs` patterns). Android checks: the x86_64 emulator with `-gpu host`, adb run with the sandbox disabled.

Suggested order: section A (Android freezes and data loss) first, then B (table re-renders), C (pictures), D (the rest of the performance work), E (the remaining bugs).

---

## A. Android freezes, data loss, runaway files

Paths under `mobile/android/app/src/main/java/com/opendungeonmaster/app/` unless noted.

### A1. Blocking stops on the main thread (possible ANR)
- `WorldService.java:45-49` ("Stop hosting" notification action) and `:112-115` (`onDestroy`) call `ShareTunnel.stop()`. That method is `synchronized` and waits up to 5 s for cloudflared (`ShareTunnel.java:162-176`). `startQuick` holds the same lock for up to 45 s while it waits for the tunnel address (`ShareTunnel.java:113-137`).
- `WorldService.java:104-109` (`onTaskRemoved`) calls `WorldRuntime.stop()`, which shares a lock with `start()`. `start()` holds that lock through its 90 s health wait (`WorldRuntime.java:300-375`).
- Fix: run stops on a background executor. Make `stop()` set a cancelled flag and kill the child process without taking the start lock. Make the waits in `start()` and `startQuick` check that flag and release the lock while they wait (`wait()` on a monitor or a `CountDownLatch`, not a sleep while holding the lock).
- Verify: on the emulator, start sharing and tap "Stop hosting" while the tunnel is still coming up. The UI must stay responsive and the tunnel must end.

### A2. Plugin calls block Capacitor's shared thread
- `LocalWorldPlugin.java:63-69` (`stop`) and `:122-127` (`shareStop`) do their work inline. Every other plugin call (Preferences, Cookies, App, InAppBrowser) waits behind them.
- Fix: run them on a worker thread, as `start` and `shareStart` already do, and resolve the call from there.

### A3. Uploads can be lost during a payload upgrade
- `WorldRuntime.java:159-193`: the preserved folders are copied to `server.keep`, `server/` is deleted, the zip is unpacked, then `server.keep` is copied back. If the app dies after the delete, the next start runs `deleteTree(keep)` first (line 160) and erases the only copy.
- Fix, smallest safe version: at the top of the upgrade, if `server.keep` exists, treat it as the saved data (skip the delete and skip copying again). Better: unpack into `server.new`, move the preserved folders across with `renameTo` (same filesystem, no copying), then swap directories with renames. Best, if it is not too invasive: move player data (uploads, generated, generated-audio, ambience, models) out of `server/` into `files/data/` and point the server at it. That needs a server-side env var for the public data root, so check `src/lib/uploads-store.ts`, `openai-images.ts`, `comfyui.ts`, `harness/images.ts`, `tts.ts` and `serve-file.ts` for how they resolve `public/`.
- Verify with a unit-style test if the logic can be pulled into a pure helper, and on the emulator by killing the app mid-upgrade (install an APK with a different `builtAt`).

### A4. The server log grows forever and is read whole
- `WorldRuntime.java:316` appends to `local-server.log` on every start with no cap. `tailLog` (`:399-409`) uses `readAllBytes` to return 16 KB. `tunnel.log` is capped only at launch (`ShareTunnel.java:145-148`).
- Fix: trim both logs at start when over about 1 MB (keep the last part). Read the tail with `RandomAccessFile.seek(length - max)`. Cap `tunnel.log` during a long session too.

### A5. Node has no memory cap (on-device server, old item 11)
- `WorldRuntime.java:313-333` runs `libnode.so server.js` with no V8 flags. V8 sizes its heap from total RAM and can grow until Android's low-memory killer kills the whole app.
- Fix: add `--max-old-space-size` scaled from `ActivityManager.getMemoryClass()` or total RAM (for example 256 MB on 4 GB phones, 384 MB above), and `--max-semi-space-size=16`. Check that the flag goes before `server.js`.
- Verify: `/api/health` still comes up, and a long session (campaign start, many turns) does not hit heap OOM. Watch `adb shell dumpsys meminfo`.

### A6. A dead tunnel keeps being advertised
- When cloudflared exits, `UrlWatcher` ends silently (`ShareTunnel.java:196-222`). The notification still says friends can join.
- `keepRoomCodesPublished` (`mobile/src/bridge.ts:746-756`) runs a 60 s interval that is cleared only by `publish("")`, which only happens when `shareTunnel.status()` is called (`mobile/src/share-tunnel.ts:560-569`). After a crash or "Stop hosting" it keeps fetching `/api/campaigns` and PUTting the dead address to the broker forever.
- Fix: when the cloudflared process exits, stop the service and send a plugin event (`tunnel-status` with `state: "stopped"` or `"error"`). In the interval, check `stillUp()` first and tear down if it is false.

### A7. Portal mode starts the phone's server for remote hosts and never stops it
- `mobile/src/bridge.ts:518-551` (start at `:531`): every connect to a remote host that passes the version check starts the local Next server, then it runs for the rest of the app's life (nothing stops it at `:1603-1607` or when going back to the manager).
- First confirm with Kaleb whether portal mode still matters now that hosts at or above the native gate open in the app's own screens. If it only serves old hosts, the simplest fix is: stop the local world a short time after the game web view closes, unless it is shared or the device world is the one open.

### A8. Big downloads go through base64 several times
- `mobile/src/download-shim-core.ts:184-194`, `mobile/src/download-relay.ts:24,119-123`, `bridge.ts:352-361`, and `openDocument` (`bridge.ts:1254-1273`): files up to 40 MB become base64, cross into Java, back through `notifyListeners`, then back again in `Filesystem.writeFile`. Several copies are alive at once.
- Fix: hand the URL plus the bearer token (or cookie) to native code and stream it to a file (`Filesystem.downloadFile` or a small Java method), then open or share it from there. Keep the base64 path only for small blobs made in the page (PDFs built client-side).

### A9. `status()` is expensive and called constantly
- `WorldRuntime.java:269-285`: each call parses the payload JSON twice and walks every network interface. The home feed, `listServers`, tunnel events and room-code publishing all call it.
- Fix: cache `bundledInfo()` and `available()` for the life of the process, compute `lanOrigin` only when needed, make `port` volatile.
- Related: `bridge.ts:908-912` refreshes the whole home feed on every `local-status` and `tunnel-status` event. Debounce by 1-2 s and refresh only the local entry on `local-status`.

### A10. Smaller Android correctness items
- `LocalWorldPlugin.java:110`: the IOException path of `shareStart` does not call `tunnel().stop()`.
- `bridge.ts:929-931`: a share "stop" waits for a start that can take about 90 s, while `mobile/src/shell-hook.ts:86` gives up after 20 s and reports "unsupported". Make stop cancel the start (see A1) so it answers quickly.
- `WorldRuntime.java:203-225`: `pickPort` checks a port and binds it separately. Retry the spawn on "address in use".
- Nothing notices when the server dies after startup. Have the process watcher send a `local-status` event so the UI can show it and offer a restart.
- Optional, ask Kaleb: the server always binds `0.0.0.0` (`WorldRuntime.java:320`) even when nobody else is invited. Binding `127.0.0.1` until LAN or tunnel sharing starts would be safer. Note that LAN-only hosting freezes when the app is backgrounded, because the foreground service only runs while sharing (`LocalWorldPlugin.java:91-120`); either start the service for LAN guests or say so in the UI.

### Verified 2026-09-22 (section A)
All ten items confirmed in mechanism. Corrections and additions:
- A1 is worse than stated: `start()` also holds the monitor through `ensurePayload()` (the full zip unpack on first run and every upgrade) and through the 5 s `stopQuietly()` in its catch. The exit watcher thread also takes the monitor, so it cannot record an exit until `start()` returns. Moving the three `WorldService` callbacks onto a background thread removes the ANR by itself; the lock rework only improves cancel latency. `process` is a plain field in both classes and needs to be `volatile` or an `AtomicReference` before a lock-free `stop()`. Killing the child while `start()` polls makes the loop throw and set `state = "error"`, so the cancelled flag must be checked there or a user stop reads as a failure. `UrlWatcher.await` already wakes on stream EOF, so destroying cloudflared from an unsynchronized `stop()` unblocks `startQuick` on its own.
- A2: Capacitor 7 dispatches every plugin call on one `HandlerThread` (`Bridge.java:138,848-863`), so the claim holds, and `CapacitorHttp` is queued behind it too. Plugin `stop` has no JS caller today (`local-world.ts:289` is never called), so `shareStop` is the live case. Do not use `getBridge().execute()`; it posts to the same handler thread.
- A3: the window is also opened by any `IOException` during unzip (disk full is plausible, since the keep copy doubles the uploads' footprint). Second shape: `zip -r -X .` gives `odm-payload.json` no fixed position, so a partial unpack that already wrote it makes the next `ensurePayload` return early with an orphaned `server.keep`. Write `odm-payload.json` last as the commit marker. Option 3 (data root outside `server/`) has no server support at all: six files hardcode `process.cwd()/public` (`uploads-store.ts:32`, `openai-images.ts:176`, `comfyui.ts:291`, `harness/images.ts:228`, `tts.ts:66,131,158`, `serve-file.ts:24`) and `models` lives outside `public/`. Prefer the rename-based swap.
- A5: `ActivityManager.getMemoryClass()` is the Java heap class, not device RAM. Scale from `ActivityManager.MemoryInfo.totalMem`. The gain is a clean OOM in the log instead of an lmkd kill; it does not reduce memory use.
- A6: `publish("")` also runs on JS `stop()` and on start failure (`share-tunnel.ts:239,258`), so the loop only outlives a native "Stop hosting" or a cloudflared crash. Root cause: `LocalWorldPlugin` never calls `notifyListeners`, so Java cannot tell JS anything. One `worldEvent` listener fired from the `UrlWatcher` `finally` and from the `odm-world-watcher` thread fixes A6, the stale notification, and the "nothing notices" item in A10 together. After a native stop, `share-tunnel.ts` `state` stays `"running"` until `status()` runs.
- A7: the home-screen tap goes native first (`servers.ts:130-145`, `game-screen.ts:199-230`) and never starts the local server. The portal path, with its unstoppable local server, is reached through join links, QR scans, room codes, login and session renewal. With the server at 0.22.0 bundled, `portal-logic.ts:42` only accepts remotes at or above 0.22, which all pass the native gate, so from the home tap the portal only runs when native fails for a non-version reason. Still worth stopping the server after the web view closes.
- A8: undercounted. The trace is roughly five full-size string copies and three JSON parse/stringify rounds (page base64, `postMessage` JSON, `JSONObject` in Java, re-serialized to the Capacitor WebView, `Filesystem.writeFile` JSON, decode). `coverImage` (`bridge.ts:1480-1491`) takes the same round trip per cover. The size caps run after the bytes have already moved. Fix: for http(s) hrefs post only `{url, name}` and stream natively (cookie jar is shared; `openDocument` already holds the bearer token). Keep base64 only for `blob:` hrefs.
- A9: `lanOrigin()` runs only when `state == "running"`. Extra callers: `hostSession` (per `HostClient` construction) and `coverImage`. Feed refresh is deduped in flight with one queued rerun (`home-feed-logic.ts:385-397`), so "every event" is bounded but still two full refreshes per world or tunnel start.
- A10: the `shareStart` IOException gap has no live consequence (`startQuick` already stops on timeout, and `launch()` failure never assigns `process`). The `odm-world-watcher` thread does notice a dead server (`state = "error"`), it just cannot push that to JS or the tunnel; same fix as A6. `stopRequested` in `share-tunnel.ts` is never checked inside `worldPort()`, `requestSession` or `plugin.shareStart`, which is why stop waits.

---

## B. The table re-renders on every narration flush (old item 3)

Server repo, `src/app/campaigns/[campaignId]/`.

- The server batches narration into `dm_delta` events every 75 ms (`src/lib/dm/delta-buffer.ts:11-14`). Each one dispatches into the main reducer (`useCampaignStream.ts:800-803`), so the whole table re-renders about 13 times a second while the DM talks. `voice_speaking` (`:814`) does the same during voice chat.
- The memo on chat rows does nothing because `SessionChatColumn.tsx:93` (`onReport`) and `:185` (`onEditSave`) are new functions every render, and `MessageList.tsx:246,262` pass them straight to the memoized `MessageItem`.
- The side panel memo does nothing because `SessionView.tsx:604` passes a new `[]` for `spotlightUserIds` (`SidePanel.tsx:125` uses plain `memo`).
- `SessionHeader.tsx:120` is not memoized, gets a new `voice={{...}}` object (`SessionView.tsx:500-515`), inline callbacks, and new `narration`/`ambience` objects every render (`useAmbienceAudio.ts:298`, `useNarrationAudio.ts:193`).

Steps:
1. Quick wins: route `onReport`/`onEditSave` through the same ref pattern `MessageList` already uses for its other callbacks; hoist a module-level `EMPTY_IDS`; `useMemo` the `voice`, `narration` and `ambience` objects; wrap `SessionHeader` in `memo` and give it stable callbacks.
2. Proper fix: move `dmDraft`, `voiceSpeaking` and online presence out of the main reducer into a tiny external store (`useSyncExternalStore`) read only by the draft bubble, the voice dock and the presence chips. A narration flush should then repaint only the draft text.
3. `useSyncExternalStore` snapshots in `SessionView.tsx:163,248` and `src/lib/effects-mode.ts` read `localStorage` on every render. Cache the value and update it on the `storage` event and on the setter.
4. The React Compiler lint in the server repo is strict about ref access during render. Follow the patterns already in the file.

Verify: React Profiler or a render counter in a dev build while a DM turn streams. Rows and the side panel should not re-render per flush. Make sure it works both in the web app and in the client's Preact bundle (client `npm run build`, then the native-e2e harness).

### Verified 2026-09-22 (section B)
All four claims confirmed. The React Compiler is off in both builds (no `reactCompiler` in `next.config.ts`, no compiler plugin in either package; only the lint rules from `eslint-plugin-react-hooks` 7 run). Additions:
- Every `event` dispatch spreads state (`useCampaignStream.ts:400`) and even unknown ephemeral events fall to `default: return next`, so returning `state` for unknown seq-less events is a free win.
- `SessionChatColumn` and `MessageList` are unmemoized and receive the whole `state`; step 1 relies entirely on the `MessageItem` memo. `memo(MessageList)` only pays off after step 2 removes the `dmDraft` prop.
- `MessageList.tsx:127-199` already has the ref pattern for seven other callbacks; `onReport` and `onEditSave` are the only two missing. `onEditSave` is conditional on `steersStory`, so reuse the `hasX` boolean plus `useMemo` wrapper pattern at `:142-158`.
- `memo(SessionHeader)` never hits unless `shake`, `onCustomizeDice`, `onHelp` (`SessionView.tsx:518-524`) and `floorUserIds` (`:506-507`) are stabilized too. `VoiceDock` is also unmemoized. Put the `narration`/`ambience` `useMemo` inside the two hooks.
- Step 2: `voiceSpeaking` has a second consumer at `Lobby.tsx:459`. `message_added` clears `dmDraft` in the reducer (`:417`), and the follow-scroll effect (`MessageList.tsx:219-229`) keys on `dmDraft` and must move with the bubble. Presence only changes on join/leave; leave it in the reducer. `useSyncExternalStore` exists in `preact/compat` (the client shims already use it).
- Step 3 is confirmed as a fact but low value: `localStorage.getItem` is microseconds and there are only a handful per render. Other localStorage snapshots not listed: `useTurnChime`, `useEffectsRoot`, `SidePanel.tsx:60`, `audio-devices.ts:55,111`. Do steps 1 and 2 first.
- "13 times a second" is a ceiling; the batcher also force-flushes at stream end and before tool calls.

---

## C. Pictures (old item 7)

Kaleb's requirements: the apps should already hold every built-in picture, and any generated or uploaded picture must download and show on every phone, including hosts reached through Cloudflare. That broke recently (fixed in `a5f4998`, `b165ab4`, `2b6bb9b`), so treat this section carefully and test it against a real remote host through a tunnel, on Android and desktop, before and after.

### What is true today
- Built-in art in the server's `public/` is already WebP (3,737 WebP files). That part is compressed properly.
- Generated and uploaded pictures are not. AI output is saved as full PNG (`src/lib/openai-images.ts:178-179`, `src/lib/comfyui.ts:294`, `src/lib/harness/images.ts:231`), and uploads are stored in whatever format the user sent (`src/lib/uploads-store.ts`). On Kaleb's box the biggest generated files are 2-3 MB and portraits about 1.7 MB. They are drawn at full size, for example as 24 px token faces (`BoardStage.tsx:375-386`, `TILE = 32` minus 8) and in up to 200 chat rows with no lazy loading (`components/ui/ImageLightbox.tsx:52`).
- Only `/assets/icons/` ships inside the apps (`scripts/build-renderer.mjs:141-143`, `localAsset` in `src/renderer/game/runtime.ts:115-120`). `ui-art` is copied too, but only CSS `url(/assets/ui/...)` is rewritten to it (`build-renderer.mjs:144`); an `<img src="/assets/ui/...">` still goes to the host. Everything else built in is fetched from the host every time: `/assets/tiles` (21 MB), `/assets/props` (3.9 MB), `/assets/placeholders` (3.8 MB), `/assets/themes`, `/assets/ammo`, `/fx`, `/dice-box`, `/sidebar-icons`, `/ambience`.
- On Android (https page, http host) every host picture, built-in or not, goes through fetch, blob and object URL (`mustFetch`, `runtime.ts:128-130`) with `cache: "reload"`, and `uninstallRuntime` clears the object URL cache (`runtime.ts:360`). So every world entry downloads all of it again over the tunnel.

### C1. Ship all built-in art in the apps
- Extend `build-renderer.mjs` to copy the rest of the built-in public folders (`assets/*`, `fx`, `dice-box`, `sidebar-icons`, and `ambience` if its size is acceptable) next to the game bundle, and extend `localAsset` to map each prefix to the local copy. Same for `mobile/scripts/build-www.mjs`.
- Only map a prefix locally when the file exists in the build. Keep a manifest (file list) generated at build time and check it in `localAsset`, so a host with newer art than the app still falls back to the host.
- The server version the app was built from can differ from the host's. Built-in art paths are stable per server release; if a host is newer and a path is missing from the manifest, fall back to the host (above).
- Check APK size impact (roughly +35 MB). Kaleb skipped payload pruning for now, so mention the size to him before merging.

### C2. Keep downloaded host pictures across world entries
- Do not change `cache: "reload"`.
- Keep the object URL cache per host origin across `uninstallRuntime` (clear it only when the host changes or on memory pressure), and fix the eviction leak in `src/shared/object-url-cache.ts:18-26` (see E7).
- Optional, larger: persist generated/uploaded pictures in the Cache Storage API (or Capacitor Filesystem on Android) keyed by host origin and path, written only after a fetch that succeeded with CORS. Generated and upload filenames are unique per file (timestamps and ids), so a stored copy never goes stale. This removes repeat downloads between sessions without touching the WebView's HTTP cache.

### C3. Compress generated and uploaded pictures when they are saved
- The server on Android runs without native modules (`sharp` is pruned from the payload), so the encoder has to be pure JS or WASM, or the work happens in the browser.
- Uploads: encode in the page before upload. Resize to at most 1536 px on the long edge and export WebP with `canvas.toBlob("image/webp", 0.85)`. Every WebView and browser supports this. Keep the server accepting PNG and JPEG for older clients.
- Generated pictures: pick one approach and ask Kaleb if unsure:
  - a WASM encoder on the server (for example `@jsquash/webp` with a WASM resizer), checked to work on the Android Node build and within the A5 memory cap; or
  - keep the original and also write resized WebP variants beside it.
- Variants rather than renaming: stored campaign data already holds paths like `/generated/<name>.png`, and older apps and web clients expect them to work. So write siblings (for example `<name>.w256.webp` and `<name>.w1024.webp`) and add a query or path form the server resolves (for example `/generated/<name>.png?w=256`) that falls back to the original when no variant exists. New clients ask for the size they need: 256 for tokens and chips, 1024 for chat and panels, the original for the lightbox.
- Backfill: a one-shot script (in the server's `scripts/`) that writes variants for existing files in `public/generated` and `public/uploads`. It must be idempotent.
- Add `loading="lazy"` and `decoding="async"` to chat images and map images (`ImageLightbox.tsx:52`, `MapPanel.tsx:260,361`). Use the 256 variant for SVG `<image>` token faces.
- Make sure every new URL form goes through the runtime the same way (`HOST_PATHS` and `PUBLIC_PREFIXES` in `runtime.ts:13,279`) and is covered by the server's CORS (`src/lib/app-cors.ts`, matcher in `src/proxy.ts`).

Verify: a picture generated on host A shows on a phone joined through the tunnel, on desktop, and in the web app; a PNG upload from an old client still shows; the Cloudflare cache scenario from `b165ab4` still passes (open the host page in the web view once, then the native screens).

### Verified 2026-09-22 (section C)
Facts confirmed (file counts, sizes, PNG saves, `localAsset`, `mustFetch`, `cache: "reload"`, the eviction leak). Corrections and additions:
- Exceptions to "already WebP": `assets/themes` (PNG and JPG), `sidebar-icons` (PNG), `ammo` is a WASM file, `ambience` is gitignored and login-gated. `harness/images.ts` keeps whatever format the agent produced, which may be WebP.
- **C1 must be re-planned.** `scripts/bundle-server.mjs:93` copies the whole `public/` into `vendor/server/public`, `prune-server-payload.mjs:19` keeps it, and the Android payload pruner does not touch it. The vendored copy is 0.17.0 (7.5 MB, pre-art); the next rebuild carries about 45 MB into `server-payload.zip` and the desktop app regardless. Icons are already duplicated (`www/game/icons` plus the payload). Decide between: strip `public/assets`, `fx`, `dice-box`, `sidebar-icons` from the payload and have the phone-hosted server serve them from the www copy, or point `localAsset` at the unpacked payload (a file path on Electron; Capacitor would need a custom scheme). The manifest idea still applies to whichever copy is chosen, because `guardBogusErrors` (`runtime.ts:282-311`) cannot fall back from a missing local file. Extend the copy inside `buildGameCss` (`build-renderer.mjs:99-146`), which `mobile/scripts/build-www.mjs` already imports, so both shells pick it up.
- Quick win not in the plan: `<img src="/assets/ui/...">` can use the already-shipped `ui-art` folder with one more prefix in `localAsset` (24 uses in server src).
- C2: keeping the cache across `uninstallRuntime` is safe (keys already include the host origin, uploads and generated files are immutable and served with a one-year cache header). But on Android `mustFetch` pushes every public picture through the same 256-entry ring, and 933 tiles alone overflow it, so add a byte-based cap or do C1 first. The `runtime.ts:29` comment says sixty-four; the cap is 256. Cache Storage is unavailable on the desktop `file://` page, so it cannot be the shared fix. Desktop also re-downloads protected pictures per world entry today. Cheaper alternative worth testing: fetch a distinct URL from the app (for example `?app=1`) so the WebView gets its own cache entry with the CORS headers, and let the existing immutable header persist it. `serve-file.ts` ignores queries.
- C3: `sharp` is not a server dependency (transitive optional of `next` and `@huggingface/transformers`, never imported), so the "pruned" note is about a package the server never used. The Android Node build does not disable WebAssembly. In-browser WebP encoding already exists (`art-resize.ts`, `AvatarCropDialog.tsx`, `painted.ts`), and `/api/upload` takes `{ dataUrl, type }` from 11 callers, so one shared pre-upload encoder fits. For OpenAI gpt-image models the request body (`openai-images.ts:117-127`) could ask for `output_format: "webp"` directly (verify against current docs; dall-e-3 lacks it). `src/lib/uploads.ts:16` `UPLOAD_PATH` rejects dotted variant names and query strings, so variants must be resolved at serve time and never stored in campaign data. `loading="lazy"` saves decode work but not tunnel traffic in the apps, because `fixMedia` fetches the blob as soon as the element appears; an IntersectionObserver before the object URL fetch would be needed for that. `MapPanel.tsx:361` sits inside an open dialog where lazy gains nothing. CORS and the proxy matcher already cover `/uploads` and `/generated` by prefix; no change needed there.

---

## D. Other performance work

### D1. Hidden side panels keep running loops (old item 4)
Server repo. On phones `SidePanel.tsx:92` hides panels with `hidden` but leaves them mounted, so JS loops keep running:
- `OverworldPanel.tsx:179` redraws its whole canvas every 90 ms forever.
- `src/components/ParticleCanvas.tsx:93-159` keeps a rAF loop while weather is active (used by `SkyLayer` in `BattleMapPanel.tsx:884`). It already stops on `document.hidden` and reduced motion and idles when there is nothing to draw; the 1 s interval is a cheap wake check. The gap is element visibility only: an outdoor board with weather keeps animating behind the hidden panel.
- `BoardFx.tsx:153` is not a problem: its 60 ms interval exists only while effects are active or pending, and it drops effects on hidden tabs. Removed from this item.

Fix: pass a `visible` prop down from `SidePanel` (it already knows `mobileVisible`) or observe visibility with IntersectionObserver, and stop the loops when hidden or when `document.hidden`. The overworld's party-marker pulse is a real animation, so it needs a loop while visible; the fix is to pause while hidden, not to redraw only on change.

### D2. The contour background under a running world (old item 5)
- Server `src/app/TopoBackground.tsx:158-165` redraws a full-screen canvas at 20 fps on every page, including the table (mounted in `src/app/layout.tsx:70`). It already pauses on `document.hidden` and under reduced motion; it has no route check. In the apps the table sits on this canvas, and blurred elements above it re-blur it 20 times a second (backdrop-filter rules exist in `globals.css:522,553,1558` and `moments.css:16`; which session elements carry them was not traced). Stop it on `/campaigns/*` routes (a static frame is fine there). This does not touch the shell's `topo.ts` rule.
- Client `src/renderer/topo.ts`: it already pauses for the game layout (`chrome.ts:159`), and the native game path (`tryOpenNative` then `show("game")`) goes through that, so on current hosts topo is already paused under a running world. Only the web view fallback (`openGameWebView`, `mobile/src/bridge.ts:468-491`) leaves it drawing. Call `window.odmTopo?.pause()` there and `resume()` on close (`bridge.ts:1603`, `:1631`). Cheap, low value.
- Also in `topo.ts`: remove per-frame allocations (each crossing cell makes four `Point` objects and an array, `topo.ts:120-125`; draw with `moveTo`/`lineTo` directly), and schedule the next frame only when due instead of waking at 60-120 Hz and skipping (`:168-173`). Do not change how it looks or when it animates on shell screens.

### D3. Route changes crossfade the whole screen (old item 6)
- `src/renderer/game/index.tsx:84-105` wraps every router notification in a view transition, including query-only changes (tabs, filters), and the default root transition snapshots the whole viewport.
- Fix: skip the transition when only `search` changed; set `view-transition-name` on `.game-root` and `none` on `:root` so only the page column is captured. Check the crossfade still looks the same on real page changes (commit `c05ac2e` introduced it).

### D4. Painted map encodes WebP on the main thread (old item 8)
- Server `usePaintedMap.ts` repaints whenever `view.terrain` changes, which happens whenever a token reveals new tiles (the server blanks unexplored tiles per viewer, `src/lib/battlemap/view.ts:283-288`). Each repaint runs `paintCanvas` synchronously on the main thread (`src/lib/battlemap/render/painted.ts:184-202`) and then `canvas.toBlob("image/webp", 0.9)` (`:211`). Correction: `toBlob` is the async callback API and encodes off the main thread, so the encode is wasted work rather than a main-thread stall. There is already a 120 ms deferral with a `paintKey` dedupe (`usePaintedMap.ts:39-59`); it coalesces bursts but not reveals spaced further apart.
- Fix, in order of preference: draw straight into a `<canvas>` behind the SVG board and skip the blob entirely; or `createImageBitmap(canvas)`; an OffscreenCanvas worker is a larger refactor because `ODMRender` needs its asset images. Do not switch to PNG (bigger encode, no gain).
- Also: `BattleMapGrid.tsx:676` gets a new `view` object on every `battle_map_updated` refetch even when nothing changed, rebuilding the grid. Compare with the previous view and keep the old object when equal.

### D5. 3D dice (old item 9)
- `DiceOverlay.tsx:128` turns on `shadows: true` (1024 px soft shadow map). The WebGL context and the full-screen canvas stay alive forever after the first roll.
- The library adds a `window` resize listener (`node_modules/@3d-dice/dice-box-threejs/dist/dice-box-threejs.es.js:16879`) that is never removed, so `disposeBox` leaks, a later resize calls into a disposed renderer, and toggling dice stacks more listeners.
- Fix: turn shadows off (or a cheaper shadow type) on touch devices (`shadows` is at `:131`; `updateConfig` at `:105` can toggle it without a rebuild); dispose the box after an idle window and recreate it on the next roll (the next roll pays theme load plus WebGL init again, so consider longer than 10 s); remove the resize listener on dispose. The server has no `patch-package`; a lighter route is to wrap `window.addEventListener` around `box.initialize()` to capture the handler and remove it in `disposeBox`. `forceContextLoss()` already frees the GPU context, so the leak is JS heap plus a listener calling `setDimensions` on a disposed renderer. Keep antialiasing and dice look unchanged on desktop.

### D6. On-device server (old item 11)
Besides A5 (memory cap):
- `src/lib/db/core.ts:2383` enables WAL but not `synchronous = NORMAL`, so every persisted event fsyncs. Add the pragma next to it (WAL plus NORMAL is safe against corruption; the last moment of events may be lost on power loss, which is acceptable here).
- `src/lib/db/driver.ts:177-187`: prepares every statement again on every call. This is engine-agnostic: the better-sqlite3 wrapper (`:119`) does the same, and there are about 558 inline `getDatabase().prepare(...)` sites. Add a small LRU cache of prepared statements keyed by SQL text in both wrappers (SQLite re-prepares on schema change, so caching across `ensureSchema` ALTERs is safe). Run the full suite on both engines (`ODM_SQLITE_DRIVER=node` with a temp `SQLITE_DB_PATH` and `DB_ENCRYPTION_KEY`).
- `campaign_events` is never pruned and stores full `sheet_updated` payloads. Prune events older than what replay needs (tie this to E3: once a too-old client gets a resync instead of a replay, old events can go).
- `src/lib/tts.ts:130-141`: every snapshot does `readdirSync` over the campaign's growing audio folder. Keep the list in the DB or in memory.
- `src/lib/serve-file.ts:31-43` uses sync `existsSync`/`statSync` and has no `Range` support (always 200 with `Content-Length`, no `Accept-Ranges`), so audio cannot seek in the WebView and loops may re-download. Range is a correctness issue, not only perf: Safari and iOS refuse to play media from servers that ignore Range, so narration and ambience on iOS may be affected. Five routes use this helper. Add `Range` (206 plus `createReadStream({ start, end })`) and replace both sync calls with one async `fs.stat`. Keep the headers the CORS fix relies on.
- `src/lib/battlemap/view.ts:210-291`: `buildPlayerMapView` redoes lighting, field of view and sheet loading for every member on every change, and the client has no coalescing (`useCampaignStream.ts:1040-1051,1184-1186`, also fired from the rewind path at `:1168`), so rapid moves stack requests. `encounter_updated` also fires `refreshEncounter` at `:1195` for seats with enemy numbers, so the DM pays two round trips per encounter event; coalesce both. Client: one request in flight plus one trailing, with the older response ignored (also fixes E6). Server: cache the per-map lit set per event.

---

## E. Remaining bugs

### Server game pages
- **E1. Hidden-roll numbers are thrown away.** `refreshRolls` dispatches `{ type: "rolls" }` (`useCampaignStream.ts:1079`, action type declared at `:334`), but the reducer (`:357` onward) has no `case "rolls"`. Add it.
- **E2. The snapshot drops fields.** The campaign route returns `scene` and `activeSheetId`, but `refresh()` (`useCampaignStream.ts:971-999`) does not copy them into state, so a fresh load has no sky or weather until the next `scene_state` event and no active character until `roster_updated`. Handout, safety pause (X-card) and title card are meant to be seen by late joiners but are not in the snapshot at all. Add them to the route (`src/app/api/campaigns/[campaignId]/route.ts`) and to `refresh()`.
- **E3. Reconnects can skip events.** `listEventsSince` has `limit = 500` (`src/lib/events.ts:160`) and the events route replays one batch. Correction: reconnect with replay does exist on both sides (browser `EventSource` sends `Last-Event-ID`, the route honours it at `events/route.ts:22-23`, and the client's `host.ts:105-136` reconnects with backoff and `last-event-id`). The real gaps: the 500-row cap with no gap detection (the reducer's `seq <= lastSeq` guard only rejects duplicates), no snapshot resync after a drop, and `host.ts:125-128` giving up for good on 401/403 with only `onState(false)`, which the hook ignores. Fix: have the route loop until fewer than `limit` rows come back, call `refresh()` on an `open` that follows an `error` (the client's `HostEventSource` already dispatches both), and surface the permanent stop.
- **E4. Audio elements are never released.** `src/lib/audio-devices.ts:68,79` adds every `HTMLAudioElement` to a module-level Set. `useAmbienceAudio.ts:275` makes a new `Audio` per sting and `:211` per bed/music change, never released (the hook never imports `releaseOutput`; the unmount cleanup does not release either). Also `VoicePreviewButton.tsx:41` per click and `useNarrationAudio.ts:97` per mount. In the apps this compounds with E14: a detached `Audio` is exactly what `revokeIfUnused` cannot see. Call `releaseOutput` on `ended`/`error`, after fade-out, and on unmount; reuse a small pool for stings.
- **E5. The story reminder never becomes "due" while the table is quiet.** `SessionView.tsx:427-439` computes `now` inside a `useMemo` that only reruns on new messages or rolls. `now` is only used for the 20-minute snooze check, so the effect is that a snooze outlives its expiry until the next message or roll. Low impact; re-evaluate when `snoozedUntil` passes or move the check out of the memo.
- **E6. Stale battle-map responses can overwrite newer ones.** See D6 (coalesce and ignore older responses).
- **E7. Dice resize listener leak.** See D5.

### Client shell and runtime (`src/renderer/`)
- **E8. The game stylesheet breaks on WebView older than 120.** Confirmed by running `scopeCss` on a sample: `scripts/scope-css.mjs` wraps the whole sheet in one `.game-root{...}` block with nested rules that start with type selectors (`h1{`, `p{`) and emits `html[data-theme=...] & .x`. Nested rules starting with a type selector need Chrome 120 or later (December 2023); older WebViews drop the whole block, so the game is unstyled. Desktop is safe (Electron 39 is Chromium 142). Android has `minSdkVersion = 26` and no WebView version gate anywhere. Fix: flatten instead of nest. The script already splits rules and rewrites preludes, so emit `.game-root .x{}`, `.game-root{}` for `&`, and `html[data-theme=light] .game-root .x{}`, keeping `@media`/`@layer` as outer wrappers. Specificity is unchanged (`.game-root{.x{}}` is `:is(.game-root) .x`). Prepending `& ` only lowers the floor to Chrome 112. Check the result against `tests/shell-css-leak.test.mjs` and the new campaign wizard.
- **E9. Keyframe names collide, but are value-identical today.** `scope-css.mjs:106-108` hoists the game's `@keyframes` unprefixed, and the game sheet is appended to `<head>` after the shell sheets (`game-screen.ts:66-71`), so equal names win document-wide. The colliding names (`fade-up`, `twinkle`, `d20-roll`, `d20-face`, `spin`, `dust-drift`) are identical to the shell's, except `dust-drift` uses `translate` instead of `translate3d`. No visible breakage now; a latent hazard the leak-guard test cannot catch. Prefix the game's keyframe names while scoping (and rewrite `animation`/`animation-name` uses inside the sheet). Do not wrap them in an `@layer`, which would invert the problem.
- **E10. Side effects during render.** `src/renderer/game/index.tsx:115-118` calls `onLeave(...)` during render, so any re-render of an unmatched route (router tick, view transition) fires it again. Move it into an effect keyed on the unmatched URL. `setNavigation` (`:119`) is a plain global write with no subscribers, and `useParams()` reads it synchronously on first render, so moving it to an effect would break pages; leave it or pass params through context.
- **E11. `params` is a new Promise every render** (`index.tsx:135`, `resolvedParams`). The `react.js` shim's `use()` reads `__value` synchronously, so nothing suspends; the only cost is a page that puts `params` in a dep array. Memoize per route key and search string; cheap, not urgent.
- **E12. `patchedFetch` never matches `Request` objects** (`src/renderer/game/runtime.ts:50-56`). `Request.url` is always absolute, so `isRootRelative` is false and the call goes to the app's own origin with no bearer token; if it did match, method and body would be dropped. No `new Request(` callers exist in server src today. Resolve against `document.baseURI`, compare origins, and rebuild with `new Request(input, { headers })`. Low priority.
- **E13. SSE parser shared across reconnects** (`src/renderer/api/host.ts:100-103` creates it once outside the loop; `sse.ts:31-37` keeps buffer and pending event across `feed` calls with no reset). The first replayed event after a mid-event drop fails `JSON.parse` and is silently dropped. Create the parser per connection; keep `lastId` in the outer scope as it is now.
- **E14. Evicted-but-in-use object URLs leak** (`runtime.ts:36-40`, `src/shared/object-url-cache.ts:18-26`). Correction: URLs are revoked on eviction past the cap (256, though the `runtime.ts:29` comment says sixty-four), on `clear()`, and when no element carries them. What leaks is an evicted URL still in use: dropped from the map, never revoked later, and the next request fetches a second copy. The `querySelector` check also misses URLs held only by JS (`new Image()`, detached `Audio` from E4) and CSS backgrounds, so those can be revoked while still streaming. Fix: reference-count from `fixMedia` and the setter patch instead of querying the DOM, or defer in-use evictees to a later sweep. `tests/object-url-cache.test.mjs` pins eviction order and must stay green.
- **E15. The media MutationObserver is never disconnected** (`runtime.ts:334-349`, `uninstallRuntime` at `:357-361`). It is one observer guarded by `if (!observer)`, not a growing leak, but it keeps running `fixMedia` on every shell mutation with `active === null`. The subtree rescan (`:216-221`) only duplicates when a parent and a later child land in the same batch, and `fixMedia` short-circuits on `data-odm-*`; cheap. Disconnect on uninstall, reconnect on install.
- **E16. Home cover cache is bounded by distinct cover URLs, not by renders** (`src/renderer/home.ts:81-94`, base64 data URLs keyed by host and URL, removed only on a miss). Dozens of campaigns across several hosts can be a few MB. Small LRU or clear on host disconnect. Low priority.

### Lower priority, do if time allows
- Shell `body` uses `background-attachment: fixed` (`src/renderer/style.css:101`), which repaints on scroll. Move the gradients onto the existing fixed `body::before` layer.
- `.overlay` has `backdrop-filter: blur(6px)` over a 96% opaque background (`home.css:642`), which costs a lot and shows almost nothing. Removing it does not change the look.
- The tour animates `top/left/width/height` with a 9999 px box-shadow and polls layout every 400 ms (`tour.ts:255`, `home.css:538`). `position()` (`tour.ts:127-154`) writes all four properties unconditionally every tick even when nothing moved. Compare with the last rect before writing; use transforms or a clip-path or SVG mask instead of the shadow.

### Verified 2026-09-22 (section E)
E1, E2, E4, E8, E10, E13 confirmed as written. E3, E9, E11, E12, E14, E15, E16 confirmed in mechanism but overstated; corrected inline above. All four lower-priority CSS items confirmed. Additions:
- E2 is slightly worse than stated: `PERSISTED_EVENTS` (`useCampaignStream.ts:876-884`) carries the comment "persisted so a late joiner lands in the same scene", but the stream opens at the snapshot's `latestSeq` (`:1144`), so persisted events before the snapshot are never replayed on a fresh load. That comment is only true for a mid-session reconnect, and a reconnect can replay an old `title_card` late. The fix is the snapshot route, as planned.
- E1 fix is one line: `case "rolls": return { ...state, rolls: action.rolls };`. The `/rolls` endpoint returns the seat-visible list, so a wholesale replace is correct.
- The toggle knob animates `left` (`home.css:204`); use `transform`.

---

## Done means
- Every item above either fixed with a test (unit test where the logic is pure, headless harness or emulator check where it is UI or native), or written up as deliberately skipped with the reason.
- All test suites green in both repos.
- A short report to Kaleb per section: what changed, what was verified and how, what was not verified (real phone, real dice, voice).
- Nothing pushed or released unless he asks.
