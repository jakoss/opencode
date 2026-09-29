import { describe, expect } from "bun:test"
import { Context, DateTime, Effect, Layer, Option } from "effect"
import { Headers as HttpHeaders } from "effect/unstable/http"
import { Money } from "@opencode/schema/money"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Npm } from "@opencode/util/npm"
import { AbsolutePath } from "@opencode/core/schema"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { IntegrationConnection } from "@opencode/core/integration/connection"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"

const providerID = Provider.ID.make("acme")
const integrationID = Integration.ID.make("acme")
const chat = Model.ID.make("chat")
const fast = Model.ID.make("fast")

// The native OpenAI package needs no install, so the npm service never has to do real work.
const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

/**
 * Two projects are two Location graphs standing on one global Credential store. Compiling the same
 * graph once per project through a single memo map with the global tag shared is exactly that:
 * Credential, Database, and Bus are built once, while Provider, Model, and the resolver are per
 * project. A credential written through one project is what the other project reads.
 */
const graph = LayerNode.group([
  Credential.node,
  Provider.node,
  Model.node,
  Integration.node,
  SessionRunnerModel.node,
])

type Placement = {
  readonly ref: Location.Ref
  readonly context: Context.Context<LayerNode.Output<typeof graph>>
}

const projects = Effect.fn("projects")(function* (names: readonly string[]) {
  const scope = yield* Effect.scope
  const memoMap = yield* Layer.makeMemoMap

  // One store for every project. Location graphs build their own globals in the LayerMap memo map,
  // so a credential created in the test body would otherwise be invisible to all of them.
  const store = yield* Layer.buildWithMemoMap(
    LayerNode.compile(LayerNode.group([Credential.node])),
    memoMap,
    scope,
  )
  const credentials = Layer.succeed(Credential.Service, Context.get(store, Credential.Service))

  return yield* Effect.forEach(names, (name) =>
    Effect.gen(function* () {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(`/projects/${name}`) })
      const context = yield* Layer.buildWithMemoMap(
        LayerNode.compile(graph, {
          replacements: [
            Credential.node.replace(credentials),
            Npm.node.replace(npmLayer),
            Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location(ref)))),
          ],
          shared: Node.tags.values.global,
        }),
        memoMap,
        scope,
      )
      const placement = { ref, context } satisfies Placement
      // Each project owns its integration registry, and the availability filter only sees the
      // connections of an integration the registry knows about.
      yield* inProject(placement, register())
      return placement
    }),
  )
})

const register = Effect.fn("registerIntegration")(function* () {
  const integrations = yield* Integration.Service
  yield* integrations.transform((editor) => editor.update(integrationID, (ref) => (ref.name = "Acme")))
})

/** What a project configures about its provider, the way ConfigProviderPlugin lowers it. */
const bind = Effect.fn("bindAccount")(function* (account: string | undefined) {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) =>
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        activation: "enabled",
        package: "@opencode/ai/providers/openai",
        account,
      },
      models: [Model.Info.default(providerID, chat), Model.Info.default(providerID, fast)],
    }),
  )
})

/** The connection a stored credential stands for, the way the integration registry lists it. */
const connection = (account: Credential.Info): IntegrationConnection.Info => ({
  type: "credential",
  id: account.id,
  label: account.label,
  method: account.value.type,
})

/**
 * What a provider plugin records when the account it discovered against is a stored credential:
 * the provider's models and endpoints are only valid for the connection that produced them.
 */
const discover = Effect.fn("discover")(function* (sourceConnection: Credential.Info, account: string | undefined) {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) =>
    editor.add({
      info: { ...Provider.Info.empty(providerID), account, activation: "enabled" },
      models: [Model.Info.default(providerID, chat)],
      sourceConnection: connection(sourceConnection),
    }),
  )
})

const connect = Effect.fn("connectAccounts")(function* (credentials: Credential.Interface) {
  const personal = yield* credentials.create({
    integrationID,
    label: "Personal",
    value: Credential.Key.make({ type: "key", key: "personal-key" }),
  })
  const work = yield* credentials.create({
    integrationID,
    label: "Work",
    value: Credential.Key.make({ type: "key", key: "work-key" }),
  })
  yield* credentials.activate(work.id)
  return { personal, work }
})

/** The credential a request would actually carry, read off the resolved route. */
const resolve = Effect.fn("resolveAccount")(function* (project: Placement, id: Model.ID) {
  const modelState = yield* Model.Service
  const models = yield* SessionRunnerModel.Service
  const resolved = yield* models.resolve(
    Session.Info.make({
      id: Session.ID.make("ses_account"),
      projectID: Project.ID.global,
      title: "account binding",
      model: { id, providerID },
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: project.ref,
    }),
    modelState.available,
  )
  return yield* resolved.model.route.auth
    .apply({ request: {}, method: "POST", url: "https://provider.test", body: "", headers: HttpHeaders.empty })
    .pipe(Effect.map((headers) => Option.getOrThrow(HttpHeaders.get(headers, "authorization"))))
})

const available = Effect.fn("available")(function* (project: Placement) {  const providers = yield* Provider.Service
  return (yield* providers.available()).map((provider) => provider.id)
})

const inProject = <A, E, R>(project: Placement, effect: Effect.Effect<A, E, R>) =>
  Effect.provideContext(effect, project.context)

const it = testEffect(Layer.empty)

