import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateEvidence,
  inputSchema,
  type EvaluationInput,
} from "../shared/evaluation";
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
  await mkdir(directory, { recursive: true });
  try {
    await Bun.write(`${directory}/input.json`, JSON.stringify(input));
    await Bun.write(
      `${directory}/workflow.yaml`,
      `simulation:\n  user-workflow:\n    workflow-name: arbiter-research\n  workflow-artifacts:\n    workflow-path: ${JSON.stringify(resolve("cre/main.ts"))}\n    config-path: ${JSON.stringify(directory + "/input.json")}\n    secrets-path: ${JSON.stringify(resolve("cre/secrets.yaml"))}\n`,
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
      { stdout: "pipe", stderr: "ignore", env: childEnv },
    );
    const timer = setTimeout(() => child.kill(), 150000);
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
          "CRE simulation failed; check CLI login and configuration.",
        );
    } finally {
      clearTimeout(timer);
    }
    const lines = output
      .split("\n")
      .filter((l) => l.includes("ARBITER_EVIDENCE:"));
    if (lines.length !== 1)
      throw Error("CRE did not produce one evidence record");
    const returned = JSON.parse(lines[0]!.split("ARBITER_EVIDENCE:")[1]!);
    return validateEvidence(returned, input);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
