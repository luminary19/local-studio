import { describe, expect, test } from "bun:test";

import {
  buildProcessTree,
  listProcessEntries,
  listProcesses,
  parsePosixProcessTable,
  parseWindowsProcessTable,
} from "./process-utilities";

describe("parsePosixProcessTable", () => {
  test("parses pid, ppid, and command tokens", () => {
    const output = [
      "  101     1 /usr/bin/python3 -m vllm.entrypoints.openai.api_server --port 8000",
      '  202   101 bash -c "sleep 1"',
    ].join("\n");
    const entries = parsePosixProcessTable(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      pid: 101,
      ppid: 1,
      args: ["/usr/bin/python3", "-m", "vllm.entrypoints.openai.api_server", "--port", "8000"],
    });
    expect(entries[1]?.args).toEqual(["bash", "-c", "sleep 1"]);
  });

  test("skips malformed lines and zero pids", () => {
    const entries = parsePosixProcessTable("garbage\n 0 1 tool\n\n 5 2 tool");
    expect(entries).toEqual([{ pid: 5, ppid: 2, args: ["tool"] }]);
  });
});

describe("parseWindowsProcessTable", () => {
  test("parses a JSON array of CIM rows", () => {
    const output = JSON.stringify([
      {
        ProcessId: 4321,
        ParentProcessId: 100,
        CommandLine: '"C:\\Tools\\llama-server.exe" --port 8000',
      },
      { ProcessId: 8765, ParentProcessId: 4321, CommandLine: null },
    ]);
    const entries = parseWindowsProcessTable(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      pid: 4321,
      ppid: 100,
      args: ["C:\\Tools\\llama-server.exe", "--port", "8000"],
    });
    expect(entries[1]).toEqual({ pid: 8765, ppid: 4321, args: [] });
  });

  test("parses a single-object payload", () => {
    const output = JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: "tool" });
    expect(parseWindowsProcessTable(output)).toEqual([{ pid: 7, ppid: 1, args: ["tool"] }]);
  });

  test("drops system idle rows and invalid JSON", () => {
    expect(
      parseWindowsProcessTable(JSON.stringify([{ ProcessId: 0, ParentProcessId: 0 }])),
    ).toEqual([]);
    expect(parseWindowsProcessTable("not json")).toEqual([]);
  });
});

describe("live process table", () => {
  test("listProcessEntries sees the current process", () => {
    const entries = listProcessEntries();
    expect(entries.some((entry) => entry.pid === process.pid)).toBe(true);
  });

  test("listProcesses only returns entries with arguments", () => {
    const processes = listProcesses();
    expect(processes.length).toBeGreaterThan(0);
    expect(processes.every((entry) => entry.args.length > 0)).toBe(true);
  });

  test("buildProcessTree records the current process under a parent", () => {
    const children = [...buildProcessTree().values()].flat();
    expect(children).toContain(process.pid);
  });
});
