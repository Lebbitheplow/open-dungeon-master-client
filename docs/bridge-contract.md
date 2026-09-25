# Bridge contract: desktop and Android stay the same app

Two shells, one contract. The desktop shell (`src/main/`) and the Android
shell (`mobile/src/`) implement the same surfaces, and the game cannot tell
them apart. When the two sides drift, one platform breaks with no error:
"works on desktop, dead on Android" and nothing says why.

## The pairs

Each row is one surface with its two implementations and the shared module
between them. The comments at the top of each file say the same thing; this
page collects them so a contributor can see all five at once.

| Surface | Desktop | Android | Shared |
|---|---|---|---|
| Shell bridge (`window.odm`) | `src/main/ipc.ts` (`const bridge: OdmBridge`, `src/preload/index.ts:8`) | `mobile/src/bridge.ts` (`const bridge: OdmBridge`, `bridge.ts:1389`) | `src/shared/types.ts` (`OdmBridge`, `types.ts:329`) |
| In-game door (`window.odmShell`) | `src/preload/game.ts` | `mobile/src/shell-hook.ts` ("Same contract as the desktop preload") | server's `src/lib/shell-host.ts` is the consumer |
| Device-hosted world | `src/main/local-server.ts` + local flow in `src/main/ipc.ts` | `mobile/src/local-world.ts` ("mirrors the desktop shell's local flow") | `src/shared/ai-setup.ts` (AI wiring) |
| Sharing a world | `src/main/tunnel.ts` (QuickTunnel) | `mobile/src/share-tunnel.ts` ("the Android counterpart ... with the same order of preference") | `src/shared/broker.ts` (broker contract) |
| Home feed | `src/main/home-feed.ts` | `mobile/src/home-feed.ts` ("the shared orchestrator fed from ...") | `src/shared/home-feed-logic.ts` |

## Rules

- A new shell capability starts as a type in `src/shared/types.ts`, then gets
  implemented in `src/main/ipc.ts` and `mobile/src/bridge.ts`. Never add it
  to one side only.
- Change one side of a pair, change the other in the same PR. If the other
  side cannot follow yet, say so in the PR body.
- Behaviour both sides share goes in `src/shared/` (pure, tested with
  `npm test`), not copied into each shell. `broker.ts` and
  `home-feed-logic.ts` are the pattern; `tunnel.ts` vs `share-tunnel.ts`
  still carry duplicated fallback logic and are the next candidates.
- Tests run per side (`tests/*.test.mjs` desktop, `mobile/tests/*.test.ts`
  Android). A contract change needs a test on both sides.
