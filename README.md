# Arbiter — research deliverable escrow

A Bun + React app and non-upgradeable Solidity escrow for research work. Clients commit a brief, supplied sources, acceptance criteria, worker, resolver, amount, and timers. Workers accept; clients fund USDC; workers submit one immutable Markdown report. An evaluation proposes payment or refund. Either party can challenge; the named resolver decides disputed payments.

**Implemented and locally verified:** payment, refund, and a resolved challenge through desktop and mobile browser tests against Anvil; contract deadline and authorization paths; signed APIs; immutable SQLite storage; restart recovery; confidential-handler WASM compilation.

**Current proof boundary:** the escrow is deployed on Arc testnet and a resolved
timeout-split agreement is available in the public app. A successful
authenticated CRE CLI simulation with a real model, live paid/refunded Arc
outcomes, and live TEE attestation still need independent demo evidence.
Browser tests use explicitly labeled synthetic evaluator fixtures. `SPEC.md` is
the original wider concept; this README documents the research MVP scope.

## Run locally

Requirements: Bun 1.3+, Foundry (`forge`, `anvil`), and a browser wallet.

```sh
bun install
bun run abi
anvil
```

In another terminal:

```sh
bun run setup:local
bun run dev:local
```

Open **http://localhost:3000**. Setup deploys a local mock USDC and escrow, mints 1,000 test USDC to the client, and writes `.env.anvil`. It does not configure a fake AI evaluator. Without CRE/model credentials, requested evaluations time out to human review.

Use the first three default Anvil accounts as client, worker, and resolver in your browser wallet. Local test seed: `test test test test test test test test test test test junk`. These public test identities are only for Anvil; never fund them on a public chain. The backend uses only the fourth identity for the evaluator relay. Party transactions are signed in the browser.

| Role | Local address |
| --- | --- |
| Client | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Worker | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Resolver | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |

Re-run setup after restarting Anvil without a state file. It creates a new escrow-specific SQLite database. With a persisted Anvil state, retain `.env.anvil` and its database to resume.

## Arc and real CRE simulation

1. Fund separate client, worker, resolver, deployer, and evaluator wallets on Arc testnet. Client needs payment plus gas; other actors need gas.
2. Copy `.env.example` to `.env.arc`. Set a specific Anthropic model identifier and API key, and configure the evaluator private key. Store secrets in environment files, never in source or public evidence.
3. In the deployment shell only, set `DEPLOYER_PRIVATE_KEY` and `EVALUATOR_ADDRESS`. Run `bun run abi`, then `bun --env-file=.env.arc scripts/deploy-arc.ts`. Save the returned `ESCROW_ADDRESS` and `DEPLOYMENT_BLOCK` in `.env.arc`. The app never needs the deployer key.
4. Install the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation), authenticate with `cre login` (or `CRE_API_KEY`), and confirm your account supports confidential workflow simulation. The SDK's confidential workflows feature is currently [private beta](https://docs.chain.link/cre/guides/workflow/using-confidential-workflows).
5. Start `bun --env-file=.env.arc index.ts`. Create, accept, fund, and submit through the UI. Request evaluation as either party. The background job invokes the CLI, validates its evidence, stores it before broadcast, and posts through the designated relay.
6. For the explicit integration proof, run the server with `DISABLE_WORKER=1`, then run `bun --env-file=.env.arc scripts/proof.ts <agreement-id>` after submission. It executes the same real simulation and relay path and prints evidence hash, outcome, and transaction. Restart the normal server afterwards. Do not run a second relay process concurrently.

