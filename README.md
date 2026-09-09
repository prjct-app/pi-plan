# pi-plan-mode

Read-only planning and tracked execution for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

## Features

- `/plan` and `Ctrl+Alt+P` toggle read-only exploration.
- Built-in `edit` and `write` tools are disabled while planning.
- Bash tool calls are checked against a read-only allowlist through Pi's documented `tool_call` event.
- Numbered steps under a `Plan:` heading become a progress widget.
- The user explicitly chooses whether to execute the plan.
- `[DONE:n]` markers update progress.
- State survives reload and resume through `appendEntry()`.
- `pi.events` exposes the documented `plan-mode:enable` integration event used by `pi-workflow-actions`.
- Plan status is published through `ctx.ui.setStatus()` for Pi's native footer or compatible custom footers.

The package does not load, switch, or save themes.

## Install

```sh
pi install git:github.com/prjct-app/pi-plan-mode
```

For `/work` and the other composite workflow commands, also install:

```sh
pi install git:github.com/prjct-app/pi-workflow-actions
```

Restart Pi after installation. The package has not been published to npm.

## Compatibility and boundaries

Tested with Pi `0.85.1` and Node.js `22.19+`. Plan mode is a tool-policy workflow, not a security sandbox. Other active custom tools remain available unless they identify as Pi's managed write tools, and a model or external process may still have capabilities outside this extension.

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

Tests exercise registered commands and events without importing Pi's internal interactive-mode implementation.

## Provenance

The implementation is adapted from Pi's plan-mode example under the MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
