import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth, type SelectItem } from "@mariozechner/pi-tui";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const WIDGET_ID = "port-forwards";
const DEFAULT_LOCAL_HOST = "127.0.0.1";
const DEFAULT_REMOTE_HOST = "127.0.0.1";

type AllowedPort = number | { from: number; to: number };

type ProviderConfig = {
	id: string;
	remote: string;
	label: string;
	allowedPorts: AllowedPort[];
	localHost: string;
	remoteHost: string;
	localPortOffset: number;
	sshOptions: string[];
};

type PortForwardConfig = {
	command: string;
	providers: ProviderConfig[];
	maxVisible: number;
};

type RemotePort = {
	provider: ProviderConfig;
	key: string;
	port: number;
	localPort: number;
	address: string;
	processName: string;
	pid?: number;
	raw: string;
};

type Forward = {
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

const defaultAllowedPorts: AllowedPort[] = [3000, { from: 8080, to: 9000 }];
const defaultConfig: PortForwardConfig = {
	command: "port",
	providers: [],
	maxVisible: 15,
};

const forwards = new Map<string, Forward>();
let latestCtx: any;
let processHooksInstalled = false;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}

function normalizeAllowedPorts(value: unknown): AllowedPort[] {
	if (!Array.isArray(value)) return defaultAllowedPorts;
	const allowed = value.flatMap((entry): AllowedPort[] => {
		if (typeof entry === "number" && isValidPort(entry)) return [entry];
		if (
			entry && typeof entry === "object" &&
			isValidPort((entry as any).from) && isValidPort((entry as any).to) &&
			(entry as any).to >= (entry as any).from
		) return [{ from: (entry as any).from, to: (entry as any).to }];
		return [];
	});
	return allowed.length ? allowed : defaultAllowedPorts;
}

function portLabel(allowedPorts: AllowedPort[]): string {
	return allowedPorts.map((entry) => typeof entry === "number" ? String(entry) : `${entry.from}-${entry.to}`).join(", ");
}

function isAllowedPort(port: number, allowedPorts: AllowedPort[]): boolean {
	return allowedPorts.some((entry) => typeof entry === "number" ? port === entry : port >= entry.from && port <= entry.to);
}

function normalizeString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeSshOptions(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((option): option is string => typeof option === "string" && option.trim().length > 0).map((option) => option.trim()) : [];
}

function normalizeProvider(raw: any, index: number): ProviderConfig | undefined {
	const remote = typeof raw?.remote === "string" ? raw.remote.trim() : typeof raw?.ssh === "string" ? raw.ssh.trim() : "";
	if (!remote) return undefined;
	const label = typeof raw?.label === "string" && raw.label.trim()
		? raw.label.trim()
		: typeof raw?.hostLabel === "string" && raw.hostLabel.trim()
			? raw.hostLabel.trim()
			: remote.replace(/^[^@]+@/, "");
	const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : label || `remote-${index + 1}`;
	const localPortOffset = Number.isInteger(raw?.localPortOffset) ? raw.localPortOffset : 0;
	return {
		id,
		remote,
		label,
		allowedPorts: normalizeAllowedPorts(raw?.allowedPorts),
		localHost: normalizeString(raw?.localHost, DEFAULT_LOCAL_HOST),
		remoteHost: normalizeString(raw?.remoteHost, DEFAULT_REMOTE_HOST),
		localPortOffset,
		sshOptions: normalizeSshOptions(raw?.sshOptions),
	};
}

function normalizeCommand(value: unknown): string {
	const command = typeof value === "string" ? value.trim().replace(/^\//, "") : "";
	return command && !/\s/.test(command) ? command : defaultConfig.command;
}

function loadConfig(): PortForwardConfig {
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
		const raw = settings?.portForward ?? settings?.piPortForward;
		const providersRaw = Array.isArray(raw?.providers) ? raw.providers : Array.isArray(raw?.remotes) ? raw.remotes : [];
		const seenIds = new Set<string>();
		const providers = (providersRaw.map(normalizeProvider).filter(Boolean) as ProviderConfig[]).map((provider, index) => {
			let id = provider.id;
			if (seenIds.has(id)) id = `${id}-${index + 1}`;
			seenIds.add(id);
			return { ...provider, id };
		});
		return {
			command: normalizeCommand(raw?.command),
			providers,
			maxVisible: Number.isInteger(raw?.maxVisible) && raw.maxVisible > 0 ? raw.maxVisible : defaultConfig.maxVisible,
		};
	} catch {
		return defaultConfig;
	}
}

function localPortFor(provider: ProviderConfig, remotePort: number): number {
	return remotePort + provider.localPortOffset;
}

function forwardKey(provider: ProviderConfig, port: number): string {
	return `${provider.id}:${port}`;
}

function localEndpoint(forward: Pick<Forward, "localHost" | "localPort">): string {
	return `${forward.localHost}:${forward.localPort}`;
}

function remoteEndpoint(provider: ProviderConfig, port: number): string {
	return `${provider.label}:${provider.remoteHost}:${port}`;
}

function parsePorts(provider: ProviderConfig, stdout: string): RemotePort[] {
	const byPort = new Map<number, RemotePort>();
	for (const raw of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
		const tokens = raw.split(/\s+/);
		const local = tokens.find((token) => /:\d+$/.test(token.replace(/^\[|\]$/g, "")));
		if (!local) continue;

		const portMatch = local.match(/:(\d+)$/);
		if (!portMatch) continue;
		const port = Number(portMatch[1]);
		if (!isValidPort(port) || !isAllowedPort(port, provider.allowedPorts)) continue;
		const localPort = localPortFor(provider, port);
		if (!isValidPort(localPort)) continue;

		const address = local.replace(/:(\d+)$/, "").replace(/^\[|\]$/g, "");
		const procMatch = raw.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/);
		const processName = procMatch?.[1] ?? "unknown";
		const pid = procMatch?.[2] ? Number(procMatch[2]) : undefined;
		const key = forwardKey(provider, port);

		if (!byPort.has(port)) byPort.set(port, { provider, key, port, localPort, address, processName, pid, raw });
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
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

function isLocalPortFree(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen({ host, port }, () => {
			server.close(() => resolve(true));
		});
	});
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
	};
	forwards.set(remotePort.key, forward);

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
