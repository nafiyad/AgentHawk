import { z } from "zod";

export const dependencySectionSchema = z.enum([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
export type DependencySection = z.infer<typeof dependencySectionSchema>;

const maximumDirectDependencies = 64;
const dependencyMapSchema = z.record(z.string().min(1).max(214), z.string().min(1).max(2_048));

export const packageManifestSchema = z
  .object({
    name: z.string().min(1).optional(),
    dependencies: dependencyMapSchema.optional(),
    devDependencies: dependencyMapSchema.optional(),
    optionalDependencies: dependencyMapSchema.optional(),
    peerDependencies: dependencyMapSchema.optional(),
  })
  .passthrough()
  .superRefine((manifest, context) => {
    const count = dependencySectionSchema.options.reduce(
      (total, section) => total + Object.keys(manifest[section] ?? {}).length,
      0,
    );
    if (count > maximumDirectDependencies) {
      context.addIssue({
        code: "custom",
        message: "package.json may contain at most 64 direct dependencies.",
      });
    }
  });
export type PackageManifest = z.infer<typeof packageManifestSchema>;

export const dependencyChangeSchema = z
  .object({
    name: z.string().min(1),
    section: dependencySectionSchema,
    requestedSpec: z.string().min(1),
    kind: z.enum(["added", "version_changed", "section_changed"]),
    previousSection: dependencySectionSchema.optional(),
    previousSpec: z.string().min(1).optional(),
  })
  .strict();
export type DependencyChange = z.infer<typeof dependencyChangeSchema>;

export interface DirectDependency {
  name: string;
  section: DependencySection;
  requestedSpec: string;
}

const sections = dependencySectionSchema.options;

export function directDependencies(manifest: PackageManifest): DirectDependency[] {
  const parsed = packageManifestSchema.parse(manifest);
  const dependencies: DirectDependency[] = [];
  for (const section of sections) {
    for (const [name, requestedSpec] of Object.entries(parsed[section] ?? {})) {
      dependencies.push({ name, requestedSpec, section });
    }
  }
  return dependencies.sort(compareDependency);
}

export function compareDirectDependencies(
  baseManifest: PackageManifest,
  currentManifest: PackageManifest,
): DependencyChange[] {
  const base = groupByName(directDependencies(baseManifest));
  const current = directDependencies(currentManifest);
  const changes: DependencyChange[] = [];

  for (const dependency of current) {
    const previous = choosePrevious(base.get(dependency.name), dependency.section);
    if (!previous) {
      changes.push({ ...dependency, kind: "added" });
    } else if (previous.requestedSpec !== dependency.requestedSpec) {
      changes.push({
        ...dependency,
        kind: "version_changed",
        previousSection: previous.section,
        previousSpec: previous.requestedSpec,
      });
    } else if (previous.section !== dependency.section) {
      changes.push({
        ...dependency,
        kind: "section_changed",
        previousSection: previous.section,
        previousSpec: previous.requestedSpec,
      });
    }
  }

  return changes.sort(compareDependency);
}

function groupByName(dependencies: DirectDependency[]): Map<string, DirectDependency[]> {
  const grouped = new Map<string, DirectDependency[]>();
  for (const dependency of dependencies) {
    const values = grouped.get(dependency.name) ?? [];
    values.push(dependency);
    grouped.set(dependency.name, values);
  }
  return grouped;
}

function choosePrevious(
  candidates: DirectDependency[] | undefined,
  currentSection: DependencySection,
): DirectDependency | undefined {
  return candidates?.find((candidate) => candidate.section === currentSection) ?? candidates?.[0];
}

function compareDependency(
  left: Pick<DirectDependency, "name" | "section">,
  right: Pick<DirectDependency, "name" | "section">,
): number {
  return left.name.localeCompare(right.name) || left.section.localeCompare(right.section);
}
