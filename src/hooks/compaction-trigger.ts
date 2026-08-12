import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;
		// Another extension may have started work from an earlier settlement handler.
		if (!ctx.isIdle()) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		try {
			ctx.compact({
				onComplete: () => {
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
				},
				onError: (error: { message: string }) => {
					runtime.compactInFlight = false;
					if (error.message === "Compaction cancelled") {
						// The compaction hook already notified the user with the cancellation reason.
						return;
					}
					if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
				},
			});
		} catch (error) {
			runtime.compactInFlight = false;
			const msg = error instanceof Error ? error.message : String(error);
			if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
		}
	});
}
