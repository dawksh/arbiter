import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, arcTestnet } from "viem/chains";
import { escrowAbi } from "../shared/abi";
import type { Agreement } from "../shared/protocol";
export function chainService(env = process.env) {
  const chain = env.CHAIN_ID === "31337" ? anvil : arcTestnet;
  if (env.CHAIN_ID && !["31337", "5042002"].includes(env.CHAIN_ID))
    throw Error("Testnet only");
  const rpc = env.RPC_URL || chain.rpcUrls.default.http[0];
  const address = env.ESCROW_ADDRESS as Address | undefined;
  const client = createPublicClient({ chain, transport: http(rpc) });
  const account = env.EVALUATOR_PRIVATE_KEY
    ? privateKeyToAccount(env.EVALUATOR_PRIVATE_KEY as Hex)
    : undefined;
  const wallet = account
    ? createWalletClient({ account, chain, transport: http(rpc) })
    : undefined;
  async function read(id: string): Promise<Agreement> {
    if (!address) throw Error("Deploy an escrow and set ESCROW_ADDRESS");
    const a = await client.readContract({
      address,
      abi: escrowAbi,
      functionName: "getAgreement",
      args: [BigInt(id)],
    });
    return JSON.parse(
      JSON.stringify({ id, ...a }, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
  }
  async function send(
    functionName: "postEvaluation" | "settle" | "executeTimeout",
    args: readonly unknown[],
  ) {
    if (!wallet || !address) throw Error("Evaluator relay not configured");
    const { request } = await client.simulateContract({
      address,
      abi: escrowAbi,
      functionName,
      args,
      account: wallet.account,
    } as any);
    return wallet.writeContract(request);
  }
  return { chain, rpc, address, client, wallet, read, send };
}
