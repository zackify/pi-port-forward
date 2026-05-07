import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { vi } from "bun:test";

import {
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
  parseSettingsConfig,
  localPortFor,
  forwardKey,
  localEndpoint,
  remoteEndpoint,
  parsePorts,
  isLocalPortFree,
  defaultConfig,
  defaultAllowedPorts,
  type ProviderConfig,
  type PortForwardConfig,
} from "./utils";

describe("shellQuote", () => {
  test("wraps value in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  test("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shellQuote("don't")).toBe(`'don'"'"'t'`);
  });

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("handles multiple quotes", () => {
    expect(shellQuote("it's a \"test\"")).toBe(`'it'"'"'s a "test"'`);
  });
});

describe("isValidPort", () => {
  test("accepts valid ports", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(80)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(8080)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  test("rejects invalid ports", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
    expect(isValidPort(Infinity)).toBe(false);
  });
});

describe("normalizeAllowedPorts", () => {
  test("returns default for non-array input", () => {
    expect(normalizeAllowedPorts(null)).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts(undefined)).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts("string")).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts(123)).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts({})).toEqual([...defaultAllowedPorts]);
  });

  test("accepts valid single ports", () => {
    expect(normalizeAllowedPorts([3000, 8080, 9000])).toEqual([3000, 8080, 9000]);
  });

  test("accepts valid port ranges", () => {
    expect(normalizeAllowedPorts([{ from: 8080, to: 9000 }])).toEqual([{ from: 8080, to: 9000 }]);
    expect(normalizeAllowedPorts([{ from: 1, to: 1000 }])).toEqual([{ from: 1, to: 1000 }]);
  });

  test("accepts mixed ports and ranges", () => {
    expect(normalizeAllowedPorts([3000, { from: 8080, to: 9000 }, 5432])).toEqual([3000, { from: 8080, to: 9000 }, 5432]);
  });

  test("filters out invalid ports", () => {
    expect(normalizeAllowedPorts([0, 3000, 65536])).toEqual([3000]);
    expect(normalizeAllowedPorts([-1, 100])).toEqual([100]);
  });

  test("filters out invalid ranges", () => {
    expect(normalizeAllowedPorts([{ from: 9000, to: 8080 }])).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts([{ from: 0, to: 100 }])).toEqual([...defaultAllowedPorts]);
    expect(normalizeAllowedPorts([{ from: 100, to: 65536 }])).toEqual([...defaultAllowedPorts]);
  });

  test("returns default for empty array", () => {
    expect(normalizeAllowedPorts([])).toEqual([...defaultAllowedPorts]);
  });

  test("filters out non-port values", () => {
    expect(normalizeAllowedPorts(["string", null, undefined, {}])).toEqual([...defaultAllowedPorts]);
  });
});

describe("portLabel", () => {
  test("formats single ports", () => {
    expect(portLabel([3000])).toBe("3000");
    expect(portLabel([80])).toBe("80");
  });

  test("formats port ranges", () => {
    expect(portLabel([{ from: 8080, to: 9000 }])).toBe("8080-9000");
  });

  test("formats mixed", () => {
    expect(portLabel([3000, { from: 8080, to: 9000 }])).toBe("3000, 8080-9000");
  });

  test("handles empty array", () => {
    expect(portLabel([])).toBe("");
  });
});

describe("isAllowedPort", () => {
  test("matches single ports", () => {
    expect(isAllowedPort(3000, [3000, 8080])).toBe(true);
    expect(isAllowedPort(8080, [3000, 8080])).toBe(true);
    expect(isAllowedPort(8081, [3000, 8080])).toBe(false);
  });

  test("matches port ranges", () => {
    expect(isAllowedPort(8080, [{ from: 8080, to: 9000 }])).toBe(true);
    expect(isAllowedPort(8500, [{ from: 8080, to: 9000 }])).toBe(true);
    expect(isAllowedPort(9000, [{ from: 8080, to: 9000 }])).toBe(true);
    expect(isAllowedPort(8079, [{ from: 8080, to: 9000 }])).toBe(false);
    expect(isAllowedPort(9001, [{ from: 8080, to: 9000 }])).toBe(false);
  });

  test("matches mixed", () => {
    expect(isAllowedPort(3000, [3000, { from: 8080, to: 9000 }])).toBe(true);
    expect(isAllowedPort(8500, [3000, { from: 8080, to: 9000 }])).toBe(true);
    expect(isAllowedPort(5432, [3000, { from: 8080, to: 9000 }])).toBe(false);
  });

  test("handles empty allowedPorts", () => {
    expect(isAllowedPort(3000, [])).toBe(false);
  });
});

