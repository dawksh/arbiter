import { chainService } from "../server/chain";
import { simulateNoModel } from "../server/evaluator";
import { Store } from "../server/store";
import { inputSchema } from "../shared/evaluation";

const id = process.argv[2];
if (!id) throw Error("Usage: bun run simulate <submitted agreement id>");
const chain = chainService();
if (!chain.address) throw Error("Set ESCROW_ADDRESS");
const store = new Store(process.env.DB_PATH);
try {
  const agreement = await chain.read(id);
  if (agreement.state !== 3)
    throw Error("Agreement must have a committed submission");
  const result = await simulateNoModel(
    inputSchema.parse({
      agreementId: id,
      chainId: chain.chain.id,
      escrow: chain.address,
      brief: JSON.parse(store.get(agreement.terms.briefHash)),
      sources: JSON.parse(store.get(agreement.terms.sourcesHash)),
      policy: JSON.parse(store.get(agreement.terms.policyHash)),
      report: store.get(agreement.submissionHash),
    }),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  store.close();
}
