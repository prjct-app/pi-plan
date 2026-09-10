/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Structured plans: Goal, Approach, numbered steps, Verify, Risks
 * - Plan review dialog (execute / refine / stay / discard)
 * - [DONE:n] markers to complete steps during execution
 * - Progress widget with bar, current-step highlight, and footer status
 * - Custom renderers for plan, execution, and completion messages
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { PLAN_MODE_ENABLE_EVENT, type PlanModeEnableRequest } from "./events.ts";
import {
	extractTodoItems,
	extractVerification,
	isSafeCommand,
	markCompletedSteps,
	progressBar,
	type TodoItem,
} from "./utils.ts";

// Tools
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

// Custom message types that carry instructions. They are only relevant while
// their mode is active and are filtered out of the model context afterwards.
const PLAN_INSTRUCTION_TYPE = "plan-mode-context";

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	verify?: string;
	toolsBeforePlanMode?: string[];
}

interface PlanListDetails {
	steps: TodoItem[];
	verify?: string;
}

type ReviewChoice = "execute" | "refine" | "stay" | "discard";

const PLAN_MODE_PROMPT = `[PLAN MODE ACTIVE]
You are in plan mode: read-only exploration before any edit.

Restrictions:
- The edit and write tools are disabled.
- Bash is limited to an allowlist of read-only commands.
- Never attempt changes; describe exactly what you would change instead.

Process:
1. Investigate first: open the real files, symbols, and tests involved. Do not speculate about code you have not read.
2. If the request is ambiguous or has multiple viable approaches, ask the user (ask_user when available) before finalizing the plan.
3. Produce the plan in exactly this format:

**Goal:** one sentence describing the end state
**Approach:** 2-3 sentences on the strategy and key trade-offs

Plan:
1. Imperative step naming the concrete file(s)/symbol(s) and the change
2. ...

**Verify:** the exact command(s) that prove the plan succeeded
**Risks:** one line per risk, only when real risks exist

Rules:
- 3 to 8 steps, ordered by dependency, each independently checkable.
- Every step must reference real paths or symbols found during investigation.
- No filler steps such as "run tests" or "update docs" unless the user asked; the Verify section covers validation.
- Keep each step to one line; put file lists or notes as indented sub-bullets under its step.`;

function executionRules(verify: string | undefined): string {
	const verification = verify
		? `When every step is done, verify with: ${verify} — and report the actual result.`
		: "When every step is done, run the project's verification commands and report the actual result.";
	return `Rules:
- If a step is blocked, explain why and continue with the next unblocked step.
- Include a [DONE:n] tag in your response only after step n is actually applied.
- ${verification}`;
}

// Kickoff message: the full approved plan, sent once when execution starts.
function executionKickoffPrompt(todos: TodoItem[], verify: string | undefined): string {
	const stepList = todos.map((t) => `${t.step}. ${t.text}`).join("\n");
	const first = todos.find((t) => !t.completed);
	return `[EXECUTING PLAN - Full tool access restored]

Approved steps:
${stepList}

Complete the steps in order, starting with step ${first?.step ?? 1}${first ? `: ${first.text}` : ""}.
${executionRules(verify)}`;
}

