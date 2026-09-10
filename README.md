# pi-plan

[![pi-plan — extension for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-plan-mode/main/docs/cover.png)](https://pi.dev)

Read-only planning with an approval step and tracked execution in Pi.

`@prjct.app/pi-plan` · Planning commands and progress UI; one extension.

## Install

Requires Pi installed separately and Node.js **22.19 or later**. Compatibility is tested with **Pi 0.85.1**; newer versions are not yet verified. This is an independent community package.

Install with Pi's package manager:

```sh
pi install npm:@prjct.app/pi-plan
```

For project-only installation, add `-l`: `pi install -l npm:@prjct.app/pi-plan`. Restart Pi after installation. Do not install the same extension from both GitHub and npm: Pi treats those as different package identities.

## Usage

| Entry point | Behavior |
| --- | --- |
| `/plan` | Toggle planning mode |
| `Ctrl+Alt+P` | Toggle planning mode from the keyboard |
| `/todos` | Show the current plan's steps |
| `pi --plan` | Start with planning enabled after the extension is installed |

Run `/plan`, then ask Pi to investigate a concrete task. Numbered steps under a `Plan:` heading become a progress list. Choose whether to execute when prompted. During execution, `[DONE:n]` markers update completed steps.

Planning disables the managed `edit` and `write` tools and checks Bash calls against a read-only allowlist. Other custom tools and external processes can retain write capabilities. Plan mode is a workflow policy, not a security sandbox.

Install Pi Workflows separately if you also want `/work`, `/spec`, and the other workflow commands. Pi Plan works independently. Its integration event remains `plan-mode:enable` and its status key remains `plan-mode`, preserving compatibility with existing integrations.


## Manage the package

For an npm installation:

```sh
pi list
pi update npm:@prjct.app/pi-plan
pi remove npm:@prjct.app/pi-plan
```

Use `pi config` to enable or disable individual resources. Use `pi config -l` for project settings and add `-l` to removal when you installed locally.

To pin version 0.1.1, use `pi install npm:@prjct.app/pi-plan@0.1.1`. Pi skips pinned npm versions during package updates. For a Git installation, update or remove using the same `git:github.com/prjct-app/pi-plan-mode` source instead of the npm source.

When switching from GitHub to npm, remove the Git installation first, then install the npm package and restart Pi.

## Troubleshooting

If `/work` is unknown, install Pi Workflows too. If `/todos` is empty, ask for numbered steps under a `Plan:` heading. Restart after installation so the extension and CLI flag are registered.

## Package and API documentation

Uses documented tool selection, `tool_call`, commands, shortcuts, flags, `appendEntry()`, `pi.events`, and status/widget APIs.

See [Package structure and compatibility](docs/package.md) for the manifest, dependency policy, shipped resources, and official references. This package follows the [official Pi package guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md) and [extension API guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) for the tested version.

## Development

From a repository checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Pi loads the TypeScript entry point directly; no build step is required. To try this checkout for one run, use `pi -e .`. Tests use isolated temporary state and do not call model APIs. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE).

Third-party code or assets are credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the accompanying licenses are included.
