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
import { ON_OFF, SYMBOL, brand, completer, openPanel, row, setMode } from "@prjct.app/pi-tui-kit";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Key,
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
function formatStep(item: TodoItem, theme: Theme, current: TodoItem | undefined): string {
	if (item.completed) {
		return theme.fg("success", "✓ ") + theme.fg("muted", theme.strikethrough(item.text));
	}
	if (item === current) {
		return theme.fg("accent", "▸ ") + theme.fg("text", item.text);
	}
	return theme.fg("dim", "○ ") + theme.fg("muted", item.text);
}

/** Collapsed: one row in the shared grammar. Expanded: the row, then the steps. */
function planRow(theme: Theme, symbol: string, tone: "accent" | "success" | "muted", target: string, meta: string, body: string[], expanded: boolean): Component {
	const head = row(theme, { symbol, tone, verb: "PLAN", target, meta });
	if (!expanded || !body.length) return head;
	const container = new Container();
	container.addChild(head);
	container.addChild(new Text(body.join("\n"), 2, 0));
	return container;
}

const stepCount = (steps: readonly TodoItem[]): string => `${steps.length} step${steps.length === 1 ? "" : "s"}`;

function planListView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	const done = steps.filter((item) => item.completed).length;
	return planRow(theme, SYMBOL.idle, "muted", `drafted · ${stepCount(steps)}`, `${done}/${steps.length} done`, [
		...steps.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`),
		...(details?.verify ? [theme.fg("muted", `Verify: ${details.verify}`)] : []),
	], expanded);
}

function planCompleteView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	return planRow(theme, SYMBOL.ok, "success", `complete · ${stepCount(steps)}`, `${steps.length}/${steps.length} done`, [
		...steps.map((item) => theme.fg("muted", `✓ ${item.text}`)),
		...(details?.verify ? [theme.fg("muted", `Verified with: ${details.verify}`)] : []),
	], expanded);
}

function planExecuteView(details: PlanListDetails | undefined, expanded: boolean, theme: Theme): Component {
	const steps = details?.steps ?? [];
	const first = steps.find((t) => !t.completed);
	return planRow(theme, SYMBOL.active, "accent", `execute · from step ${first?.step ?? 1} of ${steps.length}`, "started", [
		...steps.map((item) => `${item.step}. ${item.text}`),
		...(details?.verify ? [theme.fg("muted", `Verify: ${details.verify}`)] : []),
	], expanded);
}

export function installPlan(pi: ExtensionAPI): void {
	const session = {
		planModeEnabled: false,
		executionMode: false,
		todoItems: [] as TodoItem[],
		planVerify: undefined as string | undefined,
		toolsBeforePlanMode: undefined as string[] | undefined,
	};

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
		if (session.executionMode && session.todoItems.length > 0) {
			const completed = session.todoItems.filter((t) => t.completed).length;
			setMode(ctx, "plan", `plan ${completed}/${session.todoItems.length}`);
		} else if (session.planModeEnabled) {
			const drafted = session.todoItems.length > 0 ? ` · ${session.todoItems.length} step${session.todoItems.length === 1 ? "" : "s"} ready` : "";
			setMode(ctx, "plan", `plan${drafted}`);
		} else {
			setMode(ctx, "plan", undefined);
		}

		// Progress widget below the editor while executing
		if (session.executionMode && session.todoItems.length > 0) {
			ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
				invalidate() {},
				render(width: number) {
					const total = session.todoItems.length;
					const doneCount = session.todoItems.filter((t) => t.completed).length;
					const current = session.todoItems.find((t) => !t.completed);
					const lines = [`${theme.fg("accent", theme.bold(`Plan ${doneCount}/${total}`))}  ${theme.fg("dim", "/todos")}`];
					for (const item of session.todoItems) lines.push(formatStep(item, theme, current));
					if (session.planVerify) lines.push(theme.fg("dim", `Verify: ${session.planVerify}`));
					return lines.map((line) => truncateToWidth(line, width));
				},
			}));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function enablePlanModeTools(): void {
		if (session.toolsBeforePlanMode === undefined) {
			session.toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(uniqueToolNames(session.toolsBeforePlanMode.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name))));
	}

	function restoreNormalModeTools(): void {
		if (session.toolsBeforePlanMode !== undefined) {
			pi.setActiveTools(session.toolsBeforePlanMode);
			session.toolsBeforePlanMode = undefined;
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: session.planModeEnabled,
			todos: session.todoItems,
			executing: session.executionMode,
			verify: session.planVerify,
			toolsBeforePlanMode: session.toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function enablePlanMode(ctx: ExtensionContext, source?: string): void {
		session.planModeEnabled = true;
		session.executionMode = false;
		session.todoItems = [];
		session.planVerify = undefined;
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
		session.planModeEnabled = false;
		session.executionMode = false;
		session.todoItems = [];
		session.planVerify = undefined;
		restoreNormalModeTools();
		ctx.ui.notify(reason, "info");
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (session.planModeEnabled) {
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
				new Text(theme.fg("accent", theme.bold(`Plan ready · ${session.todoItems.length} steps`)), 1, 0),
			);
			container.addChild(
				new Text(session.todoItems.map((t) => theme.fg("muted", ` ${t.step}. ${t.text}`)).join("\n"), 1, 0),
			);
			if (session.planVerify) container.addChild(new Text(theme.fg("dim", ` Verify: ${session.planVerify}`), 1, 0));

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

	/** /todos: the shared docked panel; steps on the left, the full step and plan state on the right. */
	function showTodosPanel(ctx: ExtensionContext): Promise<void> {
		return openPanel(ctx, {
			title: "Plan",
			summary: () => {
				const doneCount = session.todoItems.filter((t) => t.completed).length;
				const phase = session.executionMode ? "executing" : session.planModeEnabled ? "draft" : "done";
				return `${doneCount}/${session.todoItems.length} steps · ${phase}`;
			},
			items: () => {
				const current = session.todoItems.find((t) => !t.completed);
				return session.todoItems.map((item) => ({
					id: String(item.step),
					label: `${item.step}. ${item.text}`,
					symbol: item.completed ? SYMBOL.ok : item === current ? SYMBOL.active : SYMBOL.idle,
					tone: item.completed ? "success" : item === current ? "accent" : "muted",
					meta: item.completed ? "done" : item === current ? "next" : "",
				}));
			},
			detail: (row) => {
				const item = session.todoItems.find((t) => String(t.step) === row.id)!;
				return {
					title: `Step ${item.step} of ${session.todoItems.length}`,
					subtitle: item.completed ? "Done." : "Not done yet.",
					subtitleTone: item.completed ? "success" : "muted",
					fields: [
						{ label: "step", value: item.text },
						{ label: "plan", value: session.executionMode ? "executing" : session.planModeEnabled ? "draft, read-only" : "finished" },
						...(session.planVerify ? [{ label: "verify", value: session.planVerify }] : []),
					],
				};
			},
			actions: [
				{
					key: "d",
					label: (row) => (session.todoItems.find((t) => String(t.step) === row?.id)?.completed ? "Mark not done" : "Mark done"),
					when: (row) => !!row && session.executionMode,
					run: (row, panel) => {
						const item = session.todoItems.find((t) => String(t.step) === row!.id)!;
						item.completed = !item.completed;
						persistState();
						updateStatus(ctx);
						panel.notice(`Step ${item.step} ${item.completed ? "done" : "reopened"}.`, "success");
					},
				},
			],
			empty: "No plan steps. Create a plan first with /plan.",
		});
	}

	pi.events.on(PLAN_MODE_ENABLE_EVENT, (data) => {
		const request = data as PlanModeEnableRequest;
		if (!request?.ctx || typeof request.source !== "string") return;

		enablePlanMode(request.ctx, request.source);
		request.handled = true;
	});

	pi.registerCommand("plan", {
		description: brand("plan mode, read-only exploration: on | off (Ctrl+Alt+P toggles)"),
		getArgumentCompletions: completer(ON_OFF("plan mode")),
		handler: async (args, ctx) => {
			const word = args.trim().toLowerCase();
			if (word === "on") { if (!session.planModeEnabled) enablePlanMode(ctx); else ctx.ui.notify("Plan mode is already on.", "info"); return; }
			if (word === "off") { if (session.planModeEnabled) disablePlanMode(ctx); else ctx.ui.notify("Plan mode is already off.", "info"); return; }
			if (word) { ctx.ui.notify("Usage: /plan [on|off]. /plan alone toggles.", "warning"); return; }
			togglePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: brand("plan steps: panel with progress and done toggles"),
		handler: async (_args, ctx) => {
			if (session.todoItems.length === 0) {
				ctx.ui.notify("No plan steps. Create a plan first with /plan", "info");
				return;
			}
			if (!ctx.hasUI) {
				const list = session.todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
				ctx.ui.notify(`Plan:\n${list}`, "info");
				return;
			}
			await showTodosPanel(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: brand("toggle plan mode"),
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
		if (!session.planModeEnabled) return;

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

	// Instruction messages reach the model only while their mode is on. Every
	// copy stays while it is on: dropping older copies rewrote the history at
	// each turn and threw away the provider's prompt cache from that point on.
	// before_agent_start injects a copy only when it differs from the last one,
	// so copies do not pile up. Display entries (plan list, completion) live
	// outside the LLM context entirely (appendEntry, not sendMessage).
	pi.on("context", async (event) => {
		const messages = event.messages;
		return {
			messages: messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === PLAN_INSTRUCTION_TYPE) return session.planModeEnabled;
				if (msg.customType === "plan-execution-context") return session.executionMode;
				if (msg.customType === "plan-mode-execute") return session.executionMode;
				// Only extension-owned, typed messages are mode instructions. A
				// user may quote any marker while reporting a bug or correcting us.
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	// The last copy of an instruction already in the session; an identical one is not sent again.
	const lastInstruction = (ctx: ExtensionContext | undefined, customType: string): unknown => {
		const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as { type?: string; customType?: string; content?: unknown }[];
		for (const entry of [...branch].reverse()) {
			if (entry.type === "custom_message" && entry.customType === customType) return entry.content;
		}
		return undefined;
	};

	pi.on("before_agent_start", async (_event, ctx) => {
		if (session.planModeEnabled) {
			if (lastInstruction(ctx, PLAN_INSTRUCTION_TYPE) === PLAN_MODE_PROMPT) return;
			return {
				message: {
					customType: PLAN_INSTRUCTION_TYPE,
					content: PLAN_MODE_PROMPT,
					display: false,
				},
			};
		}

		if (session.executionMode && session.todoItems.length > 0) {
			const content = executionContextPrompt(session.todoItems, session.planVerify);
			if (lastInstruction(ctx, "plan-execution-context") === content) return;
			return {
				message: {
					customType: "plan-execution-context",
					content,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!session.executionMode || session.todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, session.todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (session.executionMode && session.todoItems.length > 0) {
			if (session.todoItems.every((t) => t.completed)) {
				// Display-only record; kept out of the LLM context on purpose.
				pi.appendEntry("plan-complete", {
					steps: session.todoItems,
					verify: session.planVerify,
				} satisfies PlanListDetails);
				session.executionMode = false;
				session.todoItems = [];
				session.planVerify = undefined;
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!session.planModeEnabled || !ctx.hasUI) return;

		// Extract the plan from the last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);
			const extracted = extractTodoItems(text);
			if (extracted.length > 0) {
				session.todoItems = extracted;
				session.planVerify = extractVerification(text);
			}
		}

		if (session.todoItems.length === 0) return;
		updateStatus(ctx);
		persistState();

		const choice = await planReviewDialog(ctx);

		if (choice === "execute") {
			const details: PlanListDetails = { steps: session.todoItems, verify: session.planVerify };

			session.planModeEnabled = false;
			session.executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			// The step list is a display-only entry; only the kickoff instruction
			// enters the LLM context.
			pi.appendEntry("plan-todo-list", details);
			pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: executionKickoffPrompt(session.todoItems, session.planVerify),
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "refine") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.appendEntry("plan-todo-list", { steps: session.todoItems, verify: session.planVerify } satisfies PlanListDetails);
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		} else if (choice === "discard") {
			disablePlanMode(ctx, "Plan discarded. Full access restored.");
		}
		// "stay" or dialog cancelled: remain in plan mode.
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setMode(ctx, "plan", undefined);
		ctx.ui.setWidget("plan-todos", undefined);
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			session.planModeEnabled = true;
		}

		// getBranch() scopes restore to this branch, never a fork's copy.
		const entries = ctx.sessionManager.getBranch();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e) => e.type === "custom" && e.customType === "plan-mode")
			.pop();

		if (planModeEntry?.type === "custom" && planModeEntry.data) {
			const data = planModeEntry.data as PlanModeState;
			session.planModeEnabled = data.enabled ?? session.planModeEnabled;
			session.todoItems = data.todos ?? session.todoItems;
			session.executionMode = data.executing ?? session.executionMode;
			session.planVerify = data.verify ?? session.planVerify;
			session.toolsBeforePlanMode = data.toolsBeforePlanMode ?? session.toolsBeforePlanMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && session.executionMode && session.todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			const executeIndex = Array.from(entries.keys()).reverse()
				.find((i) => entries[i]!.type === "custom_message" && entries[i]!.customType === "plan-mode-execute") ?? -1;

			// Only scan messages after the execute marker
			const messages = entries
				.slice(executeIndex + 1)
				.flatMap((entry) => entry.type === "message" && isAssistantMessage(entry.message as AgentMessage) ? [entry.message as AssistantMessage] : []);
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, session.todoItems);
		}

		if (session.planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}

export default function planModeExtension(pi: ExtensionAPI): void {
	installPlan(pi);
}