// Per-start injection: progress plus only the remaining steps. Completed
// steps are already visible in the transcript and would be stale noise.
function executionContextPrompt(todos: TodoItem[], verify: string | undefined): string {
	const doneCount = todos.filter((t) => t.completed).length;
	const remaining = todos.filter((t) => !t.completed);
	const stepList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
	return `[EXECUTING PLAN - Full tool access restored]

Progress: ${doneCount}/${todos.length} steps complete.
Remaining steps:
${stepList}

${executionRules(verify)}`;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// Collapsed one-line transcript view (pi-team pattern).
function collapsed(text: string): Component {
	return {
		invalidate() {},
		render(width: number) {
			return [truncateToWidth(text, width)];
		},
	};
}

function formatStep(item: TodoItem, theme: Theme, current: TodoItem | undefined): string {
	if (item.completed) {
		return theme.fg("success", "✓ ") + theme.fg("muted", theme.strikethrough(item.text));
	}
	if (item === current) {
		return theme.fg("accent", "▸ ") + theme.fg("text", item.text);
	}
	return theme.fg("dim", "○ ") + theme.fg("muted", item.text);
}

function planListView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	const heading = `▸ Plan · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
	if (!expanded) return collapsed(`${heading} · Ctrl+O details`);
	const lines = [theme.fg("accent", theme.bold(heading))];
	for (const item of steps) lines.push(`${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`);
	if (details?.verify) lines.push(theme.fg("muted", `Verify: ${details.verify}`));
	return new Text(lines.join("\n"), 1, 0);
}

function planCompleteView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	const heading = `▸ Plan complete ✓ · ${steps.length}/${steps.length}`;
	if (!expanded) return collapsed(heading);
	const lines = [theme.fg("success", theme.bold(heading))];
	for (const item of steps) lines.push(theme.fg("muted", `✓ ${item.text}`));
	if (details?.verify) lines.push(theme.fg("muted", `Verified with: ${details.verify}`));
	return new Text(lines.join("\n"), 1, 0);
}

function planExecuteView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	const first = steps.find((t) => !t.completed);
	const heading = `▸ Execute plan · start at step ${first?.step ?? 1} of ${steps.length}`;
	if (!expanded) return collapsed(`${heading} · Ctrl+O details`);
	const lines = [theme.fg("accent", theme.bold(heading))];
	for (const item of steps) lines.push(`${item.step}. ${item.text}`);
	if (details?.verify) lines.push(theme.fg("muted", `Verify: ${details.verify}`));
	return new Text(lines.join("\n"), 1, 0);
}

export function installPlan(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let planVerify: string | undefined;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `▸ plan ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			const drafted = todoItems.length > 0 ? ` · ${todoItems.length} steps ready` : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `⏸ plan${drafted}`));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Progress widget below the editor while executing
		if (executionMode && todoItems.length > 0) {
			ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
				invalidate() {},
				render(width: number) {
					const total = todoItems.length;
					const doneCount = todoItems.filter((t) => t.completed).length;
					const pct = Math.round((doneCount / total) * 100);
					const barColor = doneCount === total ? "success" : "accent";
					const current = todoItems.find((t) => !t.completed);
					const lines = [
						theme.fg("accent", theme.bold(`▸ Plan ${doneCount}/${total}`)) +
							" " +
							theme.fg(barColor, progressBar(doneCount, total)) +
							theme.fg("muted", ` ${pct}%`),
					];
					for (const item of todoItems) lines.push(formatStep(item, theme, current));
					if (planVerify) lines.push(theme.fg("dim", `Verify: ${planVerify}`));
					return lines.map((line) => truncateToWidth(line, width));
				},
			}));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(uniqueToolNames(toolsBeforePlanMode.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name))));
	}

	function restoreNormalModeTools(): void {
		if (toolsBeforePlanMode !== undefined) {
			pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			verify: planVerify,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function enablePlanMode(ctx: ExtensionContext, source?: string): void {
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		planVerify = undefined;
		enablePlanModeTools();
		ctx.ui.notify(
			source
				? `Plan mode enabled by ${source}. Write tools disabled; bash is read-only.`
				: "Plan mode enabled. Write tools disabled; bash is read-only.",
			"info",
		);
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext, reason = "Plan mode disabled. Full access restored."): void {
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		planVerify = undefined;
		restoreNormalModeTools();
		ctx.ui.notify(reason, "info");
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			disablePlanMode(ctx);
		} else {
			enablePlanMode(ctx);
		}
	}

	// Bordered SelectList dialog (documented TUI Pattern 1).
	function planReviewDialog(ctx: ExtensionContext): Promise<ReviewChoice | null> {
		return ctx.ui.custom<ReviewChoice | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(`Plan ready · ${todoItems.length} steps`)), 1, 0),
			);
			container.addChild(
				new Text(todoItems.map((t) => theme.fg("muted", ` ${t.step}. ${t.text}`)).join("\n"), 1, 0),
			);
			if (planVerify) container.addChild(new Text(theme.fg("dim", ` Verify: ${planVerify}`), 1, 0));

			const items: SelectItem[] = [
				{ value: "execute", label: "Execute the plan", description: "Restore full tools and track step progress" },
				{ value: "refine", label: "Refine the plan", description: "Send feedback and keep planning" },
				{ value: "stay", label: "Stay in plan mode", description: "Keep read-only exploration" },
				{ value: "discard", label: "Discard the plan", description: "Exit plan mode and drop these steps" },
			];
			const list = new SelectList(items, items.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value as ReviewChoice);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc stay in plan mode"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	function showTodosDialog(ctx: ExtensionContext): Promise<null> {
		const total = todoItems.length;
		const doneCount = todoItems.filter((t) => t.completed).length;
		return ctx.ui.custom<null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			const title = executionMode
				? `Executing plan · ${doneCount}/${total} done`
				: planModeEnabled
					? `Draft plan · ${total} steps`
					: `Plan · ${doneCount}/${total} done`;
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			const current = todoItems.find((t) => !t.completed);
			container.addChild(
				new Text(todoItems.map((item) => ` ${item.step}. ${formatStep(item, theme, current)}`).join("\n"), 1, 0),
			);
			if (planVerify) container.addChild(new Text(theme.fg("dim", ` Verify: ${planVerify}`), 1, 0));
			container.addChild(new Text(theme.fg("dim", "esc/enter close"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done(null);
					tui.requestRender();
				},
			};
		});
	}

	pi.events.on(PLAN_MODE_ENABLE_EVENT, (data) => {
		const request = data as PlanModeEnableRequest;
		if (!request?.ctx || typeof request.source !== "string") return;

		enablePlanMode(request.ctx, request.source);
		request.handled = true;
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show the current plan steps and progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No plan steps. Create a plan first with /plan", "info");
				return;
			}
			if (!ctx.hasUI) {
				const list = todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
				ctx.ui.notify(`Plan:\n${list}`, "info");
				return;
			}
			await showTodosDialog(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.registerEntryRenderer<PlanListDetails>("plan-todo-list", (entry, { expanded }, theme) =>
		planListView(entry.data, expanded, theme),
	);
	pi.registerEntryRenderer<PlanListDetails>("plan-complete", (entry, { expanded }, theme) =>
		planCompleteView(entry.data, expanded, theme),
	);
	pi.registerMessageRenderer<PlanListDetails>("plan-mode-execute", (message, { expanded }, theme) =>
		planExecuteView(message.details, expanded, theme),
	);

	// In plan mode, block writes defensively (even if another extension
	// re-adds them) and restrict bash to the read-only allowlist.
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is disabled. Present the plan and get approval before editing.`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter stale instruction messages so old mode prompts never accumulate
	// in the model context. Each mode keeps only its LATEST injected copy;
	// older duplicates are dropped. Display entries (plan list, completion)
	// live outside the LLM context entirely (appendEntry, not sendMessage).
	pi.on("context", async (event) => {
		const messages = event.messages;
		let lastPlanInstruction = -1;
		let lastExecutionInstruction = -1;
		messages.forEach((m, i) => {
			const customType = (m as { customType?: string }).customType;
			if (customType === PLAN_INSTRUCTION_TYPE) lastPlanInstruction = i;
			if (customType === "plan-execution-context") lastExecutionInstruction = i;
		});

		return {
			messages: messages.filter((m, i) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === PLAN_INSTRUCTION_TYPE) return planModeEnabled && i === lastPlanInstruction;
				if (msg.customType === "plan-execution-context") return executionMode && i === lastExecutionInstruction;
				if (msg.customType === "plan-mode-execute") return executionMode;
				if (msg.role !== "user") return true;

				// Legacy sessions stored the plan-mode prompt as plain user text.
				const content = msg.content;
				if (typeof content === "string") {
					return planModeEnabled || !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return (
						planModeEnabled ||
						!content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"))
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: PLAN_INSTRUCTION_TYPE,
					content: PLAN_MODE_PROMPT,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			return {
				message: {
					customType: "plan-execution-context",
					content: executionContextPrompt(todoItems, planVerify),
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				// Display-only record; kept out of the LLM context on purpose.
				pi.appendEntry("plan-complete", {
					steps: todoItems,
					verify: planVerify,
				} satisfies PlanListDetails);
				executionMode = false;
				todoItems = [];
				planVerify = undefined;
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract the plan from the last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			const extracted = extractTodoItems(text);
			if (extracted.length > 0) {
				todoItems = extracted;
				planVerify = extractVerification(text);
			}
		}

		if (todoItems.length === 0) return;
		updateStatus(ctx);
		persistState();

		const choice = await planReviewDialog(ctx);

		if (choice === "execute") {
			const details: PlanListDetails = { steps: todoItems, verify: planVerify };

			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			// The step list is a display-only entry; only the kickoff instruction
			// enters the LLM context.
			pi.appendEntry("plan-todo-list", details);
			pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: executionKickoffPrompt(todoItems, planVerify),
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "refine") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.appendEntry("plan-todo-list", { steps: todoItems, verify: planVerify } satisfies PlanListDetails);
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		} else if (choice === "discard") {
			disablePlanMode(ctx, "Plan discarded. Full access restored.");
		}
		// "stay" or dialog cancelled: remain in plan mode.
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		// getBranch() scopes restore to this branch, never a fork's copy.
		const entries = ctx.sessionManager.getBranch();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e) => e.type === "custom" && e.customType === "plan-mode")
			.pop();

		if (planModeEntry?.type === "custom" && planModeEntry.data) {
			const data = planModeEntry.data as PlanModeState;
			planModeEnabled = data.enabled ?? planModeEnabled;
			todoItems = data.todos ?? todoItems;
			executionMode = data.executing ?? executionMode;
			planVerify = data.verify ?? planVerify;
			toolsBeforePlanMode = data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "custom_message" && entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}

export default function planModeExtension(pi: ExtensionAPI): void {
	installPlan(pi);
}
