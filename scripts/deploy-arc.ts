import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
const key = process.env.DEPLOYER_PRIVATE_KEY,
  relay = process.env.EVALUATOR_ADDRESS;
if (!key || !relay || !isAddress(relay))
  throw Error(
    "Set DEPLOYER_PRIVATE_KEY and EVALUATOR_ADDRESS. The backend uses only EVALUATOR_PRIVATE_KEY.",
  );
const transport = http(
  process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0],
);
const client = createPublicClient({ chain: arcTestnet, transport });
if ((await client.getChainId()) !== 5042002) throw Error("Arc testnet only");
const token = "0x3600000000000000000000000000000000000000";
const wallet = createWalletClient({
  account: privateKeyToAccount(key as Hex),
  chain: arcTestnet,
  transport,
});
const artifact = await Bun.file(
  "out/ResearchEscrow.sol/ResearchEscrow.json",
).json();
const tx = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [token, relay],
});
const receipt = await client.waitForTransactionReceipt({ hash: tx });
if (receipt.status !== "success") throw Error("Deployment reverted");
console.log(
  JSON.stringify(
    {
      ESCROW_ADDRESS: receipt.contractAddress,
      DEPLOYMENT_BLOCK: String(receipt.blockNumber),
      transaction: `https://testnet.arcscan.app/tx/${tx}`,
    },
    null,
    2,
  ),
);
