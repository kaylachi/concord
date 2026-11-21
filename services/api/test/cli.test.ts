import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import { NotFound } from "../src/concord.js";
import { loadConfig, type Config } from "../src/config.js";
import { openRuntime } from "../src/main.js";
import { FAST, at, key } from "./helpers.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("CLI registers and register-delete", { timeout: 30_000 }, () => {
  let dataDir: string;
  let orgId: string;
  let config: Config;
  const assetCode = "TEST";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "concord-cli-test-"));
    config = loadConfig({ CONCORD_DATA_DIR: dataDir });
    const runtime = openRuntime(config);
    const { orgId: newOrgId } = await runtime.auth.signUp({
      email: "user@example.test",
      name: "Test User",
      password: "Password123!",
      orgName: "Test Org",
    });
    orgId = newOrgId;

    const concord = runtime.tenants.forOrg(orgId);
    concord.db.insert(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetCode,
      "testnet",
      assetCode,
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "Test Asset",
      7,
      "ledger",
      "ready",
      "2026-10-01T00:00:00Z",
    );
    runtime.close();
  });

  beforeEach(async () => {
    const runtime = openRuntime(config);
    const concord = runtime.tenants.forOrg(orgId);
    concord.db.raw.exec("DELETE FROM runs; DELETE FROM registers; DELETE FROM register_positions;");

    const csv1 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,100,active\n";
    const reg1 = concord.importRegister(
      assetCode,
      { csv: csv1, asOf: "2026-10-01T00:00:00.000Z", source: "reg1.csv" },
      { id: "u1", label: "admin <admin@example.test>" },
    );
    await concord.reconcile(assetCode, reg1.registerId);

    const csv2 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,90,active\n";
    const reg2 = concord.importRegister(assetCode, { csv: csv2, asOf: "2026-10-02T00:00:00.000Z", source: "reg2.csv" });
    await concord.reconcile(assetCode, reg2.registerId);

    runtime.close();
  });

  afterAll(() => {
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  function run(args: string[], stdin?: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: dataDir,
          CONCORD_ORG: orgId,
        },
        input: stdin,
        encoding: "utf8",
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number; message?: string };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  it("lists imported registers in table format and json format", () => {
    // 1. Table format
    const resTable = run(["registers", assetCode]);
    expect(resTable.status).toBe(0);
    expect(resTable.stdout).toContain("as-of");
    expect(resTable.stdout).toContain("rejected rows");
    expect(resTable.stdout).toContain("reg1.csv");
    expect(resTable.stdout).toContain("reg2.csv");
    expect(resTable.stdout).toContain("admin <admin@example.test>");

    // 2. JSON format
    const resJson = run(["registers", assetCode, "--json"]);
    expect(resJson.status).toBe(0);
    const parsed = JSON.parse(resJson.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      source: "reg2.csv",
      positions: 1,
    });
    expect(parsed[1]).toMatchObject({
      source: "reg1.csv",
      importedBy: "admin <admin@example.test>",
    });
  });

  it("supports aborting register deletion without --yes", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'n'
    const resAbort = run(["register-delete", assetCode, String(regId)], "n\n");
    expect(resAbort.stdout).toContain("aborted");

    // Verify it was NOT deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(2);
  });

  it("confirms and deletes when 'y' is answered to prompt", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'y'
    const resConfirm = run(["register-delete", assetCode, String(regId)], "y\n");
    expect(resConfirm.status).toBe(0);
    expect(resConfirm.stdout).toContain(`deleted register ${regId}`);

    // Verify it is deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("deletes a register with --yes and reports how many runs went with it", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Delete with --yes
    const resDel = run(["register-delete", assetCode, String(regId), "--yes"]);
    expect(resDel.status).toBe(0);
    expect(resDel.stdout).toContain(`deleted register ${regId} (1 reconciliation run removed)`);

    // Verify it is gone from the list
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("fails cleanly when deleting a nonexistent register", () => {
    const res = run(["register-delete", assetCode, "99999", "--yes"]);
    expect(res.status).not.toBe(0);
  });
});

describe("CLI runs and run commands", () => {
  it("lists reconciliation history with runs, respects --limit, shows run details, and exits 1 on unknown run id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-cli-555-"));
    try {
      const issuer = key();
      const holder = key();
      let orgId: string;
      let run1Id: number;
      let run2Id: number;

      const rt = openRuntime(loadConfig({ CONCORD_DATA_DIR: dir, CONCORD_SIGNUP: "open" }));
      try {
        const fastAuth = new Auth(rt.control, { signup: "open", cost: FAST });
        const signed = await fastAuth.signUp({
          email: "runs-cli@example.test",
          name: "CLI Operator",
          orgName: "Runs Org",
          password: "correct horse battery",
        });
        orgId = signed.orgId;
        const ws = rt.tenants.forOrg(orgId);
        ws.db.insert(
          `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, synced_at, synced_ledger, created_at)
           VALUES ('CASSETRUN', 'testnet', 'FUND', ?, 'Fund', 7, 'window', 'ready', ?, 20, ?)`,
          issuer,
          at(20),
          at(1),
        );
        const reg1 = ws.importRegister("FUND", {
          csv: `holder_id,account,units\nH1,${holder},0\n`,
          asOf: at(5),
        });
        const reg2 = ws.importRegister("FUND", {
          csv: `holder_id,account,units\nH1,${holder},0\n`,
          asOf: at(10),
        });
        const r1 = await ws.reconcile("FUND", reg1.registerId);
        const r2 = await ws.reconcile("FUND", reg2.registerId);
        run1Id = r1.id;
        run2Id = r2.id;
      } finally {
        rt.close();
      }

      const execCli = async (args: string[]) => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => lines.push(String(msg ?? "")));
        try {
          await runCli(args, { CONCORD_DATA_DIR: dir, CONCORD_ORG: orgId });
          return lines.join("\n");
        } finally {
          spy.mockRestore();
        }
      };

      const allRuns = JSON.parse(await execCli(["runs", "FUND", "--json"])) as Array<Record<string, unknown>>;
      expect(allRuns).toHaveLength(2);
      expect(allRuns[0]).toMatchObject({
        id: run2Id,
        asOf: at(10),
        status: "clean",
        openBreaks: 0,
      });
      expect(allRuns[0]).toHaveProperty("createdAt");
      expect(allRuns[0]).toHaveProperty("chainBehind");
      expect(allRuns[0]).toHaveProperty("summary");

      const limited = JSON.parse(await execCli(["runs", "FUND", "--limit", "1", "--json"])) as Array<Record<string, unknown>>;
      expect(limited).toHaveLength(1);
      expect(limited[0]!.id).toBe(run2Id);

      const shown = JSON.parse(await execCli(["run", String(run1Id), "--json"])) as Record<string, unknown>;
      expect(shown).toMatchObject({
        id: run1Id,
        asOf: at(5),
        status: "clean",
        openBreaks: 0,
      });
      expect(shown).toHaveProperty("breaks");
      expect(shown).toHaveProperty("lines");

      await expect(execCli(["run", "999999", "--json"])).rejects.toThrow(NotFound);
      await expect(execCli(["run", "999999", "--json"])).rejects.toThrow("reconciliation 999999 not found");

      const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
      const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      const proc = spawnSync(process.execPath, [tsxCli, cliEntry, "run", "999999"], {
        env: { ...process.env, CONCORD_DATA_DIR: dir, CONCORD_ORG: orgId },
        encoding: "utf8",
      });
      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain("reconciliation 999999 not found");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 15_000);
});
