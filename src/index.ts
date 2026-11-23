/**
 * dsh-shared-terminal — bridge the person's sidebar terminals to agent tools.
 *
 * The built-in `@deepseek-ai/dsh-api-terminal-controller` owns the terminals a
 * person opens in the Web right sidebar; the built-in `@deepseek-ai/dsh-tool-terminal`
 * owns owner-isolated agent sessions. Neither side can touch the other, so a
 * person who logs into a jump host by hand has no way to hand that authenticated
 * shell to the agent. This plugin closes that gap on the controller's own terms:
 * the agent gains three tools that list, type into, and read the screen of the
 * Session's *person-driven* terminals. Writes go through the terminal process
 * handle's PTY input (exactly what the sidebar's attach uplink feeds), so the
 * person watches every agent keystroke live in their tab; reads render the same
 * headless screen snapshot the UI shows. No new client UI, no new PTYs, no new
 * ownership domain — the sidebar stays the single display, and the person's
 * typed secrets never pass through the model.
 *
 * @module dsh-shared-terminal
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name. */
const name = "shared-terminal";

/** Host services this consumer needs: the sidebar terminal controller, the tool registry, and prompt guidance. */
const inject = ["terminalController", "tools", "systemPrompt"];

/** Default cap for one complete shared-terminal tool result. */
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

/** Longest bounded post-write wait, so a wedged remote host cannot hold a tool call. */
const MAX_WAIT_MS = 20_000;

/** Schemastery configuration for the shared terminal consumer. */
const Config = z.object({
	maxResultBytes: z.number().step(1).min(64).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESULT_BYTES),
	sendWaitMs: z.number().step(1).min(0).max(MAX_WAIT_MS).default(3_000)
});

/** The controller's runtime surface this bridge relies on (TS-private members are runtime-visible). */
interface SessionAgent {
	readonly id: string;
}

interface WebTerminalInfoLike {
	readonly id: string;
	readonly title: string;
	readonly shell: { readonly path: string; readonly args: readonly string[]; readonly name: string };
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	readonly state: "failed" | "running" | "exited";
	readonly exitCode: number | null;
	readonly error?: string;
}

/** The process handle every write from the sidebar's attach uplink goes through. */
interface TerminalHandleLike {
	write(data: string): Promise<void>;
	inspectActivity(): Promise<{ state: "idle" | "busy" | "unknown"; revision: number } | undefined>;
}

/** One committed sidebar terminal; private fields are accessed reflectively below. */
interface BrowserTerminalLike {
	readonly info: WebTerminalInfoLike;
	readonly handle: TerminalHandleLike;
	/** Headless screen model behind the UI's own rendering. */
	readonly serializer: { serialize(): string };
	/** Serialized operation queue the controller routes every attach command through. */
	enqueue<T>(task: () => T | Promise<T>): Promise<T>;
}

interface TerminalControllerLike {
	list(sessionId: string): WebTerminalInfoLike[];
	terminal(agent: SessionAgent, id: string): BrowserTerminalLike;
	readonly config: { readonly maxInputBytes: number };
}

//#region rendering

const encoder = new TextEncoder();
const TRUNCATED = "\n[output truncated]";

function byteLength(text: string): number {
	return encoder.encode(text).byteLength;
}

/** Tail-bound text to the configured result budget, keeping the freshest output. */
function boundText(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	let cut = text.length;
	while (cut > 0 && byteLength(text.slice(0, cut)) > maxBytes - byteLength(TRUNCATED)) cut = Math.floor(cut / 2);
	return TRUNCATED + text.slice(cut);
}

function textResult(text: string, maxBytes: number) {
	return [{ type: "text" as const, text: boundText(text, maxBytes) }];
}

function rawContentText(content: Array<{ type: string; text?: string }>): string | undefined {
	if (content.length !== 1) return undefined;
	return content[0]?.type === "text" ? content[0].text : undefined;
}

/** Final safety net: bound every rendered text result to the configured budget. */
function makeFinalizer(maxBytes: number) {
	return (_exec: unknown, result: { content: Array<{ type: string; text?: string }> }) => {
		const raw = rawContentText(result.content);
		return raw === undefined ? undefined : textResult(raw, maxBytes);
	};
}

