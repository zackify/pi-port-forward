import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth, type SelectItem } from "@mariozechner/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
	DEFAULT_LOCAL_HOST,
	DEFAULT_REMOTE_HOST,
	type AllowedPort,
	type ProviderConfig,
	type PortForwardConfig,
	type RemotePort,
	type Forward,
	defaultAllowedPorts,
	defaultConfig,
	shellQuote,
	isValidPort,
	normalizeAllowedPorts,
	portLabel,
	isAllowedPort,
	normalizeString,
	normalizeSshOptions,
	normalizeProvider,
	normalizeCommand,
	loadConfig as utilsLoadConfig,
	localPortFor,
	forwardKey,
	localEndpoint as utilsLocalEndpoint,
	remoteEndpoint as utilsRemoteEndpoint,
	parsePorts as utilsParsePorts,
	isLocalPortFree as utilsIsLocalPortFree,
} from "./utils";

export type { AllowedPort, ProviderConfig, PortForwardConfig, RemotePort, Forward };
export {
	shellQuote,
	isValidPort,
	normalizeAllowedPorts,
	portLabel,
	isAllowedPort,
	normalizeString,
	normalizeSshOptions,
	normalizeProvider,
	normalizeCommand,
	loadConfig,
	localPortFor,
	forwardKey,
	localEndpoint,
	remoteEndpoint,
	parsePorts,
	isLocalPortFree,
};

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const WIDGET_ID = "port-forwards";

type InternalForward = {
	key: string;
	provider: ProviderConfig;
	remotePort: number;
	localPort: number;
	localHost: string;
	remoteHost: string;
	processName: string;
	remotePid?: number;
	child: ChildProcessWithoutNullStreams;
	startedAt: number;
	notifyOnExit: boolean;
	exited: boolean;
};

const forwards = new Map<string, InternalForward>();
let latestCtx: any;
let processHooksInstalled = false;

function loadConfig(): PortForwardConfig {
	return utilsLoadConfig(SETTINGS_PATH);
}

function localEndpoint(forward: Pick<InternalForward, "localHost" | "localPort">): string {
	return `${forward.localHost}:${forward.localPort}`;
}

function remoteEndpoint(provider: ProviderConfig, port: number): string {
	return utilsRemoteEndpoint(provider, port);
}

function parsePorts(provider: ProviderConfig, stdout: string): RemotePort[] {
	return utilsParsePorts(provider, stdout);
}

async function isLocalPortFree(host: string, port: number): Promise<boolean> {
	return utilsIsLocalPortFree(host, port);
}

