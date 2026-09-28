/** Small diagnostic categories shared by validation, file import, and registration. */
export type ProfileErrorCode = "invalid_json" | "unsupported_schema" | "invalid_structure" | "invalid_geometry" | "invalid_tiling" | "invalid_policy" | "unresolved_reference" | "duplicate_id";

/** A profile failure with a stable category and a human-readable explanation. */
export class ProfileError extends Error {
  /** Construct a diagnosable profile error without storing imported payloads.
   * @param code - Failure stage/category.
   * @param message - Human-readable validation or registry explanation.
   */
  constructor(public readonly code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** Label a validation stage while preserving already classified failures.
 * @param code - Category to attach to ordinary validator errors.
 * @param validate - Pure validation operation.
 * @returns Normalized validated data.
 * @throws ProfileError with the original human-readable explanation.
 */
export function profileValidation<T>(code: ProfileErrorCode, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError(code, error instanceof Error ? error.message : "Invalid profile data");
  }
}
