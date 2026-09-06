import { simulate } from "../server/evaluator";
import { chainService } from "../server/chain";
import { Store } from "../server/store";
import { hash, inputSchema } from "../shared/evaluation";
const id = process.argv[2];
if (!id) throw Error("Usage: bun run proof <submitted agreement id>");
const chain = chainService();
if (chain.chain.id !== 5042002 || !chain.address || !chain.wallet)
  throw Error("Configure Arc testnet escrow and evaluator relay");
const a = await chain.read(id);
if (a.state !== 3)
  throw Error("Agreement must have a funded, committed submission");
const store = new Store(process.env.DB_PATH);
const result = await simulate(
  inputSchema.parse({
    agreementId: id,
    chainId: chain.chain.id,
    escrow: chain.address,
    brief: JSON.parse(store.get(a.terms.briefHash)),
    sources: JSON.parse(store.get(a.terms.sourcesHash)),
    policy: JSON.parse(store.get(a.terms.policyHash)),
    report: store.get(a.submissionHash),
  }),
);
const body = JSON.stringify(result);
store.put(body, chain.address);
store.enqueue(id);
store.db
  .query("UPDATE jobs SET status='ready',evidence=? WHERE id=?")
  .run(body, id);
const tx = await chain.send("postEvaluation", [
  BigInt(id),
  chain.address,
  BigInt(chain.chain.id),
  a.terms.policyHash,
  a.submissionHash,
  hash(body),
  result.outcome,
]);
store.db.query("UPDATE jobs SET status='relaying',tx=? WHERE id=?").run(tx, id);
const receipt = await chain.client.waitForTransactionReceipt({ hash: tx });
if (receipt.status !== "success") throw Error("Relay reverted");
store.db.query("UPDATE jobs SET status='posted' WHERE id=?").run(id);
store.close();
console.log(
  JSON.stringify(
    {
      mode: result.executionMode,
      evidenceHash: hash(body),
      outcome: result.outcome,
      tx,
    },
    null,
    2,
  ),
);
