import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";

// Agent-restricted join requests grant access to an email address with no
// Paperclip account yet (see server/src/routes/access.ts, resolveOrCreateUserIdForEmail).
// There is no outbound email provider in this codebase, so instead of having
// better-auth's magic-link plugin send mail, `sendMagicLink` below captures
// the generated URL for the caller (the join-request approval route) to hand
// to a human approver, who relays it themselves — same manual-copy pattern
// already used for company invite links.
export type MagicLinkIssuer = (input: {
  email: string;
  callbackURL: string;
  baseUrl: string;
}) => Promise<string>;

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldEnableAuthRateLimit(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}): boolean {
  const override = input.override?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  return input.deploymentMode === "authenticated";
}

export function buildBetterAuthRateLimitOptions(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}) {
  return {
    enabled: shouldEnableAuthRateLimit(input),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins: string[],
): BetterAuthInstance & { issueMagicLink: MagicLinkIssuer } {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  // Correlates a signInMagicLink call with the URL its sendMagicLink
  // callback receives, so issueMagicLink below can return the link to its
  // caller instead of emailing it (see the MagicLinkIssuer comment above).
  const pendingMagicLinks = new Map<string, string>();

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    plugins: [
      magicLink({
        // Meant to be relayed once by a human approver right after
        // generating it, not sit around like an emailed link would.
        expiresIn: 15 * 60,
        sendMagicLink: async ({ url, metadata }) => {
          const correlationId =
            metadata && typeof metadata.correlationId === "string" ? metadata.correlationId : null;
          if (correlationId) pendingMagicLinks.set(correlationId, url);
        },
      }),
    ],
    rateLimit: buildBetterAuthRateLimitOptions({
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
      override: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    }),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  const instance = betterAuth(authConfig);

  const issueMagicLink: MagicLinkIssuer = async ({ email, callbackURL, baseUrl: callBaseUrl }) => {
    // signInMagicLink needs an absolute URL to build the link around, and in
    // "auto" baseURL mode that's derived from the incoming HTTP request —
    // but calling auth.api.signInMagicLink() in-process (as opposed to a
    // real HTTP request reaching it) leaves that undefined and it throws
    // building `new URL(undefined)`. Making a real loopback HTTP call
    // instead (exactly what a browser POST to this same endpoint would do)
    // sidesteps that: the request goes through the normal dispatch path,
    // which does resolve baseURL correctly from the Host header, and the
    // sendMagicLink hook above still fires in-process either way.
    const target = new URL(callBaseUrl);
    const correlationId = randomUUID();
    const selfUrl = `http://127.0.0.1:${config.port}/api/auth/sign-in/magic-link`;
    const response = await fetch(selfUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: target.host,
      },
      body: JSON.stringify({ email, callbackURL, metadata: { correlationId } }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Magic link request failed (${response.status}): ${body}`);
    }
    const rawUrl = pendingMagicLinks.get(correlationId);
    pendingMagicLinks.delete(correlationId);
    if (!rawUrl) {
      throw new Error("Magic link generation did not produce a URL");
    }
    // The self-request above is plain loopback HTTP, so the link
    // better-auth builds may have picked up the wrong scheme/host from it
    // (e.g. http://127.0.0.1:port) — normalize it to the caller's real
    // public origin, which is what will actually be reachable.
    const fixedUrl = new URL(rawUrl);
    fixedUrl.protocol = target.protocol;
    fixedUrl.host = target.host;
    return fixedUrl.toString();
  };

  return Object.assign(instance, { issueMagicLink });
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
