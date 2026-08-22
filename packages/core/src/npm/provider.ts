import { maxSatisfying, valid } from "semver";
import { z } from "zod";
import type { PackageCoordinate } from "../domain.js";
import {
  type HttpErrorKind,
  type JsonHttpClient,
  SafeHttpClient,
  SafeHttpError,
} from "../http/safe-http-client.js";
import { cancellationError, type OperationContext, throwIfCancelled } from "../operation.js";
import { parseStrictIsoTimestamp, validClockValue } from "../time.js";

const lifecycleNames = ["preinstall", "install", "postinstall", "prepack", "prepare"] as const;

const registryTimestampSchema = z
  .string()
  .refine((value) => parseStrictIsoTimestamp(value) !== undefined, {
    message: "Invalid registry timestamp.",
  });

const versionDocumentSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    deprecated: z.string().optional(),
    repository: z
      .union([
        z.string(),
        z.object({ type: z.string().optional(), url: z.string().optional() }).passthrough(),
      ])
      .optional(),
    scripts: z.record(z.string(), z.unknown()).optional(),
    dist: z
      .object({
        tarball: z.string().optional(),
        integrity: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const packumentSchema = z
  .object({
    name: z.string().min(1),
    "dist-tags": z.record(z.string(), z.string()),
    versions: z.record(z.string(), versionDocumentSchema),
    time: z.record(z.string(), registryTimestampSchema).optional(),
  })
  .passthrough();

export interface NpmPackageMetadata {
  name: string;
  requestedSpec: string;
  resolvedVersion: string;
  packagePublishedAt?: string;
  releasePublishedAt?: string;
  deprecated?: string;
  repositoryUrl?: string;
  lifecycleScripts: string[];
  dist?: {
    integrity?: string;
    tarball?: string;
  };
}

export type NpmProviderResult =
  | { ok: true; status: "ok"; fetchedAt: string; data: NpmPackageMetadata }
  | { ok: false; status: HttpErrorKind; fetchedAt: string; message: string };

const cachedNpmResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("ok"),
    fetchedAt: registryTimestampSchema,
    data: z
      .object({
        name: z.string().min(1),
        requestedSpec: z.string(),
        resolvedVersion: z.string().min(1),
        packagePublishedAt: registryTimestampSchema.optional(),
        releasePublishedAt: registryTimestampSchema.optional(),
        deprecated: z.string().optional(),
        repositoryUrl: z
          .string()
          .refine((value) => !hasUrlCredentials(value))
          .optional(),
        lifecycleScripts: z.array(z.enum(lifecycleNames)),
        dist: z
          .object({
            integrity: z.string().optional(),
            tarball: z
              .string()
              .refine((value) => !hasUrlCredentials(value))
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export function parseCachedNpmResult(value: unknown): NpmProviderResult {
  return cachedNpmResultSchema.parse(value) as NpmProviderResult;
}

export function npmResultForCache(
  result: Extract<NpmProviderResult, { ok: true }>,
): Extract<NpmProviderResult, { ok: true }> {
  const { dist, repositoryUrl: _repositoryUrl, ...publicData } = result.data;
  const repositoryUrl = safePublicUrl(result.data.repositoryUrl);
  const tarball = safePublicUrl(dist?.tarball);
  const publicDist = dist
    ? {
        ...(dist.integrity ? { integrity: dist.integrity } : {}),
        ...(tarball ? { tarball } : {}),
      }
    : undefined;
  return {
    ...result,
    data: {
      ...publicData,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(publicDist ? { dist: publicDist } : {}),
    },
  };
}

function safePublicUrl(value: string | undefined): string | undefined {
  return value && !hasUrlCredentials(value) ? value : undefined;
}

function hasUrlCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/iu.test(value);
  }
}

export interface NpmRegistryProviderOptions {
  httpClient?: JsonHttpClient;
  now?: () => Date;
  registryUrl?: string;
}

export class NpmRegistryProvider {
  readonly id = "npm";
  readonly #httpClient: JsonHttpClient;
  readonly #now: () => Date;
  readonly #registryUrl: URL;

  constructor(options: NpmRegistryProviderOptions = {}) {
    this.#httpClient = options.httpClient ?? new SafeHttpClient();
    this.#now = options.now ?? (() => new Date());
    this.#registryUrl = normalizeRegistryUrl(options.registryUrl ?? "https://registry.npmjs.org/");
  }

  async getPackage(
    input: PackageCoordinate,
    options: OperationContext = {},
  ): Promise<NpmProviderResult> {
    try {
      throwIfCancelled(options);
      const document = await this.#httpClient.getJson(packageUrl(this.#registryUrl, input.name), {
        signal: options.signal,
      });
      throwIfCancelled(options);
      const packument = packumentSchema.parse(document);
      if (packument.name !== input.name) {
        return failure(
          "invalid_response",
          "Registry package name did not match the request.",
          validClockValue(this.#now(), "Provider clock"),
        );
      }

      const resolvedVersion = resolveVersion(packument, input.requestedSpec);
      if (!resolvedVersion) {
        return failure(
          "not_found",
          "Requested package version or selector was not found.",
          validClockValue(this.#now(), "Provider clock"),
        );
      }
      const version = packument.versions[resolvedVersion];
      if (!version || version.name !== input.name || version.version !== resolvedVersion) {
        return failure(
          "invalid_response",
          "Registry version metadata was inconsistent.",
          validClockValue(this.#now(), "Provider clock"),
        );
      }

      const repositoryUrl = normalizeRepository(version.repository);
      const lifecycleScripts = lifecycleNames.filter(
        (name) => typeof version.scripts?.[name] === "string",
      );
      const dist = normalizeDist(version.dist);

      return {
        fetchedAt: validClockValue(this.#now(), "Provider clock"),
        ok: true,
        status: "ok",
        data: {
          name: input.name,
          requestedSpec: input.requestedSpec,
          resolvedVersion,
          ...(packument.time?.created ? { packagePublishedAt: packument.time.created } : {}),
          ...(packument.time?.[resolvedVersion]
            ? { releasePublishedAt: packument.time[resolvedVersion] }
            : {}),
          ...(version.deprecated ? { deprecated: version.deprecated } : {}),
          ...(repositoryUrl ? { repositoryUrl } : {}),
          lifecycleScripts,
          ...(dist ? { dist } : {}),
        },
      };
    } catch (error) {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      if (error instanceof SafeHttpError) {
        return failure(error.kind, error.message, validClockValue(this.#now(), "Provider clock"));
      }
      if (error instanceof z.ZodError) {
        return failure(
          "invalid_response",
          "Registry returned metadata with an invalid shape.",
          validClockValue(this.#now(), "Provider clock"),
        );
      }
      return failure(
        "provider_error",
        "Registry evaluation failed.",
        validClockValue(this.#now(), "Provider clock"),
      );
    }
  }
}

function normalizeRegistryUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new TypeError("Registry URL must not contain credentials.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError("Registry URL must use HTTPS.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function packageUrl(registry: URL, packageName: string): URL {
  const encoded = packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
  return new URL(encoded, registry);
}

function resolveVersion(
  packument: z.infer<typeof packumentSchema>,
  selector: string,
): string | undefined {
  if (selector === "" || selector === "*" || selector === "latest") {
    return packument["dist-tags"].latest;
  }
  const exact = valid(selector);
  if (exact) return packument.versions[exact] ? exact : undefined;
  const tagged = packument["dist-tags"][selector];
  if (tagged) return tagged;
  return maxSatisfying(Object.keys(packument.versions), selector) ?? undefined;
}

function normalizeRepository(
  repository: z.infer<typeof versionDocumentSchema>["repository"],
): string | undefined {
  if (typeof repository === "string") return repository;
  return repository?.url;
}

function normalizeDist(
  dist: z.infer<typeof versionDocumentSchema>["dist"],
): NpmPackageMetadata["dist"] | undefined {
  if (!dist?.integrity && !dist?.tarball) return undefined;
  return {
    ...(dist.integrity ? { integrity: dist.integrity } : {}),
    ...(dist.tarball ? { tarball: dist.tarball } : {}),
  };
}

function failure(status: HttpErrorKind, message: string, fetchedAt: string): NpmProviderResult {
  return { fetchedAt, ok: false, status, message };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