/** The last `lines` rows of one full screen render, joined with newlines. */
function screenTail(screen: string, lines: number): string {
	const rows = screen.replace(/\n$/u, "").split("\n");
	return rows.slice(Math.max(0, rows.length - lines)).join("\n").replace(/\s+$/u, "");
}

//#endregion
//#region controller access

/**
 * Resolve one committed sidebar terminal. The controller's `terminal` accessor
 * is TS-private but a plain prototype method, and it applies the controller's
 * own Session ownership and closed-id checks before returning the terminal.
 */
function resolveTerminal(controller: TerminalControllerLike, agent: SessionAgent, id: string): BrowserTerminalLike {
	if (typeof id !== "string" || id.length === 0) throw new Error("id must be a non-empty string");
	return controller.terminal(agent, id);
}

/** Render the terminal's current screen exactly as the sidebar would, without taking input control. */
async function renderScreen(terminal: BrowserTerminalLike): Promise<string> {
	return await terminal.enqueue(async () => terminal.serializer.serialize());
}

/**
 * Wait for the shell to look idle again after submitted input. The bash backend
 * publishes shell activity (`shellActivity: true` at spawn); remote shells over
 * SSH may report `unknown`, in which case the wait simply runs out.
 */
async function waitForIdle(handle: TerminalHandleLike, waitMs: number, signal: AbortSignal): Promise<"idle" | "timeout"> {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline && !signal.aborted) {
		const activity = await handle.inspectActivity().catch(() => undefined);
		if (activity?.state === "idle") return "idle";
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return "timeout";
}

//#endregion
//#region tools

