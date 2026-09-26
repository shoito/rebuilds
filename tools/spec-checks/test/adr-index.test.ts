import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { END, renderIndex, replaceIndex, START } from "../src/adr-index.ts";
import { ROOT } from "./support.ts";

const adr = (file: string, status: string, title: string) => ({
  path: `docs/decisions/${file}`,
  text: `---\nstatus: ${status}\ndate: 2026-09-26\n---\n\n# ${title}\n\nbody\n`,
});

const README = `# Decisions\n\nintro\n\n${START}\nold\n${END}\n\nfooter\n`;

describe("REQ-DLV-010: ADR index", () => {
  it("REQ-DLV-010: renders link, title without the ADR number, and status in number order", () => {
    const table = renderIndex([
      adr("0002-b.md", "accepted", "ADR-0002: Second"),
      adr("0001-a.md", "proposed", "ADR-0001: First"),
      { path: "docs/decisions/README.md", text: "not an ADR" },
    ]);
    expect(table).toBe(
      ["| ADR | 決定 | 状態 |", "| --- | --- | --- |", "| [0001](0001-a.md) | First | proposed |", "| [0002](0002-b.md) | Second | accepted |"].join("\n"),
    );
  });

  it("REQ-DLV-010: replaces only the text between the markers", () => {
    const next = replaceIndex(README, "TABLE");
    expect(next).toBe(`# Decisions\n\nintro\n\n${START}\nTABLE\n${END}\n\nfooter\n`);
    expect(() => replaceIndex("no markers", "TABLE")).toThrow(/markers/);
  });

  it("REQ-DLV-010: a forgotten update is detected; a regenerated status change is not", () => {
    const adrs = [adr("0023-cells.md", "proposed", "ADR-0023: Cells")];
    const committed = replaceIndex(README, renderIndex(adrs));
    const added = [...adrs, adr("0034-new.md", "proposed", "ADR-0034: New")];
    expect(replaceIndex(committed, renderIndex(added))).not.toBe(committed);
    const accepted = [adr("0023-cells.md", "accepted", "ADR-0023: Cells")];
    const regenerated = replaceIndex(committed, renderIndex(accepted));
    expect(replaceIndex(regenerated, renderIndex(accepted))).toBe(regenerated);
  });

  it("REQ-DLV-010: both real decisions/README.md files are up to date", () => {
    for (const dir of ["docs/decisions", "systems/slack/docs/decisions"]) {
      const files = readdirSync(join(ROOT, dir))
        .filter((f) => /^\d{4}-/.test(f))
        .map((f) => ({ path: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), "utf8") }));
      const readme = readFileSync(join(ROOT, dir, "README.md"), "utf8");
      expect(replaceIndex(readme, renderIndex(files)), dir).toBe(readme);
    }
  });

  it("REQ-DLV-010: the --check command passes on the repository", () => {
    const out = execFileSync("node", ["src/cli.ts", "gen:adr-index", "--check"], { cwd: join(ROOT, "tools/spec-checks"), encoding: "utf8" });
    expect(out).toBe("");
  });
});
