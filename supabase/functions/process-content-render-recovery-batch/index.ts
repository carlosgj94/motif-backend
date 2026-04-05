import {
  acceptedResponse,
  authorizeProcessorRequest,
} from "../_shared/content_processor.ts";
import { processContentRenderRecoveryBatch } from "../_shared/content_render_recovery_processor.ts";

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
    const result = await processContentRenderRecoveryBatch();
    console.log("content render recovery batch completed", {
      ...result,
      duration_ms: Date.now() - startedAt,
    });
  };

  EdgeRuntime.waitUntil(run());

  return acceptedResponse({
    accepted: true,
    trigger: "process-content-render-recovery-batch",
  });
});
