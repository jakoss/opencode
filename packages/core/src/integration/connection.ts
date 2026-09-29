export * as IntegrationConnection from "./connection.js"

import { Connection } from "@opencode/schema/connection"

export const CredentialInfo = Connection.CredentialInfo
export type CredentialInfo = Connection.CredentialInfo

export const EnvInfo = Connection.EnvInfo
export type EnvInfo = Connection.EnvInfo

export const Info = Connection.Info
export type Info = Connection.Info

export const Status = Connection.Status
export type Status = Connection.Status

/** Identity of an access choice; labels and refreshed token values do not identify a new connection. */
export function key(
  connection:
    | { readonly type: "credential"; readonly id: string }
    | { readonly type: "env"; readonly name: string }
    | undefined,
) {
  if (!connection) return undefined
  return connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`
}

/**
 * Connections a config `account` label names, ignoring case. An unbound provider matches its first
 * connection, the globally active one. Anything other than exactly one is a failure the caller reports:
 * an ambiguous name must not silently retarget another account.
 */
export function match(connections: readonly Info[], account: string | undefined) {
  if (account === undefined) return connections.slice(0, 1)
  const wanted = account.toLowerCase()
  return connections.filter(
    (connection) => connection.type === "credential" && connection.label.toLowerCase() === wanted,
  )
}