describe("normalizeString", () => {
  test("returns trimmed string for valid input", () => {
    expect(normalizeString("hello", "default")).toBe("hello");
    expect(normalizeString("  spaces  ", "default")).toBe("spaces");
  });

  test("returns fallback for invalid input", () => {
    expect(normalizeString("", "default")).toBe("default");
    expect(normalizeString("   ", "default")).toBe("default");
    expect(normalizeString(null, "default")).toBe("default");
    expect(normalizeString(undefined, "default")).toBe("default");
    expect(normalizeString(123, "default")).toBe("default");
  });
});

describe("normalizeSshOptions", () => {
  test("returns filtered array", () => {
    expect(normalizeSshOptions(["-o", "StrictHostKeyChecking=no"])).toEqual(["-o", "StrictHostKeyChecking=no"]);
  });

  test("filters empty strings", () => {
    expect(normalizeSshOptions(["", "  ", "-o"])).toEqual(["-o"]);
  });

  test("filters non-strings", () => {
    expect(normalizeSshOptions([null, undefined, 123, "-o"])).toEqual(["-o"]);
  });

  test("returns empty array for non-array", () => {
    expect(normalizeSshOptions("string")).toEqual([]);
    expect(normalizeSshOptions(null)).toEqual([]);
    expect(normalizeSshOptions(123)).toEqual([]);
  });

  test("trims strings", () => {
    expect(normalizeSshOptions(["  -o  ", "  Option  "])).toEqual(["-o", "Option"]);
  });
});

describe("normalizeProvider", () => {
  test("creates provider from remote", () => {
    const result = normalizeProvider({ remote: "user@host.com" }, 0);
    expect(result).toEqual({
      id: "host.com",
      remote: "user@host.com",
      label: "host.com",
      allowedPorts: [3000, { from: 8080, to: 9000 }],
      localHost: "127.0.0.1",
      remoteHost: "127.0.0.1",
      localPortOffset: 0,
      sshOptions: [],
    });
  });

  test("uses ssh as fallback for remote", () => {
    const result = normalizeProvider({ ssh: "user@host.com" }, 0);
    expect(result?.remote).toBe("user@host.com");
  });

  test("uses custom label", () => {
    const result = normalizeProvider({ remote: "user@host.com", label: "My Server" }, 0);
    expect(result?.label).toBe("My Server");
  });

  test("uses hostLabel as fallback label", () => {
    const result = normalizeProvider({ remote: "user@host.com", hostLabel: "Legacy Label" }, 0);
    expect(result?.label).toBe("Legacy Label");
  });

  test("uses custom id", () => {
    const result = normalizeProvider({ remote: "user@host.com", id: "custom-id" }, 0);
    expect(result?.id).toBe("custom-id");
  });

  test("uses label as id fallback", () => {
    const result = normalizeProvider({ remote: "user@host.com", label: "Server" }, 0);
    expect(result?.id).toBe("Server");
  });

  test("returns undefined for missing remote", () => {
    expect(normalizeProvider({}, 0)).toBeUndefined();
    expect(normalizeProvider({ label: "test" }, 0)).toBeUndefined();
    expect(normalizeProvider({ ssh: "" }, 0)).toBeUndefined();
  });

  test("applies localPortOffset", () => {
    const result = normalizeProvider({ remote: "user@host.com", localPortOffset: 100 }, 0);
    expect(result?.localPortOffset).toBe(100);
  });

  test("applies custom hosts", () => {
    const result = normalizeProvider({
      remote: "user@host.com",
      localHost: "0.0.0.0",
      remoteHost: "0.0.0.0",
    }, 0);
    expect(result?.localHost).toBe("0.0.0.0");
    expect(result?.remoteHost).toBe("0.0.0.0");
  });

  test("applies sshOptions", () => {
    const result = normalizeProvider({
      remote: "user@host.com",
      sshOptions: ["-o", "StrictHostKeyChecking=no"],
    }, 0);
    expect(result?.sshOptions).toEqual(["-o", "StrictHostKeyChecking=no"]);
  });

  test("generates remote index id fallback", () => {
    const result = normalizeProvider({ remote: "user@host.com" }, 5);
    expect(result?.id).toBe("host.com");
  });

  test("label takes precedence over hostLabel", () => {
    const result = normalizeProvider({ remote: "user@host.com", label: "Custom", hostLabel: "Legacy" }, 0);
    expect(result?.label).toBe("Custom");
  });
});

