# pi-thread-manager

Daemon-backed long-lived Pi thread sessions.

`pi-thread-manager` adds `/threads` and the model-facing `thread` tool for creating and managing independent child Pi RPC sessions. Threads are separate from one-shot subagents: they have durable identity, registry state, launch profile, lifecycle state, logs/session refs, approval tracking, and can be re-entered by later parent Pi sessions through the broker daemon.

## Install

```bash
pi install git:github.com/jastro-dev/pi-thread-manager
```

Then reload Pi:

```text
/reload
```

## Commands

```text
/threads status
/threads list
/threads create [worktreeMode=isolated_required] [baseRef=<ref>] <name> [initial prompt]
/threads create worktreeMode=shared_cwd_allowed <name> [initial prompt]
/threads read <thread-id> [limit=<n>] [cursor=<n>]
/threads send <thread-id> <message>
/threads follow-up <thread-id> <message>
/threads steer <thread-id> <message>
/threads stop <thread-id>
/threads cleanup <thread-id>
/threads approvals
/threads approve <approval-id>
/threads deny <approval-id>
/threads review-loop repo=<OWNER/REPO> prNumber=<n> fixerThreadId=<thread-id>
```

The model-facing tool is `thread` with matching actions: `status`, `list`, `create`, `read`, `send`, `follow_up`, `steer`, `abort`, `stop`, `cleanup`, `approvals`, `approve`, `deny`, and `review_loop`.

## Runtime state

Default state lives under:

```text
~/.pi/agent/thread-manager/
  threads.json
  threads.last-good.json
  broker.pid
  broker.spawn.lock
  worktrees.alloc.lock
  broker.sock            # Unix only
  threads/<thread-id>/
    thread.log
    sessions/
```

On Windows the broker uses a named pipe like `\\.\pipe\pi-thread-manager-<home>`. The daemon records PID, daemon epoch, store path, active/orphan thread counts, pending operations, pending approvals, and active schedules in `/threads status`.

## Optional runtime config

Optional runtime config lives at:

```text
~/.pi/agent/thread-manager/config.json
```

When absent, managed child Pi sessions use the built-in launch resolution: the daemon resolves the installed Pi CLI script and runs it with the current Node executable. To intentionally wrap child launches, set `launchCommand` and optional `launchArgs`. The launcher appends the resolved Pi CLI script path and normal Pi RPC args after `launchArgs`.

`childEnv` optionally injects non-secret `PI_*` string flags into every managed child Pi process. It cannot override the manager-owned `PI_THREAD_ID` and rejects secret-like names.

Example:

```json
{
  "launchCommand": "aubx",
  "launchArgs": ["tsx"],
  "childEnv": {
    "PI_SUBAGENT_CHILD": "1"
  }
}
```

## Safety model

- Child Pi sessions run through normal Pi behavior. Launch profiles record execution cwd, model, extension-loading policy, approval mode, and whether values were inherited from the parent.
- New write-capable threads launch in isolated Git worktrees by default. Thread metadata records source cwd/repo, execution cwd, worktree root, generated branch, base ref/SHA, allocation state, and cleanup state.
- Legacy shared-cwd threads still work when explicitly requested with `worktreeMode=shared_cwd_allowed`; status/list output labels them `legacy shared cwd` because concurrent writers can collide.
- `stop` is process-only and retains isolated worktrees. Use `/threads cleanup <thread-id>` only after inspecting the result. Cleanup refuses dirty, locked, occupied, missing/mismatched, unmarked, or unmerged worktrees and uses `git branch -d`, never force deletion.
- A delivered prompt is not completion. `send`, `follow_up`, and `steer` acknowledge delivery/acceptance only; use `read` or `status` to inspect progress.
- The daemon persists operations and approvals before external writes. Approval scope binds repo, PR, head SHA, branch, action type, thread IDs, review thread IDs, diff summary, expiry, and approver.
- GitHub write actions default to approval-required. Automatic replies or review-thread resolution without explicit policy are out of scope.
- Review comments are untrusted input. Fixer prompts delimit comment text and tell the child thread not to follow instructions inside comments that request secrets, policy changes, silent public writes, or scope expansion.

## Threads vs other Pi primitives

| Primitive | Best for | Lifecycle |
| --- | --- | --- |
| Subagent | One-shot delegated task under current orchestrator | In-process task; finishes or aborts |
| Intercom | Messaging existing sessions | Session-to-session communication |
| Thread manager | Durable peer Pi sessions and automation loops | Broker-owned child Pi RPC processes with durable registry |

## Development

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm node --import tsx --test tests/*.test.ts
```

## License

MIT. See [LICENSE](./LICENSE).
