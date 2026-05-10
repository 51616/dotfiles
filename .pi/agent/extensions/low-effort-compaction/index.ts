import { compact, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const COMPACTION_THINKING_LEVEL = "low" as const;
const STATUS_KEY = "low-effort-compaction";
const COMPACTING_STATUS = "⧉ compacting |";

type ActiveModel = NonNullable<ExtensionContext["model"]>;

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

export default function lowEffortCompaction(pi: ExtensionAPI) {
  let compactionModel: ModelSnapshot | null = null;

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("Low-effort compaction skipped: no active model", "warning");
      return;
    }

    compactionModel = snapshotModel(model);
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, COMPACTING_STATUS);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(`Low-effort compaction auth failed: ${auth.error}`, "warning");
      return;
    }
    if (!auth.apiKey) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(`Low-effort compaction auth failed: no API key for ${model.provider}`, "warning");
      return;
    }

    const result = await compact(
      event.preparation,
      model,
      auth.apiKey,
      auth.headers,
      event.customInstructions,
      event.signal,
      COMPACTION_THINKING_LEVEL,
    );

    return { compaction: result };
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
