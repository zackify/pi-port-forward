// Utility functions exported for testing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_HOST = "127.0.0.1";

export type AllowedPort = number | { from: number; to: number };

export type ProviderConfig = {
	id: string;
	remote: string;
	label: string;
	allowedPorts: AllowedPort[];
	localHost: string;
	remoteHost: string;
	localPortOffset: number;
	sshOptions: string[];
};

export type PortForwardConfig = {
	command: string;
	providers: ProviderConfig[];
	maxVisible: number;
};

export type RemotePort = {
	provider: ProviderConfig;
	key: string;
	port: number;
	localPort: number;
	address: string;
	processName: string;
	pid?: number;
	raw: string;
};

export type Forward = {
	key: string;
	provider: ProviderConfig;
	remotePort: number;
	localPort: number;
	localHost: string;
	remoteHost: string;
	processName: string;
	remotePid?: number;
	child: import("node:child_process").ChildProcessWithoutNullStreams;
	startedAt: number;
	notifyOnExit: boolean;
	exited: boolean;
};

export const defaultAllowedPorts: AllowedPort[] = [3000, { from: 8080, to: 9000 }];
export const defaultConfig: PortForwardConfig = {
	command: "port",
	providers: [],
	maxVisible: 15,
};

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function normalizeAllowedPorts(value: unknown): AllowedPort[] {
	if (!Array.isArray(value)) return [...defaultAllowedPorts];
	const allowed = value.flatMap((entry): AllowedPort[] => {
		if (typeof entry === "number" && isValidPort(entry)) return [entry];
		if (
			entry && typeof entry === "object" &&
			isValidPort((entry as { from: number; to: number }).from) && isValidPort((entry as { from: number; to: number }).to) &&
			(entry as { from: number; to: number }).to >= (entry as { from: number; to: number }).from
		) return [{ from: (entry as { from: number; to: number }).from, to: (entry as { from: number; to: number }).to }];
		return [];
	});
	return allowed.length ? allowed : [...defaultAllowedPorts];
}

export function portLabel(allowedPorts: AllowedPort[]): string {
	return allowedPorts.map((entry) => typeof entry === "number" ? String(entry) : `${entry.from}-${entry.to}`).join(", ");
}

export function isAllowedPort(port: number, allowedPorts: AllowedPort[]): boolean {
	return allowedPorts.some((entry) => typeof entry === "number" ? port === entry : port >= entry.from && port <= entry.to);
}

export function normalizeString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeSshOptions(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((option): option is string => typeof option === "string" && option.trim().length > 0).map((option) => option.trim()) : [];
}

export function normalizeProvider(raw: unknown, index: number): ProviderConfig | undefined {
	const r = raw as any;
	const remote = typeof r?.remote === "string" ? r.remote.trim() : typeof r?.ssh === "string" ? r.ssh.trim() : "";
	if (!remote) return undefined;
	const label = typeof r?.label === "string" && r.label.trim()
		? r.label.trim()
		: typeof r?.hostLabel === "string" && r.hostLabel.trim()
			? r.hostLabel.trim()
			: remote.replace(/^[^@]+@/, "");
	const id = typeof r?.id === "string" && r.id.trim() ? r.id.trim() : label || `remote-${index + 1}`;
	const localPortOffset = Number.isInteger(r?.localPortOffset) ? r.localPortOffset : 0;
	return {
		id,
		remote,
		label,
		allowedPorts: normalizeAllowedPorts(r?.allowedPorts),
		localHost: normalizeString(r?.localHost, DEFAULT_LOCAL_HOST),
		remoteHost: normalizeString(r?.remoteHost, DEFAULT_REMOTE_HOST),
		localPortOffset,
		sshOptions: normalizeSshOptions(r?.sshOptions),
	};
}

export function normalizeCommand(value: unknown): string {
	const command = typeof value === "string" ? value.trim().replace(/^\//, "") : "";
	return command && !/\s/.test(command) ? command : defaultConfig.command;
}

// Export for testing - parses raw settings object
export function parseSettingsConfig(raw: unknown): PortForwardConfig {
	const providersRaw = Array.isArray(raw?.providers) ? raw.providers : Array.isArray(raw?.remotes) ? raw.remotes : [];
	const seenIds = new Set<string>();
	const providers = (providersRaw.map((p: unknown, i: number) => normalizeProvider(p, i)).filter(Boolean) as ProviderConfig[]).map((provider, index) => {
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
}

export function loadConfig(settingsPath?: string): PortForwardConfig {
	const SETTINGS_PATH = settingsPath || path.join(os.homedir(), ".pi", "agent", "settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
		const raw = settings?.portForward ?? settings?.piPortForward;
		return parseSettingsConfig(raw);
	} catch {
		return { ...defaultConfig };
	}
}

export function localPortFor(provider: ProviderConfig, remotePort: number): number {
	return remotePort + provider.localPortOffset;
}

export function forwardKey(provider: ProviderConfig, port: number): string {
	return `${provider.id}:${port}`;
}

export function localEndpoint(forward: Pick<Forward, "localHost" | "localPort">): string {
	return `${forward.localHost}:${forward.localPort}`;
}

export function remoteEndpoint(provider: Pick<ProviderConfig, "label" | "remoteHost">, port: number): string {
	return `${provider.label}:${provider.remoteHost}:${port}`;
}

export function parsePorts(provider: ProviderConfig, stdout: string): RemotePort[] {
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
		const procMatch = raw.match(/users:\(\("([^"]+)",pid=(\d+)/);
		const processName = procMatch?.[1] ?? "unknown";
		const pid = procMatch?.[2] ? Number(procMatch[2]) : undefined;
		const key = forwardKey(provider, port);

		if (!byPort.has(port)) byPort.set(port, { provider, key, port, localPort, address, processName, pid, raw });
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function isLocalPortFree(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen({ host, port }, () => {
			server.close(() => resolve(true));
		});
	});
}
