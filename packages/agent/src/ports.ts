import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export function isPidAlive(pid: number | undefined): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export function portAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/** IPv4 address as printed in /proc/net/tcp (little-endian hex). */
export function ipv4ToProc(host: string): string | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  const value = (((nums[3]! << 24) | (nums[2]! << 16) | (nums[1]! << 8) | nums[0]!) >>> 0);
  return value.toString(16).padStart(8, "0").toUpperCase();
}

export function inodeFromProcNet(text: string, port: number, host: string): string | undefined {
  const want = ipv4ToProc(host);
  for (const raw of text.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/);
    if (fields.length < 10 || !fields[0]?.endsWith(":")) continue;
    const local = fields[1] ?? "";
    const [addr, portHex] = local.split(":");
    if (!addr || !portHex) continue;
    if (Number.parseInt(portHex, 16) !== port) continue;
    if (fields[3]?.toUpperCase() !== "0A") continue;
    const addrHex = addr.toUpperCase();
    const wildcard = addrHex === "00000000";
    if (want && addrHex !== want && !wildcard) continue;
    const inode = fields[9];
    if (inode && inode !== "0") return inode;
  }
  return undefined;
}

export function pidForSocketInode(inode: string, procRoot = "/proc"): number | undefined {
  const needle = `socket:[${inode}]`;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(path.join(procRoot, entry, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(path.join(procRoot, entry, "fd", fd)) === needle) return Number(entry);
      } catch {
        /* fd vanished */
      }
    }
  }
  return undefined;
}

export function parseNetstatPid(text: string, port: number, host: string): number | undefined {
  const want = host.toLowerCase();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] !== "TCP" || !/LISTENING/i.test(line)) continue;
    const local = parts[1];
    const pid = Number(parts[parts.length - 1]);
    if (!local || !Number.isInteger(pid)) continue;
    const parsed = splitHostPort(local);
    if (!parsed || parsed.port !== port) continue;
    const addr = parsed.host.toLowerCase();
    if (addr === want || addr === "0.0.0.0" || addr === "::" || addr === "*") return pid;
  }
  return undefined;
}

export function parseLsofPids(text: string): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

function splitHostPort(local: string): { host: string; port: number } | undefined {
  if (local.startsWith("[")) {
    const end = local.indexOf("]");
    if (end < 0) return undefined;
    const port = Number(local.slice(end + 2));
    if (!Number.isInteger(port)) return undefined;
    return { host: local.slice(1, end), port };
  }
  const idx = local.lastIndexOf(":");
  if (idx <= 0) return undefined;
  const port = Number(local.slice(idx + 1));
  if (!Number.isInteger(port)) return undefined;
  return { host: local.slice(0, idx), port };
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout ?? ""));
    });
  });
}

async function listeningPidLinux(host: string, port: number): Promise<number | undefined> {
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const inode = inodeFromProcNet(text, port, host);
    if (!inode) continue;
    const pid = pidForSocketInode(inode);
    if (pid) return pid;
  }
  return undefined;
}

export async function listeningPid(host: string, port: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    const text = await execText("netstat", ["-ano", "-p", "TCP"]);
    return parseNetstatPid(text, port, host);
  }
  if (process.platform === "darwin") {
    const text = await execText("lsof", ["-nP", `-iTCP:${host}:${port}`, "-sTCP:LISTEN", "-t"]);
    return parseLsofPids(text);
  }
  return listeningPidLinux(host, port);
}
