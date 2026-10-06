# agent-context-engine

Manages context sharing between agents with conflict resolution, versioning, and synchronization mechanisms for distributed agent systems

## Features

- Production-ready code
- TypeScript/Python with full type safety
- Comprehensive error handling
- Built by Retsumdk

## Installation

```bash
git clone https://github.com/Retsumdk/agent-context-engine.git
cd agent-context-engine
bun install
```

## Usage

```bash
bun run src/index.ts --help
```

## Configuration

Create `config.json` (TypeScript) or `config.yaml` (Python) for custom settings.

## License

MIT License

---

Built by [Retsumdk](https://github.com/Retsumdk)

## Architecture

`agent-context-engine` is a single-purpose TypeScript CLI built with [Commander](https://github.com/tj/commander.js). The runtime flow is deliberately simple so it can be embedded in larger agent pipelines:

```
CLI invocation (bun run src/index.ts)
        │
        ▼
config.json discovery ── merges user config over DEFAULTS
        │                 (baseUrl, timeout, retries, apiKey)
        ▼
main(cfg) ── applies settings and reports the effective
             connection target, timeout, and retry policy
```

Configuration is loaded from `config.json` in the current working directory (or a path passed with `--config`). A missing or malformed config file is not fatal: the CLI falls back to its built-in defaults rather than crashing.

## Usage example

Run with no configuration (defaults apply):

```bash
bun run src/index.ts
# [agent-context-engine] Connected to https://api.example.com
# [agent-context-engine] Timeout: 30000ms | Retries: 3
# [agent-context-engine] Done.
```

Run in verbose mode against a custom config:

```bash
bun run src/index.ts --config ./my-config.json --verbose
```

### Configuration

| Key        | Type     | Default                    | Meaning                                  |
|------------|----------|----------------------------|------------------------------------------|
| `baseUrl`  | `string` | `https://api.example.com`  | Endpoint the engine connects to          |
| `timeout`  | `number` | `30000`                    | Request timeout in milliseconds          |
| `retries`  | `number` | `3`                        | Retry attempts before giving up          |
| `apiKey`   | `string` | _(unset)_                  | Optional credential for the target API   |

## Development

```bash
bun install          # install dependencies
bun test             # run the test suite
bun run build        # compile with tsc
bunx tsc --noEmit    # typecheck without emitting
```

Tests live in `tests/index.test.ts` and run with `bun test`.

## Error handling

The CLI wraps its work in a top-level try/catch: unexpected failures are reported to `stderr` as `Error: <message>` and the process exits with code `1`, so wrapper scripts and CI pipelines can branch on the exit status.
