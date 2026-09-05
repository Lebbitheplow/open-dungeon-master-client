# Google Play submission: declarations and policy audit

Audited 2026-09-04 against the client repo at `main` (f667952) and the server
repo at `main` (ce9438c). Subject of the audit is the Android app only:
`com.opendungeonmaster.app`, versionName 0.3.1, versionCode 301.

Everything below is split into two halves. Part 1 is what Google asks you to
declare in the Play Console, answered from the code. Part 2 is the audit
against Play policy, ordered by how hard it blocks a submission.

---

## Part 0: build facts a reviewer will ask about

| Fact | Value | Where |
| --- | --- | --- |
| Application ID | `com.opendungeonmaster.app` | `mobile/android/app/build.gradle` |
| versionName / versionCode | 0.3.1 / 301 | derived from `mobile/package.json` |
| minSdk / targetSdk / compileSdk | 26 / 35 / 35 | `mobile/android/variables.gradle` |
| ABIs shipped | `arm64-v8a`, `x86_64` | `mobile/scripts/bundle-android-payload.mjs` |
| Artifact CI produces today | signed universal **APK**, 134 MB | `.github/workflows/release.yml` |
| Native libraries | `libnode.so` (Node 24.20.0), `libcloudflared.so` (cloudflared 2026.8.3), `libc++_shared.so` | `mobile/android/app/src/main/jniLibs/` |
| 16 KB page alignment | Yes, all three ELF LOAD segments align at 0x4000 | verified with `readelf -lW` |
| 64-bit support | Yes, both shipped ABIs are 64-bit | no 32-bit ABI is built |
| Signing | env-driven release keystore, PKCS12, alias `odm` | keystore at `~/.local/share/odm/odm-release.keystore` |
| Obfuscation | `minifyEnabled false` | no mapping file to upload |

### What the app actually does, in reviewer terms

Open Dungeon Master is a tabletop roleplaying client for Dungeons and Dragons
5th Edition campaigns. The Android app can work in three modes:

1. **Host on the phone.** The APK carries a full Node.js runtime plus the
   game server as a zip in assets. On first run the server is unpacked into
   app-private storage and launched as a child process on `127.0.0.1`. The
   game UI is that local server rendered in a WebView.
2. **Share that world.** An optional Cloudflare tunnel (`libcloudflared.so`,
   run as a second child process) publishes the phone's local server so
   friends can join from anywhere. A foreground service keeps it alive.
3. **Join someone else's server.** The user types a server address or scans a
   QR invite, and the app loads that server in the WebView.

There is no Open Dungeon Master account, no developer-run game backend, and
no hosted service. The one piece of developer-run infrastructure is a
Cloudflare Worker that mints tunnel hostnames (see Data safety, below).

---

## Part 1: Play Console declarations

### 1.1 Permissions

Every permission in the merged release manifest, verified with
`apkanalyzer manifest permissions` against the built release APK.

**Declared deliberately in `mobile/android/app/src/main/AndroidManifest.xml`:**

| Permission | Runtime prompt? | Why the app needs it |
| --- | --- | --- |
| `INTERNET` | No | Reaching a remote game server, and the tunnel. |
| `ACCESS_NETWORK_STATE` | No | Knowing whether the phone is on Wi-Fi so the LAN join address can be offered. |
| `FOREGROUND_SERVICE` | No | Keeps the phone-hosted world running while the host uses another app. |
| `FOREGROUND_SERVICE_SPECIAL_USE` | No | Type for the above. See 1.2. |
| `RECORD_AUDIO` | Yes | Voice chat between players at the table, and push-to-talk speech to text, both inside the game WebView. |
| `MODIFY_AUDIO_SETTINGS` | No | Routing voice chat audio. |
| `POST_NOTIFICATIONS` | Yes (Android 13+) | The hosting notification, plus turn alerts and session reminders. |
| `CAMERA` | Yes | Scanning a QR invite card. Paired with `<uses-feature android:required="false">` so camera-less devices can still install. |
| `BLUETOOTH_SCAN` (with `neverForLocation`) | Yes (Android 12+) | Pairing Pixels smart dice so physical rolls enter the game. |

**Pulled in by the `@capacitor-community/bluetooth-le` plugin:**

