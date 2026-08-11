import { compact, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const COMPACTION_THINKING_LEVEL = "low" as const;
const LOW_EFFORT_COMPACTION_ATTEMPTS = 3;
const LOW_EFFORT_RETRY_DELAY_MS = 2_000;
const STATUS_KEY = "low-effort-compaction";
const COMPACTING_STATUS = "⧉ compacting |";

// Substitute a cheaper model for compaction when the active model is overkill
// for a summarization task. Keyed by `${provider}/${id}` of the active model;
// value is the model to use for the compaction request only (the session model
// is not changed). If the target isn't in the registry, or the low-effort
// request fails after retries, we fall back to pi's built-in default compaction path.
const COMPACTION_MODEL_OVERRIDES: Record<string, { provider: string; modelId: string }> = {
  "sakana/fugu-ultra": { provider: "sakana", modelId: "fugu-mini" },
};

type ActiveModel = NonNullable<ExtensionContext["model"]>;
type ModelRegistry = ExtensionContext["modelRegistry"];
type CompactFunction = typeof compact;
type CompactParameters = Parameters<CompactFunction>;
type CompactResult = Awaited<ReturnType<CompactFunction>>;
type DelayFunction = (delayMs: number, signal?: AbortSignal) => Promise<void>;

type LowEffortCompactionDependencies = {
  compact: CompactFunction;
  delay: DelayFunction;
};

type ModelSnapshot = {
  provider: string;
  id: string;
  model: ActiveModel;
};

function snapshotModel(model: ActiveModel): ModelSnapshot {
  return {
    provider: model.provider,
    id: model.id,
    model,
  };
}

function sameModel(left: ModelSnapshot, right: ActiveModel | undefined): boolean {
  return right !== undefined && left.provider === right.provider && left.id === right.id;
}

function formatModel(model: Pick<ModelSnapshot, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function resolveCompactionModel(active: ActiveModel, registry: ModelRegistry): ActiveModel {
  const override = COMPACTION_MODEL_OVERRIDES[`${active.provider}/${active.id}`];
  if (!override) return active;
  const alternate = registry.find(override.provider, override.modelId);
  // Silent fallback: if the override model isn't registered/enabled, keep using
  // the active model so compaction still works.
  return alternate ?? active;
}

function setCompactionStatus(ctx: ExtensionContext, attempt = 1): void {
  if (!ctx.hasUI) return;

  const retrySuffix = attempt > 1 ? ` retry ${attempt}/${LOW_EFFORT_COMPACTION_ATTEMPTS}` : "";
  ctx.ui.setStatus(STATUS_KEY, `${COMPACTING_STATUS}${retrySuffix}`);
}

function clearStatus(ctx: ExtensionContext): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function notifyDefaultFallback(
  ctx: ExtensionContext,
  model: Pick<ModelSnapshot, "provider" | "id">,
  reason: string,
): void {
  ctx.ui.notify(
    `Low-effort compaction failed for ${formatModel(model)}: ${reason}. Falling back to default compaction.`,
    "warning",
  );
}

function notifyRetry(
  ctx: ExtensionContext,
  model: Pick<ModelSnapshot, "provider" | "id">,
  error: unknown,
  attempt: number,
): void {
  ctx.ui.notify(
    `Low-effort compaction attempt ${attempt}/${LOW_EFFORT_COMPACTION_ATTEMPTS} failed for ${formatModel(model)}: ${formatError(error)}. Retrying in ${formatDelay(LOW_EFFORT_RETRY_DELAY_MS)}.`,
    "warning",
  );
}

function formatDelay(delayMs: number): string {
  if (delayMs % 1_000 === 0) return `${delayMs / 1_000}s`;
  return `${delayMs}ms`;
}

function createAbortError(): Error {
  const error = new Error("Compaction cancelled");
  error.name = "AbortError";
  return error;
}

async function delay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError());
    };

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function compactWithRetries(
  compactFn: CompactFunction,
  compactArgs: CompactParameters,
  ctx: ExtensionContext,
  model: Pick<ModelSnapshot, "provider" | "id">,
  delayFn: DelayFunction,
): Promise<CompactResult> {
  for (let attempt = 1; attempt <= LOW_EFFORT_COMPACTION_ATTEMPTS; attempt++) {
    try {
      return await compactFn(...compactArgs);
    } catch (error) {
      if (isAbortError(error, compactArgs[5])) throw error;
      if (attempt === LOW_EFFORT_COMPACTION_ATTEMPTS) throw error;

      notifyRetry(ctx, model, error, attempt);
      setCompactionStatus(ctx, attempt + 1);
      await delayFn(LOW_EFFORT_RETRY_DELAY_MS, compactArgs[5]);
    }
  }

  throw new Error("Low-effort compaction failed without an error");
}

export function registerLowEffortCompaction(
  pi: ExtensionAPI,
  dependencies: Partial<LowEffortCompactionDependencies> = {},
): void {
  const compactFn = dependencies.compact ?? compact;
  const delayFn = dependencies.delay ?? delay;
  let compactionModel: ModelSnapshot | null = null;

  pi.on("session_before_compact", async (event, ctx) => {
    let modelForCompaction: ActiveModel | undefined;

    try {
      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("Low-effort compaction skipped: no active model", "warning");
        return;
      }

      // Snapshot the *session* model so we can restore it after compaction,
      // even if we use a different model for the compaction request itself.
      compactionModel = snapshotModel(model);
      setCompactionStatus(ctx);

      modelForCompaction = resolveCompactionModel(model, ctx.modelRegistry);

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelForCompaction);
      if (!auth.ok) {
        notifyDefaultFallback(ctx, modelForCompaction, auth.error);
        return;
      }
      if (!auth.apiKey) {
        notifyDefaultFallback(ctx, modelForCompaction, `no API key for ${modelForCompaction.provider}`);
        return;
      }

      const compactArgs: CompactParameters = [
        event.preparation,
        modelForCompaction,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        COMPACTION_THINKING_LEVEL,
      ];
      const result = await compactWithRetries(
        compactFn,
        compactArgs,
        ctx,
        modelForCompaction,
        delayFn,
      );

      return { compaction: result };
    } catch (error) {
      if (isAbortError(error, event.signal)) {
        return { cancel: true };
      }

      if (modelForCompaction) {
        notifyDefaultFallback(ctx, modelForCompaction, formatError(error));
      } else {
        ctx.ui.notify(
          `Low-effort compaction failed before model resolution: ${formatError(error)}. Falling back to default compaction.`,
          "warning",
        );
      }
      return;
    } finally {
      clearStatus(ctx);
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    const expected = compactionModel;
    compactionModel = null;
    if (!expected || sameModel(expected, ctx.model)) return;

    await pi.setModel(expected.model);
    ctx.ui.notify(
      `Restored session model to ${formatModel(expected)} after compaction`,
      "warning",
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    compactionModel = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}

export default function lowEffortCompaction(pi: ExtensionAPI): void {
  registerLowEffortCompaction(pi);
}
