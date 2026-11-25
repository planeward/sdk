/**
 * App-declared permissions. An app serves its declaration at
 * `GET {experience origin}/.well-known/planeward-permissions`; a 404 means it
 * declares none. Planeward reads it, lets the workspace grant each key, and
 * puts the viewer's granted keys in the viewer token's `permissions` claim.
 */

/** Where Planeward reads the declaration, on the Experience URL's origin. */
export const PLANEWARD_PERMISSIONS_PATH =
  "/.well-known/planeward-permissions" as const;

/** Dotted lowercase key, e.g. `posts.moderate` or `billing.view_invoices`. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const PERMISSION_KEY_MAX_LENGTH = 64;
export const PERMISSION_NAME_MAX_LENGTH = 60;
export const PERMISSION_DESCRIPTION_MAX_LENGTH = 200;
/** Per list (`dashboard`, `community`). */
export const PERMISSIONS_MAX_PER_LIST = 25;

export type PlanewardPermissionDefault = "on" | "off";

export type PlanewardPermissionEntry = {
  /** Matches {@link PERMISSION_KEY_PATTERN}, at most 64 characters, unique in its list. */
  key: string;
  /** 1–60 characters, shown to the people who grant it. */
  name: string;
  /** Up to 200 characters. */
  description?: string;
  /** What the key resolves to before anyone grants or denies it. */
  default: PlanewardPermissionDefault;
};

/** The endpoint's response, as Planeward reads it (a missing list is `[]`). */
export type PlanewardPermissionsResponse = {
  /** Granted per workspace role; checked in dashboard tokens. */
  dashboard: PlanewardPermissionEntry[];
  /** Granted to @everyone, membership plans and staff roles; checked in experience tokens. */
  community: PlanewardPermissionEntry[];
};

/** What {@link definePermissions} accepts: either list may be left out. */
export type PlanewardPermissionsDefinition = {
  dashboard?: readonly PlanewardPermissionEntry[];
  community?: readonly PlanewardPermissionEntry[];
};

/** The union of keys a definition declares, for typing `can()` calls. */
export type PlanewardPermissionKey<T extends PlanewardPermissionsDefinition> =
  | NonNullable<T["dashboard"]>[number]["key"]
  | NonNullable<T["community"]>[number]["key"];

/**
 * Types the body of `/.well-known/planeward-permissions` and returns it
 * unchanged. Keys keep their literal types, so `PlanewardPermissionKey<typeof
 * permissions>` names them. Check the result with `planeward permissions`.
 */
export function definePermissions<
  const T extends PlanewardPermissionsDefinition,
>(permissions: T): T {
  return permissions;
}

export type ValidatePermissionsResult =
  | { ok: true; value: PlanewardPermissionsResponse }
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateEntry(
  value: unknown,
  path: string,
  errors: string[]
): PlanewardPermissionEntry | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object.`);
    return null;
  }
  const before = errors.length;
  const { key, name, description } = value;

  if (typeof key !== "string") {
    errors.push(`${path}.key: must be a string.`);
  } else if (key.length > PERMISSION_KEY_MAX_LENGTH) {
    errors.push(
      `${path}.key: must be at most ${PERMISSION_KEY_MAX_LENGTH} characters.`
    );
  } else if (!PERMISSION_KEY_PATTERN.test(key)) {
    errors.push(
      `${path}.key: "${key}" must be dotted lowercase segments, like "posts.moderate".`
    );
  }

  if (typeof name !== "string") {
    errors.push(`${path}.name: must be a string.`);
  } else if (!name.trim()) {
    errors.push(`${path}.name: can't be empty.`);
  } else if (name.length > PERMISSION_NAME_MAX_LENGTH) {
    errors.push(
      `${path}.name: must be at most ${PERMISSION_NAME_MAX_LENGTH} characters.`
    );
  }

  if (description !== undefined) {
    if (typeof description !== "string") {
      errors.push(`${path}.description: must be a string.`);
    } else if (description.length > PERMISSION_DESCRIPTION_MAX_LENGTH) {
      errors.push(
        `${path}.description: must be at most ${PERMISSION_DESCRIPTION_MAX_LENGTH} characters.`
      );
    }
  }

  if (value.default !== "on" && value.default !== "off") {
    errors.push(`${path}.default: must be "on" or "off".`);
  }

  if (errors.length > before) return null;
  return {
    key: key as string,
    name: name as string,
    ...(description === undefined
      ? {}
      : { description: description as string }),
    default: value.default as PlanewardPermissionDefault,
  };
}

function validateList(
  value: unknown,
  list: keyof PlanewardPermissionsResponse,
  errors: string[]
): PlanewardPermissionEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${list}: must be an array.`);
    return [];
  }
  if (value.length > PERMISSIONS_MAX_PER_LIST) {
    errors.push(
      `${list}: at most ${PERMISSIONS_MAX_PER_LIST} permissions (got ${value.length}).`
    );
  }
  const entries: PlanewardPermissionEntry[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const entry = validateEntry(item, `${list}[${index}]`, errors);
    if (!entry) return;
    if (seen.has(entry.key)) {
      errors.push(`${list}[${index}].key: "${entry.key}" is listed twice.`);
    }
    seen.add(entry.key);
    entries.push(entry);
  });
  return entries;
}

/**
 * Checks a permissions response against Planeward's rules and returns the
 * normalized value (both lists present, unknown fields dropped) or every
 * problem found, each prefixed with its path (`community[2].key: …`).
 */
export function validatePermissionsResponse(
  json: unknown
): ValidatePermissionsResult {
  if (!isRecord(json)) {
    return {
      ok: false,
      errors: [
        '(root): must be a JSON object like { "dashboard": [], "community": [] }.',
      ],
    };
  }
  const errors: string[] = [];
  const dashboard = validateList(json.dashboard, "dashboard", errors);
  const community = validateList(json.community, "community", errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { dashboard, community } };
}

/**
 * Whether the viewer was granted `key`: true only when the token's
 * `permissions` claim lists it. A token from a host without the claim grants
 * nothing.
 */
export function can(
  claims: { readonly permissions?: readonly string[] } | null | undefined,
  key: string
): boolean {
  return claims?.permissions?.includes(key) ?? false;
}
