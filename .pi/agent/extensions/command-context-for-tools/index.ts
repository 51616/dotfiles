import { ExtensionRunner } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Patch: expose command-context session control actions on the plain ExtensionContext.
 *
 * Why: built-in slash commands like /reload are handled by the interactive TUI input layer,
 * not by AgentSession.prompt(). When an extension/tool tries to "send" "/reload" via
 * pi.sendUserMessage(), it does NOT execute the built-in command.
 *
 * Fix: let tools call ctx.reload()/ctx.newSession()/ctx.switchSession() directly (these are
 * already wired by InteractiveMode.bindExtensions() via commandContextActions).
 *
 * This keeps `pi_slash` reliable without needing to fake user input.
 */
export default function commandContextForTools(_pi: ExtensionAPI) {
  const proto = ExtensionRunner.prototype as unknown as Record<string, unknown>;
  if (proto.__commandContextForToolsPatched) return;
  proto.__commandContextForToolsPatched = true;

  const origCreateContext = ExtensionRunner.prototype.createContext;

  ExtensionRunner.prototype.createContext = function patchedCreateContext() {
    const ctx = origCreateContext.call(this) as Record<string, unknown>;

    // These live on the runner instance and are normally only used by createCommandContext().
    // We copy references onto the tool/event context object.
    const self = this as unknown as Record<string, unknown>;

    if (typeof ctx.waitForIdle !== "function" && typeof self.waitForIdleFn === "function") {
      ctx.waitForIdle = () => (self.waitForIdleFn as () => Promise<void>)();
    }
    if (typeof ctx.newSession !== "function" && typeof self.newSessionHandler === "function") {
      ctx.newSession = (options?: unknown) => (self.newSessionHandler as (o?: unknown) => Promise<unknown>)(options);
    }
    if (typeof ctx.fork !== "function" && typeof self.forkHandler === "function") {
      ctx.fork = (entryId: string) => (self.forkHandler as (id: string) => Promise<unknown>)(entryId);
    }
    if (typeof ctx.navigateTree !== "function" && typeof self.navigateTreeHandler === "function") {
      ctx.navigateTree = (targetId: string, options?: unknown) =>
        (self.navigateTreeHandler as (id: string, o?: unknown) => Promise<unknown>)(targetId, options);
    }
    if (typeof ctx.switchSession !== "function" && typeof self.switchSessionHandler === "function") {
      ctx.switchSession = (sessionPath: string) =>
        (self.switchSessionHandler as (p: string) => Promise<unknown>)(sessionPath);
    }
    if (typeof ctx.reload !== "function" && typeof self.reloadHandler === "function") {
      ctx.reload = () => (self.reloadHandler as () => Promise<void>)();
    }

    return ctx as never;
  };
}
