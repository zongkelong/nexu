import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { modelListResponseSchema } from "@nexu/shared";
import { PLATFORM_MODELS } from "../lib/models.js";

import type { AppBindings } from "../types.js";

const listModelsRoute = createRoute({
  method: "get",
  path: "/api/v1/models",
  tags: ["Models"],
  responses: {
    200: {
      content: {
        "application/json": { schema: modelListResponseSchema },
      },
      description: "Available models",
    },
  },
});

export function registerModelRoutes(app: OpenAPIHono<AppBindings>) {
  app.openapi(listModelsRoute, async (c) => {
    return c.json({ models: PLATFORM_MODELS }, 200);
  });
}
