import { isAddress, verifyMessage, type Hex } from "viem";
import { z } from "zod";
import { Store } from "./store";
import { chainService } from "./chain";
import { authMessage } from "../shared/protocol";
import {
  briefSchema,
  sourcesSchema,
  policySchema,
  sampleBrief,
  sampleSources,
  samplePolicy,
  hash,
} from "../shared/evaluation";
const envelope = z
  .object({
    address: z.string().refine(isAddress),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    nonce: z.string().uuid(),
    body: z.string().max(100000),
  })
  .strict();
export function createApi(
  store: Store,
  chain: ReturnType<typeof chainService>,
  origin: string,
  model: string,
) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  async function authorize(req: Request, action: string) {
    if (req.headers.get("origin") && req.headers.get("origin") !== origin)
      throw Error("Origin mismatch");
    const e = envelope.parse(await req.json());
    const row = store.db
      .query("SELECT address,expires FROM nonces WHERE nonce=?")
      .get(e.nonce) as { address: string; expires: number } | null;
    if (
      !row ||
      row.expires < Date.now() ||
      row.address !== e.address.toLowerCase()
    )
      throw Error("Authorization expired");
    const message = authMessage(
      origin,
      chain.chain.id,
      chain.address || "",
      e.address,
      action,
      hash(e.body),
      e.nonce,
    );
    if (
      !(await verifyMessage({
        address: e.address as Hex,
        message,
        signature: e.signature as Hex,
      }))
    )
      throw Error("Invalid signature");
    const result = store.db
      .query("DELETE FROM nonces WHERE nonce=?")
      .run(e.nonce);
    if (result.changes !== 1) throw Error("Nonce already used");
    return e;
  }
  return async (req: Request) => {
    const url = new URL(req.url),
      path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/config")
        return json({
          chainId: chain.chain.id,
          chainName: chain.chain.name,
          rpc: chain.chain.id === 31337 ? chain.rpc : arcRpc,
          escrow: chain.address || null,
          origin,
          model,
          executionMode:
            "CRE CLI simulation · trusted relay · no live TEE attestation",
          sample: {
            brief: sampleBrief,
            sources: sampleSources,
            policy: samplePolicy(model),
          },
        });
      if (req.method === "POST" && path === "/api/nonce") {
        if (req.headers.get("origin") && req.headers.get("origin") !== origin)
          throw Error("Origin mismatch");
        const { address } = z
          .object({ address: z.string().refine(isAddress) })
          .parse(await req.json());
        store.db.query("DELETE FROM nonces WHERE expires<?").run(Date.now());
        const count = store.db
          .query("SELECT COUNT(*) AS n FROM nonces")
          .get() as { n: number };
        if (count.n > 5000)
          return json({ error: "Too many pending requests" }, 429);
        const nonce = crypto.randomUUID();
        store.db
          .query("INSERT INTO nonces VALUES (?,?,?)")
          .run(nonce, address.toLowerCase(), Date.now() + 300000);
        return json({ nonce });
      }
      if (req.method === "GET" && path === "/api/agreements") {
        if (!chain.address) return json([]);
        const count = await chain.client.readContract({
          address: chain.address,
          abi: (await import("../shared/abi")).escrowAbi,
          functionName: "count",
        });
        const before = BigInt(
          url.searchParams.get("before") || String(count + 1n),
        );
        const ids = [];
        for (
          let i = before - 1n < count ? before - 1n : count;
          i > 0n && ids.length < 50;
          i--
        )
          ids.push(String(i));
        return json(
          await Promise.all(
            ids.map(async (id) => {
              const a = await chain.read(id);
              let title = "Research agreement";
              try {
                title = JSON.parse(store.get(a.terms.briefHash)).title;
              } catch {}
              return { ...a, title };
            }),
          ),
        );
      }
      const detail = path.match(/^\/api\/agreements\/([1-9][0-9]*)$/);
      if (req.method === "GET" && detail) {
        const a = await chain.read(detail[1]!);
        const content = (h: string) => {
          try {
            return store.get(h);
          } catch {
            return null;
          }
        };
        return json({
          ...a,
          chainTime: Number((await chain.client.getBlock()).timestamp),
          brief: content(a.terms.briefHash),
          sources: content(a.terms.sourcesHash),
          policy: content(a.terms.policyHash),
          report: content(a.submissionHash),
          job: store.job(a.id),
          events: store.db
            .query("SELECT * FROM events WHERE id=? ORDER BY block,idx")
            .all(a.id),
        });
      }
      if (req.method === "POST" && path === "/api/terms") {
        const e = await authorize(req, "terms");
        const payload = z
          .object({
            brief: briefSchema,
            sources: sourcesSchema,
            policy: policySchema,
          })
          .strict()
          .parse(JSON.parse(e.body));
        if (payload.policy.model !== model)
          throw Error("Model must match deployment policy");
        return json({
          briefHash: store.put(JSON.stringify(payload.brief), e.address),
          sourcesHash: store.put(JSON.stringify(payload.sources), e.address),
          policyHash: store.put(JSON.stringify(payload.policy), e.address),
        });
      }
      const action = path.match(
        /^\/api\/agreements\/([1-9][0-9]*)\/(submission|evaluate)$/,
      );
      if (req.method === "POST" && action) {
        const id = action[1]!,
          verb = action[2]!;
        const e = await authorize(req, `${verb}:${id}`);
        const a = await chain.read(id);
        const addr = e.address.toLowerCase();
        if (verb === "submission") {
          if (addr !== a.terms.worker.toLowerCase() || a.state !== 2)
            throw Error("Only the funded worker can upload");
          if (!e.body.length || new TextEncoder().encode(e.body).length > 80000)
            throw Error("Report must be 1–80000 UTF-8 bytes");
          return json({ hash: store.put(e.body, e.address) });
        }
        if (
          ![a.client, a.terms.worker].some((x) => x.toLowerCase() === addr) ||
          a.state !== 3
        )
          throw Error("Only a party can evaluate a committed submission");
        store.enqueue(id);
        return json(store.job(id), 202);
      }
      const content = path.match(/^\/api\/content\/(0x[0-9a-f]{64})$/);
      if (req.method === "GET" && content)
        return new Response(store.get(content[1]!), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError
              ? "Invalid request"
              : error instanceof Error
                ? error.message.slice(0, 250)
                : "Request failed",
        },
        400,
      );
    }
  };
}
const arcRpc = "https://rpc.testnet.arc.io";
