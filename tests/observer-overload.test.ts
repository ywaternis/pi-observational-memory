import { describe, expect, it, vi } from "vitest";
import { ObserverStreamError, runObserver } from "../src/agents/observer/agent.js";

const overload = "Codex error: Our servers are currently overloaded. Please try again later";
const baseArgs = {
	model: {} as any,
	priorReflections: [],
	priorObservations: [],
	chunk: "[Source entry id: a]\nUser requested a memory update.",
	allowedSourceEntryIds: ["a"],
};

function loopWithFailures(failures: number, errorMessage = overload, stopReason = "error") {
	let calls = 0;
	return vi.fn((_prompts: any, context: any) => {
		const failed = ++calls <= failures;
		return {
			async *[Symbol.asyncIterator]() {
				if (failed) yield { type: "message_end", message: { role: "assistant", stopReason, errorMessage } };
			},
			result: async () => {
				if (!failed) await context.tools[0].execute("record", {
					observations: [{ timestamp: "2026-05-02 10:30", content: "User requested a memory update.", relevance: "high", sourceEntryIds: ["a"] }],
				});
				return {};
			},
		};
	});
}

describe("observer overload recovery", () => {
	it("retries the reported Codex overload and returns recorded observations", async () => {
		const loop = loopWithFailures(1);
		const observations = await runObserver({ ...baseArgs, agentLoop: loop as any });
		expect(observations).toHaveLength(1);
		expect(observations?.[0].sourceEntryIds).toEqual(["a"]);
		expect(loop).toHaveBeenCalledTimes(2);
	});

	it("stops after three retries and preserves the provider error", async () => {
		const loop = loopWithFailures(Infinity);
		await expect(runObserver({ ...baseArgs, agentLoop: loop as any })).rejects.toThrow(overload);
		expect(loop).toHaveBeenCalledTimes(4);
	}, 10_000);

	it.each([
		["Invalid API key", "error"],
		["prompt is too long", "error"],
		[overload, "aborted"],
	])("does not retry %s (%s)", async (message, stopReason) => {
		const loop = loopWithFailures(Infinity, message, stopReason);
		await expect(runObserver({ ...baseArgs, agentLoop: loop as any })).rejects.toBeInstanceOf(ObserverStreamError);
		expect(loop).toHaveBeenCalledTimes(1);
	});

	it("cancels the backoff without starting another request", async () => {
		const controller = new AbortController();
		const loop = loopWithFailures(Infinity);
		const result = runObserver({ ...baseArgs, agentLoop: loop as any, signal: controller.signal });
		const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
		// Let the failed stream drain and the retry delay begin.
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await assertion;
		expect(loop).toHaveBeenCalledTimes(1);
	});
});