The model request and response validation execute inside `handlerInTee`. **The MVP execution mode is CRE CLI simulation with a trusted allowlisted relay, not a live attested TEE.** The CLI requires authentication; see [simulation commands](https://docs.chain.link/cre/reference/cli/workflow). The app has no fallback that invents a pass when the CLI or model is unavailable.

## Public testnet app

The Arc UI is deployed at **https://arbiter-escrow-daksh.fly.dev**. It stores
public agreement content and evidence on an encrypted Fly SQLite volume. Its
backend worker is intentionally disabled, so using the deployed UI does not
make model requests or use an evaluator private key. Browser wallets still
perform all permitted party and resolver transactions directly on Arc.

Deploy application changes with:

```sh
flyctl deploy --app arbiter-escrow-daksh --config fly.toml --ha=false
```

Arc chain ID is **5042002**. The escrow uses the [USDC ERC-20 interface](https://docs.arc.io/arc/references/contract-addresses) at `0x3600000000000000000000000000000000000000`, with **six-decimal integers**. Arc's native gas interface uses 18 decimals; see the [stablecoin native model](https://docs.arc.io/arc/concepts/stablecoin-native-model). No native-value transfer funds the escrow.

## Demonstrate the outcomes

Use the supplied database comparison task and notes, with `samples/report.md` as a starting report. Semantic results are model judgments, not guaranteed fixtures.

- **Payment:** submit a supported report meeting all criteria; inspect a pass; let the challenge period expire; settle. Anyone may settle, and the worker receives the entire deposit.
- **Refund:** submit work that omits the required comparison or recommendation; inspect a failure; let the challenge period expire; settle. The client receives the entire deposit.
- **Resolved challenge:** challenge a pass or failure as either party before expiry, switch to the named resolver, enter the worker's share, and resolve. Zero refunds all; the full amount pays all; an intermediate amount splits.

Normal timers: submission defaults to 24 hours, evaluation 5 minutes, challenge 24 hours, resolution 48 hours. The labeled demo preset uses a 5-minute evaluation timeout, 1-minute challenge period, and 3-minute resolution period; the submission deadline remains editable. Timers are committed before acceptance. Evaluation starts at submission; challenge starts at the result; resolution starts at escalation. An evaluation timeout anchors resolution to the evaluation deadline even if executed late.

**Resolver timeout intentionally splits 50/50**, with any micro-USDC rounding remainder returned to the client. This is an explicit testnet compromise, displayed before acceptance. A missing submission refunds the client. No revisions, fees, challenge bonds, arbitrary web research, private storage, or evaluator marketplaces are included. Cap: 100 USDC per agreement.

## Checks

```sh
bun run typecheck
bun run test
bun run test:contracts
bun run build
bun run build:cre
```

For the browser suite, keep Anvil running, run `bun run setup:local`, and stop any app already on port 3000:

```sh
bunx playwright install chromium
bun run test:browser
```

The browser suite starts its own server with indexing enabled and the relay key disabled. It injects a test wallet, uses the actual local contract for every transaction, and posts a synthetic evaluator result from the test harness. It covers payout/refund/challenge on desktop and mobile, wallet rejection, report reload recovery, content/evidence commitments, and the onchain timeline. Screenshots and failure traces go to `test-results/`.

## Structure and operations

- `contracts/src/ResearchEscrow.sol`: fixed terms and recipients; OpenZeppelin token operations and reentrancy guard.
- `shared/evaluation.ts`: pinned prompt/rubric schema, deterministic checks, strict criterion and excerpt validation, uncertainty-first aggregation.
- `cre/handler.ts`: Anthropic call and validation inside the confidential runtime; bounded transport retries; public evidence only.
- `server/`: wallet-signature nonces, immutable content, onchain reads, persistent event cursor, resumable evaluation jobs, and automatic eligible settlement.
- `web/`: list, creation, detail, wallet signing, report upload, evidence, deadlines, resolver actions, and persisted transaction hashes.

Run one server/relay per database. SQLite is scoped to a chain and escrow; changing deployments requires a separate `DB_PATH`. Retain the database: hashes prove integrity but do not recover missing offchain content. Submitted bytes use binary SQLite storage to preserve BOMs and line endings. Nonces bind wallet, origin, chain, escrow, action, and exact body hash, expire after five minutes, and are consumed once.

The worker records evidence before broadcasting. After an uncertain result or restart it checks authoritative contract state before retrying; the contract prevents duplicate evaluation and payout. Arc indexing retains a two-block buffer, and the cursor includes a block hash for local reorg recovery. Event timelines can lag polling briefly. If the backend is offline, onchain settlement and timeout functions remain callable by anyone.

All uploaded content is public sample material. The model provider receives evaluation inputs. Evidence excludes credentials and raw provider responses. This is an unaudited testnet MVP, not a production arbitration system.
