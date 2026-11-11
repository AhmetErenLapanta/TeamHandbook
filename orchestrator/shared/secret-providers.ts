/** The places a secret's value is read from, for the server and the screens alike; a test holds the server's providers to this list. */
export const SECRET_PROVIDER_KINDS = ["vault", "env", "op"] as const;
export type SecretProviderKind = (typeof SECRET_PROVIDER_KINDS)[number];

/** Where a value is read from: kept as it is written, since it holds no secret itself. */
export interface SecretReference {
  provider: SecretProviderKind;
  reference: string;
}

/** A setting that takes a secret: the value itself, kept in the vault, or a reference read when it is needed. */
export type SettingsSecretValue = { literal: string } | SecretReference;
