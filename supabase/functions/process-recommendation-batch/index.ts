import {
  acceptedResponse,
  authorizeProcessorRequest,
} from "../_shared/content_processor.ts";
import { processRecommendationBatch } from "../_shared/recommendation_processor.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authFailure = authorizeProcessorRequest(request);
  if (authFailure) {
    return authFailure;
  }

  const run = async () => {
    const startedAt = Date.now();
    const result = await processRecommendationBatch();
    console.log("recommendation refresh batch completed", {
      ...result,
      duration_ms: Date.now() - startedAt,
    });
  };

  EdgeRuntime.waitUntil(run());

  return acceptedResponse({
    accepted: true,
    trigger: "process-recommendation-batch",
  });
});
