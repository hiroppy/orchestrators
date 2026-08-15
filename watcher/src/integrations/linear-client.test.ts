import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { linearRequest } from "./linear-client.ts";

describe("linearRequest", () => {
  it("includes GraphQL error details from an unsuccessful HTTP response", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json(
        {
          errors: [
            {
              message: "Workflow state does not belong to the issue team",
              extensions: { code: "BAD_USER_INPUT" },
            },
          ],
        },
        { status: 400 },
      ),
    );

    await assert.rejects(
      linearRequest("linear-api-key", "mutation Test { test }", {}, 1_000),
      /Linear returned HTTP 400\. Linear GraphQL error: Workflow state does not belong to the issue team/,
    );
  });

  it("keeps the status-only error when the response has no GraphQL details", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response("Bad Request", { status: 400 }),
    );

    await assert.rejects(linearRequest("linear-api-key", "mutation Test { test }", {}, 1_000), {
      message: "Linear returned HTTP 400.",
    });
  });
});
