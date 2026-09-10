# Changelog

## 0.2.0

- Upgrade the plan review step to a bordered selection dialog with Execute, Refine, Stay, and Discard actions, each with a description.
- Add custom transcript renderers for the plan list, execution kickoff, and completion messages with collapsed summaries and Ctrl+O expanded detail.
- Replace the plain todo widget with a progress view: completion bar, percentage, current-step highlight, strikethrough completed steps, and the plan's Verify command.
- Show drafted step counts in the footer while planning and `▸ plan n/total` while executing.
- Turn `/todos` into a themed dialog showing steps, progress, and verification; it falls back to a notification without a TUI.
- Produce structured plans: Goal, Approach, 3–8 numbered steps with concrete file references, a Verify section with exact commands, and Risks. Execution re-runs the Verify commands and reports the result.
- Keep step verbs intact during cleanup so steps such as "Delete the deprecated flag" are never inverted; stop plan extraction at the end of the numbered section so verification lists are not captured.
- Block `edit` and `write` defensively in plan mode, extend the Bash policy (`find -delete`/`-exec`, `sed -i`, `perl -i`, `git restore/clean/switch`, `xargs`, and more read-only inspection commands), and filter stale plan/execution instruction messages out of the model context.
- Restore state through the current session branch so forks never inherit plan state, and detect the execution marker from custom message entries.
- Export `installPlan()` and `extractVerification()` in the public API.

## 0.1.3

- Clarify the package description and add focused discovery keywords.
- Declare the cover image for the official Pi package gallery.

- Align repository, documentation, and cover URLs with the npm package name.

## 0.1.2

- Use a publicly accessible cover URL so npm renders the image for every visitor.

## 0.1.1

- Add a dedicated cover to the GitHub and npm README.
- Keep the existing extension behavior unchanged.

## 0.1.0

- Set the npm package identity to `@prjct.app/pi-plan`.
- Clarify installation, project scope, updates, removal, usage, and limitations.
- Document resource discovery and dependencies against the official Pi 0.85.1 guides.
- Include contribution and package documentation in the release file list.

Initial npm release. The documentation and naming changes preserve the existing extension runtime behavior.