describe("normalizeCommand", () => {
  test("returns normalized command", () => {
    expect(normalizeCommand("forward")).toBe("forward");
    expect(normalizeCommand("  ports  ")).toBe("ports");
  });

  test("removes leading slash", () => {
    expect(normalizeCommand("/port")).toBe("port");
    expect(normalizeCommand("/forward")).toBe("forward");
  });

  test("returns default for whitespace command", () => {
    expect(normalizeCommand("")).toBe("port");
    expect(normalizeCommand("   ")).toBe("port");
    expect(normalizeCommand("two words")).toBe("port");
  });

  test("returns default for non-string", () => {
    expect(normalizeCommand(null)).toBe("port");
    expect(normalizeCommand(123)).toBe("port");
    expect(normalizeCommand({})).toBe("port");
  });
});

describe("parseSettingsConfig", () => {
  test("returns default config for null/undefined", () => {
    expect(parseSettingsConfig(null)).toEqual({ ...defaultConfig });
    expect(parseSettingsConfig(undefined)).toEqual({ ...defaultConfig });
  });

  test("parses portForward config", () => {
    const raw = {
      command: "fwd",
      providers: [{ remote: "user@host.com" }],
      maxVisible: 10,
    };
    const result = parseSettingsConfig(raw);
    expect(result.command).toBe("fwd");
    expect(result.providers.length).toBe(1);
    expect(result.maxVisible).toBe(10);
  });

  test("parses piPortForward config (legacy) using remotes", () => {
    const raw = {
      command: "legacy",
      remotes: [{ remote: "user@legacy.com" }],
    };
    const result = parseSettingsConfig(raw);
    expect(result.command).toBe("legacy");
    expect(result.providers.length).toBe(1);
  });

  test("deduplicates provider ids", () => {
    const raw = {
      providers: [
        { remote: "user@host1.com", id: "same-id" },
        { remote: "user@host2.com", id: "same-id" },
        { remote: "user@host3.com", id: "same-id" },
      ],
    };
    const result = parseSettingsConfig(raw);
    expect(result.providers[0].id).toBe("same-id");
    expect(result.providers[1].id).toBe("same-id-2");
    expect(result.providers[2].id).toBe("same-id-3");
  });

  test("defaults maxVisible to 15 if invalid", () => {
    const raw = { maxVisible: -1 };
    const result = parseSettingsConfig(raw);
    expect(result.maxVisible).toBe(15);
  });

  test("defaults maxVisible to 15 if not integer", () => {
    const raw = { maxVisible: "ten" };
    const result = parseSettingsConfig(raw);
    expect(result.maxVisible).toBe(15);
  });

  test("defaults maxVisible to 15 if zero", () => {
    const raw = { maxVisible: 0 };
    const result = parseSettingsConfig(raw);
    expect(result.maxVisible).toBe(15);
  });

  test("normalizes command", () => {
    expect(parseSettingsConfig({ command: "/slash" }).command).toBe("slash");
    expect(parseSettingsConfig({ command: "  spaces  " }).command).toBe("spaces");
  });
});

describe("loadConfig", () => {
  test("loadConfig returns defaultConfig (integration test)", () => {
    // This test just verifies loadConfig doesn't crash with default values
    // In a real environment, it would read from the settings file
    const result = loadConfig();
    expect(result).toBeDefined();
    expect(result.command).toBeDefined();
  });
});

describe("localPortFor", () => {
  test("calculates local port with offset", () => {
    expect(localPortFor({ localPortOffset: 0 }, 8080)).toBe(8080);
    expect(localPortFor({ localPortOffset: 100 }, 8080)).toBe(8180);
    expect(localPortFor({ localPortOffset: -100 }, 8100)).toBe(8000);
  });
});

describe("forwardKey", () => {
  test("generates key", () => {
    expect(forwardKey({ id: "host.com" }, 8080)).toBe("host.com:8080");
    expect(forwardKey({ id: "custom" }, 3000)).toBe("custom:3000");
  });
});

describe("localEndpoint", () => {
  test("formats endpoint", () => {
    expect(localEndpoint({ localHost: "127.0.0.1", localPort: 8080 })).toBe("127.0.0.1:8080");
    expect(localEndpoint({ localHost: "0.0.0.0", localPort: 3000 })).toBe("0.0.0.0:3000");
  });
});