describe("provider account binding", () => {
  it.effect("binds two projects to two accounts at the same time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [personal, work, unbound] = yield* projects(["personal", "work", "unbound"])
        yield* connect(Context.get(personal.context, Credential.Service)).pipe(
          Effect.provideContext(personal.context),
        )
        yield* inProject(personal, bind("Personal"))
        yield* inProject(work, bind("Work"))
        yield* inProject(unbound, bind(undefined))

        const [personalHeader, workHeader, unboundHeader] = yield* Effect.all(
          [
            inProject(personal, resolve(personal, chat)),
            inProject(work, resolve(work, chat)),
            inProject(unbound, resolve(unbound, chat)),
          ],
          { concurrency: "unbounded" },
        )

        expect(personalHeader).toBe("Bearer personal-key")
        expect(workHeader).toBe("Bearer work-key")
        // "Work" is the globally active credential, which is what an unbound project follows.
        expect(unboundHeader).toBe("Bearer work-key")
      }),
    ),
  )

  it.effect("keeps a bound project on its account when the global selection changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [personal, work, unbound] = yield* projects(["personal", "work", "unbound"])
        const credentials = Context.get(work.context, Credential.Service)
        yield* connect(credentials).pipe(Effect.provideContext(work.context))
        yield* inProject(personal, bind("Personal"))
        yield* inProject(work, bind("Work"))
        yield* inProject(unbound, bind(undefined))
        expect(yield* inProject(unbound, resolve(unbound, chat))).toBe("Bearer work-key")

        // The user switches the global selection to the personal account.
        yield* Effect.gen(function* () {
          const found = (yield* credentials.list(integrationID)).find((entry) => entry.label === "Personal")
          if (!found) throw new Error("no account named Personal")
          yield* credentials.activate(found.id)
        }).pipe(Effect.provideContext(work.context))

        expect(yield* inProject(work, resolve(work, chat))).toBe("Bearer work-key")
        expect(yield* inProject(personal, resolve(personal, chat))).toBe("Bearer personal-key")
        expect(yield* inProject(unbound, resolve(unbound, chat))).toBe("Bearer personal-key")
      }),
    ),
  )

  it.effect("binds an auxiliary request on the same provider to the same account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [personal] = yield* projects(["personal"])
        yield* connect(Context.get(personal.context, Credential.Service)).pipe(
          Effect.provideContext(personal.context),
        )
        yield* inProject(personal, bind("Personal"))

        // Titles and compaction both funnel through SessionRunnerModel.resolve, so a second model
        // of the bound provider must spend the same account as the agent step.
        expect(yield* inProject(personal, resolve(personal, fast))).toBe("Bearer personal-key")
        expect(yield* inProject(personal, resolve(personal, chat))).toBe("Bearer personal-key")
      }),
    ),
  )

  it.effect("fails with the available accounts when a project names one that does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [stranger] = yield* projects(["stranger"])
        yield* connect(Context.get(stranger.context, Credential.Service)).pipe(
          Effect.provideContext(stranger.context),
        )
        yield* inProject(stranger, bind("Contractor"))

        const failure = yield* inProject(stranger, resolve(stranger, chat)).pipe(Effect.flip)
        if (failure._tag !== "Integration.AccountNotFound") throw new Error(`unexpected failure: ${failure._tag}`)
        expect(failure.integrationID).toBe(integrationID)
        expect(failure.account).toBe("Contractor")
        expect([...failure.labels].sort()).toEqual(["Personal", "Work"])
        expect(failure.message).toContain("Contractor")
        expect(failure.message).toContain("Personal")
      }),
    ),
  )

  it.effect("drops a bound project from availability when its account is renamed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [work] = yield* projects(["work"])
        const credentials = Context.get(work.context, Credential.Service)
        const accounts = yield* connect(credentials).pipe(Effect.provideContext(work.context))
        yield* inProject(work, discover(accounts.work, "Work"))
        expect(yield* inProject(work, available(work))).toEqual([providerID])

        yield* Effect.gen(function* () {
          const accounts = yield* credentials.list(integrationID)
          const renamed = accounts.find((entry) => entry.label === "Work")
          if (!renamed) throw new Error("no account named Work")
          yield* credentials.update(renamed.id, { label: "Work SSO" })
        }).pipe(Effect.provideContext(work.context))

        // Discovery no longer describes this project's account, so the provider leaves the catalog
        // rather than serving another license's endpoint.
        expect(yield* inProject(work, available(work))).toEqual([])
        expect(yield* inProject(work, resolve(work, chat)).pipe(Effect.flip).pipe(Effect.map((e) => e._tag))).toBe(
          "SessionRunnerModel.ModelUnavailableError",
        )
      }),
    ),
  )

  it.effect("keeps a bound project's discovered models while an unrelated account is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [work, unbound] = yield* projects(["work", "unbound"])
        const credentials = Context.get(work.context, Credential.Service)
        const accounts = yield* connect(credentials).pipe(Effect.provideContext(work.context))

        // The work account discovered this provider's endpoints, but the global selection now
        // points at the personal account, so it is the active connection neither project wants.
        yield* credentials.activate(accounts.personal.id).pipe(Effect.provideContext(work.context))
        yield* inProject(work, discover(accounts.work, "Work"))
        yield* inProject(unbound, discover(accounts.work, undefined))

        expect(yield* inProject(work, available(work))).toEqual([providerID])
        // Unbound discovery still belongs to the previously active account, so it must be dropped.
        expect(yield* inProject(unbound, available(unbound))).toEqual([])
      }),
    ),
  )
})
