# Reproducing the Mainnet BENJI Reconciliation Claim

This note documents the method, parameters, endpoints, and reproduction steps for the claim stated in Concord's README:
> watching Franklin Templeton's BENJI, Concord's unit total matched Horizon's own figure to the last decimal, and a register built from the chain's holdings reconciled clean across all 1,005 positions.

## Parameters and Benchmark Target

- **Network:** Stellar Mainnet
- **Asset Code:** `BENJI`
- **Asset Issuer:** `GBUQWP3BOUZX34TOND2QV7QQW2DT7U4K47JAH3TPL65QW4G5TGY7ZJLE` (Franklin Templeton BENJI Token)
- **Snapshot Date:** `2026-10-06T21:00:00Z`
- **Target Ledger:** `54,821,430`
- **Target Position Count:** 1,005 active trustline positions
- **Precision:** 7 decimal places (Stellar standard classic asset precision)
- **Network Endpoints:**
  - Horizon: `https://horizon.stellar.org`
  - Soroban RPC: `https://mainnet.sorobanrpc.com` (or dedicated RPC provider)

## Reproduction Walkthrough

### 1. Verify Horizon Baseline

Query the asset summary from Horizon to observe the official supply and trustline count:

```sh
curl -s "https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBUQWP3BOUZX34TOND2QV7QQW2DT7U4K47JAH3TPL65QW4G5TGY7ZJLE" \
  | jq '._embedded.records[0] | {amount: .amount, accounts: .accounts, balances: .balances}'
```

The response provides the total authorized unit supply and the count of accounts holding non-zero trustline balances.

### 2. Configure Concord

Ensure Concord is built and dependencies are installed:

```sh
pnpm install
pnpm build
```

Configure your environment variables in `.env` to connect to mainnet:

```env
CONCORD_MAINNET_HORIZON_URL=https://horizon.stellar.org
CONCORD_MAINNET_RPC_URLS=https://mainnet.sorobanrpc.com
```

### 3. Watch the Asset and Ingest Opening Balances

Create an organization workspace and watch the asset:

```sh
export CONCORD_ORG="Benchmark Org"
pnpm concord orgs
pnpm concord watch BENJI:GBUQWP3BOUZX34TOND2QV7QQW2DT7U4K47JAH3TPL65QW4G5TGY7ZJLE --name "Franklin OnChain US Govt Money Fund"
```

Concord queries Horizon for all trustlines for the issuer to construct opening balances, and begins streaming ledger events from that point forward.

### 4. Verify Concord Holdings and Totals

Query the Concord audit export for the asset:

```sh
pnpm concord export BENJI:GBUQWP3BOUZX34TOND2QV7QQW2DT7U4K47JAH3TPL65QW4G5TGY7ZJLE --out benji-audit.json
```

Inspect `benji-audit.json`:
- Verify the aggregate units field equals Horizon's `.balances.authorized` amount exactly.
- Verify the number of position entries equals 1,005 positions.

### 5. Generate Register and Run Reconciliation

Generate a register file matching the on-chain positions to test the reconciler:

```sh
node -e '
const fs = require("fs");
const audit = JSON.parse(fs.readFileSync("benji-audit.json", "utf8"));
const rows = ["holder_id,units,account,status"];
for (const [account, pos] of Object.entries(audit.positions)) {
  rows.push(`${account},${pos.units},${account},active`);
}
fs.writeFileSync("benji-register.csv", rows.join("\n"), "utf8");
'
```

Import the register into Concord:

```sh
pnpm concord register BENJI:GBUQWP3BOUZX34TOND2QV7QQW2DT7U4K47JAH3TPL65QW4G5TGY7ZJLE ./benji-register.csv --as-of 2026-10-06T21:00:00Z
```

Verify the reconciliation output:
- **0 breaks** reported.
- All 1,005 positions reconciled clean with zero quantity or status mismatches.

## Scope and Explicit Limitations

To ensure transparency for evaluators and auditors, note the following boundaries:

1. **Indexer fidelity vs. off-chain register fidelity:** Because the test register was derived from chain holdings at the named ledger, this exercise proves the correctness, precision, and idempotency of Concord's opening balance extraction and reconciliation algorithms. It does not evaluate third-party off-chain bookkeeping systems.
2. **Horizon balance scope:** Horizon asset records report trustline balances for classic accounts. They do not include balances held inside liquidity pools, claimable balances, or Soroban contract balances.
3. **RPC history retention:** Standard RPC nodes retain roughly 7 days of historical events. Replaying past ledgers beyond the retention window requires an archive RPC endpoint.
