import { chmodSync, writeFileSync } from "node:fs";

export interface FakeExecutableResponse {
  when: string[];
  echo: string;
}

export function writeFakeExecutable(
  basePath: string,
  posixScript: string,
  windowsResponses: FakeExecutableResponse[],
): string {
  if (process.platform === "win32") {
    const cmdPath = `${basePath}.cmd`;
    const lines = ["@echo off"];
    for (const response of windowsResponses) {
      for (const value of response.when) {
        lines.push(`if "%~1"=="${value}" (echo ${response.echo}&exit /b 0)`);
      }
    }
    lines.push("exit /b 0");
    writeFileSync(cmdPath, `${lines.join("\r\n")}\r\n`, "utf8");
    return cmdPath;
  }
  writeFileSync(basePath, posixScript, "utf8");
  chmodSync(basePath, 0o755);
  return basePath;
}
