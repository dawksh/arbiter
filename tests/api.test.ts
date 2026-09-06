import { test, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { Store } from "../server/store";
import { createApi } from "../server/api";
import { authMessage } from "../shared/protocol";
import {
  hash,
  sampleBrief,
  sampleSources,
  samplePolicy,
} from "../shared/evaluation";
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const escrow = "0x0000000000000000000000000000000000000001";
const origin = "http://localhost:3000";
function setup(role = true) {
  const store = new Store(":memory:");
  const chain = {
    chain: { id: 31337, name: "Anvil" },
    address: escrow,
    read: async () => ({
      id: "1",
      client: account.address,
      terms: { worker: role ? account.address : escrow },
      state: 2,
    }),
  } as any;
  return {
    store,
    api: createApi(store, chain, origin, "claude-sonnet-4-20250514"),
  };
}
async function authorize(
  api: ReturnType<typeof createApi>,
  action: string,
  body: string,
) {
  const r = await api(
    new Request(origin + "/api/nonce", {
      method: "POST",
      body: JSON.stringify({ address: account.address }),
    }),
  );
  const { nonce } = (await r.json()) as any;
  const signature = await account.signMessage({
    message: authMessage(
      origin,
      31337,
      escrow,
      account.address,
      action,
      hash(body),
      nonce,
    ),
  });
  return { address: account.address, nonce, signature, body };
}
const post = (api: ReturnType<typeof createApi>, path: string, body: any) =>
  api(
    new Request(origin + "/api" + path, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
test("signed upload preserves exact content; nonce replay is rejected", async () => {
  const { store, api } = setup();
  const body = "\uFEFF# Report\r\n  exact whitespace \n";
  const e = await authorize(api, "submission:1", body);
  const r = await post(api, "/agreements/1/submission", e);
  expect(r.status).toBe(200);
  const result = (await r.json()) as any;
  expect(store.get(result.hash)).toBe(body);
  expect((await post(api, "/agreements/1/submission", e)).status).toBe(400);
  store.close();
});
test("wrong role, tampered body and wrong action rejected", async () => {
  const { store, api } = setup(false);
  expect(
    (
      await post(
        api,
        "/agreements/1/submission",
        await authorize(api, "submission:1", "report"),
      )
    ).status,
  ).toBe(400);
  const e = await authorize(api, "submission:1", "report");
  expect(
    (await post(api, "/agreements/1/submission", { ...e, body: "changed" }))
      .status,
  ).toBe(400);
  expect((await post(api, "/terms", e)).status).toBe(400);
  store.close();
});
test("terms stored with canonical committed hashes", async () => {
  const { store, api } = setup();
  const payload = {
    brief: sampleBrief,
    sources: sampleSources,
    policy: samplePolicy("claude-sonnet-4-20250514"),
  };
  const r = await post(
    api,
    "/terms",
    await authorize(api, "terms", JSON.stringify(payload)),
  );
  expect(r.status).toBe(200);
  const result = (await r.json()) as any;
  expect(hash(store.get(result.policyHash))).toBe(result.policyHash);
  store.close();
});
test("immutable storage and idempotent job queue survive reopening", () => {
  const path = `/tmp/arbiter-test-${crypto.randomUUID()}.sqlite`;
  let store = new Store(path);
  const h = store.put("original", "a");
  store.put("original", "b");
  store.enqueue("1");
  store.enqueue("1");
  store.close();
  store = new Store(path);
  expect(store.get(h)).toBe("original");
  expect(store.job("1")?.status).toBe("pending");
  expect(
    (store.db.query("SELECT COUNT(*) AS n FROM jobs").get() as any).n,
  ).toBe(1);
  store.close();
  for (const suffix of ["", "-wal", "-shm"])
    Bun.file(path + suffix)
      .delete()
      .catch(() => {});
});