| Permission | Note |
| --- | --- |
| `BLUETOOTH_CONNECT` | Talking to a paired Pixels die. |
| `BLUETOOTH` (`maxSdkVersion=30`) | Legacy pre-Android-12 path. |
| `BLUETOOTH_ADMIN` (`maxSdkVersion=30`) | Legacy pre-Android-12 path. |
| `ACCESS_FINE_LOCATION` | **Uncapped. See finding B-4.** |
| `ACCESS_COARSE_LOCATION` | **Uncapped. See finding B-4.** |

**Pulled in by `@capacitor/local-notifications`:**

| Permission | Note |
| --- | --- |
| `WAKE_LOCK` | Delivering a scheduled local notification. |
| `RECEIVE_BOOT_COMPLETED` | Re-registering scheduled notifications after a reboot. |

**Not requested, and worth stating in the listing because reviewers look for
them:** no `QUERY_ALL_PACKAGES`, no `READ_MEDIA_IMAGES` or `READ_MEDIA_VIDEO`
(image uploads go through the system document picker), no
`MANAGE_EXTERNAL_STORAGE`, no `SCHEDULE_EXACT_ALARM` or `USE_EXACT_ALARM`, no
`REQUEST_INSTALL_PACKAGES`, no SMS or call log permissions, no background
location.

### 1.2 Foreground service declaration

Play requires a separate declaration for every foreground service type, with
a video or description showing the user-visible feature.

- Service: `WorldService` (`mobile/android/app/src/main/java/com/opendungeonmaster/app/WorldService.java`)
- Type declared: `specialUse`
- `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` already set in the manifest: "Runs the
  player's own tabletop game server so friends on the same network can join
  while the app is in the background."
- User-visible behavior: a low-importance ongoing notification titled "Your
  world is shared" with a "Stop hosting" action. It starts only when the user
  shares the world, never during solo play, and stops on swipe-away.

Suggested wording for the console declaration:

> The user's phone hosts the tabletop game session that other players are
> connected to. If the process is killed while the user checks another app,
> every connected player is disconnected mid-session. The service runs only
> while the user has explicitly chosen to share, shows a persistent
> notification with a one-tap stop action, and ends when sharing ends or the
> app is swiped away.

See finding B-5 for the risk that Google pushes back on `specialUse`.

### 1.3 Third-party SDKs and libraries

There is no analytics, attribution, crash-reporting, or advertising SDK in
the app. Google Play Services is not linked (`google-services.json` is absent
and the plugin block is skipped).

| Component | Version | License | What it does | Collects user data? |
| --- | --- | --- | --- | --- |
| Capacitor (`@capacitor/core`, `/android`) | ^7.0.0 | MIT | Native shell and JS bridge | No |
| `@capacitor/app` | ^7.0.0 | MIT | App lifecycle and deep link events | No |
| `@capacitor/preferences` | ^7.0.0 | MIT | Stores the server address and local profile | Local only |
| `@capacitor/filesystem` | ^7.1.8 | MIT | Saves exported character and campaign files | Local only |
| `@capacitor/share` | ^7.0.4 | MIT | System share sheet for invite links and exports | No |
| `@capacitor/local-notifications` | ^7.0.7 | MIT | Turn alerts and session reminders | No |
| `@capacitor/barcode-scanner` | ^2.2.6 | MIT | Scans the QR invite card | No |
| `@capacitor-community/bluetooth-le` | ^7.3.2 | MIT | Pixels smart dice pairing | No |
| `@capgo/inappbrowser` | ^7.0.0 | MPL-2.0 | The WebView the game runs in | No |
| AndroidX appcompat / coordinatorlayout / core-splashscreen | see `variables.gradle` | Apache-2.0 | UI plumbing | No |
| Node.js (bundled as `libnode.so`) | 24.20.0 | MIT | Runs the bundled game server on device | No |
| cloudflared (bundled as `libcloudflared.so`) | 2026.8.3 | Apache-2.0 | Optional outbound tunnel so friends can join | Connection metadata reaches Cloudflare |
| Bundled server dependencies | see server `package.json` | mixed OSS | The game itself: Next.js, better-sqlite3 (pruned on Android), mediasoup, pdf-lib, jszip, docx, Radix UI | No |

Note for the console: cloudflared is the only component that sends anything
to a third party by design, and only when the user taps Share. `sharp`,
`onnxruntime-node`, `better-sqlite3-multiple-ciphers` and the mediasoup
worker are pruned from the Android payload, so their native code is not in
the APK.

### 1.4 Ads

**No ads.** There is no ad SDK, no ad mediation, no ad identifier use, and no
`com.google.android.gms.permission.AD_ID` permission. Answer "No, my app does
not contain ads" and leave the advertising ID declaration empty.

