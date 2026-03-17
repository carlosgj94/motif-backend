import {
  acceptedResponse,
  authorizeProcessorRequest,
  processContentBatch,
} from "../_shared/content_processor.ts";

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
    const result = await processContentBatch();
    console.log("content processing batch completed", {
      ...result,
      duration_ms: Date.now() - startedAt,
    });
  };

  EdgeRuntime.waitUntil(run());

  return acceptedResponse({
    accepted: true,
    trigger: "process-content-batch",
  });
});
