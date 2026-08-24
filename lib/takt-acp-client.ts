import { type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawnCommand, stopChild } from "./process-control.ts";
import { resolveCommand } from "./takt-state.ts";

const ACP_CANCEL_NOTIFY_TIMEOUT_MS = 2_000;

export interface TaktAcpClientOptions {
  cwd: string;
  command?: string;
  onUpdate?: (update: TaktAcpUpdate) => void;
}

export interface TaktAcpUpdate {
  sessionId: string;
  kind: string;
  text?: string;
  title?: string;
  status?: string;
}

export interface TaktEnqueueResult {
  sessionId: string;
  stopReason: string;
  messages: string[];
  /** Workflow reported by TAKT's ACP enqueue result, when present. */
  workflow?: string;
}

export interface VerifiedTaktEnqueueResult extends TaktEnqueueResult {
  expectedWorkflow: string;
  workflowVerified: true;
}

export function buildEnqueuePrompt(task: string): string {
  return `/go ${task.trim()}`;
}

/** Read the exact workflow contract written by the planner. */
export function extractWorkflowDirective(text: string): string | undefined {
  const matches = [...text.matchAll(/^\s*(?:[-*]\s+)?workflow\s*:\s*([^\s`#]+)\s*$/gim)];
  return matches.at(-1)?.[1]?.trim() || undefined;
}

/** Read the workflow that TAKT reports after persisting an ACP task. */
export function extractEnqueuedWorkflow(messages: readonly string[]): string | undefined {
  let pendingResultIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (/status\s*:\s*pending/i.test(messages[index] ?? "")) {
      pendingResultIndex = index;
      break;
    }
  }
  if (pendingResultIndex < 0) {
    return undefined;
  }
  return extractWorkflowDirective(messages.slice(pendingResultIndex).join("\n"));
}

export function verifyEnqueueWorkflow(
  task: string,
  result: TaktEnqueueResult,
): VerifiedTaktEnqueueResult {
  const expectedWorkflow = extractWorkflowDirective(task);
  if (!expectedWorkflow) {
    throw new Error("TAKT task must include an exact `workflow: <id>` directive before enqueueing");
  }
  const actualWorkflow = result.workflow ?? extractEnqueuedWorkflow(result.messages);
  if (!actualWorkflow) {
    throw new Error(
      `TAKT ACP enqueue did not report a workflow for the pending task; it remains unverified (${expectedWorkflow})`,
    );
  }
  if (actualWorkflow !== expectedWorkflow) {
    throw new Error(
      `TAKT ACP workflow mismatch: requested ${expectedWorkflow}, persisted ${actualWorkflow}; `
      + "the pending task was preserved and execution is blocked",
    );
  }
  return {
    ...result,
    workflow: actualWorkflow,
    expectedWorkflow,
    workflowVerified: true,
  };
}

export function normalizeAcpUpdate(notification: SessionNotification): TaktAcpUpdate {
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    return {
      sessionId: notification.sessionId,
      kind: update.sessionUpdate,
      ...(update.content.type === "text" ? { text: update.content.text } : {}),
    };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return {
      sessionId: notification.sessionId,
      kind: update.sessionUpdate,
      ...(update.title ? { title: update.title } : {}),
      ...(update.status ? { status: update.status } : {}),
    };
  }
  return { sessionId: notification.sessionId, kind: update.sessionUpdate };
}

export class TaktAcpClient {
  private child: ChildProcess | undefined;
  private connection: ClientContext | undefined;
  private sessionId: string | undefined;
  private readonly options: TaktAcpClientOptions;

  constructor(options: TaktAcpClientOptions) {
    this.options = options;
  }

  async enqueue(task: string): Promise<TaktEnqueueResult> {
    if (!task.trim()) {
      throw new Error("TAKT task must not be empty");
    }
    if (this.child) {
      throw new Error("TAKT ACP request is already running");
    }

    const command = resolveCommand(this.options.command ?? process.env.TAKT_ACP_COMMAND ?? "takt-acp");
    const child = spawnCommand(command, [], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Give cancellation a private POSIX process group so descendants do
      // not survive when the ACP server ignores termination.
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });
    this.child = child;
    const stderr = collectStderr(child);
    const updates: TaktAcpUpdate[] = [];
    const app = client({ name: "pi-takt-marionette" })
      .onNotification(methods.client.session.update, ({ params }) => {
        const update = normalizeAcpUpdate(params);
        updates.push(update);
        this.options.onUpdate?.(update);
      })
      .onRequest(methods.client.elicitation.create, async () => ({ action: "decline" }));

    try {
      const output = Writable.toWeb(child.stdin as NodeJS.WritableStream) as unknown as WritableStream<Uint8Array>;
      const input = Readable.toWeb(child.stdout as NodeJS.ReadableStream) as unknown as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(output, input);
      const childError = new Promise<never>((_resolve, reject) => {
        child.once("error", reject);
      });
      const result = await Promise.race([
        app.connectWith(stream, async (connection) => {
          this.connection = connection;
          const initialized = await connection.request<InitializeResponse>(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { elicitation: { form: true } },
            clientInfo: { name: "pi-takt-marionette", version: "0.1.0" },
          });
          if (initialized.protocolVersion !== PROTOCOL_VERSION) {
            throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}`);
          }

          const newSessionParams = {
            cwd: this.options.cwd,
            mcpServers: [],
            defaultAction: "enqueue",
          } as unknown as NewSessionRequest;
          const session = await connection.request<NewSessionResponse>(methods.agent.session.new, newSessionParams);
          this.sessionId = session.sessionId;
          const prompt = await connection.request<PromptResponse>(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: buildEnqueuePrompt(task) }],
          });
          return { sessionId: session.sessionId, prompt };
        }),
        childError,
      ]);

      const messages = updates.flatMap((update) => (update.text ? [update.text] : []));
      const workflow = extractEnqueuedWorkflow(messages);
      return {
        sessionId: result.sessionId,
        stopReason: result.prompt.stopReason,
        messages,
        ...(workflow ? { workflow } : {}),
      };
    } catch (error) {
      const detail = stderr.value;
      if (detail && error instanceof Error) {
        error.message = `${error.message} (${detail})`;
      }
      throw error;
    } finally {
      this.connection = undefined;
      this.sessionId = undefined;
      await terminate(child);
      if (this.child === child) {
        this.child = undefined;
      }
    }
  }

  async cancel(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    const child = this.child;
    try {
      if (connection && sessionId) {
        await withTimeout(
          connection.notify(methods.agent.session.cancel, { sessionId }),
          ACP_CANCEL_NOTIFY_TIMEOUT_MS,
          "TAKT ACP cancel notification timed out",
        );
      }
    } finally {
      // A broken ACP stream must not prevent the owned process from being
      // terminated. Keep the identity check so a newer enqueue cannot be
      // cleared by a late cancellation.
      if (child) {
        await terminate(child);
        if (this.child === child) {
          this.child = undefined;
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

function collectStderr(child: ChildProcess): { value: string } {
  const result = { value: "" };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    result.value = `${result.value}${chunk}`.slice(-2_000).replace(/\s+/g, " ").trim();
  });
  return result;
}

async function terminate(child: ChildProcess): Promise<void> {
  await stopChild(child);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