### 1.5 In-app purchases and monetization

**None.** No Play Billing library, no external payment flow, no donation or
subscription link anywhere in the client or server code. The app is free and
MIT licensed. Answer "No" to in-app purchases, and "Free" for pricing.

Because there is nothing to buy, the Payments policy and the alternative
billing rules do not apply.

### 1.6 Data safety

The honest headline is that the developer runs almost no infrastructure, but
"almost" is not "none", and the Data safety form has to reflect the exception.

**Data the app stores only on the user's device or the user's own server:**

| Data | Where | Notes |
| --- | --- | --- |
| Username and salted password hash | app-private SQLite on the phone, or the remote server the user joins | Never leaves that machine. |
| Campaign text, characters, chat messages, dice history | same | This is the game. |
| Uploaded and generated images and audio | app-private `files/` | |
| An OpenAI API key, if the user supplies one | the on-device server's settings table | The user pastes their own key. |

**Data that reaches a third party, and when:**

| Recipient | Trigger | What is sent |
| --- | --- | --- |
| Cloudflare (`odm-tunnel-broker.tunnel-broker.workers.dev`, developer-operated Worker) | User taps Share to publish their world | The local port number, plus the IP address Cloudflare attaches to the request. The Worker stores a per-IP counter in KV keyed `ip:<ip>:<date>` with a 24 hour TTL for rate limiting, and a session record. See finding B-6. |
| Cloudflare (tunnel edge, `trycloudflare.com` or `play-CODE.opendungeonmaster.com`) | same | All game traffic between remote players and the phone transits the tunnel. |
| Cloudflare DoH (`cloudflare-dns.com/dns-query`) | same | A DNS lookup for the new tunnel hostname, to confirm it resolved. |
| OpenAI (`api.openai.com`) | Only if the user chooses the OpenAI option and pastes their own key | Prompts and game text, per OpenAI's own policy. |
| Whatever server the user joins | User joins a friend's game | Everything they type in that game. |
| A model provider the server operator configured | Set by the operator, not by the app | Prompts and game content. |

**Recommended form answers:** declare that the app collects "App activity"
and "Personal info: user IDs" in the sense that a user-chosen display name
and game content travel to the server the user chose to join, that it is not
shared with the developer, that data is encrypted in transit, and that users
can request deletion. Then use the free-text and privacy policy to explain
the self-hosted model. Do **not** claim "no data collected", because the
tunnel broker sees IP addresses and the Share path routes game traffic
through Cloudflare.

### 1.7 Account creation and deletion

The app does create accounts, on the phone-hosted server or on the server the
user joins. Play's account deletion requirement is satisfied in-app:
`/settings` has a "Delete account" section, and `deleteUserCascade` in
`src/lib/db/users.ts` removes the row and its dependents. Server admins can
also delete any account from `AdminUsersPanel`.

For the console's "Data deletion" URL requirement, you still need a web page
describing how to delete an account and the data, because Play wants an
off-app route as well as the in-app one.

### 1.8 Target audience and content rating

**Recommended target age group: 18 and over.** Reasoning:

- The AI Dungeon Master is whatever model the server operator pointed at.
  There is no content filter the app can guarantee, and the terms of service
  already say so.
- Players type free-form text to each other and can talk over voice chat.
- A user can point the app at any server on the internet.

Choosing 18+ keeps the app out of the Families policy and out of Designed for
Families entirely, which is the right call here.

**Suggested IARC questionnaire answers:**

| Question | Answer | Basis |
| --- | --- | --- |
| Violence | Yes, fantasy or cartoon violence, non-graphic | Turn-based 5e combat with hit points, monsters, and character death. No depiction beyond prose and optional generated art. |
| Blood or gore | Mild, prose only | Dark fantasy and horror genres are selectable. |
| Sexual content or nudity | No explicit content | The live DM prompt hard-codes fade to black: "Intimacy is available only to partners and always FADES TO BLACK ... No explicit sexual content, ever, however the table asks" (`src/lib/dm/prompt.ts`, `relationshipRules`). Romance is a relationship ladder only. See finding B-1 for dead code that contradicts this. |
| Profanity | Possible, user-generated | Players type freely; the model may swear. |
| Controlled substances | Incidental, fantasy setting | Taverns and potions. |
| Gambling | No | Dice are a game mechanic, no wagering, no simulated gambling. |
| Users interact | **Yes** | Multiplayer text chat and voice chat. |
| Users can share content | **Yes** | Campaigns, characters, images, and files are shared with the party. |
| Shares user location | No | The app never reads location. Say no, and see finding B-4 about removing the permissions that imply otherwise. |
| Digital purchases | No | |
| Unrestricted internet access | **Yes** | The user can enter any server URL, and the WebView loads it. |
| Generative AI | **Yes** | Declare it. The narration, and optionally images, are model output. |

