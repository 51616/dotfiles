import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";
import { resolveRemoteFffRuntime, type RemoteFffRuntime } from "./remote-runtime.ts";
import { RemoteFffWorkerClient, type RemoteFffWorkerLauncher } from "./worker-client.ts";

export interface RemoteFffManagerOptions {
  launcher?: RemoteFffWorkerLauncher;
  idleTtlMs?: number;
  requestTimeoutMs?: number;
}

export interface RemoteFffClientSnapshot {
  runtime: RemoteFffRuntime;
  localPid?: number;
}

interface ManagedClient {
  key: string;
  runtime: RemoteFffRuntime;
  client: RemoteFffWorkerClient;
}

function buildSessionKey(session: PiSshSession): string {
  const connection = session.getConnectionInfo();
  return `${connection.remote}:${connection.port}:${connection.remoteCwd}`;
}

export class RemoteFffManager {
  private readonly launcher?: RemoteFffWorkerLauncher;
  private readonly idleTtlMs: number;
  private readonly requestTimeoutMs: number;
  private managed: ManagedClient | null = null;

  constructor(options: RemoteFffManagerOptions = {}) {
    this.launcher = options.launcher;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  }

  get snapshot(): RemoteFffClientSnapshot | null {
    if (!this.managed) return null;
    return {
      runtime: this.managed.runtime,
      localPid: this.managed.client.pid,
    };
  }

  async getClient(session: PiSshSession, signal?: AbortSignal): Promise<RemoteFffWorkerClient> {
    const key = buildSessionKey(session);
    if (this.managed?.key === key) {
      return this.managed.client;
    }

    this.dispose();
    const runtime = await resolveRemoteFffRuntime(session, signal);
    const client = new RemoteFffWorkerClient({
      ...runtime,
      idleTtlMs: this.idleTtlMs,
      requestTimeoutMs: this.requestTimeoutMs,
      ...(this.launcher ? { launcher: this.launcher } : {}),
    });
    this.managed = { key, runtime, client };
    return client;
  }

  dispose(): void {
    this.managed?.client.dispose();
    this.managed = null;
  }

  restart(): void {
    this.managed?.client.restart();
  }
}