describe("remoteEndpoint", () => {
  test("formats endpoint", () => {
    expect(remoteEndpoint({ label: "host.com", remoteHost: "127.0.0.1" }, 8080)).toBe("host.com:127.0.0.1:8080");
  });
});

describe("parsePorts", () => {
  const provider: ProviderConfig = {
    id: "host.com",
    label: "host.com",
    allowedPorts: [3000, { from: 8080, to: 9000 }],
    localPortOffset: 0,
    localHost: "127.0.0.1",
    remoteHost: "127.0.0.1",
    sshOptions: [],
    remote: "user@host.com",
  };

  test("parses ss output", () => {
    const output = `LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=1234,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(1);
    expect(result[0].port).toBe(8080);
    expect(result[0].localPort).toBe(8080);
    expect(result[0].processName).toBe("nginx");
    expect(result[0].pid).toBe(1234);
  });

  test("parses multiple ports", () => {
    const output = `LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=100,fd=6))
LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=200,fd=6))
LISTEN 0 128 127.0.0.1:9000 0.0.0.0:* users:(("python",pid=300,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(3);
    expect(result.map(r => r.port)).toEqual([3000, 8080, 9000]);
  });

  test("filters ports not in allowed list", () => {
    const output = `LISTEN 0 128 127.0.0.1:80 0.0.0.0:* users:(("apache",pid=123,fd=6))
LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=456,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(1);
    expect(result[0].port).toBe(8080);
  });

  test("handles IPv6 brackets", () => {
    const output = `LISTEN 0 128 [::1]:8080 [::]:* users:(("nginx",pid=123,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(1);
    expect(result[0].address).toBe("::1");
  });

  test("handles unknown process", () => {
    const output = `LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(1);
    expect(result[0].processName).toBe("unknown");
    expect(result[0].pid).toBeUndefined();
  });

  test("handles CRLF line endings", () => {
    const output = `LISTEN 0 128 127.0.0.1:8080\r\nLISTEN 0 128 127.0.0.1:3000`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(2);
  });

  test("handles empty input", () => {
    expect(parsePorts(provider, "")).toEqual([]);
    expect(parsePorts(provider, "\n\n")).toEqual([]);
  });

  test("deduplicates same port", () => {
    const output = `LISTEN 0 128 127.0.0.1:8080 users:(("nginx",pid=123,fd=6))
LISTEN 0 128 127.0.0.1:8080 users:(("node",pid=456,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result.length).toBe(1);
  });

  test("respects localPortOffset", () => {
    const offsetProvider = { ...provider, localPortOffset: 100 };
    const output = `LISTEN 0 128 127.0.0.1:8080 users:(("nginx",pid=123,fd=6))`;
    const result = parsePorts(offsetProvider, output);
    expect(result[0].localPort).toBe(8180);
  });

  test("skips lines without port match", () => {
    const output = `Some other output without ports`;
    const result = parsePorts(provider, output);
    expect(result).toEqual([]);
  });

  test("skips ports outside valid range", () => {
    const output = `LISTEN 0 128 127.0.0.1:65536 users:(("nginx",pid=123,fd=6))`;
    const result = parsePorts(provider, output);
    expect(result).toEqual([]);
  });

  test("skips ports where localPort would be invalid", () => {
    const highOffsetProvider = { ...provider, localPortOffset: 60000 };
    const output = `LISTEN 0 128 127.0.0.1:8080 users:(("nginx",pid=123,fd=6))`;
    const result = parsePorts(highOffsetProvider, output);
    expect(result).toEqual([]);
  });
});

describe("isLocalPortFree", () => {
  test("returns true for free port", async () => {
    const result = await isLocalPortFree("127.0.0.1", 19999);
    expect(result).toBe(true);
  });

  test("returns false for occupied port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen({ host: "127.0.0.1", port: 19998 }, () => resolve());
    });
    const result = await isLocalPortFree("127.0.0.1", 19998);
    server.close();
    expect(result).toBe(false);
  });
});

describe("defaultConfig", () => {
  test("has correct default values", () => {
    expect(defaultConfig.command).toBe("port");
    expect(defaultConfig.providers).toEqual([]);
    expect(defaultConfig.maxVisible).toBe(15);
  });
});

describe("defaultAllowedPorts", () => {
  test("has correct default values", () => {
    expect(defaultAllowedPorts).toEqual([3000, { from: 8080, to: 9000 }]);
  });
});