Expect this to land at Teen or Mature 17+ from IARC, with the AI and open
interaction answers being what drives it upward.

### 1.9 Declarations that do not apply

Not a financial, health, medical, VPN, government, blockchain, dating, news,
or child-directed app. No COVID or contact tracing. No device or call
recording. No accessibility service. No SDK that collects an advertising ID.

---

## Part 2: Policy and technical audit

Ordered by severity. Anything marked BLOCKER will stop the upload or the
review as things stand today.

### BLOCKER B-1: the app cannot be uploaded as an APK

`.github/workflows/release.yml` builds and signs a universal APK
(`:app:packageRelease`, 134 MB). Google Play has required an Android App
Bundle for all new apps since August 2021 and will reject the APK at upload.

**Fix.** Add an `:app:bundleRelease` step and publish the `.aab`. Keep the APK
for the GitHub release and sideloaders, since that is a genuinely useful
distribution channel for this project. With ABI splits, the per-device
download drops to roughly 85 MB (49 MB server payload plus about 32 MB of
compressed arm64 native code), comfortably under Play's 200 MB download cap.
Uploading the current universal build as a single artifact would be near that
cap for no reason.

You will also need to decide on Play App Signing. Google will ask to manage
the signing key. If you enroll, the keystore at
`~/.local/share/odm/odm-release.keystore` becomes the upload key, and losing
it stops being fatal to updates. Enrolling is the safer choice, but note the
Play-signed APK will have a **different** certificate fingerprint than the
GitHub-released APK, which matters for App Links (see B-7).

### BLOCKER B-2: targetSdk 35 is below the current Play requirement

`variables.gradle` sets `targetSdkVersion = 35` (Android 15). Play's annual
target API rule required new apps and updates to target API 36 (Android 16)
from 31 August 2026. That date has passed, so a 0.3.1 build will be refused.

**Fix.** Move `compileSdkVersion` and `targetSdkVersion` to 36, then retest
the two places most likely to break: the edge-to-edge handling that
`capacitor.config.ts` already forces with `adjustMarginsForEdgeToEdge`, and
the foreground service start path in `WorldService`. Confirm the exact
current requirement in the Play Console before you build, since the API level
floor moves every August.

### BLOCKER B-3: no in-app way to report AI-generated or user-generated content

Grepping the whole server UI finds no report or flag affordance. Two Play
policies both require one:

- **Generative AI apps** must give users an in-app mechanism to report or flag
  offensive AI-generated content, and that reporting has to inform moderation.
- **User-generated content** requires an in-app system for reporting content
  and users, plus a way to block abusive users.

The app has an AI narrator and multiplayer chat, so both apply. The
self-hosted architecture does not exempt you. Google's position is that the
app must offer the mechanism, and it is fine for the report to route to the
server operator rather than to you.

**Fix.** A modest version satisfies this: a report action on each DM message
and each player message that writes a row to a `reports` table on that
server, surfaced in the existing admin panel, plus a per-user block or mute
that the party lead and the admin can act on. The admin panel and the
`AdminUsersPanel` delete path already give you the moderation half. Document
in the listing that reports go to the operator of the server the player
chose, and that the app itself has no central moderation because there is no
central service.

### B-4: location permissions ship in the APK but are never used

The release APK declares `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`
with no `maxSdkVersion`, inherited from `@capacitor-community/bluetooth-le`.
The app's own manifest already goes out of its way to mark `BLUETOOTH_SCAN`
`neverForLocation` specifically so Android 12+ never prompts for location, so
the intent is clear and correct. The declaration is the leftover.

This matters for three reasons: location is a sensitive permission that draws
extra review, the Play listing will show "location" to users, and the Data
safety form and IARC questionnaire both ask about location in a way that is
now awkward to answer cleanly.

**Fix.** In `mobile/android/app/src/main/AndroidManifest.xml`, override both
with `android:maxSdkVersion="30"` and `tools:node="replace"`, matching the
pattern already used for `BLUETOOTH_SCAN`. Devices on API 26 to 30 genuinely
need fine location to BLE-scan, so capping rather than removing preserves the
Pixels dice feature on older phones. After the change, re-run
`apkanalyzer manifest permissions` and confirm the cap landed.

