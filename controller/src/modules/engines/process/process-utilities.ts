import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import type { Recipe } from "../../models/types";
import type { Backend } from "@local-studio/contracts/recipes";
import { detectEngineFromArguments } from "../engine-spec";
import { extractFlag as extractFlagUtility } from "../argument-utilities";
import { resolveVllmRecipePythonPath } from "../runtimes/vllm-python-path";
import type { Config } from "../../../config/env";

export { extractFlagUtility as extractFlag };

export const splitCommand = (command: string): string[] => {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((token) => token.replace(/^"|"$/g, ""));
};

export const detectBackend = (args: string[]): Backend | null => {
  if (args.length === 0) return null;
  return detectEngineFromArguments(args);
};

export type ProcessEntry = { pid: number; ppid: number; args: string[] };

export const parsePosixProcessTable = (output: string): ProcessEntry[] =>
  output
    .split("\n")
    .map((line): ProcessEntry | null => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        args: splitCommand(match[3] ?? ""),
      };
    })
    .filter((entry): entry is ProcessEntry => entry !== null && entry.pid > 0);

type CimProcessRow = {
  ProcessId?: number;
  ParentProcessId?: number;
  CommandLine?: string | null;
};

export const parseWindowsProcessTable = (output: string): ProcessEntry[] => {
  try {
    const parsed: unknown = JSON.parse(output);
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as CimProcessRow[];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId ?? 0),
        ppid: Number(row.ParentProcessId ?? 0),
        args: splitCommand(row.CommandLine ?? ""),
      }))
      .filter((entry) => entry.pid > 0);
  } catch {
    return [];
  }
};

const WINDOWS_PROCESS_QUERY =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

const WINDOWS_TABLE_CACHE_TTL_MS = 2_000;
let windowsTableCache: { readAt: number; entries: ProcessEntry[] } | null = null;

const queryWindowsProcessTable = (): ProcessEntry[] => {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY],
    { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
  );
  if (result.status !== 0) return [];
  return parseWindowsProcessTable(result.stdout.toString("utf-8"));
};

const readWindowsProcessTable = (): ProcessEntry[] => {
  const now = Date.now();
  if (windowsTableCache && now - windowsTableCache.readAt < WINDOWS_TABLE_CACHE_TTL_MS) {
    return windowsTableCache.entries;
  }
  const entries = queryWindowsProcessTable();
  windowsTableCache = { readAt: now, entries };
  return entries;
};

const readPosixProcessTable = (): ProcessEntry[] => {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="]);
  if (result.status !== 0) return [];
  return parsePosixProcessTable(result.stdout.toString("utf-8"));
};

export const listProcessEntries = (): ProcessEntry[] => {
  try {
    return process.platform === "win32" ? readWindowsProcessTable() : readPosixProcessTable();
  } catch {
    return [];
  }
};

export const listProcesses = (): Array<{ pid: number; args: string[] }> =>
  listProcessEntries()
    .filter((entry) => entry.args.length > 0)
    .map(({ pid, args }) => ({ pid, args }));

export const buildEnvironment = (
  recipe: Recipe,
  config?: Pick<Config, "data_dir">,
): Record<string, string> => {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env["FLASHINFER_DISABLE_VERSION_CHECK"] = "1";

  const venvBin = resolveVenvBinForRecipe(recipe, config?.data_dir);
  if (venvBin) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${venvBin}${delimiter}${env[pathKey] ?? ""}`;
  }

  const environmentVariables: Record<string, string> = {};
  if (recipe.env_vars && typeof recipe.env_vars === "object") {
    for (const [key, value] of Object.entries(recipe.env_vars)) {
      if (value !== undefined && value !== null) {
        environmentVariables[String(key)] = String(value);
      }
    }
  }

  const extraEnvironment =
    recipe.extra_args["env_vars"] || recipe.extra_args["env-vars"] || recipe.extra_args["envVars"];
  if (extraEnvironment && typeof extraEnvironment === "object") {
    for (const [key, value] of Object.entries(extraEnvironment as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        environmentVariables[String(key)] = String(value);
      }
    }
  }

  for (const [key, value] of Object.entries(environmentVariables)) {
    env[key] = value;
  }

  const readExtraArgument = (key: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(recipe.extra_args, key)) {
      return recipe.extra_args[key];
    }
    const kebab = key.replace(/_/g, "-");
    if (Object.prototype.hasOwnProperty.call(recipe.extra_args, kebab)) {
      return recipe.extra_args[kebab];
    }
    const snake = key.replace(/-/g, "_");
    if (Object.prototype.hasOwnProperty.call(recipe.extra_args, snake)) {
      return recipe.extra_args[snake];
    }
    return undefined;
  };

  const isDefined = (value: unknown): boolean => {
    return value !== undefined && value !== null && value !== false;
  };

  const visibleDevices =
    readExtraArgument("visible_devices") ??
    readExtraArgument("VISIBLE_DEVICES") ??
    readExtraArgument("CUDA_VISIBLE_DEVICES") ??
    readExtraArgument("cuda_visible_devices") ??
    readExtraArgument("cuda-visible-devices");
  const hipVisibleDevices =
    readExtraArgument("hip_visible_devices") ?? readExtraArgument("HIP_VISIBLE_DEVICES");
  const rocrVisibleDevices =
    readExtraArgument("rocr_visible_devices") ?? readExtraArgument("ROCR_VISIBLE_DEVICES");

  const forcedTool = (process.env["LOCAL_STUDIO_GPU_SMI_TOOL"] ?? "").trim().toLowerCase();
  const platform =
    forcedTool === "nvidia-smi"
      ? "cuda"
      : forcedTool === "amd-smi" || forcedTool === "rocm-smi"
        ? "rocm"
        : "unknown";

  if (isDefined(visibleDevices)) {
    const value = String(visibleDevices);
    if (platform === "cuda") {
      env["CUDA_VISIBLE_DEVICES"] = value;
    } else if (platform === "rocm") {
      env["HIP_VISIBLE_DEVICES"] = value;
      env["ROCR_VISIBLE_DEVICES"] = value;
    } else {
      env["CUDA_VISIBLE_DEVICES"] = value;
      env["HIP_VISIBLE_DEVICES"] = value;
      env["ROCR_VISIBLE_DEVICES"] = value;
    }
  }

  if (isDefined(hipVisibleDevices)) {
    env["HIP_VISIBLE_DEVICES"] = String(hipVisibleDevices);
  }
  if (isDefined(rocrVisibleDevices)) {
    env["ROCR_VISIBLE_DEVICES"] = String(rocrVisibleDevices);
  }

  return env;
};

function resolveVenvBinForRecipe(recipe: Recipe, dataDirectory?: string): string | null {
  const python =
    recipe.python_path && recipe.python_path.trim()
      ? recipe.python_path
      : resolveVllmRecipePythonPath(recipe.python_path, dataDirectory);
  if (python) return dirname(python);
  return null;
}

export const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const buildProcessTree = (): Map<number, number[]> => {
  const tree = new Map<number, number[]>();
  for (const { pid, ppid } of listProcessEntries()) {
    const children = tree.get(ppid) ?? [];
    children.push(pid);
    tree.set(ppid, children);
  }
  return tree;
};

export const collectChildren = (
  tree: Map<number, number[]>,
  pid: number,
  accumulator: Set<number>,
): void => {
  const children = tree.get(pid) ?? [];
  for (const child of children) {
    if (!accumulator.has(child)) {
      accumulator.add(child);
      collectChildren(tree, child, accumulator);
    }
  }
};
