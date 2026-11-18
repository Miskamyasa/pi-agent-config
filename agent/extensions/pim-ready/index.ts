import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function pimReady(pi: ExtensionAPI) {
  const enabled = process.env.PIM_WEZTERM_READY ?? (process.env.WEZTERM_PANE ? "1" : "0");
  if (enabled !== "1" || !process.stdout.isTTY) return;

  function setReady(ctx: ExtensionContext, ready: boolean): void {
    if (ctx.mode !== "tui") return;
    const value = Buffer.from(ready ? `ready:${randomUUID()}` : "0").toString("base64");
    process.stdout.write(`\x1b]1337;SetUserVar=task_completion=${value}\x07`);
  }

  pi.on("session_start", (_event, ctx) => setReady(ctx, false));
  pi.on("agent_start", (_event, ctx) => setReady(ctx, false));
  pi.on("agent_settled", (_event, ctx) => setReady(ctx, true));
  pi.on("session_shutdown", (_event, ctx) => setReady(ctx, false));
}
