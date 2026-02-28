import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  onboardingCompleteResponseSchema,
  onboardingCompleteSchema,
} from "@nexu/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema/index.js";
import type { AppBindings } from "../types.js";

const completeOnboardingRoute = createRoute({
  method: "post",
  path: "/api/v1/onboarding/complete",
  tags: ["Onboarding"],
  request: {
    body: {
      content: { "application/json": { schema: onboardingCompleteSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: onboardingCompleteResponseSchema },
      },
      description: "Onboarding completed",
    },
  },
});

export function registerOnboardingRoutes(app: OpenAPIHono<AppBindings>) {
  app.openapi(completeOnboardingRoute, async (c) => {
    const authUserId = c.get("userId");
    const body = c.req.valid("json");
    const now = new Date().toISOString();

    await db
      .update(users)
      .set({
        onboardingRole: body.role,
        onboardingCompany: body.company ?? "",
        onboardingUseCases: JSON.stringify(body.useCases),
        onboardingReferralSource: body.referralSource,
        onboardingReferralDetail: body.referralDetail ?? "",
        onboardingChannelVotes: JSON.stringify(body.channelVotes ?? []),
        onboardingAvatar: body.selectedAvatar,
        onboardingAvatarVotes: JSON.stringify(body.avatarVotes ?? []),
        onboardingCompletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.authUserId, authUserId));

    return c.json({ ok: true }, 200);
  });
}