/** Register the shared terminal tools and their usage guidance. */
function apply(ctx: any, config: { maxResultBytes?: number; sendWaitMs?: number } = {}) {
	const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
	const sendWaitMs = config.sendWaitMs ?? 3_000;
	const finalizeContent = makeFinalizer(maxResultBytes);
	const controller = ctx.terminalController as TerminalControllerLike;
	if (controller === undefined) throw new Error("shared-terminal: the terminalController service is required — mount the web app's terminal-controller entry (dsh-web-app provides it by default)");

	ctx.systemPrompt.section({
		name: "tool:shared-terminal",
		order: ctx.systemPrompt.getSectionOrder("TOOL_PTY"),
		text: "The person's sidebar terminals are shared with you: shared_terminal_list shows them, shared_terminal_send types into them, shared_terminal_read reads their screen. Use these when the person asks you to take over a terminal they prepared (such as one already logged into a jump host); everything you type appears live in their tab, and every read reflects exactly what they see. The person types passwords and one-time codes themselves — never ask for or send credentials through these tools. For your own private shell state use terminal_open instead."
	});

	const LIST_SCHEMA = {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				id: { type: "string", required: true },
				title: { type: "string", required: true },
				shell: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						args: { type: "array", items: { type: "string" } },
						name: { type: "string", required: true }
					}
				},
				cwd: { type: "string", required: true },
				cols: { type: "integer", required: true },
				rows: { type: "integer", required: true },
				state: { type: "string", required: true },
				exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
				error: { type: "string" }
			}
		}
	};
	const SEND_SCHEMA = {
		type: "object",
		additionalProperties: false,
		properties: {
			detail: { type: "string", required: true },
			screen: { type: "string", required: true }
		}
	};

	ctx.tools.register(defineTool({
		name: "shared_terminal_list",
		description: "List the person's sidebar terminals in this Session (id, title, shell, directory, size, state). Use it to discover which terminal to take over with shared_terminal_send/shared_terminal_read.",
		parameters: {},
		finalizeContent,
		output: {
			schema: LIST_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: boundText(JSON.stringify(value, null, 2), maxResultBytes)
			}]
		},
		async execute(_args, exec) {
			// Normalize each controller info to exactly the declared shape, so the
			// strict output schema cannot drift away from the controller's value.
			return controller.list(exec.agent.id).map((t) => ({
				id: t.id,
				title: t.title,
				shell: { path: t.shell.path, args: [...t.shell.args], name: t.shell.name },
				cwd: t.cwd,
				cols: t.cols,
				rows: t.rows,
				state: t.state,
				exitCode: t.exitCode,
				...(t.error === undefined ? {} : { error: t.error })
			}));
		},
		presentCall: () => ({ card: "generic", title: "List shared terminals", kind: "read" })
	}));

	ctx.tools.register(defineTool({
		name: "shared_terminal_send",
		description: "Type text into one of the person's sidebar terminals, as if at their keyboard; the person sees it live. Enter is submitted by default. Optionally waits for the shell to look idle again, then returns the current screen.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Terminal id from shared_terminal_list."
			},
			text: {
				type: "string",
				required: true,
				description: "Text to deliver to the terminal input, without implicit newline conversion."
			},
			submit: {
				type: "boolean",
				description: "Append Enter after the text (default true). Set false for partial input such as a username before a password prompt."
			},
			waitMs: {
				type: "integer",
				description: `Bounded wait after submitting for the shell to look idle again (0-${MAX_WAIT_MS} ms, default ${sendWaitMs}).`
			}
		},
		finalizeContent,
		output: {
			schema: SEND_SCHEMA,
			render: (_args, value: { detail: string; screen: string }) => [{
				type: "text",
				text: boundText(`${value.detail}\n\n${screenTail(value.screen, 40)}`, maxResultBytes)
			}]
		},
		async execute(args, exec) {
			const terminal = resolveTerminal(controller, exec.agent, args.id);
			if (terminal.info.state !== "running") throw new Error(`terminal ${args.id} is ${terminal.info.state}, not running`);
			const data = args.text + (args.submit === false ? "" : "\n");
			if (encoder.encode(data).byteLength > controller.config.maxInputBytes) throw new Error("text exceeds the terminal's input byte limit");
			// Route through the controller's own operation queue — the exact path
			// every sidebar attach uplink write takes — so input and screen state
			// stay serialized with the person's own activity. Reset the retention
			// idle clock the same way that path does, so the unattended reaper
			// does not close a terminal the agent is actively driving.
			await terminal.enqueue(async () => {
				(terminal as { retention?: { invalidate(): void } }).retention?.invalidate();
				await terminal.handle.write(data);
			});
			const wait = args.waitMs === undefined ? sendWaitMs : Math.min(Math.max(0, args.waitMs), MAX_WAIT_MS);
			const outcome = wait > 0 ? await waitForIdle(terminal.handle, wait, exec.signal) : "idle";
			const screen = await renderScreen(terminal);
			const detail = outcome === "idle" ? "shell looks idle" : "wait window elapsed; screen may still be updating";
			return { detail, screen };
		},
		presentCall: (args: { id: string; text: string; submit?: boolean }) => ({
			card: "generic",
			title: `Type into ${args.id}${args.submit === false ? " (no Enter)" : ""}`,
			kind: "execute"
		})
	}));

	ctx.tools.register(defineTool({
		name: "shared_terminal_read",
		description: "Read one of the person's sidebar terminals as text — the exact screen they see. Does not take input control and never disturbs their typing.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Terminal id from shared_terminal_list."
			},
			lines: {
				type: "integer",
				description: "Last N screen rows to return (default 40)."
			}
		},
		finalizeContent,
		output: {
			schema: SEND_SCHEMA,
			render: (args: { lines?: number }, value: { screen: string }) => [{
				type: "text",
				text: boundText(screenTail(value.screen, Math.min(Math.max(1, args.lines ?? 40), 500)), maxResultBytes)
			}]
		},
		async execute(args, exec) {
			const terminal = resolveTerminal(controller, exec.agent, args.id);
			const screen = await renderScreen(terminal);
			return { detail: terminal.info.title, screen };
		},
		presentCall: (args: { id: string }) => ({ card: "generic", title: `Read terminal ${args.id}`, kind: "read" })
	}));
}

//#endregion

export { Config, DEFAULT_MAX_RESULT_BYTES, MAX_WAIT_MS, apply, inject, name };
