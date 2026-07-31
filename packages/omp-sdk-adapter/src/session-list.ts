// Wraps OMP SDK's SessionManager.list/listAll (ADR-019: the file-backed
// SessionManager is the source of truth for sessions; Pocket must not build
// its own session index/directory). This file -- alongside src/index.ts --
// is allowed to import @oh-my-pi/pi-coding-agent because scripts/check-
// architecture.ts isolates that import to this package alone.
//
// What SessionManager.list's SessionInfo does/doesn't expose (read from the
// SDK's actual .d.ts, not guessed -- see
// node_modules/.../pi-coding-agent/dist/types/session/session-listing.d.ts):
//   path, id, cwd, title?, parentSessionPath?, created, modified,
//   messageCount, size, firstMessage, allMessagesText, status?.
// `status` is the conversation's own lifecycle ("complete" | "interrupted" |
// "aborted" | "error" | "pending" | "unknown" | absent) -- e.g. whether the
// last turn ended cleanly -- and is NOT a session-file-format compatibility
// signal, so it must not be mapped onto SessionCompatibility.
//
// Critically, SessionInfo carries no session-file-format version and no SDK
// version (SessionHeader.version does exist, per session-entries.d.ts, but
// SessionManager.list does not surface it -- list() is documented as a cheap
// scan, unlike SessionManager.open()/peekSessionInit(), which do read enough
// of the file to know things like that). That means none of
// fully-compatible / supported-older-requires-backup / newer-than-runtime /
// unsupported / corrupt / ownership-conflict can be honestly derived from a
// list() result -- proving any of them would require opening the file (which
// list() deliberately avoids, and which this module deliberately does not do
// either, to keep listing cheap and lock-free). Every session summary this
// module produces therefore reports compatibility as "indeterminate" rather
// than guessing; see packages/host-core/src/index.ts's SessionCompatibility
// doc comment for the same note from the consumer side.
import { SessionManager, type SessionInfo, type SessionStorage } from "@oh-my-pi/pi-coding-agent";
import { sessionId } from "@pocket-omp/agent-domain";
import type { OmpSessionSummary, SessionListPort } from "@pocket-omp/host-core";

type ListSessionsFn = (
  cwd: string,
  sessionDir?: string,
  storage?: SessionStorage,
) => Promise<SessionInfo[]>;
type ListAllSessionsFn = (storage?: SessionStorage) => Promise<SessionInfo[]>;

export interface OmpSessionListAdapterOptions {
  readonly storage?: SessionStorage;
  /** Injectable for tests; defaults to the real SessionManager.list. */
  readonly list?: ListSessionsFn;
  /** Injectable for tests; defaults to the real SessionManager.listAll. */
  readonly listAll?: ListAllSessionsFn;
}

/**
 * The only implementation of host-core's SessionListPort in this codebase:
 * everywhere else must go through this adapter rather than calling
 * SessionManager directly (ADR-019 + the OMP-SDK-isolation rule above).
 */
export class OmpSessionListAdapter implements SessionListPort {
  readonly #storage: SessionStorage | undefined;
  readonly #list: ListSessionsFn;
  readonly #listAll: ListAllSessionsFn;

  public constructor(options: OmpSessionListAdapterOptions = {}) {
    this.#storage = options.storage;
    this.#list =
      options.list ?? ((cwd, sessionDir, storage) => SessionManager.list(cwd, sessionDir, storage));
    this.#listAll = options.listAll ?? ((storage) => SessionManager.listAll(storage));
  }

  public async listSessions(input: {
    readonly cwd?: string;
  }): Promise<readonly OmpSessionSummary[]> {
    const infos =
      input.cwd === undefined
        ? await this.#listAll(this.#storage)
        : await this.#list(input.cwd, undefined, this.#storage);
    return infos.map(toOmpSessionSummary);
  }
}

/** Converts one OMP SessionInfo into host-core's OmpSessionSummary. Exported for direct unit testing without going through SessionManager at all. */
export function toOmpSessionSummary(info: SessionInfo): OmpSessionSummary {
  return {
    sessionId: sessionId(info.id),
    path: info.path,
    cwd: info.cwd,
    ...(info.title === undefined ? {} : { title: info.title }),
    updatedAtMs: BigInt(info.modified.getTime()),
    compatibility: "indeterminate",
  };
}
