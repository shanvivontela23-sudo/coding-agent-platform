# Product 03B — invites, members, and signed-in polish

Approved scope for this PR:

- Owner-created organization invitations for `developer` and `rep` only, expiring after seven days.
- First-time authenticated users with a confirmed matching email see explicit Accept, Decline, or create-own-organization choices.
- Exactly two new invitation `SECURITY DEFINER` functions: list invitations for a verified confirmed email, and accept one specific invitation.
- Wrong-email acceptance, unconfirmed email, owner invitations, expired invitations, and invitation reuse are rejected.
- Members list and pending invitations stay tenant-scoped; caught API errors are logged as structured, secret-free server-side events.
- Applied migrations are immutable: `0001_tenant_core.sql` is never edited; this PR adds `0002_organization_invitations.sql` only.
- Signed-in shell polish: Dhara + organization in the sidebar; signed-in email plus initials avatar in the user menu; Sign out and System/Light/Dark theme controls in that menu.
- User-facing copy contains no build-process wording. Empty project state is: `No projects yet. Connect a repository to get started.`
- Signed-in heading scale is approximately 24px / 18px / 16px while login and onboarding keep the larger scale.

## Approved design-token adjustments

The supplied palette is preserved except where WCAG contrast required the explicitly approved minimal changes:

- Light success: `#1A7F4B` -> `#1A7E4A`.
- Light warning: `#B45309` -> `#B35209`.
- Light accent-button text uses `#FAFAF7` instead of pure white.
- Dark accent hover is derived as an 88% sRGB mix of dark accent `#5EC4B6` with dark page `#14171A`, producing `#55AFA3`.

Decorative `--border` keeps the original subtle values (`#E4E2DC` light, `#2C3238` dark) and is intentionally exempt from contrast enforcement. Interactive `--border-control` and the focus ring use `#8D8C88` light and `#666A6E` dark and must reach at least 3:1 against page, card, and sidebar surfaces.
