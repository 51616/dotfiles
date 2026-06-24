import test from "node:test";
import assert from "node:assert/strict";
import { createTuiWriterLeaseController } from "../pi-instance-manager/lib/pi-instance-manager-tui-writer.ts";

test("tui writer acquire failure reports the active owner details", async () => {
  const errors = [];
  const retries = [];
  const owner = `pi-tui:writer:pid=${process.pid}:instance=existing:session=s1`;

  const controller = createTuiWriterLeaseController({
    managerRequest: async (op) => {
      if (op === "tui_writer.acquire") throw new Error("tui writer already active");
      if (op === "state.get") {
        return {
          state: {
            tuiWriters: [
              {
                sessionId: "s1",
                owner,
                pid: process.pid,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected op: ${op}`);
    },
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    onRenewAttemptFinished: () => {},
    ownerPid: 999,
    ownerId: "new-owner",
  });

  const lease = await controller.acquireTuiWriterLease("s1");

  assert.equal(lease, null);
  assert.deepEqual(retries, [1200]);
  assert.match(errors.at(-1), /tui_writer\.acquire failed: tui writer already active/);
  assert.match(errors.at(-1), new RegExp(`pid=${process.pid}`));
  assert.match(errors.at(-1), new RegExp(`cwd=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(errors.at(-1), /owner=pi-tui:writer:/);
});
