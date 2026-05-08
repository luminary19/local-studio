# vLLM Studio Refactor Report — 2026-05-08

## Preserved functionality inventory

Before edits, I inventoried the active surface and preservation checks:

- Frontend routes: `/`, `/agent`, `/agent/sessions`, `/configs`, `/discover`, `/logs`, `/recipes`, `/settings`, `/setup`, `/usage`, plus all existing `/api/agent/*`, `/api/proxy/*`, `/api/settings`, and `/api/voice/*` routes produced by `npx next build`.
- Agent/Pi flow: multi-pane `/agent` workspace, tabs, Pi runtime session IDs, queued steer/follow-up messages, session replay, tool-call streaming, browser tool toggle, file/diff panels, projects sidebar events, and local agentfs storage.
- Desktop behavior: Electron build stays hardened under `frontend/desktop/AGENTS.md` and installed app remains `/Applications/vLLM Studio.app` with bundle id `org.vllm.studio.desktop`.
- Deployment behavior: root `AGENTS.md` workflow remains unchanged; current main was fast-forwarded and pushed before this refactor branch.

## What changed

- Extracted agent chat/session event types and pure replay/reducer logic from `frontend/src/app/agent/_components/chat-pane.tsx` into typed shared module `frontend/src/lib/agent/chat-session.ts`.
- Centralized Pi event-to-assistant-message handling so live streaming and replay use one typed reducer path instead of maintaining duplicate tool-call/message-update branches.
- Centralized agent ID generation in `chat-session.ts`; `agent-workspace.tsx` now reuses it for pane/runtime IDs instead of carrying its own random helper.
- Replaced duplicated local `AgentModel` and `ProjectEntry` shapes in `agent-workspace.tsx` with type imports from the existing shared agent modules.
- Kept `chat-pane.tsx` compatibility exports (`makeFreshTab`, `SessionTab`, `replaySessionEvents`, etc.) so existing imports/tests and UI contracts continue to work.

## Reduction / centralization

- `frontend/src/app/agent/_components/chat-pane.tsx`: reduced from 2,177 lines to 1,483 lines.
- `frontend/src/app/agent/_components/agent-workspace.tsx`: reduced duplicated local type/id helper code.
- Net source delta after adding the shared module is about 169 fewer source lines, while moving core logic behind a smaller typed interface.

## Parity checks

Initial release-to-main checks already run before this refactor branch:

- `cd frontend && npx eslint src && npx tsc --noEmit && npm test`
- `cd controller && bun run typecheck && bun test` (`105 pass`)
- `cd frontend && npx next build`
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/agent` returned `200`

Refactor-branch focused checks run during implementation:

- `cd frontend && npx prettier --write src/app/agent/_components/chat-pane.tsx src/app/agent/_components/agent-workspace.tsx src/lib/agent/chat-session.ts`
- `cd frontend && npx eslint src/app/agent/_components/chat-pane.tsx src/app/agent/_components/agent-workspace.tsx src/lib/agent/chat-session.ts`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm test -- --run src/app/agent/_components/chat-pane.test.ts`

Final refactor-branch checks completed:

- `cd frontend && npx eslint src && npx tsc --noEmit && npm test` (`69 passed`)
- `cd controller && bun run typecheck && bun test` (`105 pass`)
- `cd frontend && npx next build`
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/agent` returned `200`
- `cd frontend && npm run desktop:dist`
- Reinstalled `/Applications/vLLM Studio.app`, removed legacy `~/Applications/vllm-studio-mac.app`, relaunched the canonical app, verified only `/Applications/vLLM Studio.app`, and verified bundle id `org.vllm.studio.desktop`.

Git commit/push and follow-on branch are recorded in the final handoff.
