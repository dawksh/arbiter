import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { anvil, arcTestnet } from "viem/chains";
import { escrowAbi } from "../shared/abi";
import { hash, type Policy, type Criterion } from "../shared/evaluation";
import {
  states,
  eligible,
  authMessage,
  type Agreement,
} from "../shared/protocol";
import "./style.css";
declare global {
  interface Window {
    ethereum?: any;
  }
}
type Config = {
  chainId: number;
  chainName: string;
  rpc: string;
  escrow: Address | null;
  origin: string;
  model: string;
  executionMode: string;
  sample: {
    brief: { title: string; brief: string };
    sources: { id: string; text: string }[];
    policy: Policy;
  };
};
type Detail = Agreement & {
  brief: string | null;
  sources: string | null;
  policy: string | null;
  report: string | null;
  job: {
    status: string;
    evidence: string | null;
    error: string | null;
    tx: string | null;
  } | null;
  events: { tx: string; idx: number; state: number; actor: string }[];
};
async function api(path: string, body?: unknown) {
  const res = await fetch(
    "/api" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data: any = await res.json();
  if (!res.ok) throw Error(data.error || "Request failed");
  return data;
}
const short = (s: string) => s.slice(0, 6) + "…" + s.slice(-4);
const money = (s: string) => formatUnits(BigInt(s), 6);
const date = (n: number) => new Date(n * 1000).toLocaleString();
function App() {
  const [config, setConfig] = useState<Config>();
  const [account, setAccount] = useState<Address>();
  const [list, setList] = useState<(Agreement & { title: string })[]>([]);
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(
    localStorage.getItem("arbiter.tx"),
  );
  const [now, setNow] = useState(Date.now() / 1000);
  const path = location.pathname,
    id = path.match(/^\/agreements\/(\d+)$/)?.[1];
  const chain = config?.chainId === 31337 ? anvil : arcTestnet;
  const publicClient = config
    ? createPublicClient({ chain, transport: http(config.rpc) })
    : null;
  async function refresh() {
    if (id) {
      const data = await api(`/agreements/${id}`);
      setDetail(data);
      setNow(data.chainTime);
    } else if (path !== "/create") setList(await api("/agreements"));
  }
  useEffect(() => {
    api("/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
    refresh().catch((e) => setError(e.message));
    const t = setInterval(() => {
      refresh().catch((e) => setError(e.message));
    }, 3000);
    const changed = (a: string[]) => setAccount(a[0] as Address | undefined);
    window.ethereum
      ?.request({ method: "eth_accounts" })
      .then(changed)
      .catch(() => {});
    window.ethereum?.on?.("accountsChanged", changed);
    return () => {
      clearInterval(t);
      window.ethereum?.removeListener?.("accountsChanged", changed);
    };
  }, []);
  useEffect(() => {
    if (!pending || !publicClient) return;
    let cancelled = false;
    publicClient
      .waitForTransactionReceipt({ hash: pending as Hex })
      .then((r) => {
        if (cancelled) return;
        localStorage.removeItem("arbiter.tx");
        setPending(null);
        if (r.status === "reverted")
          setError(
            "Transaction reverted. Refresh and check the permitted actions.",
          );
        else setNotice("Transaction confirmed.");
        refresh();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pending, config]);
  async function wallet() {
    if (!window.ethereum) throw Error("Install a browser wallet to continue.");
    const w = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [a] = await w.requestAddresses();
    if (!a) throw Error("No wallet selected");
    setAccount(a);
    try {
      await w.switchChain({ id: chain.id });
    } catch (e: any) {
      if (e.code === 4902) {
        await w.addChain({ chain });
        await w.switchChain({ id: chain.id });
      } else throw e;
    }
    return { w, a };
  }
  async function run(fn: () => Promise<void>) {
    if (busy || pending) return;
    setBusy(true);
    setError("");
    setNotice("Check your wallet to continue.");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setNotice("");
      setError(e.shortMessage || e.message || "Action failed");
    } finally {
      setBusy(false);
    }
  }
  async function signed(route: string, action: string, body: string) {
    const { w, a } = await wallet();
    const { nonce } = await api("/nonce", { address: a });
    const message = authMessage(
      config!.origin,
      chain.id,
      config!.escrow || "",
      a,
      action,
      hash(body),
      nonce,
    );
    const signature = await w.signMessage({ account: a, message });
    return api(route, { address: a, signature, nonce, body });
  }
  async function tx(
    name: string,
    args: unknown[],
    address = config!.escrow!,
    abi: readonly unknown[] = escrowAbi,
  ) {
    const { w, a } = await wallet();
    const request = await publicClient!.simulateContract({
      address,
      abi,
      functionName: name,
      args,
      account: a,
    } as any);
    const h = await w.writeContract(request.request as any);
    localStorage.setItem("arbiter.tx", h);
    setPending(h);
    setNotice("Transaction submitted. Waiting for confirmation…");
    const r = await publicClient!.waitForTransactionReceipt({ hash: h });
    localStorage.removeItem("arbiter.tx");
    setPending(null);
    if (r.status !== "success") throw Error("Transaction reverted");
    setNotice("Transaction confirmed.");
    return r;
  }
  const disabled = busy || !!pending;
  return (
    <>
      <header>
        <a className="brand" href="/">
          <span className="mark">a</span> arbiter
          <span className="beta">TESTNET</span>
        </a>
        <nav>
          <a href="/">Agreements</a>
          <button
            className="wallet"
            disabled={disabled}
            onClick={() =>
              run(async () => {
                await wallet();
                setNotice("Wallet connected.");
              })
            }
          >
            {account ? short(account) : "Connect wallet"}
          </button>
        </nav>
      </header>
      <main>
        <div className="environment">
          <span className="dot" />
          {config?.chainName || "Connecting"}
          <span>Research deliverable escrow</span>
        </div>
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
            {pending && <TxLink tx={pending} local={chain.id === 31337} />}
          </div>
        )}
        {config && !config.escrow && (
          <div className="alert">
            Escrow is not deployed. Run the local setup in the README or
            configure an Arc testnet deployment to enable agreements.
          </div>
        )}
        {path === "/create" && config ? (
          <Create
            config={config}
            disabled={disabled || !config.escrow}
            onCreate={(data) =>
              run(async () => {
                const hashes = await signed(
                  "/terms",
                  "terms",
                  JSON.stringify({
                    brief: data.brief,
                    sources: data.sources,
                    policy: data.policy,
                  }),
                );
                const receipt = await tx("create", [
                  {
                    worker: data.worker,
                    resolver: data.resolver,
                    amount: parseUnits(data.amount, 6),
                    ...hashes,
                    submissionDeadline: BigInt(
                      Math.floor(new Date(data.deadline).getTime() / 1000),
                    ),
                    evaluationPeriod: BigInt(data.demo ? 300 : 300),
                    challengePeriod: BigInt(data.demo ? 60 : 86400),
                    resolutionPeriod: BigInt(data.demo ? 180 : 172800),
                  },
                ]);
                const { decodeEventLog } = await import("viem");
                for (const log of receipt.logs) {
                  try {
                    const event = decodeEventLog({
                      abi: escrowAbi,
                      data: log.data,
                      topics: log.topics,
                    });
                    if (event.eventName === "Changed") {
                      location.href = "/agreements/" + String(event.args.id);
                      return;
                    }
                  } catch {}
                }
                location.href = "/";
              })
            }
          />
        ) : id ? (
          <>
            {detail && config ? (
              <DetailView
                key={id}
                a={detail}
                account={account}
                now={now}
                disabled={disabled}
                config={config}
                onAction={(name, args) =>
                  run(async () => {
                    await tx(name, args);
                  })
                }
                onFund={() =>
                  run(async () => {
                    const token = await publicClient!.readContract({
                      address: config.escrow!,
                      abi: escrowAbi,
                      functionName: "token",
                    });
                    const { a } = await wallet();
                    const allowance = await publicClient!.readContract({
                      address: token,
                      abi: erc20Abi,
                      functionName: "allowance",
                      args: [a, config.escrow!],
                    });
                    if (allowance < BigInt(detail.terms.amount))
                      await tx(
                        "approve",
                        [config.escrow, BigInt(detail.terms.amount)],
                        token,
                        erc20Abi,
                      );
                    await tx("fund", [BigInt(id)]);
                  })
                }
                onSubmit={(report) =>
                  run(async () => {
                    const { hash: h } = await signed(
                      `/agreements/${id}/submission`,
                      `submission:${id}`,
                      report,
                    );
                    await tx("submit", [BigInt(id), h]);
                  })
                }
                onEvaluate={() =>
                  run(async () => {
                    await signed(
                      `/agreements/${id}/evaluate`,
                      `evaluate:${id}`,
                      "",
                    );
                    setNotice(
                      "Evaluation queued. You can leave this page and return.",
                    );
                  })
                }
              />
            ) : (
              <p>Loading agreement…</p>
            )}
          </>
        ) : (
          <>
            <div className="hero">
              <div>
                <p className="eyebrow">WORK, WITH TERMS.</p>
                <h1>
                  Good research.
                  <br />
                  <span>Agreed outcomes.</span>
                </h1>
                <p>
                  Fund a brief. Review the evidence.
                  <br />
                  Settle with a clear path when you disagree.
                </p>
              </div>
              <a className="button" href="/create">
                Create agreement <span>↗</span>
              </a>
            </div>
            <div className="section-title">
              <h2>Your workspace</h2>
              <span>{list.length} agreements</span>
            </div>
            {list.length ? (
              <div className="agreements">
                {list.map((a) => (
                  <a
                    className="agreement"
                    href={"/agreements/" + a.id}
                    key={a.id}
                  >
                    <div>
                      <span className={"badge state-" + a.state}>
                        {states[a.state]}
                      </span>
                      <h3>{a.title}</h3>
                      <p>
                        #{a.id} · Worker {short(a.terms.worker)}
                      </p>
                    </div>
                    <div className="amount">
                      {money(a.terms.amount)} <small>USDC</small>
                      <p>
                        {a.state === 6
                          ? "Settled"
                          : "Due " + date(a.terms.submissionDeadline)}
                      </p>
                    </div>
                    <span className="arrow">↗</span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="empty">
                <span className="empty-icon">⌁</span>
                <h3>A clear agreement is a good start.</h3>
                <p>
                  Create your first research task with a brief, supplied
                  sources,
                  <br />
                  and criteria both parties can inspect.
                </p>
                <a href="/create">Create a research agreement →</a>
              </div>
            )}
            <div className="steps">
              {[
                "01 / Agree on the work",
                "02 / Fund with USDC",
                "03 / Review & settle",
              ].map((s) => (
                <div key={s}>{s}</div>
              ))}
            </div>
          </>
        )}
      </main>
      <footer>
        <span>Arbiter / Research MVP</span>
        <span>
          Public sample material · External AI provider receives inputs
          <br />
          {config?.executionMode || "CRE CLI simulation · trusted relay"}
        </span>
      </footer>
    </>
  );
}
function TxLink({ tx, local }: { tx: string; local: boolean }) {
  return local ? (
    <code>{short(tx)}</code>
  ) : (
    <a
      href={`https://testnet.arcscan.app/tx/${tx}`}
      target="_blank"
      rel="noreferrer"
    >
      View transaction ↗
    </a>
  );
}
type CreateData = {
  worker: string;
  resolver: string;
  amount: string;
  deadline: string;
  demo: boolean;
  brief: Config["sample"]["brief"];
  sources: Config["sample"]["sources"];
  policy: Policy;
};
function Create({
  config,
  disabled,
  onCreate,
}: {
  config: Config;
  disabled: boolean;
  onCreate: (d: CreateData) => void;
}) {
  const [draft, setDraft] = useState<CreateData>(() => {
    try {
      const saved = localStorage.getItem("arbiter.draft");
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      worker: "",
      resolver: "",
      amount: "10",
      deadline: new Date(
        Date.now() + 86400000 - new Date().getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16),
      demo: false,
      ...config.sample,
    };
  });
  const [sources, setSources] = useState(
    JSON.stringify(draft.sources, null, 2),
  );
  const [criteria, setCriteria] = useState(
    draft.policy.criteria.map((c) => c.text).join("\n"),
  );
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const set = (p: Partial<CreateData>) => setDraft((d) => ({ ...d, ...p }));
  useEffect(() => {
    localStorage.setItem("arbiter.draft", JSON.stringify(draft));
  }, [draft]);
  return (
    <>
      <a className="back" href="/">
        ← Agreements
      </a>
      <div className="page-title">
        <p className="eyebrow">NEW AGREEMENT</p>
        <h1>Set the terms.</h1>
        <p>Everything below is fixed before the worker accepts.</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            if (!isAddress(draft.worker) || !isAddress(draft.resolver))
              throw Error("Enter valid wallet addresses.");
            if (
              !/^\d+(\.\d{1,6})?$/.test(draft.amount) ||
              parseUnits(draft.amount, 6) <= 0n ||
              parseUnits(draft.amount, 6) > 100000000n
            )
              throw Error("Payment must be between 0.000001 and 100 USDC.");
            onCreate({
              ...draft,
              sources: JSON.parse(sources),
              policy: {
                ...draft.policy,
                model: config.model,
                criteria: criteria
                  .split("\n")
                  .filter(Boolean)
                  .map((text, n) => ({ id: `criterion-${n + 1}`, text })),
              },
            });
          } catch (e: any) {
            setError(e.message);
          }
        }}
      >
        <div className="two-column">
          <section className="panel">
            <h2>01 / The people & payment</h2>
            <label>
              Worker wallet
              <input
                required
                value={draft.worker}
                placeholder="0x…"
                onChange={(e) => set({ worker: e.target.value })}
              />
            </label>
            <label>
              Human resolver wallet
              <input
                required
                value={draft.resolver}
                placeholder="0x…"
                onChange={(e) => set({ resolver: e.target.value })}
              />
            </label>
            <div className="fields">
              <label>
                Payment · USDC
                <input
                  required
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              </label>
              <label>
                Submission deadline
                <input
                  required
                  type="datetime-local"
                  value={draft.deadline}
                  onChange={(e) => set({ deadline: e.target.value })}
                />
              </label>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.demo}
                onChange={(e) => set({ demo: e.target.checked })}
              />
              Demo timers: 5 min evaluation, 1 min challenge, 3 min resolution
            </label>
            <p className="muted">
              Normal timers: 5 min evaluation, 24 hr challenge, 48 hr
              resolution. Each period starts at its corresponding lifecycle
              event.
            </p>
          </section>
          <section className="panel">
            <h2>02 / The research brief</h2>
            <label>
              Title
              <input
                required
                maxLength={120}
                value={draft.brief.title}
                onChange={(e) =>
                  set({ brief: { ...draft.brief, title: e.target.value } })
                }
              />
            </label>
            <label>
              Brief & workload
              <textarea
                required
                rows={6}
                value={draft.brief.brief}
                onChange={(e) =>
                  set({ brief: { ...draft.brief, brief: e.target.value } })
                }
              />
            </label>
            <p className="muted">
              One report per agreement. Revisions need a new agreement.
            </p>
          </section>
        </div>
        <section className="panel">
          <h2>03 / Sources & acceptance criteria</h2>
          <div className="two-column">
            <label>
              Supplied source notes · JSON
              <textarea
                rows={12}
                value={sources}
                onChange={(e) => {
                  setSources(e.target.value);
                  try {
                    set({ sources: JSON.parse(e.target.value) });
                  } catch {}
                }}
              />
            </label>
            <div>
              <label>
                Semantic criteria · one per line
                <textarea
                  rows={5}
                  value={criteria}
                  onChange={(e) => {
                    setCriteria(e.target.value);
                    set({
                      policy: {
                        ...draft.policy,
                        criteria: e.target.value
                          .split("\n")
                          .filter(Boolean)
                          .map((text, n) => ({
                            id: `criterion-${n + 1}`,
                            text,
                          })),
                      },
                    });
                  }}
                />
              </label>
              <div className="fields">
                <label>
                  Minimum words
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={draft.policy.minWords}
                    onChange={(e) =>
                      set({
                        policy: {
                          ...draft.policy,
                          minWords: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Maximum words
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={draft.policy.maxWords}
                    onChange={(e) =>
                      set({
                        policy: {
                          ...draft.policy,
                          maxWords: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Required headings · comma separated
                <input
                  value={draft.policy.sections.join(", ")}
                  onChange={(e) =>
                    set({
                      policy: {
                        ...draft.policy,
                        sections: e.target.value
                          .split(",")
                          .map((s) => s.trim()),
                      },
                    })
                  }
                />
              </label>
              <p className="muted">
                Reference each supplied source as [SOURCE_ID]. Evaluation uses
                these notes; independent citation verification is outside this
                version.
              </p>
            </div>
          </div>
        </section>
        <section className="panel terms">
          <h2>Before you commit</h2>
          <p>
            A pass proposes full payment; a failure proposes full refund. Either
            party can challenge. Inconclusive or overdue evaluations go to the
            named resolver, who may pay, refund, or split.
          </p>
          <p>
            <strong>
              If the resolver misses the deadline, funds split 50/50.
            </strong>{" "}
            An odd micro-USDC remainder goes to the client. This is an explicit
            testnet demo compromise.
          </p>
          <p>
            Public storage. The external model provider receives the brief,
            notes, and report. Model: <code>{config.model}</code>. Workflow:
            research-v1.
          </p>
          <label className="checkbox">
            <input
              required
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I understand these terms, including the resolver timeout split.
          </label>
          {error && <p role="alert">{error}</p>}
          <button disabled={disabled || !accepted} type="submit">
            Commit agreement ↗
          </button>
        </section>
      </form>
    </>
  );
}
function DetailView({
  a,
  account,
  now,
  disabled,
  config,
  onAction,
  onFund,
  onSubmit,
  onEvaluate,
}: {
  a: Detail;
  account?: Address;
  now: number;
  disabled: boolean;
  config: Config;
  onAction: (n: string, args: unknown[]) => void;
  onFund: () => void;
  onSubmit: (r: string) => void;
  onEvaluate: () => void;
}) {
  const [report, setReport] = useState(
    localStorage.getItem("arbiter.report." + a.id) || "",
  );
  const [award, setAward] = useState(money(a.terms.amount));
  const [accept, setAccept] = useState(false);
  const [fileError, setFileError] = useState("");
  const brief = a.brief ? JSON.parse(a.brief) : null,
    policy: Policy | null = a.policy ? JSON.parse(a.policy) : null;
  const sources = a.sources ? JSON.parse(a.sources) : [];
  const ev = a.job?.evidence ? JSON.parse(a.job.evidence) : null;
  const verified = !!ev && hash(a.job!.evidence!) === a.evidenceHash;
  const client = account?.toLowerCase() === a.client.toLowerCase(),
    worker = account?.toLowerCase() === a.terms.worker.toLowerCase(),
    resolver = account?.toLowerCase() === a.terms.resolver.toLowerCase();
  const deadline =
    a.state <= 2
      ? a.terms.submissionDeadline
      : a.state === 3
        ? a.evaluationDeadline
        : a.state === 4
          ? a.challengeDeadline
          : a.state === 5
            ? a.resolutionDeadline
            : 0;
  const action = (name: string) => onAction(name, [BigInt(a.id)]);
  function save(s: string) {
    setReport(s);
    localStorage.setItem("arbiter.report." + a.id, s);
  }
  return (
    <>
      <a className="back" href="/">
        ← Agreements
      </a>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">AGREEMENT #{a.id}</p>
          <h1>{brief?.title || "Research agreement"}</h1>
          <span className={"badge state-" + a.state}>{states[a.state]}</span>
        </div>
        <div className="big-amount">
          {money(a.terms.amount)}
          <small>USDC in agreement</small>
        </div>
      </div>
      <div className="two-column detail-grid">
        <div>
          <section className="panel">
            <h2>The agreed work</h2>
            <p className="prose">
              {brief?.brief || "Brief is unavailable from this server."}
            </p>
            <h3>Acceptance criteria</h3>
            {policy?.criteria.map((c) => (
              <p key={c.id} className="criterion-line">
                <span>✓</span>
                {c.text}
              </p>
            ))}
            {policy && (
              <p className="muted">
                {policy.minWords}–{policy.maxWords} words · Headings:{" "}
                {policy.sections.join(", ")}
              </p>
            )}
            <details>
              <summary>Supplied source notes</summary>
              {sources.map((s: any) => (
                <p key={s.id}>
                  <strong>[{s.id}]</strong> {s.text}
                </p>
              ))}
            </details>
            <details>
              <summary>Committed policy & hashes</summary>
              <pre>{a.policy}</pre>
              <p>
                Brief: <code>{a.terms.briefHash}</code>
              </p>
              <p>
                Sources: <code>{a.terms.sourcesHash}</code>
              </p>
              <p>
                Policy: <code>{a.terms.policyHash}</code>
              </p>
            </details>
          </section>
          <section className="panel">
            <h2>Research report</h2>
            {a.report ? (
              <>
                <pre className="report">{a.report}</pre>
                <a
                  href={"/api/content/" + a.submissionHash}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download exact content ↗
                </a>
                <p className="muted">
                  Submission hash: <code>{a.submissionHash}</code>
                </p>
              </>
            ) : worker && a.state === 2 && now < deadline ? (
              <>
                <label>
                  Paste your Markdown report
                  <textarea
                    rows={12}
                    value={report}
                    onChange={(e) => save(e.target.value)}
                  />
                </label>
                <label>
                  Or upload a Markdown file
                  <input
                    type="file"
                    accept=".md,.markdown,text/markdown,text/plain"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 80000) {
                        setFileError("File exceeds 80 KB.");
                        return;
                      }
                      try {
                        save(
                          new TextDecoder("utf-8", {
                            fatal: true,
                            ignoreBOM: true,
                          }).decode(await f.arrayBuffer()),
                        );
                        setFileError("");
                      } catch {
                        setFileError("File must contain valid UTF-8 text.");
                      }
                    }}
                  />
                </label>
                {fileError && <p role="alert">{fileError}</p>}
                <p className="muted">
                  The exact text is saved before you commit its hash. Only one
                  submission is allowed.
                </p>
                <button
                  disabled={disabled || !report}
                  onClick={() => onSubmit(report)}
                >
                  Save & commit report
                </button>
              </>
            ) : (
              <p className="muted">
                {a.state < 2
                  ? "Work begins after acceptance and funding."
                  : "No report available."}
              </p>
            )}
          </section>
          <section className="panel">
            <div className="section-title">
              <h2>Evaluation evidence</h2>
              {ev && (
                <span className="badge">
                  {verified ? "Onchain commitment verified" : "Awaiting relay"}
                </span>
              )}
            </div>
            <p className="muted">
              {ev?.executionMode === "synthetic-test-fixture"
                ? "Synthetic test fixture · no model call"
                : config.executionMode}
            </p>
            {a.job?.error && <p className="alert">{a.job.error}</p>}
            {ev ? (
              <>
                {ev.criteria.map((c: Criterion) => (
                  <div className="evidence" key={c.id}>
                    <span className={"verdict " + c.status}>{c.status}</span>
                    <h3>{c.id}</h3>
                    <p>{c.justification}</p>
                    {c.excerpts.map((x, n) => (
                      <blockquote key={n}>{x}</blockquote>
                    ))}
                  </div>
                ))}
                <details>
                  <summary>Execution record</summary>
                  <pre>{JSON.stringify(ev, null, 2)}</pre>
                </details>
                {a.job?.tx && (
                  <TxLink tx={a.job.tx} local={config.chainId === 31337} />
                )}
              </>
            ) : (
              <p>
                {a.job
                  ? `Job status: ${a.job.status}`
                  : "No evaluation yet. Results will include criterion-level decisions and supporting report excerpts."}
              </p>
            )}
          </section>
        </div>
        <aside>
          <section className="panel action-panel">
            <h2>{a.state === 6 ? "Settlement complete" : "Next step"}</h2>
            {deadline > 0 && (
              <div className="deadline">
                <span>
                  {a.state <= 2
                    ? "Submission"
                    : a.state === 3
                      ? "Evaluation"
                      : a.state === 4
                        ? "Challenge"
                        : "Resolution"}{" "}
                  deadline
                </span>
                <strong>{date(deadline)}</strong>
                <small>
                  {now >= deadline
                    ? "Deadline reached"
                    : Math.ceil((deadline - now) / 60) + " minutes remaining"}
                </small>
              </div>
            )}
            {a.state === 0 && worker && now < deadline && (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={accept}
                    onChange={(e) => setAccept(e.target.checked)}
                  />
                  I accept the fixed terms and 50/50 resolver timeout split
                  below.
                </label>
                <button
                  disabled={
                    disabled || !accept || !a.brief || !a.policy || !a.sources
                  }
                  onClick={() => action("accept")}
                >
                  Accept fixed terms
                </button>
              </>
            )}
            {a.state === 1 && client && now < deadline && (
              <button disabled={disabled} onClick={onFund}>
                Approve & fund {money(a.terms.amount)} USDC
              </button>
            )}
            {a.state === 3 &&
              (client || worker) &&
              !a.job &&
              now < deadline && (
                <button disabled={disabled} onClick={onEvaluate}>
                  Request evaluation
                </button>
              )}
            {a.state === 4 && (
              <>
                <p>
                  Proposed outcome:{" "}
                  <strong>
                    {a.outcome === 1
                      ? "Full payment to worker"
                      : "Full refund to client"}
                  </strong>
                </p>
                {(client || worker) && now < deadline && (
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={() => action("challenge")}
                  >
                    Challenge outcome
                  </button>
                )}
              </>
            )}
            {a.state === 5 && resolver && now < deadline && (
              <>
                <label>
                  Worker receives · USDC
                  <input
                    inputMode="decimal"
                    value={award}
                    onChange={(e) => setAward(e.target.value)}
                  />
                </label>
                <p>Client receives the remaining balance.</p>
                <button
                  disabled={
                    disabled ||
                    !/^\d+(\.\d{1,6})?$/.test(award) ||
                    parseUnits(award || "0", 6) > BigInt(a.terms.amount)
                  }
                  onClick={() =>
                    onAction("resolve", [BigInt(a.id), parseUnits(award, 6)])
                  }
                >
                  Resolve & settle
                </button>
              </>
            )}
            {eligible(a, now) && (
              <button
                disabled={disabled}
                onClick={() => action(eligible(a, now)!)}
              >
                {eligible(a, now) === "settle"
                  ? "Settle agreement"
                  : "Execute timeout"}
              </button>
            )}
            {a.state === 6 && (
              <div className="settled">
                <p>
                  Worker received <strong>{money(a.workerPaid)} USDC</strong>
                </p>
                <p>
                  Client refunded{" "}
                  <strong>
                    {money(
                      String(BigInt(a.terms.amount) - BigInt(a.workerPaid)),
                    )}{" "}
                    USDC
                  </strong>
                </p>
              </div>
            )}
            {!account && (
              <p className="muted">
                Connect your wallet to see your permitted actions.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Parties</h2>
            {[
              ["Client", a.client],
              ["Worker", a.terms.worker],
              ["Resolver", a.terms.resolver],
            ].map(([role, address]) => (
              <div className="party" key={role}>
                <span>{role}</span>
                <code title={address}>{short(address!)}</code>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Settlement terms</h2>
            <p>
              Either party may challenge. The named resolver can release,
              refund, or split payment.
            </p>
            <p>
              <strong>Resolver timeout: 50/50 split.</strong> This is a testnet
              demo compromise agreed before acceptance.
            </p>
            <p className="muted">
              Evaluation: {a.terms.evaluationPeriod}s<br />
              Challenge: {a.terms.challengePeriod}s<br />
              Resolution: {a.terms.resolutionPeriod}s
            </p>
          </section>
          <section className="panel">
            <h2>Onchain timeline</h2>
            {a.events.map((e) => (
              <div className="event" key={e.tx + e.idx}>
                <span className="dot" />
                <div>
                  <strong>{states[e.state]}</strong>
                  <TxLink tx={e.tx} local={config.chainId === 31337} />
                </div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
