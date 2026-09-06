import type { Address } from "viem";
export const states = [
  "Awaiting acceptance",
  "Awaiting funding",
  "In progress",
  "Evaluating",
  "Challenge window",
  "Human review",
  "Settled",
];
export type Agreement = {
  id: string;
  client: Address;
  terms: {
    worker: Address;
    resolver: Address;
    amount: string;
    briefHash: string;
    sourcesHash: string;
    policyHash: string;
    submissionDeadline: number;
    evaluationPeriod: number;
    challengePeriod: number;
    resolutionPeriod: number;
  };
  state: number;
  submissionHash: string;
  evidenceHash: string;
  outcome: number;
  evaluationDeadline: number;
  challengeDeadline: number;
  resolutionDeadline: number;
  workerPaid: string;
};
export function authMessage(
  domain: string,
  chainId: number,
  escrow: string,
  address: string,
  action: string,
  digest: string,
  nonce: string,
) {
  return `Arbiter authorization\nOrigin: ${domain}\nChain: ${chainId}\nEscrow: ${escrow.toLowerCase()}\nWallet: ${address.toLowerCase()}\nAction: ${action}\nContent: ${digest}\nNonce: ${nonce}`;
}
export function eligible(a: Agreement, now: number) {
  if (a.state === 4 && now >= a.challengeDeadline) return "settle";
  if (
    (a.state === 2 && now >= a.terms.submissionDeadline) ||
    (a.state === 3 && now >= a.evaluationDeadline) ||
    (a.state === 5 && now >= a.resolutionDeadline)
  )
    return "executeTimeout";
  return null;
}
