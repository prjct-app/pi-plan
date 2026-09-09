import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_ENABLE_EVENT = "plan-mode:enable";

export interface PlanModeEnableRequest {
	ctx: ExtensionContext;
	source: string;
	handled?: boolean;
}
