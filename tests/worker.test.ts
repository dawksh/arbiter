import { test, expect } from "bun:test";
import { Store } from "../server/store";
import { startWorker } from "../server/worker";
import {
  hash,
  evidence,
  inconclusive,
  sampleBrief,
  sampleSources,
  samplePolicy,
} from "../shared/evaluation";
function setup() {
  const store = new Store(":memory:");
  const address = "0x0000000000000000000000000000000000000001";
  const briefHash = store.put(JSON.stringify(sampleBrief), address),
    sourcesHash = store.put(JSON.stringify(sampleSources), address),
    policyHash = store.put(
      JSON.stringify(samplePolicy("claude-sonnet-4-20250514")),
      address,
    ),
    submissionHash = store.put("Report", address);
  let now = 100,
    block = 1;
  let scans = 0;
  const sends: string[] = [];
  const agreement = {
    id: "1",
    client: address,
    state: 3,
    terms: {
      briefHash,
      sourcesHash,
      policyHash,
      submissionDeadline: 90,
      resolutionPeriod: 40,
      amount: "100",
    },
    submissionHash,
    evidenceHash: "0x" + "00".repeat(32),
    evaluationDeadline: 200,
    resolutionDeadline: 0,
    challengeDeadline: 0,
  };
  const chain: any = {
    address,
    chain: { id: 31337 },
    wallet: {},
    read: async () => ({ ...agreement }),
    client: {
      getBlock: async () => ({
        number: BigInt(block),
        timestamp: BigInt(now),
        hash: "block-" + block,
      }),
      getContractEvents: async () => {
        scans++;
        return [
          {
            blockNumber: 1n,
            transactionHash: "tx1",
            logIndex: 0,
            args: { id: 1n, state: 3, actor: address },
          },
        ];
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
    send: async (name: string, args: any[]) => {
      sends.push(name);
      if (name === "postEvaluation") {
        agreement.evidenceHash = args[5];
        agreement.state = 5;
        agreement.resolutionDeadline = now + 40;
      } else if (name === "executeTimeout") {
        if (agreement.state === 3) {
          agreement.state = 5;
          agreement.resolutionDeadline = agreement.evaluationDeadline + 40;
        } else agreement.state = 6;
      }
      return "0x" + "11".repeat(32);
    },
  };
  store.enqueue("1");
  return {
    store,
    chain,
    agreement,
    sends,
    setNow: (n: number) => (now = n),
    reorg: () => block++,
    get scans() {
      return scans;
    },
  };
}
test("pending job resumes, persists evidence and delivers exactly once", async () => {
  const s = setup();
  let evaluations = 0;
  const evaluate = async (i: any) => {
    evaluations++;
    return evidence(i, inconclusive(i));
  };
  let worker = startWorker(s.store, s.chain, evaluate, false);
  await worker.tick();
  worker();
  expect(s.store.job("1")?.status).toBe("posted");
  expect(evaluations).toBe(1);
  worker = startWorker(s.store, s.chain, evaluate, false);
  await worker.tick();
  worker();
  expect(evaluations).toBe(1);
  expect(s.sends).toEqual(["postEvaluation"]);
  expect(s.scans).toBe(1);
  s.store.close();
});
test("uncertain broadcast reconciles onchain evidence after restart", async () => {
  const s = setup();
  let evaluations = 0;
  const evaluate = async (i: any) => {
    evaluations++;
    return evidence(i, inconclusive(i));
  };
  s.chain.client.waitForTransactionReceipt = async () => {
    throw Error("Receipt unavailable");
  };
  let worker = startWorker(s.store, s.chain, evaluate, false);
  await worker.tick();
  worker();
  expect(s.store.job("1")?.status).toBe("relaying");
  worker = startWorker(s.store, s.chain, evaluate, false);
  await worker.tick();
  worker();
  expect(s.store.job("1")?.status).toBe("posted");
  expect(s.sends.length).toBe(1);
  expect(evaluations).toBe(1);
  s.store.close();
});
test("outage retries are bounded and timeout reaches human review then fallback", async () => {
  const s = setup();
  let calls = 0;
  const worker = startWorker(
    s.store,
    s.chain,
    async () => {
      calls++;
      throw Error("No credentials");
    },
    false,
  );
  for (let n = 0; n < 5; n++) await worker.tick();
  expect(calls).toBe(3);
  expect(s.sends).toEqual([]);
  s.setNow(200);
  await worker.tick();
  expect(s.agreement.state).toBe(5);
  s.setNow(240);
  await worker.tick();
  expect(s.agreement.state).toBe(6);
  expect(s.sends).toEqual(["executeTimeout", "executeTimeout"]);
  worker();
  s.store.close();
});
test("event cursor reorg rescans and reuses immutable evidence", async () => {
  const s = setup();
  let calls = 0;
  const worker = startWorker(
    s.store,
    s.chain,
    async (i: any) => {
      calls++;
      return evidence(i, inconclusive(i));
    },
    false,
  );
  await worker.tick();
  s.agreement.state = 3;
  s.reorg();
  await worker.tick();
  expect(s.scans).toBe(2);
  expect(calls).toBe(1);
  expect(s.sends.length).toBe(2);
  worker();
  s.store.close();
});

test("stale persisted evidence cannot evaluate a changed submission", async () => {
  const s = setup();
  s.chain.wallet = undefined;
  const worker = startWorker(
    s.store,
    s.chain,
    async (i) => evidence(i, inconclusive(i)),
    false,
  );
  await worker.tick();
  expect(s.store.job("1")?.status).toBe("ready");
  s.agreement.submissionHash = s.store.put("Different report", s.chain.address);
  s.chain.wallet = {};
  await worker.tick();
  expect(s.sends).toEqual([]);
  expect(s.store.job("1")?.status).toBe("obsolete");
  worker();
  s.store.close();
});
