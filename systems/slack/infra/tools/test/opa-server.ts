// Starts `opa run --server` with the plan policy so property tests can evaluate
// thousands of inputs without spawning a process per input.
import { type ChildProcess, spawn } from "node:child_process";
import { POLICY_DIRS, type PolicyInput, type PolicyResult } from "../src/plan-policy.ts";

export interface OpaServer {
  evaluate(input: PolicyInput): Promise<PolicyResult>;
  stop(): void;
}

export async function startOpaServer(): Promise<OpaServer> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn("opa", ["run", "--server", "--addr", `127.0.0.1:${port}`, "--log-level", "error", ...POLICY_DIRS], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}/v1/data/infra/plan/result`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error("opa server did not start");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    async evaluate(input) {
      const res = await fetch(url, { method: "POST", body: JSON.stringify({ input }) });
      const body = (await res.json()) as { result?: PolicyResult };
      if (!body.result) throw new Error(`opa returned no result: ${JSON.stringify(body)}`);
      return body.result;
    },
    stop() {
      proc.kill();
    },
  };
}
