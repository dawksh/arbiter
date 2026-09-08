import { mkdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  validateEvidence,
  inputSchema,
  type EvaluationInput,
} from "../shared/evaluation";

function cliFailure(stderr: string) {
  const secret = process.env.ANTHROPIC_API_KEY;
  const safe = stderr
    .replaceAll(secret || "__missing_secret__", "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return safe.slice(-500) || "no diagnostic output";
}

export function evidenceRecord(output: string) {
  const chunks = new Map<number, string>();
  for (const match of output.matchAll(
    /ARBITER_EVIDENCE_(\d+):([A-Za-z0-9+/=]+)/g,
  ))
    chunks.set(Number(match[1]), match[2]!);
  if (chunks.size) {
    const ordered = [...chunks.entries()].sort(([left], [right]) => left - right);
    if (ordered.some(([index], expected) => index !== expected))
      throw Error("CRE evidence chunks are incomplete");
    return JSON.parse(
      Buffer.from(
        ordered.map(([, chunk]) => chunk).join(""),
        "base64",
      ).toString("utf8"),
    );
  }
  const marker = "ARBITER_EVIDENCE:";
  const start = output.lastIndexOf(marker);
  if (start < 0) throw Error("CRE did not produce an evidence record");
  const jsonStart = output.indexOf("{", start + marker.length);
  if (jsonStart < 0) throw Error("CRE evidence record is not JSON");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = jsonStart; index < output.length; index++) {
    const char = output[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0)
      return JSON.parse(output.slice(jsonStart, index + 1));
  }
  throw Error("CRE evidence record is incomplete");
}

export async function simulate(input: EvaluationInput) {
  inputSchema.parse(input);
  if (!process.env.ANTHROPIC_API_KEY)
    throw Error(
      "ANTHROPIC_API_KEY is missing; evaluation will time out to human review.",
    );
  const cli = Bun.which(process.env.CRE_BIN || "cre");
  if (!cli)
    throw Error(
      "CRE CLI is missing; evaluation will time out to human review.",
    );
  const directory = resolve(".cache", `evaluation-${crypto.randomUUID()}`);
  const workflowPath = relative(directory, resolve("cre/main.ts"));
  const secretsPath = relative(directory, resolve("cre/secrets.yaml"));
  await mkdir(directory, { recursive: true });
  try {
    await Bun.write(`${directory}/input.json`, JSON.stringify(input));
    await Bun.write(
      `${directory}/workflow.yaml`,
      `simulation:\n  user-workflow:\n    workflow-name: arbiter-research\n  workflow-artifacts:\n    workflow-path: ${JSON.stringify(workflowPath)}\n    config-path: "input.json"\n    secrets-path: ${JSON.stringify(secretsPath)}\n`,
    );
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        [
          "PATH",
          "HOME",
          "TMPDIR",
          "CRE_API_KEY",
          "CRE_CONFIG_DIR",
          "ANTHROPIC_API_KEY",
        ].includes(name),
      ),
    );
    const child = Bun.spawn(
      [
        cli,
        "workflow",
        "simulate",
        directory,
        "--target",
        "simulation",
        "--non-interactive",
        "--trigger-index",
        "0",
      ],
      { stdout: "pipe", stderr: "pipe", env: childEnv },
    );
    const timer = setTimeout(() => child.kill(), 150000);
    const stderr = new Response(child.stderr).text();
    let output = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true });
        if (output.length > 500000) {
          child.kill();
          throw Error("CRE output limit exceeded");
        }
      }
      output += decoder.decode();
      if ((await child.exited) !== 0)
        throw Error(
          `CRE simulation failed: ${cliFailure(await stderr)}`,
        );
    } finally {
      clearTimeout(timer);
    }
    const returned = evidenceRecord(output);
    return validateEvidence(returned, input);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
