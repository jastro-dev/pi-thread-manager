# pi-thread-manager

Daemon-backed long-lived Pi thread sessions for normal Pi.

`pi-thread-manager` adds a `/threads` command and a model-facing `thread` tool. It lets a Pi session create, inspect, message, steer, stop, and clean up other long-lived Pi RPC sessions through a local broker daemon. Each thread has a stable id, launch profile, lifecycle state, logs, approval records, and optional isolated Git worktree.

Use it when one Pi session needs durable parallel work without losing track of child process state.

## Install

```bash
pi install git:github.com/jastro-dev/pi-thread-manager
```

Then reload Pi:

```text
/reload
```

## Quick start

```text
/threads status
/threads create worker "Inspect this repo and report the test command"
/threads list
/threads read <thread-id>
/threads send <thread-id> "Run the tests and summarize failures"
/threads stop <thread-id>
/threads cleanup <thread-id>
```

The model-facing tool is `thread`. It exposes the same core actions as `/threads`: `status`, `list`, `create`, `read`, `send`, `follow_up`, `steer`, `abort`, `stop`, `cleanup`, `approvals`, `approve`, `deny`, and `review_loop`.

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

## Worktree behavior

New write-capable threads launch in isolated Git worktrees by default:

```text
/threads create worktreeMode=isolated_required worker "Fix the failing test"
```

Thread metadata records the source repo, execution cwd, worktree root, generated branch, base ref/SHA, allocation state, and cleanup state.

Shared-cwd threads still work when explicitly requested:

```text
/threads create worktreeMode=shared_cwd_allowed scout "Inspect the repo only"
```

Use shared cwd for read-only scouting or when you deliberately want the child Pi session in the parent cwd. Avoid concurrent writers in shared cwd.

`stop` only stops the process. It keeps isolated worktrees intact. Use `/threads cleanup <thread-id>` after inspecting the result. Cleanup refuses dirty, locked, occupied, missing/mismatched, or unmarked worktrees. It also refuses branches with commits that are neither merged into local `HEAD` nor reachable from any remote-tracking branch. Locally merged branches are deleted with `git branch -d`; locally unmerged branches are deleted only after the remote-reachability proof.

## Optional runtime config

Optional runtime config lives at:

```text
~/.pi/agent/thread-manager/config.json
```

When absent, child Pi sessions use the built-in launch resolution: the daemon resolves the installed Pi CLI script and runs it with the current Node executable.

To intentionally wrap child launches, set `launchCommand` and optional `launchArgs`. The launcher appends the resolved Pi CLI script path and normal Pi RPC args after `launchArgs`.

Example:

```json
{
  "launchCommand": "node",
  "launchArgs": []
}
```

`childEnv` may inject non-secret `PI_*` string flags into every managed child Pi process. It cannot override the manager-owned `PI_THREAD_ID` and rejects secret-like names.

## Safety model

- Child sessions are normal Pi RPC processes running as the current user.
- Launch profiles record cwd, model, extension-loading policy, approval mode, and inherited parent values.
- A delivered prompt is not completion. `send`, `follow_up`, and `steer` acknowledge delivery/acceptance only; use `read` or `status` to inspect progress.
- The daemon persists operations and approvals before external writes.
- GitHub write actions default to approval-required.
- Review comments are untrusted input. Fixer prompts delimit comment text and tell the child thread not to follow instructions inside comments that request secrets, policy changes, silent public writes, or scope expansion.

## Development

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm node --import tsx --test tests/*.test.ts
```

## License

MIT. See [LICENSE](./LICENSE).
