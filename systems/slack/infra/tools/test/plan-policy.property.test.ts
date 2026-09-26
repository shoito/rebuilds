// PROP-INFRA-003: the plan policy passes exactly when every stateful delete is
// covered by a valid exception and nothing falls into DT-INFRA-007 row 4.
// The Rego policy (via opa) is compared with the TypeScript reference
// implementation of DT-INFRA-007 on generated plans (quality.md section 2.1).
import fc from "fast-check";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INFRA_DIR } from "../src/lib/paths.ts";
import { loadPolicyData, referenceAllow, referenceRow } from "../src/plan-policy-reference.ts";
import { type OpaServer, startOpaServer } from "./opa-server.ts";
import { policyInput } from "./plan-json.arbitrary.ts";

const NUM_RUNS = Number(process.env["PROP_INFRA_003_RUNS"] ?? 1000);
const COUNTEREXAMPLE_DIR = join(INFRA_DIR, "policy/test/fixtures/counterexamples");

describe("PROP-INFRA-003: plan policy blocks every protected change", () => {
  let opa: OpaServer;
  const data = loadPolicyData();

  beforeAll(async () => {
    opa = await startOpaServer();
  });
  afterAll(() => opa?.stop());

  it(`PROP-INFRA-003: opa result equals the DT-INFRA-007 reference implementation (${NUM_RUNS} runs)`, async () => {
    const details = await fc.check(
      fc.asyncProperty(policyInput, async (input) => {
        const result = await opa.evaluate(input);
        const expected = referenceAllow(input, data);
        if (result.allow !== expected) return false;
        // Every denied change is reported by address; row 1 usage is reported.
        const changes = input.plan.resource_changes ?? [];
        const rows = changes.map((rc) => referenceRow(rc, input, data));
        const deniedCount = rows.filter((r) => r === 2 || r === 4).length;
        const deniedAddresses = new Set(changes.filter((_, i) => rows[i] === 2 || rows[i] === 4).map((rc) => rc.address));
        if (deniedCount > 0 && result.deny.length === 0) return false;
        for (const a of deniedAddresses) if (!result.deny.some((m) => m.startsWith(`${a}: `))) return false;
        if (rows.includes(1) && result.exceptions_used.length === 0) return false;
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
    if (details.failed && details.counterexample) {
      mkdirSync(COUNTEREXAMPLE_DIR, { recursive: true });
      const file = join(COUNTEREXAMPLE_DIR, `seed-${details.seed}.json`);
      writeFileSync(file, JSON.stringify(details.counterexample[0], null, 2));
      expect.fail(`PROP-INFRA-003 counterexample (shrunk) written to ${file}\n${fc.defaultReportMessage(details)}`);
    }
    expect(details.failed).toBe(false);
  });
});
