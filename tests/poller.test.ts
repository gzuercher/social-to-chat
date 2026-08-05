import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthTracker } from "../src/lib/healthTracker.js";
import type { PlatformConfig } from "../src/lib/config.js";
import { LAST_RUN_METADATA_KEY, Store } from "../src/state/store.js";
import { runOnce } from "../src/poller.js";
import type {
  Notifier,
  OpsEvent,
  PostRef,
  SocialEvent,
  SocialProvider,
} from "../src/platforms/types.js";

function cfg(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    key: "raptus-linkedin",
    platform: "linkedin",
    name: "Raptus AG (LinkedIn)",
    enabled: true,
    comments: true,
    options: {},
    ...overrides,
  };
}

function postEvent(id: string, text = `Post ${id}`): SocialEvent {
  return {
    schemaVersion: 1,
    source: "social",
    platform: "linkedin",
    type: "post",
    externalId: id,
    author: "Raptus AG",
    text,
    context: "",
    url: `https://example.com/${id}`,
    timestamp: new Date().toISOString(),
  };
}

function commentEvent(id: string, context: string): SocialEvent {
  return { ...postEvent(id, `Kommentar ${id}`), type: "comment", context };
}

/** Fake-Adapter: liefert konfigurierbare Posts/Kommentare oder wirft. */
class FakeProvider implements SocialProvider {
  readonly platform = "linkedin" as const;
  readonly key: string;
  posts: SocialEvent[] = [];
  comments: SocialEvent[] = [];
  failWith: Error | null = null;
  failCommentsWith: Error | null = null;
  commentCalls = 0;
  lastCommentInput: PostRef[] | null = null;

  constructor(key: string) {
    this.key = key;
  }

  async fetchPosts(): Promise<SocialEvent[]> {
    if (this.failWith) throw this.failWith;
    return this.posts;
  }

  async fetchComments(posts: PostRef[]): Promise<SocialEvent[]> {
    this.commentCalls++;
    this.lastCommentInput = posts;
    if (this.failCommentsWith) throw this.failCommentsWith;
    return this.comments;
  }
}

/** Fake-Notifier: zeichnet auf, kann pro externalId scheitern. */
class FakeNotifier implements Notifier {
  sent: SocialEvent[] = [];
  ops: OpsEvent[] = [];
  failFor = new Set<string>();

  async send(event: SocialEvent): Promise<void> {
    if (this.failFor.has(event.externalId)) throw new Error("HTTP 500: webhook kaputt");
    this.sent.push(event);
  }

  async sendOps(event: OpsEvent): Promise<void> {
    this.ops.push(event);
  }
}

