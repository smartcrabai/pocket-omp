import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent";
import { MemorySessionStorage, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { sessionId } from "@pocket-omp/agent-domain";

import { OmpSessionListAdapter, toOmpSessionSummary } from "../src/session-list";

// ---------------------------------------------------------------------------
// toOmpSessionSummary: pure conversion, hand-built SessionInfo fixtures.
// ---------------------------------------------------------------------------

// `Partial<SessionInfo>` cannot express `{ title: undefined }` under
// exactOptionalPropertyTypes, but the tests below need to pass an explicit
// undefined to prove the absent-title path. The optional fields therefore
// admit undefined here and are re-omitted when building the fixture.
interface SessionInfoOverrides {
  readonly path?: string;
  readonly id?: string;
  readonly cwd?: string;
  readonly created?: Date;
  readonly modified?: Date;
  readonly messageCount?: number;
  readonly size?: number;
  readonly firstMessage?: string;
  readonly allMessagesText?: string;
  readonly title?: string | undefined;
  readonly parentSessionPath?: string | undefined;
  readonly status?: SessionInfo["status"];
}

function sessionInfo(overrides: SessionInfoOverrides = {}): SessionInfo {
  const { title, parentSessionPath, status, ...required } = overrides;
  return {
    path: "/home/user/.local/share/omp/sessions/abc/2024-01-01_s1.jsonl",
    id: "session-1",
    cwd: "/home/user/project",
    created: new Date("2024-01-01T00:00:00.000Z"),
    modified: new Date("2024-01-02T03:04:05.006Z"),
    messageCount: 3,
    size: 512,
    firstMessage: "hello",
    allMessagesText: "hello world",
    ...required,
    ...(title === undefined ? {} : { title }),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    ...(status === undefined ? {} : { status }),
  };
}

describe("toOmpSessionSummary", () => {
  test("maps path/cwd/sessionId directly and converts modified (Date) to updatedAtMs (bigint)", () => {
    const summary = toOmpSessionSummary(sessionInfo());

    expect(summary.sessionId).toBe(sessionId("session-1"));
    expect(summary.path).toBe("/home/user/.local/share/omp/sessions/abc/2024-01-01_s1.jsonl");
    expect(summary.cwd).toBe("/home/user/project");
    expect(typeof summary.updatedAtMs).toBe("bigint");
    expect(summary.updatedAtMs).toBe(BigInt(new Date("2024-01-02T03:04:05.006Z").getTime()));
  });

  test("preserves bigint precision for a modified date beyond Number.MAX_SAFE_INTEGER milliseconds would ever reach, guarding against silent truncation through Number", () => {
    // SessionInfo.modified is always a Date (never already a bigint -- there
    // is no bigint-typed field on SessionInfo per the SDK's own .d.ts), so
    // the risk this guards against is BigInt(date.getTime()) silently
    // rounding through `number` rather than "an existing bigint changing
    // type". A far-future date still round-trips exactly.
    const farFuture = new Date("2100-01-01T00:00:00.000Z");
    const summary = toOmpSessionSummary(sessionInfo({ modified: farFuture }));
    expect(summary.updatedAtMs).toBe(BigInt(farFuture.getTime()));
  });

  test("includes title when SessionInfo has one", () => {
    const summary = toOmpSessionSummary(sessionInfo({ title: "Fix the bug" }));
    expect(summary.title).toBe("Fix the bug");
  });

  test("omits title (rather than setting it to undefined) when SessionInfo has none", () => {
    const summary = toOmpSessionSummary(sessionInfo({ title: undefined }));
    expect("title" in summary).toBe(false);
  });

  // compatibility: every SessionInfo variation below maps to "indeterminate".
  // SessionInfo (SessionManager.list's lightweight metadata scan) carries no
  // session-file-format version and no SDK version, and a session file that
  // fails to parse is silently omitted by the SDK's scan rather than
  // surfaced with an error marker (see session-list.ts's doc comment and
  // this package's src/session-list.ts). None of fully-compatible /
  // supported-older-requires-backup / newer-than-runtime / unsupported /
  // corrupt / ownership-conflict can therefore be honestly derived here --
  // this is a regression test guarding against a future contributor wiring
  // SessionInfo.status (a conversation-lifecycle concept, not a
  // file-compatibility one) into `compatibility` by mistake.
  describe("compatibility is always 'indeterminate' (SessionInfo carries no compatibility signal)", () => {
    const statuses: ReadonlyArray<SessionInfo["status"]> = [
      "complete",
      "interrupted",
      "aborted",
      "error",
      "pending",
      "unknown",
      undefined,
    ];
    for (const status of statuses) {
      test(`status=${String(status)}`, () => {
        const summary = toOmpSessionSummary(sessionInfo({ status }));
        expect(summary.compatibility).toBe("indeterminate");
      });
    }
  });
});

// ---------------------------------------------------------------------------
// OmpSessionListAdapter: SessionManager.list/listAll substituted with a fake
// (per the task's instruction not to depend on the real SDK/filesystem for
// this conversion test).
// ---------------------------------------------------------------------------

describe("OmpSessionListAdapter", () => {
  test("scoped listSessions({cwd}) calls the injected list() with that cwd and converts every result", async () => {
    const calls: Array<{ cwd: string; sessionDir?: string }> = [];
    const adapter = new OmpSessionListAdapter({
      list: async (cwd, sessionDir) => {
        calls.push({ cwd, ...(sessionDir === undefined ? {} : { sessionDir }) });
        return [sessionInfo({ id: "a" }), sessionInfo({ id: "b" })];
      },
      listAll: async () => {
        throw new Error("listAll should not be called when cwd is provided");
      },
    });

    const summaries = await adapter.listSessions({ cwd: "/workspace" });

    expect(calls).toEqual([{ cwd: "/workspace" }]);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.sessionId)).toEqual([sessionId("a"), sessionId("b")]);
    for (const summary of summaries) expect(summary.compatibility).toBe("indeterminate");
  });

  test("unscoped listSessions({}) calls the injected listAll() instead of list()", async () => {
    let listAllCalled = false;
    const adapter = new OmpSessionListAdapter({
      list: async () => {
        throw new Error("list should not be called when cwd is omitted");
      },
      listAll: async () => {
        listAllCalled = true;
        return [sessionInfo({ id: "only" })];
      },
    });

    const summaries = await adapter.listSessions({});

    expect(listAllCalled).toBe(true);
    expect(summaries.map((s) => s.sessionId)).toEqual([sessionId("only")]);
  });

  test("propagates an empty result", async () => {
    const adapter = new OmpSessionListAdapter({ list: async () => [] });
    const summaries = await adapter.listSessions({ cwd: "/empty" });
    expect(summaries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real SDK integration: proves the fake-based tests above match actual
// SessionManager behavior, using MemorySessionStorage so nothing touches the
// real filesystem (no dependency on a fake -- exercises the true static
// SessionManager.list()).
// ---------------------------------------------------------------------------

describe("OmpSessionListAdapter against the real SessionManager (MemorySessionStorage)", () => {
  test("lists a session created via SessionManager.create", async () => {
    const storage = new MemorySessionStorage();
    const cwd = "/workspace/real";
    const manager = SessionManager.create(cwd, undefined, storage);
    await manager.ensureOnDisk();
    await manager.flush();

    const adapter = new OmpSessionListAdapter({ storage });
    const summaries = await adapter.listSessions({ cwd });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe(sessionId(manager.getSessionId()));
    expect(summaries[0]?.cwd).toBe(cwd);
    expect(summaries[0]?.compatibility).toBe("indeterminate");
    expect(typeof summaries[0]?.updatedAtMs).toBe("bigint");
  });
});
