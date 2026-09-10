/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	// find/awk/sed/perl in-place or exec mutations
	/\bfind\b[^|]*\s(-delete|-exec\b|-ok\b)/i,
	/\bsed\s+-\w*i/i,
	/\bawk\s+-i\s*inplace\b/i,
	/\bperl\s+-\w*i/i,
	/\bxargs\b/i,
	/\bpatch\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean|restore|switch|worktree|rm|apply|am\b|reflog\s+expire)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*nl\b/,
	/^\s*readlink\b/,
	/^\s*realpath\b/,
	/^\s*basename\b/,
	/^\s*dirname\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|blame|grep|describe|rev-parse|ls-|config\s+--get)/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|ls|why|outdated|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

// Clean display text without changing its meaning: keep verbs such as
// "Delete" or "Remove" because stripping them inverts the step's intent.
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 100) {
		cleaned = `${cleaned.slice(0, 97)}...`;
	}
	return cleaned;
}

// Header accepted as "Plan:", "**Plan:**", "## Plan:", and similar variants.
const PLAN_HEADER = /(?:^|\n)\s*(?:#{1,6}\s+)?\*{0,2}Plan\*{0,2}\s*:\*{0,2}\s*\n/i;
const NUMBERED_STEP = /^\s*(\d+)[.)]\s+(.+)$/;
const CONTINUATION = /^\s+\S/;

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(PLAN_HEADER);
	if (!headerMatch || headerMatch.index === undefined) return items;

	const planSection = message.slice(headerMatch.index + headerMatch[0].length);
	for (const line of planSection.split("\n")) {
		const stepMatch = line.match(NUMBERED_STEP);
		if (stepMatch) {
			const cleaned = cleanStepText(stepMatch[2]);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
			continue;
		}
		// Indented sub-bullets belong to the previous step; skip them without
		// ending the section. Any other line ends the numbered plan, so later
		// numbered lists (e.g. verification steps) are never captured.
		if (items.length > 0 && line.trim().length > 0 && !CONTINUATION.test(line)) break;
	}
	return items;
}

// Extract the "**Verify:**" section: the exact commands that prove the plan.
export function extractVerification(message: string): string | undefined {
	const match = message.match(/(?:^|\n)\s*(?:#{1,6}\s+)?\*{0,2}Verify\*{0,2}\s*:\*{0,2}\s*/i);
	if (!match || match.index === undefined) return undefined;

	const lines: string[] = [];
	for (const line of message.slice(match.index + match[0].length).split("\n")) {
		if (line.trim().length === 0) {
			if (lines.length > 0) break;
			continue;
		}
		// Stop at the next section header such as "**Risks:**".
		if (lines.length > 0 && /^\s*(?:#{1,6}\s|\*{0,2}[A-Z][A-Za-z ]*\*{0,2}\s*:)/.test(line)) break;
		lines.push(line.trim().replace(/^[-*]\s+/, ""));
	}
	const text = lines
		.join("; ")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
	return text.length > 0 ? text.slice(0, 200) : undefined;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

export function progressBar(completed: number, total: number, width = 8): string {
	const ratio = total <= 0 ? 0 : completed / total;
	const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}