async function getRemotePorts(pi: ExtensionAPI, provider: ProviderConfig): Promise<RemotePort[]> {
	const remoteScript = "ss -H -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true";
	const result = await pi.exec(
		"ssh",
		["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...provider.sshOptions, provider.remote, remoteScript],
		{ timeout: 8000 },
	);
	if (result.code !== 0 && !result.stdout.trim()) {
		throw new Error((result.stderr || `ssh exited ${result.code}`).trim());
	}
	return parsePorts(provider, result.stdout);
}

function stopForward(key: string, updateUi = true): boolean {
	const forward = forwards.get(key);
	if (!forward) return false;
	forwards.delete(key);
	forward.notifyOnExit = false;
	forward.child.kill("SIGTERM");
	setTimeout(() => {
		if (!forward.exited) forward.child.kill("SIGKILL");
	}, 1500).unref?.();
	if (updateUi) updateWidget(latestCtx);
	return true;
}

function stopAllForwards(updateUi = false): void {
	for (const key of [...forwards.keys()]) stopForward(key, updateUi);
}

async function startForward(remotePort: RemotePort): Promise<Forward> {
	const parentPid = process.pid;
	const localPort = remotePort.localPort;
	const provider = remotePort.provider;
	const sshArgs = [
		"-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=2",
		...provider.sshOptions,
		"-N",
		"-L", `${provider.localHost}:${localPort}:${provider.remoteHost}:${remotePort.port}`,
		provider.remote,
	];

	const script = `ssh ${sshArgs.map(shellQuote).join(" ")} &\n` +
		`child=$!\n` +
		`trap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null' EXIT INT TERM HUP\n` +
		`while kill -0 ${parentPid} 2>/dev/null; do\n` +
		`  if ! kill -0 "$child" 2>/dev/null; then wait "$child"; exit $?; fi\n` +
		`  sleep 1\n` +
		`done\n` +
		`kill "$child" 2>/dev/null\n` +
		`wait "$child" 2>/dev/null\n`;

	const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "ignore", "pipe"] });
	const forward: Forward = {
		key: remotePort.key,
		provider,
		remotePort: remotePort.port,
		localPort,
		localHost: provider.localHost,
		remoteHost: provider.remoteHost,
		processName: remotePort.processName,
		remotePid: remotePort.pid,
		child,
		startedAt: Date.now(),
		notifyOnExit: false,
		exited: false,
	} as Forward;
	forwards.set(remotePort.key, forward as InternalForward);

	let stderr = "";
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
		if (stderr.length > 4000) stderr = stderr.slice(-4000);
	});
	child.on("exit", (code, signal) => {
		forward.exited = true;
		exitCode = code;
		exitSignal = signal;
		const current = forwards.get(remotePort.key);
		if (current?.child === child) {
			forwards.delete(remotePort.key);
			if (forward.notifyOnExit) {
				latestCtx?.ui?.notify?.(
					`Forward ${localEndpoint(forward)} → ${remoteEndpoint(provider, remotePort.port)} stopped${code ? ` (${code})` : signal ? ` (${signal})` : ""}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
					code ? "error" : "info",
				);
			}
			updateWidget(latestCtx);
		}
	});

	await new Promise((resolve) => setTimeout(resolve, 800));
	if (forward.exited) {
		forwards.delete(remotePort.key);
		throw new Error(`ssh forward exited${exitCode ? ` with code ${exitCode}` : exitSignal ? ` with ${exitSignal}` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	}

	forward.notifyOnExit = true;
	updateWidget(latestCtx);
	return forward;
}

function installProcessHooks(): void {
	if (processHooksInstalled) return;
	processHooksInstalled = true;
	process.once("exit", () => stopAllForwards(false));
}

function updateWidget(ctx: any): void {
	if (!ctx?.hasUI) return;
	latestCtx = ctx;
	if (forwards.size === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(
		WIDGET_ID,
		(_tui: any, theme: any) => ({
			render(width: number): string[] {
				const lines = [theme.fg("accent", `↔ Forwarded ports (${forwards.size})`)];
				const list = [...forwards.values()].sort((a, b) => a.provider.label.localeCompare(b.provider.label) || a.remotePort - b.remotePort);
				for (let i = 0; i < list.length; i++) {
					const f = list[i];
					const prefix = i === list.length - 1 ? "└─" : "├─";
					const pid = f.remotePid ? ` pid ${f.remotePid}` : "";
					lines.push(truncateToWidth(`${theme.fg("dim", prefix)} ${localEndpoint(f)} → ${remoteEndpoint(f.provider, f.remotePort)} ${theme.fg("muted", `${f.processName}${pid}`)}`, width, "…"));
				}
				return lines;
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
	ctx.ui.requestRender?.();
}

export default function devPortForwardExtension(pi: ExtensionAPI) {
	installProcessHooks();
	const config = loadConfig();

	pi.registerCommand(config.command, {
		description: "Toggle SSH local port forwards from configured remotes",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			if (!ctx.hasUI) {
				ctx.ui.notify("/port requires interactive UI", "error");
				return;
			}
			if (config.providers.length === 0) {
				ctx.ui.notify("No SSH remotes configured. Add portForward.providers to ~/.pi/agent/settings.json.", "info");
				return;
			}

			const results = await Promise.all(config.providers.map(async (provider) => {
				try {
					return { provider, ports: await getRemotePorts(pi, provider), error: undefined as unknown };
				} catch (error) {
					return { provider, ports: [] as RemotePort[], error };
				}
			}));

			for (const result of results) {
				if (result.error) {
					ctx.ui.notify(`Could not list ports on ${result.provider.remote}: ${result.error instanceof Error ? result.error.message : String(result.error)}`, "error");
				}
			}

			const ports = results.flatMap((result) => result.ports);
			const activeOnly = [...forwards.values()].filter((f) => !ports.some((p) => p.key === f.key));
			const items: SelectItem[] = [
				...ports.map((p) => {
					const active = forwards.has(p.key);
					const pid = p.pid ? ` pid ${p.pid}` : "";
					return {
						value: p.key,
						label: `${active ? "●" : "○"} [${p.provider.label}] ${p.port} ${p.processName}${pid}`,
						description: active ? `forwarded at ${p.provider.localHost}:${p.localPort}; space to stop` : `${p.address}; space to forward to ${p.provider.localHost}:${p.localPort}`,
					};
				}),
				...activeOnly.map((f) => ({
					value: f.key,
					label: `● [${f.provider.label}] ${f.remotePort} ${f.processName}${f.remotePid ? ` pid ${f.remotePid}` : ""}`,
					description: `forwarded at ${localEndpoint(f)}; remote listener no longer shown; space to stop`,
				})),
			];

			const allowed = config.providers.map((p) => `${p.label}: ${portLabel(p.allowedPorts)}`).join("; ");
			if (items.length === 0) {
				ctx.ui.notify(`No listening TCP ports (${allowed}) found on configured remotes`, "info");
				return;
			}

			const portByKey = new Map(ports.map((p) => [p.key, p]));

			async function togglePort(key: string): Promise<void> {
				const existing = forwards.get(key);
				if (existing) {
					stopForward(key);
					ctx.ui.notify(`Stopped forward ${localEndpoint(existing)} → ${remoteEndpoint(existing.provider, existing.remotePort)}`, "info");
					return;
				}

				const port = portByKey.get(key);
				if (!port) {
					ctx.ui.notify("Port is no longer available", "error");
					return;
				}

				if (!(await isLocalPortFree(port.provider.localHost, port.localPort))) {
					ctx.ui.notify(`${port.provider.localHost}:${port.localPort} is already in use; not starting forward`, "error");
					return;
				}

				try {
					const forward = await startForward(port);
					ctx.ui.notify(`Forwarding ${localEndpoint(forward)} → ${remoteEndpoint(port.provider, port.port)} (${port.processName})`, "success");
				} catch (error) {
					ctx.ui.notify(`Could not start forward: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selected = 0;
				let busy = false;
				const maxVisible = Math.min(items.length, config.maxVisible);

				function renderItem(item: SelectItem, isSelected: boolean, width: number): string[] {
					const key = String(item.value);
					const active = forwards.has(key);
					const marker = active ? theme.fg("success", "●") : theme.fg("dim", "○");
					const prefix = isSelected ? theme.fg("accent", "› ") : "  ";
					const label = String(item.label).replace(/^[●○] /, "");
					const line = `${prefix}${marker} ${isSelected ? theme.fg("accent", label) : label}`;
					const existing = forwards.get(key);
					const description = existing ? `forwarded at ${localEndpoint(existing)}; space to stop` : item.description;
					const desc = description ? `    ${theme.fg("muted", description)}` : "";
					return desc
						? [truncateToWidth(line, width, "…"), truncateToWidth(desc, width, "…")]
						: [truncateToWidth(line, width, "…")];
				}

				return {
					render(width: number): string[] {
						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold(`Ports (${allowed})`)), 1, 0));
						const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), items.length - maxVisible));
						const end = Math.min(items.length, start + maxVisible);
						const lines: string[] = [];
						for (let i = start; i < end; i++) lines.push(...renderItem(items[i], i === selected, width));
						if (items.length > maxVisible) lines.push(theme.fg("dim", `  ${start + 1}-${end} of ${items.length}`));
						container.addChild(new Text(lines.join("\n"), 0, 0));
						container.addChild(new Text(theme.fg("dim", busy ? "toggling…" : "↑↓ navigate • space toggle more • enter toggle and close • esc close"), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						return container.render(width);
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
						else if (matchesKey(data, Key.down)) selected = Math.min(items.length - 1, selected + 1);
						else if (matchesKey(data, Key.escape)) done();
						else if (matchesKey(data, Key.enter) && !busy) {
							busy = true;
							void togglePort(String(items[selected].value)).finally(() => {
								busy = false;
								done();
							});
						} else if (matchesKey(data, Key.space) && !busy) {
							busy = true;
							void togglePort(String(items[selected].value)).finally(() => {
								busy = false;
								tui.requestRender();
							});
						}
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAllForwards(false);
	});
}
