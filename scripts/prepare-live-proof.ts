import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { escrowAbi } from "../shared/abi";
import { hash, sampleBrief, samplePolicy, sampleSources } from "../shared/evaluation";
import { authMessage } from "../shared/protocol";

if (process.env.CONFIRM_LIVE_DEMO !== "1")
  throw Error("Set CONFIRM_LIVE_DEMO=1 to create a paid Arc agreement");

const escrow = process.env.ESCROW_ADDRESS as Address | undefined;
const origin = process.env.APP_ORIGIN || "http://localhost:3000";
const model = process.env.ANTHROPIC_MODEL;
if (!escrow || !model) throw Error("Set ESCROW_ADDRESS and ANTHROPIC_MODEL");

const key = (name: string) => {
  const value = process.env[name] as Hex | undefined;
  if (!value) throw Error(`Set ${name}`);
  return privateKeyToAccount(value);
};
const clientAccount = key("CLIENT_PRIVATE_KEY");
const workerAccount = key("WORKER_PRIVATE_KEY");
const resolver = process.env.RESOLVER_ADDRESS as Address | undefined;
if (!resolver) throw Error("Set RESOLVER_ADDRESS");

const transport = http(process.env.RPC_URL);
const publicClient = createPublicClient({ chain: arcTestnet, transport });
const clientWallet = createWalletClient({
  account: clientAccount,
  chain: arcTestnet,
  transport,
});
const workerWallet = createWalletClient({
  account: workerAccount,
  chain: arcTestnet,
  transport,
});

async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "API request failed");
  return data;
}

async function signed(
  account: ReturnType<typeof privateKeyToAccount>,
  route: string,
  action: string,
  body: string,
) {
  const { nonce } = await request("/api/nonce", { address: account.address });
  const signature = await account.signMessage({
    message: authMessage(
      origin,
      arcTestnet.id,
      escrow!,
      account.address,
      action,
      hash(body),
      nonce,
    ),
  });
  return request(route, { address: account.address, signature, nonce, body });
}

async function write(
  wallet: typeof clientWallet,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) {
  const { request: tx } = await publicClient.simulateContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
  } as never);
  const txHash = await wallet.writeContract(tx as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw Error(`${functionName} reverted`);
  return txHash;
}

const report = `# Comparison
PostgreSQL supports relational constraints, joins, and ACID transactions. Managed hosting can reduce operations work, while horizontal write scaling takes planning [PG]. MongoDB stores flexible documents and supports sharding. Cross-document relationships require careful modeling, and transactions add complexity [MONGO]. SQLite is embedded, uses no database server, and supports SQL and transactions. Its single writer and local file deployment constrain distributed write-heavy services [SQLITE].

# Tradeoffs
PostgreSQL fits relational billing data and can use managed hosting to reduce work. MongoDB offers flexible documents but needs careful relationship modeling. SQLite minimizes server operations but its single writer is a constraint for a distributed service. These are tradeoffs from the supplied notes.

# Recommendation
Recommend PostgreSQL for this transactional SaaS workload. Its relational constraints, joins, and ACID transactions fit relational billing data, and managed hosting addresses the limited operations budget [PG].`;
const policy = samplePolicy(model);
const termBody = JSON.stringify({
  brief: sampleBrief,
  sources: sampleSources,
  policy,
});
const hashes = await signed(clientAccount, "/api/terms", "terms", termBody);
const amount = 5_000_000n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 86_400);
const createTx = await write(clientWallet, escrow, escrowAbi, "create", [
  {
    worker: workerAccount.address,
    resolver,
    amount,
    ...hashes,
    submissionDeadline: deadline,
    evaluationPeriod: 300n,
    challengePeriod: 60n,
    resolutionPeriod: 180n,
  },
]);
const id = await publicClient.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: "count",
});
const agreementId = String(id);
const acceptTx = await write(workerWallet, escrow, escrowAbi, "accept", [id]);
const token = await publicClient.readContract({
  address: escrow,
  abi: escrowAbi,
  functionName: "token",
});
const approveTx = await write(clientWallet, token, erc20Abi, "approve", [escrow, amount]);
const fundTx = await write(clientWallet, escrow, escrowAbi, "fund", [id]);
const { hash: submissionHash } = await signed(
  workerAccount,
  `/api/agreements/${agreementId}/submission`,
  `submission:${agreementId}`,
  report,
);
const submitTx = await write(workerWallet, escrow, escrowAbi, "submit", [id, submissionHash]);

console.log(
  JSON.stringify(
    {
      agreementId,
      amountMicroUsdc: String(amount),
      transactions: { createTx, acceptTx, approveTx, fundTx, submitTx },
    },
    null,
    2,
  ),
);
