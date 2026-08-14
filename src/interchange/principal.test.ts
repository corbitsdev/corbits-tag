import { describe, expect, test } from "bun:test";

import {
  createPrincipalResolver,
  UNRESOLVED_MESSAGE,
  type AuthorIdentity,
  type PrincipalResolution,
  type UnresolvedReason,
} from "./principal.ts";

/**
 * These cover the resolver's decision logic, not drizzle.
 *
 * The stubs return configured rows and record the conditions they were asked
 * for; they do not evaluate drizzle predicates. Where that limits a test —
 * notably case folding, which SQL enforces — the test asserts on the emitted
 * condition instead, and says so rather than implying more coverage than it has.
 */

const TENANT = { id: "tnt_acme", slug: "acme" };
const USER = { id: "usr_ada", email: "Ada@Example.com" };
const MEMBER = { id: "prn_ada", status: "active" as const };

type Rows = { tenant?: unknown; user?: unknown; principal?: unknown };

function fakeDb(rows: Rows = {}) {
  const asked: { user?: unknown; principal?: unknown } = {};
  const pick = (key: keyof Rows, fallback: unknown) =>
    key in rows ? rows[key] : fallback;

  const db = {
    query: {
      tenant: { findFirst: async () => pick("tenant", TENANT) },
      user: {
        findFirst: async (args: { where?: unknown }) => {
          asked.user = args?.where;
          return pick("user", USER);
        },
      },
      principal: {
        findFirst: async (args: { where?: unknown }) => {
          asked.principal = args?.where;
          return pick("principal", MEMBER);
        },
      },
    },
  };
  return { db: db as never, asked };
}

function author(over: Partial<AuthorIdentity> = {}): AuthorIdentity {
  return {
    userId: "U123",
    email: "ada@example.com",
    emailVerified: true,
    isRestricted: false,
    isBot: false,
    ...over,
  };
}

function reasonOf(r: PrincipalResolution): UnresolvedReason | "resolved" {
  return r.ok ? "resolved" : r.reason;
}

/**
 * Collect the literal SQL text out of a drizzle condition.
 *
 * Knowingly coupled to drizzle's internals: a template's literal segments live
 * in `queryChunks`, each a `StringChunk` whose `value` is a string array.
 * Deliberately shallow — the column references in a condition point back at
 * their table, so a deep walk recurses forever. If drizzle changes the shape
 * this returns nothing and the assertion below fails loudly rather than
 * passing vacuously.
 */
function fragments(condition: unknown): string {
  const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => (chunk as { value?: unknown })?.value)
    .filter((value): value is string[] => Array.isArray(value))
    .map((value) => value.join(""))
    .join(" ");
}

describe("resolves an existing member", () => {
  test("returns their principal", async () => {
    const { db } = fakeDb();
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author(),
    );
    expect(result).toEqual({
      ok: true,
      principal: {
        principalId: "prn_ada",
        tenantId: "tnt_acme",
        userId: "usr_ada",
        email: "ada@example.com",
      },
    });
  });

  test("normalises the email it reports", async () => {
    const { db } = fakeDb();
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author({ email: "  ADA@Example.COM  " }),
    );
    expect(result.ok && result.principal.email).toBe("ada@example.com");
  });

  test("folds case in SQL, not only on the input", async () => {
    // user.email is case-sensitive text, so lowercasing only the parameter
    // would miss a row stored as "Ada@Example.com".
    const { db, asked } = fakeDb();
    await createPrincipalResolver({ db, tenantSlug: "acme" })(author());
    expect(fragments(asked.user).toLowerCase()).toContain("lower(");
  });
});

describe("reports what it found, without deciding", () => {
  const cases: Array<[string, AuthorIdentity | null, UnresolvedReason]> = [
    ["a failed lookup", null, "lookup_failed"],
    ["a bot", author({ isBot: true }), "bot_author"],
    ["a guest", author({ isRestricted: true }), "restricted_author"],
    ["no email", author({ email: undefined }), "no_email"],
    ["a blank email", author({ email: "   " }), "no_email"],
  ];

  for (const [label, input, expected] of cases) {
    test(`${label} -> ${expected}`, async () => {
      const { db } = fakeDb();
      const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
        input,
      );
      expect(reasonOf(result)).toBe(expected);
    });
  }

  test("an unknown isBot is not treated as a bot", async () => {
    // principal.kind includes "agent", so refusing unknown provenance is the
    // host's call. The package must not make it.
    const { db } = fakeDb();
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author({ isBot: "unknown" }),
    );
    expect(reasonOf(result)).toBe("resolved");
  });

  test("an unknown isRestricted is not treated as a guest", async () => {
    const { db } = fakeDb();
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author({ isRestricted: "unknown" }),
    );
    expect(reasonOf(result)).toBe("resolved");
  });

  const dbCases: Array<[string, Rows, UnresolvedReason]> = [
    ["missing tenant", { tenant: undefined }, "tenant_not_found"],
    ["no user row", { user: undefined }, "no_account"],
    ["no membership", { principal: undefined }, "not_a_member"],
    [
      "suspended membership",
      { principal: { id: "prn_x", status: "suspended" } },
      "principal_inactive",
    ],
  ];

  for (const [label, rows, expected] of dbCases) {
    test(`${label} -> ${expected}`, async () => {
      const { db } = fakeDb(rows);
      const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
        author(),
      );
      expect(reasonOf(result)).toBe(expected);
    });
  }
});

describe("carries context so the host need not re-query", () => {
  test("no_account reports the tenant and the normalised email", async () => {
    // The host provisions from exactly these two values.
    const { db } = fakeDb({ user: undefined });
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author({ email: "New.Person@Example.com" }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "no_account",
      tenantId: "tnt_acme",
      email: "new.person@example.com",
    });
  });

  test("reasons found before the tenant lookup carry no tenant", async () => {
    const { db } = fakeDb();
    const result = await createPrincipalResolver({ db, tenantSlug: "acme" })(
      author({ isBot: true }),
    );
    expect(result.ok === false && result.tenantId).toBeUndefined();
  });
});

describe("UNRESOLVED_MESSAGE", () => {
  test("covers every reason the resolver can return", () => {
    const reasons: UnresolvedReason[] = [
      "lookup_failed",
      "bot_author",
      "restricted_author",
      "no_email",
      "no_account",
      "not_a_member",
      "principal_inactive",
      "tenant_not_found",
    ];
    for (const reason of reasons) {
      expect(UNRESOLVED_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });
});
