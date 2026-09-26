// Prints the CI context of a root module as JSON (account, region, state bucket,
// role ARNs, GitHub environment). Used by the infra-* workflows.
// Usage: node src/root-context.ts <root relative to infra/live>
import { rootContext } from "./state-location.ts";

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: root-context.ts <root>");
    process.exit(2);
  }
  const ctx = rootContext(root);
  if (!ctx.accountId) {
    console.error(`::error::account id of "${ctx.account}" is not set in infra/accounts.json (bootstrap not finished)`);
    process.exit(1);
  }
  console.log(JSON.stringify(ctx));
}
