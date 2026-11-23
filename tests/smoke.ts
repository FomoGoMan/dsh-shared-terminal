/** Smoke test: boot the plugin contract against a mock context and fake controller. */
import assert from "node:assert/strict";
import { name, inject, Config, apply } from "../lib/index.js";

// -- mock cordis context ----------------------------------------------------
const registered: any = {};
const sections: any[] = [];
const config = Config({});

const ctx: any = {
	terminalController: makeController(),
	tools: { register: (definition: any) => { registered[definition.name] = definition; } },
	systemPrompt: {
		section: (s: any) => sections.push(s),
		getSectionOrder: (key: string) => (key === "TOOL_PTY" ? 1700 : 0)
	}
};

// -- fake controller with one committed terminal -----------------------------
function makeController() {
	const writes: string[] = [];
	let idle = false;
	const handle = {
		write: async (data: string) => { writes.push(data); },
		inspectActivity: async () => ({ state: idle ? "idle" as const : "busy" as const, revision: writes.length })
	};
	const screen = "$ echo hi\nhi\n$ ";
	const terminal: any = {
		info: { id: "term-1", title: "zsh", shell: { path: "/bin/zsh", args: ["-i"], name: "zsh" }, cwd: "/tmp", cols: 120, rows: 40, state: "running", exitCode: null },
		handle,
		serializer: { serialize: () => screen },
		enqueue: async (task: () => any) => await task(),
		retention: { invalidate: () => { terminal.invalidated = (terminal.invalidated ?? 0) + 1; } },
		invalidated: 0
	};
	return {
		config: { maxInputBytes: 64 * 1024 },
		list: (sessionId: string) => [terminal.info],
		terminal: (_agent: any, id: string) => {
			if (id !== "term-1") throw new Error("Terminal no longer exists in this Session");
			return terminal;
		},
		writes: () => writes,
		setIdle: (v: boolean) => { idle = v; },
		wasInvalidated: () => terminal.invalidated > 0
	};
}

// -- contract checks ----------------------------------------------------------
assert.equal(name, "shared-terminal");
assert.ok(inject.includes("terminalController") && inject.includes("tools") && inject.includes("systemPrompt"), "inject list");
apply(ctx, config);
assert.deepEqual(sections.map((s) => s.name), ["tool:shared-terminal"], "system prompt section registered");
assert.deepEqual(Object.keys(registered).sort(), ["shared_terminal_list", "shared_terminal_read", "shared_terminal_send"], "three tools registered");

// -- tool behaviour -----------------------------------------------------------
const exec = { agent: { id: "sess-1" }, signal: new AbortController().signal };
const render = (tool: any, args: any, value: any) => tool.output.render(args, value)[0].text;

// list
const listed = await registered.shared_terminal_list.execute({}, exec);
assert.ok(Array.isArray(listed) && listed[0].id === "term-1", "list returns terminal info");
assert.match(render(registered.shared_terminal_list, {}, listed), /"term-1"/, "list render includes id");

// send with submit + wait
const controller = ctx.terminalController;
controller.setIdle(false);
const sent = await registered.shared_terminal_send.execute({ id: "term-1", text: "echo hi", waitMs: 300 }, exec);
assert.deepEqual(controller.writes(), ["echo hi\n"], "write appends Enter");
assert.ok(controller.wasInvalidated(), "retention invalidated on write");
assert.match(render(registered.shared_terminal_send, {}, sent), /wait window elapsed/, "reports the wait outcome");
assert.match(render(registered.shared_terminal_send, {}, sent), /\$ echo hi/, "returns screen content");

// send with idle shell → prompt wait resolves as idle
controller.setIdle(true);
const sent2 = await registered.shared_terminal_send.execute({ id: "term-1", text: "ls", waitMs: 2000 }, exec);
assert.match(render(registered.shared_terminal_send, {}, sent2), /shell looks idle/, "idle wait resolves");

// send partial input (no Enter)
await registered.shared_terminal_send.execute({ id: "term-1", text: "sudo ", submit: false, waitMs: 0 }, exec);
assert.equal(controller.writes().at(-1), "sudo ", "submit:false sends no newline");

// read
const read = await registered.shared_terminal_read.execute({ id: "term-1" }, exec);
assert.equal(render(registered.shared_terminal_read, {}, read), "$ echo hi\nhi\n$", "read returns serialized screen (trailing whitespace trimmed)");

// lines parameter clamps the tail
const read3 = await registered.shared_terminal_read.execute({ id: "term-1", lines: 1 }, exec);
assert.equal(render(registered.shared_terminal_read, { lines: 1 }, read3), "$", "lines:1 returns one row");

// error paths
await assert.rejects(() => registered.shared_terminal_send.execute({ id: "nope", text: "x" }, exec), /no longer exists/);
await assert.rejects(() => registered.shared_terminal_read.execute({ id: "" }, exec), /non-empty/);

// finalizeContent bounds oversized rendered text
const bounded = registered.shared_terminal_read.finalizeContent(exec, { content: [{ type: "text", text: "x".repeat(500) }] });
assert.ok(bounded[0].text.length <= 500, "finalizer bounds bytes");

console.log("smoke test OK —", Object.keys(registered).join(", "));
