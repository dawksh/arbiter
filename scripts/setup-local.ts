import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
// Public Anvil test identities. This script refuses any other chain.
const accounts = [0, 1, 2, 3].map((addressIndex) =>
  mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex },
  ),
);
const rpc = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
const p = createPublicClient({ chain: anvil, transport: http(rpc) });
if ((await p.getChainId()) !== 31337) throw Error("Local Anvil only");
const w = createWalletClient({
  account: accounts[0]!,
  chain: anvil,
  transport: http(rpc),
});
async function deploy(name: string, args: unknown[] = []) {
  const a = await Bun.file(`out/${name}.sol/${name}.json`).json();
  const h = await w.deployContract({
    abi: a.abi,
    bytecode: a.bytecode.object,
    args,
  });
  return (await p.waitForTransactionReceipt({ hash: h })).contractAddress!;
}
const token = await deploy("MockUSDC");
const escrow = await deploy("ResearchEscrow", [token, accounts[3]!.address]);
const tokenAbi = (await Bun.file("out/MockUSDC.sol/MockUSDC.json").json()).abi;
await p.waitForTransactionReceipt({
  hash: await w.writeContract({
    address: token,
    abi: tokenAbi,
    functionName: "mint",
    args: [accounts[0]!.address, 1000_000000n],
  }),
});
const block = await p.getBlockNumber();
await Bun.write(
  ".env.anvil",
  `CHAIN_ID=31337\nRPC_URL=${rpc}\nESCROW_ADDRESS=${escrow}\nDEPLOYMENT_BLOCK=0\nDB_PATH=local-${escrow}.sqlite\nEVALUATOR_PRIVATE_KEY=${toHex(accounts[3]!.getHdKey().privateKey!)}\nANTHROPIC_MODEL=claude-sonnet-4-20250514\n`,
);
await Bun.write(
  ".cache/local-deployment.json",
  JSON.stringify({
    escrow,
    token,
    block: String(block),
    client: accounts[0]!.address,
    worker: accounts[1]!.address,
    resolver: accounts[2]!.address,
    relay: accounts[3]!.address,
  }),
);
console.log(
  "Local deployment ready. Start with bun --env-file=.env.anvil index.ts. Wallet addresses:",
  JSON.stringify({
    client: accounts[0]!.address,
    worker: accounts[1]!.address,
    resolver: accounts[2]!.address,
    escrow,
  }),
);
