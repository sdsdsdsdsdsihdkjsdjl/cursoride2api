# Context Test Probes

Manual long-context probes for the Anthropic-compatible `/v1/messages` endpoint.
These scripts are intended for local/operator validation, not CI: they create
large prompts, can run for several minutes, and can consume meaningful model
quota.

## Setup

Start the proxy first:

```bash
npm start
```

By default the probes call `http://localhost:3000/v1/messages`. Override that
when testing a remote deployment:

```bash
SERVER=http://host:port API_KEY=your-key npm run probe:niah
```

`API_KEY` is only needed when the proxy was started with `API_KEY` set.

## Scripts

- `npm run probe:context` runs `context-window-test.js`, a calibrated one-shot
  context window probe. It plants multiple `NEEDLE_*` codes through a large
  payload and asks the model to list every code it can find.
- `npm run probe:niah` runs `niah-test.js`, a quick Needle-In-A-Haystack sweep
  across several payload sizes with shallow and deep needles.
- `npm run probe:niah:repeat` runs `niah-repeat.js`, a repeated NIAH benchmark
  with shallow, middle, and deep needles across multiple reps and models.

## Useful Environment Variables

- `SERVER`: proxy base URL. Default: `http://localhost:3000`.
- `API_KEY`: bearer token for the proxy when auth is enabled.
- `MODEL`: model for `probe:context`. Default: `claude-opus-4-7`.
- `TARGET_K`: target token count in thousands for `probe:context`. Default: `1000`.
- `REPS`: repetitions per size/model for `probe:niah:repeat`. Default: `3`.

Examples:

```bash
TARGET_K=500 MODEL=claude-opus-4-7 npm run probe:context
REPS=1 SERVER=http://localhost:4141 npm run probe:niah:repeat
```
