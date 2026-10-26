import {
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import { isAppViewerTokenClaims, type AppViewerTokenClaims } from "./protocol";

/**
 * The token is valid but was issued for another app. Usually the backend's
 * `PLANEWARD_APP_ID` does not match the app that the iframe belongs to.
 */
export class PlanewardTokenAudienceError extends Error {
  override readonly name = "PlanewardTokenAudienceError";
  /** The `aud` claim from the token, read without trusting it. */
  readonly tokenAudience: string;
  /** The app id this backend verified against. */
  readonly expectedAppId: string;

  constructor(tokenAudience: string, expectedAppId: string) {
    super(
      `Token is for app "${tokenAudience}", but this backend expects "${expectedAppId}". Check PLANEWARD_APP_ID.`
    );
    this.tokenAudience = tokenAudience;
    this.expectedAppId = expectedAppId;
  }
}

/** Verify with an explicit key set. Internal seam shared by the server entry and tests. */
export async function verifyPlanewardTokenWithKeys(
  token: string,
  keys: JWTVerifyGetKey,
  options: { appId: string; issuer: string }
): Promise<AppViewerTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      audience: options.appId,
      issuer: options.issuer,
      algorithms: ["RS256"],
    }));
  } catch (error) {
    if (
      error instanceof errors.JWTClaimValidationFailed &&
      error.claim === "aud"
    ) {
      throw new PlanewardTokenAudienceError(
        unverifiedAudience(token),
        options.appId
      );
    }
    throw error;
  }
  const claims = normalizeAudience(payload, options.appId);
  if (!isAppViewerTokenClaims(claims)) {
    throw new Error("Planeward token is missing required claims.");
  }
  return claims;
}

function unverifiedAudience(token: string): string {
  // Only used in the error message; the signature has already been checked.
  const { aud } = decodeJwt(token);
  if (Array.isArray(aud)) return aud.join(", ");
  return aud ?? "(none)";
}

function normalizeAudience(payload: JWTPayload, appId: string): JWTPayload {
  // jwtVerify already checked that `aud` contains appId.
  return Array.isArray(payload.aud) ? { ...payload, aud: appId } : payload;
}