### B-5: `specialUse` foreground service is the type Google pushes back on hardest

The manifest comment is candid that no typed category fits a game server, and
that is a reasonable reading. But Google reviews every `specialUse`
declaration by hand and rejects it when it believes an existing type applies.
A reviewer may well argue that `dataSync` or `connectedDevice` covers
"maintaining a network connection so remote players stay connected".

**Prepare for it rather than be surprised.** Record a short screen capture of
the flow: user taps Share, the notification appears, a second device joins,
the user switches to another app, play continues, the user taps Stop hosting.
Attach it to the declaration. Have a fallback plan to switch to `dataSync` if
the declaration is refused, which is a one-line manifest change plus the
matching `FOREGROUND_SERVICE_DATA_SYNC` permission.

### B-6: the tunnel broker keeps raw IP addresses

`workers/tunnel-broker/src/index.js` rate limits by writing a KV key of the
form `ip:<cf-connecting-ip>:<date>` and `turn:<ip>:<date>`, with TTLs of
24 hours and 35 days respectively. That is a persisted identifier held by
developer-run infrastructure, so it is not covered by Play's "processed
ephemerally" exemption, and it contradicts the current privacy policy's flat
claim of "No data is sold, shared, or transmitted to any third party,
including the creator of Open Dungeon Master."

**Fix, in order of preference.** Hash the IP with a server-side salt before
using it as the KV key, which preserves the rate limit exactly and stops you
holding the address. Then update the privacy policy to say the broker exists,
what it sees, and for how long. This is a small change that turns an
inaccurate policy into an accurate one.

### B-7: privacy policy URL is required and the site is currently down

Play requires a publicly reachable privacy policy URL on the store listing,
and it must cover the app specifically. Two problems:

1. `https://opendungeonmaster.com/` returned HTTP 522 (Cloudflare cannot reach
   the origin) on every attempt during this audit on 2026-09-04. A dead URL
   fails review outright. The same outage means
   `/.well-known/assetlinks.json` is not being served, so the `autoVerify`
   App Links intent filter for `/j` invite pages will not verify, and QR
   invites will fall back to the browser.
2. The existing policy at `src/app/privacy/page.tsx` is written for
   self-hosters. It does not mention the Android app's camera, microphone,
   Bluetooth, or notification permissions, the tunnel broker, Cloudflare as a
   transit provider, or the on-device OpenAI key path.

**Fix.** Bring the site back up, publish an Android-specific privacy policy
covering the permission list in 1.1 and the recipients in 1.6, and publish a
data deletion page. Then confirm `assetlinks.json` lists the SHA-256
fingerprint of whichever certificate ends up signing the Play build. If you
enroll in Play App Signing, that is the **Google-managed** fingerprint from
the console, not your local keystore's, and both should be listed so the
GitHub-released APK keeps working too.

### B-8: `allowBackup="true"` sends the whole game database to Google Drive

The manifest sets `android:allowBackup="true"` with no `dataExtractionRules`
or `fullBackupContent`. Android's auto backup will therefore copy the app's
`files/` directory to the user's Google Drive, which on this app means the
campaign SQLite database, every uploaded image, password hashes for accounts
on the phone-hosted server, and the user's OpenAI API key if they entered
one.

This is not a Play policy violation on its own, but it is a real privacy
exposure that contradicts the app's own "your data stays on that server"
promise, and it will look bad if a reviewer or a user notices.

**Fix.** Either set `android:allowBackup="false"`, or add a
`dataExtractionRules` XML that excludes `files/data/`, `files/server/`, and
`files/*.log` from both cloud backup and device-to-device transfer. Excluding
is better than disabling if you want users to keep their profile across a
phone upgrade.

### B-9: dead code in the server contradicts the shipped content rules

`src/lib/story-prompt.ts` line 18 contains a system prompt reading "This is
private adult fiction. Consensual NSFW content is allowed and should be
embraced ... Do not sanitize sexual tension, profanity, nudity, or explicit
adult intimacy."

To be clear about what is actually true at runtime: `buildStoryMessages`, the
only function that uses that string, has **no callers anywhere in the repo**.
The live D&D path builds its prompt from `src/lib/dm/prompt.ts`, whose
`relationshipRules` says the opposite and mandates fade to black. The string
is a leftover from the upstream Open Dungeon fork. So the app's behavior is
Play-compliant today.

