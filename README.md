# @reachpad/mcp

Give a coding agent a **durable cloud environment** it can call: a filesystem
and processes that survive between calls, resume after a pause, and fork from a
snapshot so twenty attempts cost a delta rather than twenty rebuilds.

This is the MCP translation of [reachpad](https://reachpad.dev)'s REST API. The
API is canonical; this server only translates, holds no state a restart cannot
rebuild, and reaches nothing outside the public `/v1` surface.

Zero runtime dependencies. Node ≥ 20.

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
| `create_environment(name, repo?, ref?)` | a new environment, optionally with a repository cloned into `/work` |
| `list_environments()` | your environments and how many forks each has |
| `get_environment(environment)` | what it resumes from — a snapshot carrying memory resumes mid-process; a disk-only one boots |
| `run_command(environment, argv, cwd?, env?, timeout_ms?)` | one command, its exit code and its output. A paused environment resumes to serve it. |
| `checkpoint_environment(environment, name?)` | fork from the last sealed snapshot; the original is untouched |
| `delete_environment(environment)` | archive it and free the plan slot. Nothing is deleted — snapshots and history survive. |

**Not here, deliberately:** exposing a port and starting an agent inside the
environment. Both are in reachpad's roadmap and neither is in the fleet yet — a
tool that always fails costs a model a turn and teaches it to distrust the rest,
so this server advertises nothing it cannot serve.

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
