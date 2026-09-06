import { escrowAbi } from "../shared/abi";
import { eligible } from "../shared/protocol";
import { hash, inputSchema, validateEvidence } from "../shared/evaluation";
import { simulate } from "./evaluator";
import type { Store } from "./store";
import type { chainService } from "./chain";
export function startWorker(
  store: Store,
  chain: ReturnType<typeof chainService>,
  evaluate = simulate,
  automatic = true,
) {
  let busy = false,
    stopped = false;
  const deployment = Number(process.env.DEPLOYMENT_BLOCK || 0);
  async function tick() {
    if (busy || stopped || !chain.address) return;
    busy = true;
    try {
      const latest = await chain.client.getBlock();
      const now = Number(latest.timestamp);
      const scope = `${chain.chain.id}:${chain.address.toLowerCase()}`;
      const previous = store.db
        .query("SELECT value FROM meta WHERE key='scope'")
        .get() as { value: string } | null;
      if (previous && previous.value !== scope)
        throw Error(
          "Database belongs to another escrow; use a separate DB_PATH",
        );
      store.db
        .query("INSERT OR IGNORE INTO meta VALUES ('scope',?)")
        .run(scope);
      const row = store.db
        .query("SELECT value FROM meta WHERE key='cursor'")
        .get() as { value: string } | null;
      let cursor = row
        ? JSON.parse(row.value)
        : { block: deployment - 1, hash: null };
      if (
        cursor.block >= deployment &&
        (await chain.client.getBlock({ blockNumber: BigInt(cursor.block) }))
          .hash !== cursor.hash
      ) {
        store.db.exec(
          "DELETE FROM events; DELETE FROM meta WHERE key='cursor'",
        );
        cursor = { block: deployment - 1, hash: null };
      }
      const safe = Number(latest.number) - (chain.chain.id === 31337 ? 0 : 2);
      if (cursor.block < safe) {
        const end = Math.min(safe, cursor.block + 1000);
        const logs = await chain.client.getContractEvents({
          address: chain.address,
          abi: escrowAbi,
          eventName: "Changed",
          fromBlock: BigInt(cursor.block + 1),
          toBlock: BigInt(end),
        });
        const block = await chain.client.getBlock({ blockNumber: BigInt(end) });
        store.db.transaction(() => {
          for (const l of logs)
            store.db
              .query("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)")
              .run(
                Number(l.blockNumber),
                l.transactionHash,
                l.logIndex,
                String(l.args.id),
                Number(l.args.state),
                l.args.actor!,
              );
          store.db
            .query("INSERT OR REPLACE INTO meta VALUES ('cursor',?)")
            .run(JSON.stringify({ block: end, hash: block.hash }));
        })();
      }
      const ids = store.db.query("SELECT DISTINCT id FROM events").all() as {
        id: string;
      }[];
      for (const { id } of ids) {
        const a = await chain.read(id);
        const oldJob = store.job(id);
        if (a.state === 3 && oldJob?.status === "posted")
          store.db.query("UPDATE jobs SET status='ready' WHERE id=?").run(id);
        const action = eligible(a, now);
        if (action && chain.wallet) {
          const tx = await chain.send(action, [BigInt(id)]);
          await chain.client.waitForTransactionReceipt({ hash: tx });
        }
      }
      const jobs = store.db
        .query(
          "SELECT id FROM jobs WHERE status NOT IN ('posted','obsolete') ORDER BY rowid LIMIT 20",
        )
        .all() as { id: string }[];
      for (const { id } of jobs) {
        let a = await chain.read(id);
        let job = store.job(id)!;
        if (a.state !== 3) {
          store.db
            .query("UPDATE jobs SET status=? WHERE id=?")
            .run(
              a.evidenceHash === (job.evidence ? hash(job.evidence) : "")
                ? "posted"
                : "obsolete",
              id,
            );
          continue;
        }
        if (now >= a.evaluationDeadline) continue;
        if (!job.evidence && job.attempts < 3) {
          store.db
            .query(
              "UPDATE jobs SET status='running',attempts=attempts+1,error=NULL WHERE id=?",
            )
            .run(id);
          try {
            const input = inputSchema.parse({
              agreementId: id,
              chainId: chain.chain.id,
              escrow: chain.address,
              brief: JSON.parse(store.get(a.terms.briefHash)),
              sources: JSON.parse(store.get(a.terms.sourcesHash)),
              policy: JSON.parse(store.get(a.terms.policyHash)),
              report: store.get(a.submissionHash),
            });
            const result = await evaluate(input);
            const body = JSON.stringify(result);
            store.put(body, chain.address);
            store.db
              .query("UPDATE jobs SET status='ready',evidence=? WHERE id=?")
              .run(body, id);
          } catch {
            store.db
              .query(
                "UPDATE jobs SET status='waiting',error='Simulation unavailable. Check CRE CLI, account and model credentials. Human review follows the evaluation deadline.' WHERE id=?",
              )
              .run(id);
            continue;
          }
        }
        job = store.job(id)!;
        if (!job.evidence || !chain.wallet) continue;
        a = await chain.read(id);
        if (a.state !== 3) continue;
        // The contract enforces one result. Restart after an uncertain broadcast reconciles onchain state first.
        let result;
        try {
          const input = inputSchema.parse({
            agreementId: id,
            chainId: chain.chain.id,
            escrow: chain.address,
            brief: JSON.parse(store.get(a.terms.briefHash)),
            sources: JSON.parse(store.get(a.terms.sourcesHash)),
            policy: JSON.parse(store.get(a.terms.policyHash)),
            report: store.get(a.submissionHash),
          });
          result = validateEvidence(JSON.parse(job.evidence), input);
          if (
            result.briefHash !== a.terms.briefHash ||
            result.sourcesHash !== a.terms.sourcesHash ||
            result.policyHash !== a.terms.policyHash ||
            result.submissionHash !== a.submissionHash
          )
            throw Error("Input mismatch");
        } catch {
          store.db
            .query(
              "UPDATE jobs SET status='obsolete',error='Evidence does not match the current agreement. Human review required.' WHERE id=?",
            )
            .run(id);
          continue;
        }
        const tx = await chain.send("postEvaluation", [
          BigInt(id),
          chain.address,
          BigInt(chain.chain.id),
          a.terms.policyHash,
          a.submissionHash,
          hash(job.evidence),
          result.outcome,
        ]);
        store.db
          .query("UPDATE jobs SET status='relaying',tx=? WHERE id=?")
          .run(tx, id);
        const receipt = await chain.client.waitForTransactionReceipt({
          hash: tx,
        });
        if (receipt.status === "success")
          store.db
            .query("UPDATE jobs SET status='posted',error=NULL WHERE id=?")
            .run(id);
      }
    } catch (error) {
      console.error(
        "Worker:",
        error instanceof Error ? error.message.slice(0, 160) : "unavailable",
      );
    } finally {
      busy = false;
    }
  }
  if (automatic) void tick();
  const timer = automatic ? setInterval(tick, 3000) : undefined;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  stop.tick = tick;
  return stop;
}
