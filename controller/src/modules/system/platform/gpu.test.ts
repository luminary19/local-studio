import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GpuInfo } from "../../models/types";
import { queryNvidiaSmiSnapshot } from "./gpu";

const SNAPSHOT_CSV_LINE =
  "GPU-3090, 00000000:82:00.0, NVIDIA GeForce RTX 3090, 24576, 2048, 22528, 12, 48, 80.5, 350, 580.95.05";

// Fake nvidia-smi that records its argv and prints one CSV row. Windows cannot
// execute a shell script, so it gets a .cmd shim that forwards to a JS fake run
// by the current bun executable (argv survives verbatim: no spaces in the args).
const writeFakeNvidiaSmi = (directory: string): string => {
  if (process.platform === "win32") {
    const scriptPath = join(directory, "fake-nvidia-smi.mjs");
    writeFileSync(
      scriptPath,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'writeFileSync(process.env["LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"], `${args.join("\\n")}\\n`);',
        'appendFileSync(process.env["LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH"], "1\\n");',
        `console.log(${JSON.stringify(SNAPSHOT_CSV_LINE)});`,
      ].join("\n"),
    );
    const binaryPath = join(directory, "nvidia-smi.cmd");
    writeFileSync(binaryPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return binaryPath;
  }
  const binaryPath = join(directory, "nvidia-smi");
  writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"',
      "printf '1\\n' >> \"$LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH\"",
      `printf '%s\\n' '${SNAPSHOT_CSV_LINE}'`,
    ].join("\n"),
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
};

test("collects stable NVIDIA identities from one shared snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-studio-nvidia-smi-"));
  const argumentsPath = join(directory, "arguments");
  const countPath = join(directory, "count");
  const previousBinary = process.env["NVIDIA_SMI_PATH"];
  const previousArgumentsPath = process.env["LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"];
  const previousCountPath = process.env["LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH"];

  try {
    process.env["NVIDIA_SMI_PATH"] = writeFakeNvidiaSmi(directory);
    process.env["LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"] = argumentsPath;
    process.env["LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH"] = countPath;

    const snapshot = await queryNvidiaSmiSnapshot();

    expect(snapshot).toEqual({
      available: true,
      driverVersion: "580.95.05",
      gpus: [
        {
          uuid: "GPU-3090",
          pci_bus_id: "00000000:82:00.0",
          index: 0,
          name: "NVIDIA GeForce RTX 3090",
          memory_total_mb: 24576,
          memory_used_mb: 2048,
          memory_free_mb: 22528,
          utilization_pct: 12,
          temp_c: 48,
          power_draw: 80.5,
          power_limit: 350,
        },
      ],
    });
    expect(readFileSync(countPath, "utf8")).toBe("1\n");
    expect(readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
      "--query-gpu=uuid,pci.bus_id,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit,driver_version",
      "--format=csv,noheader,nounits",
    ]);
  } finally {
    if (previousBinary === undefined) delete process.env["NVIDIA_SMI_PATH"];
    else process.env["NVIDIA_SMI_PATH"] = previousBinary;
    if (previousArgumentsPath === undefined) {
      delete process.env["LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"];
    } else {
      process.env["LOCAL_STUDIO_NVIDIA_SMI_ARGUMENTS_PATH"] = previousArgumentsPath;
    }
    if (previousCountPath === undefined) delete process.env["LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH"];
    else process.env["LOCAL_STUDIO_NVIDIA_SMI_COUNT_PATH"] = previousCountPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps stable identity optional for non-NVIDIA telemetry", () => {
  const gpu: GpuInfo = {
    index: 0,
    name: "Intel Arc Pro B70",
    memory_total_mb: 24576,
    memory_used_mb: 0,
    memory_free_mb: 24576,
    utilization_pct: 0,
    temp_c: 0,
    power_draw: 0,
    power_limit: 0,
  };

  expect(gpu.uuid).toBeUndefined();
  expect(gpu.pci_bus_id).toBeUndefined();
});