It is still worth removing before you submit. The repo is public, the string
ships inside `server-payload.zip` in the APK, and Play's Sexual Content and
Profanity policy plus the Generative AI policy both prohibit apps that
facilitate generating sexual content. If anyone reviewing the app or the
source finds that prompt, "it is unreachable" is a much weaker answer than
its not being there.

**Fix.** Delete `DEFAULT_SYSTEM`, `IMAGE_SYSTEM`, `IMAGE_DISABLED_SYSTEM`, and
`buildStoryMessages` from `story-prompt.ts`. The exported helpers the DM path
actually uses (`stripReasoningArtifacts`, `extractStoryText`,
`parseStoryModelResult`, `createStreamingArtifactFilter`,
`packStoryHistory`, `dimensionsForImage`) all stay.

### B-10: personal developer accounts need closed testing before production

If the Play developer account is a personal account created after 13 November
2023, Google requires a closed test with at least 12 testers opted in
continuously for 14 days before you can apply for production access. This is
a scheduling constraint, not a code one, but it adds two weeks minimum to the
timeline and people routinely discover it the week they wanted to ship.

Check the account type in the console now. If it applies, start recruiting
the 12 testers before you finish the code fixes above.

### Watch items, not blockers

- **`usesCleartextTraffic="true"`** is justified by the comment (LAN servers
  are commonly plain HTTP, and the connect flow tries HTTPS first). Play
  allows it. It will show up in the pre-launch report as a security note.
  Consider narrowing it to a network security config that permits cleartext
  only for private address ranges, which keeps the LAN case and closes the
  general one.
- **Executing bundled binaries.** `WorldRuntime` and `ShareTunnel` launch
  `libnode.so` and `libcloudflared.so` as child processes. This is legitimate
  under the Device and Network Abuse policy because both binaries ship inside
  the APK and nothing executable is downloaded at runtime. `WorldRuntime`'s
  only network call is a health check against `127.0.0.1`. Keep it that way:
  the moment the app fetches code or a payload update from the network, that
  policy stops being satisfied. Worth a sentence in the console notes to a
  reviewer so the two large `.so` files do not look suspicious.
- **App size.** 134 MB universal. After the AAB split this is fine, but
  Android's install-time extraction of `useLegacyPackaging` jniLibs means the
  on-disk footprint is roughly double the download. Users on cheap devices
  will feel it. Not a policy matter.
- **The WebView loads arbitrary user-entered server URLs.** This is core to
  the product and is fine, but it is the reason the IARC "unrestricted
  internet access" answer is yes, and it is worth one line in the listing
  description so it does not read as a hidden browser.
- **No armeabi-v7a.** Only 64-bit ABIs are built, so 32-bit-only devices
  cannot install. Play is fine with this. It just narrows reach.
- **`minifyEnabled false`.** Allowed. It does mean the APK is trivially
  decompilable, which for an MIT-licensed open source project is a non-issue.

---

## Pre-submission checklist

Code and build:

- [ ] B-1: publish an AAB, keep the APK for GitHub releases
- [ ] B-1: decide on Play App Signing, record both certificate fingerprints
- [ ] B-2: move compileSdk and targetSdk to 36, retest edge-to-edge and the FGS start
- [ ] B-3: add in-app content reporting and user blocking
- [ ] B-4: cap both location permissions at `maxSdkVersion="30"`
- [ ] B-6: hash IPs in the tunnel broker's rate limit keys
- [ ] B-8: add `dataExtractionRules` excluding `files/data/` and `files/server/`
- [ ] B-9: delete the unused NSFW prompt from `story-prompt.ts`
- [ ] Re-run `apkanalyzer manifest permissions` on the new build and diff against 1.1

Off-app:

- [ ] B-7: bring `opendungeonmaster.com` back up
- [ ] B-7: publish an Android-specific privacy policy and a data deletion page
- [ ] B-7: serve `/.well-known/assetlinks.json` with the correct fingerprints
- [ ] B-10: confirm developer account type and start the 12-tester closed test if required

Console forms, answered from Part 1:

- [ ] Data safety (1.6)
- [ ] Foreground service declaration plus demo video (1.2)
- [ ] Content rating questionnaire (1.8)
- [ ] Target audience: 18 and over (1.8)
- [ ] Ads: none (1.4)
- [ ] Government apps, financial features, health: all no (1.9)
- [ ] Account deletion URL (1.7)
- [ ] Store listing: screenshots, feature graphic, short and full description
