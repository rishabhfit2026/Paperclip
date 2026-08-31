// One-off operational script: sets (or resets) a real login password for the
// pre-existing "local-board" account, so it can be used to sign in for real
// once an instance is switched from local_trusted to authenticated mode.
//
// Why this exists instead of just signing up normally: local_trusted mode
// already creates a real `user` row for "local-board" (see
// ensureLocalTrustedBoardPrincipal in server/src/index.ts), with all of that
// account's existing company memberships/ownership intact. better-auth's
// normal sign-up flow refuses (silently, to avoid email enumeration) to
// attach a credential to an email that already has a user row, so this
// inserts the `account` row it would have created directly, using the same
// password hasher.
//
// Run with: pnpm --filter @paperclipai/server exec tsx scripts/set-local-board-password.ts
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { authAccounts, authUsers, createDb } from "@paperclipai/db";

const LOCAL_BOARD_USER_ID = "local-board";

function promptHiddenPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Mute echoed input so the password isn't shown in the terminal.
    const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void };
    let muted = false;
    rlAny._writeToOutput = (chunk: string) => {
      if (!muted) process.stdout.write(chunk);
    };
    process.stdout.write(question);
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const db = createDb(dbUrl);

  const user = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    console.error(
      `No "${LOCAL_BOARD_USER_ID}" user found — this script is only for instances that previously ran in local_trusted mode.`,
    );
    process.exit(1);
  }

  console.log(`Setting a login password for ${user.email} (id: ${user.id}).`);
  const password = await promptHiddenPassword("New password (min 8 characters): ");
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  const confirm = await promptHiddenPassword("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords did not match.");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const now = new Date();

  const existingCredential = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")))
    .then((rows) => rows[0] ?? null);

  if (existingCredential) {
    await db
      .update(authAccounts)
      .set({ password: hash, updatedAt: now })
      .where(eq(authAccounts.id, existingCredential.id));
    console.log("Existing password updated.");
  } else {
    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: hash,
      createdAt: now,
      updatedAt: now,
    });
    console.log("Password set.");
  }

  console.log(`You can now sign in with email "${user.email}" and the password you just set.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
