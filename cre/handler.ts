import { cre, Runner, type TeeRuntime } from "@chainlink/cre-sdk";
import { z } from "zod";
import {
  inputSchema,
  validateModel,
  evidence,
  inconclusive,
  type EvaluationInput,
} from "../shared/evaluation";

// All model I/O and validation remain inside handlerInTee. CLI simulation is not TEE attestation.
function failureReason(error: unknown) {
  if (error instanceof Error) {
    if (error.message === "Missing credential")
      return "The evaluator credential was unavailable to the confidential workflow.";
    if (error.message === "Transport unavailable")
      return "The model provider could not be reached after bounded retries.";
    if (error.message === "Provider unavailable")
      return "The model provider was unavailable after bounded retries.";
    if (error.message === "Invalid response")
      return "The model provider returned an invalid response.";
    if (
      error.message === "Wrong criterion set" ||
      error.message === "Unverifiable excerpts"
    )
      return "The model response did not satisfy the agreed evidence rules.";
  }
  if (error instanceof z.ZodError)
    return "The model response did not match the agreed structured format.";
  return "The semantic evaluation could not produce valid evidence.";
}

export function evaluateInTee(runtime: TeeRuntime<EvaluationInput>) {
  const i = inputSchema.parse(runtime.config);
  let semantic;
  try {
    const key = runtime.getSecret({ id: "ANTHROPIC_API_KEY" }).result().value;
    if (!key) throw Error("Missing credential");
    const http = new cre.capabilities.HTTPClient();
    const body = JSON.stringify({
      model: i.policy.model,
      max_tokens: 900,
      temperature: 0,
      system: i.policy.prompt,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            brief: i.brief,
            sources: i.sources,
            criteria: i.policy.criteria,
            report: i.report,
          }),
        },
      ],
    });
    let raw: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = http
          .sendRequest(runtime, {
            url: "https://api.anthropic.com/v1/messages",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-api-key": key,
            },
            body: Buffer.from(body).toString("base64"),
            timeout: "30s",
          })
          .result();
      } catch {
        if (attempt === 2) throw Error("Transport unavailable");
        continue;
      }
      if (response.statusCode === 429 || response.statusCode >= 500) {
        if (attempt === 2) throw Error("Provider unavailable");
        continue;
      }
      if (response.statusCode !== 200 || response.body.length > 100000)
        throw Error("Invalid response");
      const payload = z
        .object({
          stop_reason: z.literal("end_turn"),
          content: z
            .array(
              z.object({
                type: z.literal("text"),
                text: z.string().max(50000),
              }),
            )
            .length(1),
        })
        .parse(JSON.parse(new TextDecoder().decode(response.body)));
      raw = JSON.parse(payload.content[0]!.text);
      break;
    }
    semantic = validateModel(raw, i);
  } catch (error) {
    semantic = inconclusive(i, failureReason(error));
  }
  const result = evidence(
    i,
    semantic,
    i.simulationMode === "no-model"
      ? "cre-cli-simulation-no-model"
      : "cre-cli-simulation-trusted-relay",
  );
  // Only deliberately public evidence is emitted, never credentials or raw provider responses.
  const encoded = Buffer.from(JSON.stringify(result)).toString("base64");
  const chunkSize = 400;
  for (let offset = 0; offset < encoded.length; offset += chunkSize)
    runtime.log(
      `ARBITER_EVIDENCE_${offset / chunkSize}:${encoded.slice(offset, offset + chunkSize)}`,
    );
  return JSON.stringify(result);
}
