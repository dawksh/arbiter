import { cre, Runner } from "@chainlink/cre-sdk";
import { inputSchema, type EvaluationInput } from "../shared/evaluation";
import { evaluateInTee } from "./handler";
export async function main() {
  const runner = await Runner.newRunner<EvaluationInput>({
    configSchema: inputSchema,
  });
  await runner.run(() => [
    cre.handlerInTee(
      new cre.capabilities.CronCapability().trigger({
        schedule: "0 */5 * * * *",
      }),
      evaluateInTee,
      [{ tee: "nitro", regions: ["us-west-2"] }],
    ),
  ]);
}
await main();
