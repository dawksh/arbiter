import page from "./web/index.html";
import { Store } from "./server/store";
import { chainService } from "./server/chain";
import { createApi } from "./server/api";
import { startWorker } from "./server/worker";
const port = Number(process.env.PORT || 3000);
const chain = chainService();
const store = new Store(process.env.DB_PATH || "arbiter.sqlite");
if (chain.address) {
  const scope = `${chain.chain.id}:${chain.address.toLowerCase()}`;
  const existing = store.db
    .query("SELECT value FROM meta WHERE key='scope'")
    .get() as { value: string } | null;
  if (existing && existing.value !== scope)
    throw Error("DB_PATH belongs to another escrow");
  store.db.query("INSERT OR IGNORE INTO meta VALUES ('scope',?)").run(scope);
  if (
    chain.chain.id === 5042002 &&
    (!process.env.ANTHROPIC_MODEL || !process.env.DEPLOYMENT_BLOCK)
  )
    throw Error("Set ANTHROPIC_MODEL and DEPLOYMENT_BLOCK explicitly for Arc");
  if ((await chain.client.getChainId()) !== chain.chain.id)
    throw Error("RPC chain mismatch");
  const { escrowAbi } = await import("./shared/abi");
  const relay = await chain.client.readContract({
    address: chain.address,
    abi: escrowAbi,
    functionName: "evaluator",
  });
  if (
    chain.wallet &&
    relay.toLowerCase() !== chain.wallet.account.address.toLowerCase()
  )
    throw Error("Relay key is not the designated evaluator");
}
const api = createApi(
  store,
  chain,
  process.env.APP_ORIGIN || `http://localhost:${port}`,
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
);
const stop =
  process.env.DISABLE_WORKER === "1" ? () => {} : startWorker(store, chain);
const server = Bun.serve({
  port,
  hostname: process.env.HOST || "127.0.0.1",
  maxRequestBodySize: 150000,
  routes: { "/": page, "/create": page, "/agreements/*": page, "/api/*": api },
  fetch: () => new Response("Not found", { status: 404 }),
  development: process.env.NODE_ENV !== "production",
});
console.log(`Arbiter: ${server.url}`);
process.on("SIGTERM", () => {
  stop();
  server.stop();
  store.close();
  process.exit(0);
});
