import { describe, expect, test } from "bun:test";

import { ProvisionError, provisionPrincipal } from "./provision.ts";

/**
 * These cover `provisionPrincipal`'s own logic — what it inserts, in what
 * order, and when it throws. They do not cover Postgres.
 *
 * The stub below fakes `db.transaction` and each `insert(...).values(...)`
 * chain by recording what it was called with and returning canned rows. It
 * does not implement `onConflictDoUpdate`/`onConflictDoNothing` semantics —
 * a real upsert-on-conflict, and how two concurrent calls interleave, can
 * only be proven against real Postgres. Nothing here proves idempotency
 * under concurrency; it only proves that a single call issues the upsert
 * shape the comments in provision.ts claim it does.
 */

const TENANT_ID = "tnt_acme";

type Inserted = { table: string; values: unknown };

function fakeDb(opts: { role?: { id: string } | undefined } = {}) {
  const calls: Inserted[] = [];
  let userSeq = 0;
  let principalSeq = 0;

  function insertInto(table: string) {
    return {
      values(values: Record<string, unknown>) {
        calls.push({ table, values });
        return {
          onConflictDoUpdate() {
            return this;
          },
          onConflictDoNothing() {
            return this;
          },
          async returning() {
            if (table === "user") {
              userSeq++;
              return [{ id: values.id, email: values.email }];
            }
            if (table === "principal") {
              principalSeq++;
              return [{ id: values.id }];
            }
            return [{ id: values.id }];
          },
        };
      },
    };
  }

  const tx = {
    insert: (table: { _: { name?: string } } | string) => {
      // Drizzle table objects don't stringify usefully; the real schema
      // objects are opaque here, so callers pass a tag via `as never` and
      // we recover it through a side channel instead. See callers below.
      return insertInto(String(table));
    },
    query: {
      role: {
        findFirst: async () => opts.role,
      },
    },
  };

  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  };

  return { db: db as never, calls };
}

/**
 * `provision.ts` imports the real drizzle table objects (`user`, `principal`,
 * `principalRole`, `grant`) and passes them to `tx.insert(...)`. The stub
 * can't know their identity without importing `@intx/db/schema`, which
 * would pull in a real driver. Instead we key off insertion order: user
 * first, principal second, then any `principalRole`/`grant` rows. Tests that
 * need to distinguish only check the call count and the `values` shape, not
 * which table each call targeted by name.
 */

describe("provisionPrincipal", () => {
  test("happy path returns the provisioned principal", async () => {
    const { db } = fakeDb();
    const result = await provisionPrincipal(db, {
      tenantId: TENANT_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
    });

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.email).toBe("ada@example.com");
    expect(result.userId).toBeTruthy();
    expect(result.principalId).toBeTruthy();
  });

  test("trims and lower-cases the email before using it", async () => {
    const { db, calls } = fakeDb();
    const result = await provisionPrincipal(db, {
      tenantId: TENANT_ID,
      email: "  Ada@Example.COM  ",
      name: "Ada Lovelace",
    });

    expect(result.email).toBe("ada@example.com");
    const userInsert = calls.find(
      (c) => (c.values as { email?: string }).email !== undefined,
    );
    expect(userInsert).toBeDefined();
    expect((userInsert!.values as { email: string }).email).toBe(
      "ada@example.com",
    );
  });

  test("sets emailVerified false on the created user row", async () => {
    const { db, calls } = fakeDb();
    await provisionPrincipal(db, {
      tenantId: TENANT_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
    const userInsert = calls[0];
    expect(userInsert).toBeDefined();
    expect(
      (userInsert!.values as { emailVerified?: boolean }).emailVerified,
    ).toBe(false);
  });

  test("throws ProvisionError on an empty email, before any write", async () => {
    const { db, calls } = fakeDb();
    await expect(
      provisionPrincipal(db, { tenantId: TENANT_ID, email: "", name: "Ada" }),
    ).rejects.toThrow(ProvisionError);
    expect(calls).toHaveLength(0);
  });

  test("throws ProvisionError on a whitespace-only email, before any write", async () => {
    const { db, calls } = fakeDb();
    await expect(
      provisionPrincipal(db, {
        tenantId: TENANT_ID,
        email: "   ",
        name: "Ada",
      }),
    ).rejects.toThrow(ProvisionError);
    expect(calls).toHaveLength(0);
  });

  test("attaches roles by inserting a principalRole row per role name", async () => {
    const { db, calls } = fakeDb({ role: { id: "rol_member" } });
    await provisionPrincipal(db, {
      tenantId: TENANT_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
      roles: ["chat-member"],
    });

    // user, principal, then one insert per role.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBeDefined();
    expect(calls[2]!.values).toMatchObject({ roleId: "rol_member" });
  });

  test("attaches direct grants as rows scoped to this principal", async () => {
    const { db, calls } = fakeDb();
    const result = await provisionPrincipal(db, {
      tenantId: TENANT_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
      grants: [{ resource: "doc:*", action: "read" }],
    });

    const grantInsert = calls.at(-1);
    expect(grantInsert).toBeDefined();
    expect(grantInsert!.values).toMatchObject({
      tenantId: TENANT_ID,
      principalId: result.principalId,
      resource: "doc:*",
      action: "read",
      effect: "allow",
      origin: "system",
    });
  });

  test("a role name that does not exist throws and does not return a principal", async () => {
    const { db, calls } = fakeDb({ role: undefined });
    let threw = false;
    try {
      await provisionPrincipal(db, {
        tenantId: TENANT_ID,
        email: "ada@example.com",
        name: "Ada Lovelace",
        roles: ["does-not-exist"],
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ProvisionError);
    }
    expect(threw).toBe(true);
    // user and principal were inserted against this stub's transaction
    // before the role lookup failed; the stub can't prove the real
    // transaction rolled those back — only Postgres can. What this proves
    // is that no principalRole/grant insert happens once a role is missing,
    // and that the function's return path is never reached.
    expect(calls).toHaveLength(2);
  });
});