describe("runOnce", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setup(provider: FakeProvider): {
    store: Store;
    notifier: FakeNotifier;
    tracker: HealthTracker;
    run: (platforms?: PlatformConfig[]) => ReturnType<typeof runOnce>;
  } {
    const dir = mkdtempSync(join(tmpdir(), "s2c-"));
    dirs.push(dir);
    const store = new Store(join(dir, "test.db"));
    const notifier = new FakeNotifier();
    const tracker = new HealthTracker({ downThreshold: 1, recoveryThreshold: 1 });
    const run = (platforms: PlatformConfig[] = [cfg({ key: provider.key })]) =>
      runOnce(platforms, {
        store,
        notifier,
        healthTracker: tracker,
        providerFactory: () => provider,
      });
    return { store, notifier, tracker, run };
  }

  it("Erstlauf liest Bestand still ein, danach wird nur Neues gesendet", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    provider.posts = [postEvent("p1"), postEvent("p2")];
    const { store, notifier, run } = setup(provider);

    // Lauf 1: Bootstrap — nichts gesendet, aber alles als gesehen markiert.
    const first = await run();
    expect(notifier.sent).toEqual([]);
    expect(first.eventsSent).toBe(0);
    expect(store.isBootstrapped("raptus-linkedin")).toBe(true);

    // Lauf 2: gleicher Bestand — immer noch nichts.
    await run();
    expect(notifier.sent).toEqual([]);

    // Lauf 3: ein neuer Post — genau der wird gesendet.
    provider.posts = [postEvent("p1"), postEvent("p2"), postEvent("p3")];
    const third = await run();
    expect(notifier.sent.map((e) => e.externalId)).toEqual(["p3"]);
    expect(third.eventsSent).toBe(1);
    store.close();
  });

  it("fehlgeschlagene Sendungen werden nicht markiert und im nächsten Lauf erneut versucht", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    const { store, notifier, run } = setup(provider);
    await run(); // Bootstrap (leer)

    provider.posts = [postEvent("p1")];
    notifier.failFor.add("p1");
    const failedRun = await run();
    expect(failedRun.eventsFailed).toBe(1);
    expect(store.hasSeen("raptus-linkedin", "p1")).toBe(false);

    notifier.failFor.clear();
    await run();
    expect(notifier.sent.map((e) => e.externalId)).toEqual(["p1"]);
    store.close();
  });

  it("registriert Posts zentral und übergibt sie der Kommentar-Abfrage", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    provider.posts = [postEvent("p1")];
    provider.comments = [commentEvent("c1", "Post p1")];
    const { store, notifier, run } = setup(provider);

    await run(); // Bootstrap: Kommentare bekommen bereits die frisch registrierten Posts
    expect(provider.lastCommentInput?.map((p) => p.externalId)).toEqual(["p1"]);

    provider.comments = [commentEvent("c1", "Post p1"), commentEvent("c2", "Post p1")];
    await run();
    expect(notifier.sent.map((e) => e.externalId)).toEqual(["c2"]);
    store.close();
  });

  it("meldet einen werfenden Provider als Ops-Event (down) mit Fehlerkategorie", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    provider.failWith = new Error("HTTP 401: token expired");
    const { notifier, run, store } = setup(provider);

    const summary = await run();
    expect(summary.providersFailed).toBe(1);
    expect(notifier.ops).toHaveLength(1);
    expect(notifier.ops[0].kind).toBe("down");
    expect(notifier.ops[0].errorCategory).toBe("Authentication failed");
    expect(notifier.ops[0].type).toBe("ops");

    // Erholung → recovered-Ops-Event.
    provider.failWith = null;
    await run();
    expect(notifier.ops.map((o) => o.kind)).toEqual(["down", "recovered"]);
    store.close();
  });

  it("verschickt Token-Ablauf-Warnungen als Ops-Events", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    const { notifier, run, store } = setup(provider);
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await run([cfg({ key: provider.key, tokenExpiresAt: soon })]);
    const tokenOps = notifier.ops.filter((o) => o.kind === "tokenExpiry");
    expect(tokenOps).toHaveLength(1);
    expect(tokenOps[0].daysLeft).toBeLessThanOrEqual(7);
    store.close();
  });

  it("verschickt Posts auch dann, wenn der Kommentar-Abruf scheitert", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    const { store, notifier, run } = setup(provider);
    await run(); // Bootstrap

    // Kommentar-Berechtigung fehlt (LinkedIn ohne Partnerfreigabe: 403).
    provider.posts = [postEvent("p1")];
    provider.failCommentsWith = new Error("LinkedIn comments: HTTP 403 — Partnerfreigabe nötig");

    const summary = await run();
    // Post ist raus …
    expect(notifier.sent.map((e) => e.externalId)).toEqual(["p1"]);
    expect(store.hasSeen("raptus-linkedin", "p1")).toBe(true);
    // … und der Fehler wurde trotzdem als Provider-Ausfall gemeldet.
    expect(summary.providersFailed).toBe(1);
    expect(notifier.ops.some((o) => o.kind === "down")).toBe(true);
    store.close();
  });

  it("überspringt den Kommentar-Abruf bei comments: false", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    provider.failCommentsWith = new Error("dürfte nie aufgerufen werden");
    const { store, notifier, run } = setup(provider);
    const platforms = [cfg({ key: provider.key, comments: false })];

    await run(platforms); // Bootstrap
    provider.posts = [postEvent("p1")];
    const summary = await run(platforms);

    expect(provider.commentCalls).toBe(0);
    expect(notifier.sent.map((e) => e.externalId)).toEqual(["p1"]);
    expect(summary.providersFailed).toBe(0);
    store.close();
  });

  it("aktualisiert last_run_at und überspringt deaktivierte Provider", async () => {
    const provider = new FakeProvider("raptus-linkedin");
    const { store, run } = setup(provider);
    const summary = await run([cfg({ key: provider.key, enabled: false })]);
    expect(summary.providersTotal).toBe(0);
    expect(store.getMeta(LAST_RUN_METADATA_KEY)).toBeDefined();
    store.close();
  });
});
