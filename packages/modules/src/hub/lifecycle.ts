import { onOrgClosing } from '../onboarding/offboarding';
import { revokeAllAgentKeys } from './keys';

/**
 * An org that leaves the platform keeps no way in: every assistant key, signed-in assistant and
 * service key is revoked in the same transaction that closes it (onboarding.closeOrg).
 */
onOrgClosing(async (ctx) => {
  await revokeAllAgentKeys(ctx, 'org_closed');
});
