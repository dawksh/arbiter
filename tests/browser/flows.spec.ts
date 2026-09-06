import { test, expect, type Page } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  http,
  hexToString,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { escrowAbi } from "../../shared/abi";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const deployment = JSON.parse(
  readFileSync(".cache/local-deployment.json", "utf8"),
);
const accounts = [0, 1, 2, 3].map((addressIndex) =>
  mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex },
  ),
);
const client = createPublicClient({ chain: anvil, transport: http() });
async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const d: any = await r.json();
  if (d.error) throw Error(d.error.message);
  return d.result;
}
const roles = new WeakMap<Page, { index: number; reject: boolean }>();
async function wallet(page: Page, index: number, reject = false) {
  roles.set(page, { index, reject });
  await page.exposeFunction(
    "walletRequest",
    async ({ method, params = [] }: { method: string; params: any[] }) => {
      const role = roles.get(page)!;
      if (method === "eth_accounts" || method === "eth_requestAccounts") {
        if (role.reject && method === "eth_requestAccounts")
          throw Error("User rejected the request");
        return [accounts[role.index]!.address];
      }
      if (
        method === "wallet_switchEthereumChain" ||
        method === "wallet_addEthereumChain"
      )
        return null;
      if (method === "personal_sign")
        return accounts[role.index]!.signMessage({
          message: hexToString(params[0]),
        });
      return rpc(method, params);
    },
  );
  await page.addInitScript(() => {
    (window as any).ethereum = {
      request: async (x: any) => {
        try {
          return await (window as any).walletRequest(x);
        } catch (e: any) {
          if (e.message.includes("rejected")) e.code = 4001;
          throw e;
        }
      },
      on: () => {},
      removeListener: () => {},
    };
  });
}
async function switchRole(page: Page, index: number) {
  roles.set(page, { index, reject: false });
  await page.reload();
}
async function press(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
}
const report =
  "# Comparison\nPostgreSQL [PG], MongoDB [MONGO], SQLite [SQLITE].\n# Tradeoffs\nEach has different operational costs.\n# Recommendation\nPostgreSQL.";
test("wallet rejection is visible and retry stays available", async ({
  page,
}) => {
  await wallet(page, 0, true);
  await page.goto("/");
  await page.getByRole("button").first().click();
  await expect(page.getByRole("alert")).toContainText("rejected");
  await expect(page.getByRole("button").first()).toBeEnabled();
});
for (const outcome of ["payment", "refund", "challenge"] as const)
  test(`${outcome} from UI with real local escrow and a synthetic evaluator result`, async ({
    page,
  }) => {
    await wallet(page, 0);
    await page.goto("/create");
    await page.getByLabel("Worker wallet").fill(deployment.worker);
    await page.getByLabel("Human resolver wallet").fill(deployment.resolver);
    await page.getByLabel("Payment · USDC", { exact: true }).fill("10");
    await page.getByLabel("Demo timers:").check();
    await page.getByLabel("I understand these terms").check();
    await press(page, "Commit agreement ↗");
    await page.waitForURL(/\/agreements\/\d+/);
    const id = BigInt(page.url().split("/").pop()!);
    await switchRole(page, 1);
    await page.getByLabel("I accept the fixed terms").check();
    await press(page, "Accept fixed terms");
    await expect(
      page.getByText("Awaiting funding", { exact: true }).first(),
    ).toBeVisible();
    await switchRole(page, 0);
    await press(page, "Approve & fund 10 USDC");
    await expect(
      page.getByText("In progress", { exact: true }).first(),
    ).toBeVisible();
    await switchRole(page, 1);
    await page.getByLabel("Paste your Markdown report").fill(report);
    await page.reload();
    await expect(page.getByLabel("Paste your Markdown report")).toHaveValue(
      report,
    );
    await press(page, "Save & commit report");
    await expect(
      page.getByText("Evaluating", { exact: true }).first(),
    ).toBeVisible();
    const a = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getAgreement",
      args: [id],
    });
    const record = {
      executionMode: "synthetic-test-fixture",
      agreementId: String(id),
      chainId: 31337,
      escrow: deployment.escrow,
      policyHash: a.terms.policyHash,
      submissionHash: a.submissionHash,
      outcome: outcome === "refund" ? 2 : 1,
      criteria: [
        {
          id: "synthetic-fixture",
          status: outcome === "refund" ? "FAIL" : "PASS",
          justification: "Synthetic browser-test result. No model was called.",
          excerpts: [],
        },
      ],
    };
    const evidenceHash = execFileSync(
      "bun",
      [
        "--env-file=.env.anvil",
        "tests/helpers/record-evidence.ts",
        JSON.stringify(record),
      ],
      { encoding: "utf8" },
    ).trim() as Hex;
    const relay = createWalletClient({
      account: accounts[3]!,
      chain: anvil,
      transport: http(),
    });
    const tx = await relay.writeContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "postEvaluation",
      args: [
        id,
        deployment.escrow,
        31337n,
        a.terms.policyHash,
        a.submissionHash,
        evidenceHash,
        outcome === "refund" ? 2 : 1,
      ],
    });
    await client.waitForTransactionReceipt({ hash: tx });
    await page.reload();
    if (outcome === "challenge") {
      await press(page, "Challenge outcome");
      await expect(
        page.getByText("Human review", { exact: true }).first(),
      ).toBeVisible();
      await switchRole(page, 2);
      await page.getByLabel("Worker receives · USDC").fill("4");
      await press(page, "Resolve & settle");
    } else {
      await rpc("evm_increaseTime", [61]);
      await rpc("evm_mine");
      await page.reload();
      await press(page, "Settle agreement");
    }
    await expect(
      page.getByText("Settlement complete", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".settled")).toContainText(
      outcome === "payment"
        ? "10 USDC"
        : outcome === "refund"
          ? "0 USDC"
          : "4 USDC",
    );
    const final = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getAgreement",
      args: [id],
    });
    expect(final.state).toBe(6);
    expect(final.workerPaid).toBe(
      outcome === "payment" ? 10000000n : outcome === "refund" ? 0n : 4000000n,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByText("Onchain commitment verified", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".event").last()).toContainText("Settled");
    await page.screenshot({
      path: `test-results/${outcome}-${test.info().project.name}.png`,
      fullPage: true,
    });
  });
