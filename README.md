# @reachpad/mcp

**Development infrastructure for coding agents.** A reachpad environment is a
cloud development computer an agent operates itself: a repo, a filesystem,
installed dependencies and build state that all survive between calls — not an
ephemeral sandbox that forgets. Processes are the exception; see below.

This is the MCP server. It lets Claude, ChatGPT, Cursor, OpenCode or your own
agent create an environment, run commands in it, fork it, and come back to it
later, without a developer keeping a laptop open for them.

- **It persists.** Pause it and the disk is sealed; the next call boots from
  that seal with the files, installs and git state intact, rather than
  rebuilding. Processes are the exception: a start is always a cold boot.
- **It forks.** Twenty attempts from one prepared state cost a delta each, not
  twenty rebuilds — because the environment is a snapshot chain, not a machine.
- **It can keep secrets out of the box.** A brokered credential is called at
  the boundary on your behalf and its value never enters the environment, the
  log or the store. A credential written into the environment instead is
  readable there, by design.
- **It is agent-agnostic.** The REST API is canonical; this server, the SDK and
  the CLI are translations of it. Bring your own agent.

The API is the product boundary, not a web UI: [reachpad.dev](https://reachpad.dev).

## Install

```sh
npx -y @reachpad/mcp          # stdio, for a local client
```

In Claude Code:

```sh
claude mcp add reachpad -e REACHPAD_IDENTITY_CREDENTIAL=… -- npx -y @reachpad/mcp
```

## Two transports, one implementation

```sh
npx @reachpad/mcp                                  # stdio
REACHPAD_MCP_HTTP_PORT=8722 npx @reachpad/mcp      # streamable http
```

stdio is what a local client talks to; Streamable HTTP is what a remote
connector talks to. Same tools, same behaviour — added rather than forked,
because two implementations of one surface is how they drift.

The HTTP side answers **405 to `GET`**: every tool here is request/response, and
the spec permits declining the server-initiated stream rather than holding a
connection open for traffic that never comes. There are **no sessions** —
nothing is held across calls that a restart could not rebuild. And it carries
**no credential of its own**: whatever authorizes the HTTP request is what
authorizes reachpad.

## Configure

| variable | meaning |
|---|---|
| `REACHPAD_ENDPOINT` | your reachpad host. Plaintext `http://` to anything but loopback is refused before a socket opens. |
| `REACHPAD_IDENTITY_CREDENTIAL` | your per-user credential. It names one account and can act for no other — the server takes the identity from the credential's own record, never from the request. |
| `REACHPAD_API_KEY` | optional, per-environment scoped and revocable. When set, `run_command` uses it and needs no identity exchange. |
| `REACHPAD_MCP_HTTP_PORT` | serve HTTP instead of stdio. |
| `REACHPAD_MCP_HTTP_HOST` | default `127.0.0.1`. This process bridges to a control plane with your credentials, so binding it to the world is a decision made on purpose, behind a proxy that terminates TLS. |
| `REACHPAD_MCP_HTTP_TOKEN` | bearer token, compared in constant time. Absent, **every caller that can reach the port is authorized**, and the server says so on stderr. |
| `REACHPAD_MCP_ALLOWED_ORIGINS` | comma-separated. A request carrying an unlisted `Origin` is refused — a browser cannot forge it, which closes DNS rebinding. No `Origin` at all is a non-browser client and is allowed. |

If several credentials are set, the narrowest wins, and **a refused credential
is never retried under a broader one** — falling back would be privilege
escalation nobody chose to perform.

## Tools

| tool | what it does |
|---|---|
| `get_credit_balance()` | remaining compute credits. One credit runs one standard environment for one minute. |
| `create_environment(repo?, ref?, name?)` | a new environment, optionally with a repository cloned into `$HOME/work`. Reachpad generates its display name when omitted. |
| `list_environments()` | your environments and how many forks each has |
| `get_environment(environment)` | what it boots from: its head snapshot, its log position and its fork tree |
| `run_command(environment, argv, cwd?, env?, timeout_ms?)` | one command, its exit code and its output. A paused environment resumes to serve it. |
| `checkpoint_environment(environment, name?)` | fork from the last sealed snapshot; the original is untouched |
| `expose_port(environment, port, check?)` | open a port to the web and get the link that reaches it. Idempotent per port. |
| `list_ports(environment)` | the ports this environment has open, oldest first, with their links |
| `revoke_port(environment, port)` | close one port. Re-opening it later mints a **different** link. |
| `delete_environment(environment)` | archive it and free the plan slot. Nothing is deleted — snapshots and history survive. |

**Not here, deliberately:** starting an agent inside the environment. It is in
reachpad's roadmap and not in the fleet yet — a tool that always fails costs a
model a turn and teaches it to distrust the rest, so this server advertises
nothing it cannot serve.

### What a port link is, and is not

Worth reading before you hand one to somebody, because none of it is
discoverable from the URL:

- **Anyone signed in to Reachpad who has the link can open it.** It is not a
  private URL and not a secure one. Treat it like a preview deployment.
- **The link is an address, not a copy.** Restart the app on the same port and
  the same link serves the new version.
- **A running process does not survive a pause.** The environment cold-boots
  with its files intact and nothing running, so after a pause the link answers
  with an error until something is listening on that port again. A visitor's
  request wakes a paused environment; it does not restart anything inside it.
- **`expose_port` dials the port afterwards** and tells you if nothing
  answered, because a link to a port nothing is serving looks exactly like a
  link that works. Pass `check: false` to skip it — the dial resumes a paused
  environment.
- **With only `REACHPAD_API_KEY`, the key must be `--role owner`.** A
  `collaborator` key is refused: listing hands back live tokens, and a token is
  a capability.

## The rules it is built to

These are the ways a naive client of a streaming exec API misleads a model, and
what this one does instead.

- **An unterminated stream is UNKNOWN, never success.** If the response ends
  without a terminal event, the tool says so in those words. It is not a zero
  exit, and an agent must not retry a non-idempotent command on the strength of
  it.
- **Its deadline is looser than the server's**, so a server-side answer always
  wins the race. A client that gives up first turns "your build finished" into
  "unknown", and the numbers are mirrored from the server rather than guessed.
- **Refusals carry remedies, not codes.** At your plan limit you get the limit,
  your current count, and what to do — the numbers come from the server, because
  a limit hardcoded in a client is a lie the moment your plan changes.
- **Results are handles, not payloads.** Output is tailed with the dropped byte
  count named. Build logs can be megabytes, and an MCP result that size destroys
  the caller's context window.
- **A refusal is a result, not a transport error**, so the model can read it and
  act. Only an unknown *tool* is a protocol error.

## Test

```sh
node --test 'test/*.test.mjs'
```

No network and no credentials. The protocol suite spawns the shipped server as
a child process and speaks real JSON-RPC over its stdio against a stub control
plane on a real socket, so nothing under test is an internal import. One test
runs the same arc against a real reachpad and skips when no endpoint is
configured.

## Repository

This repository is the source. It is deliberately **separate from the reachpad
backend**: this code is public, it is published to npm, and its release
workflow holds publishing rights — none of which belong in the same repository
as the control plane. Nothing here can read the backend's source, and no job in
the backend copies files out to here.

Two server constants are mirrored in `src/client.js` — the exec grace period
and the default exec timeout. A mirrored constant normally rots; this one does
not, because the backend's own CI fetches this published package and fails if
they disagree. The check lives where the number would change.
