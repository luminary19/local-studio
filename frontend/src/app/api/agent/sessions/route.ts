import { NextRequest } from "next/server";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { listSessions } from "@/lib/agent/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cwdParam = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
  if (!cwdParam) return Response.json({ error: "cwd is required" }, { status: 400 });
  if (!path.isAbsolute(cwdParam)) {
    return Response.json({ error: "cwd must be absolute" }, { status: 400 });
  }
  if (!existsSync(cwdParam) || !statSync(cwdParam).isDirectory()) {
    return Response.json({ sessions: [] });
  }
  const sessions = await listSessions(cwdParam);
  return Response.json({ sessions });
}
