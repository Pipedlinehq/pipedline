/**
 * Loyalty's public surface. Anything a route, a server action or another module may call is
 * named here; the points ledger's internals (points.ts) are not exported at all.
 */
export * from './module';

// Programme, tiers, rewards (console).
export {
  type ProgramView,
  type RewardView,
  type TierView,
  deleteTier,
  getProgram,
  getProgramSettings,
  listRewards,
  programInput,
  rewardInput,
  saveProgram,
  saveReward,
  saveTier,
  tierInput,
} from './program';

// Joining.
export { type EnrolResult, type EnrolVia, counterEnrolInput, enrolAtCounter, enrolFromCheckout, importMember, importMemberInput, joinInput, joinLoyalty } from './enrol';

// Earning. earnForSale is what the ledger hook runs; it is exported for back-office scripts, not for routes.
export { type BackfillResult, type EarnOutcome, type SaleForEarning, backfillEarning, backfillInput, earnForSale, pointsFor } from './earning';

// Redeeming. The adjuster is registered with ordering; expireStaleRedemptions is the sweep job's work.
export {
  type RedemptionView,
  expireStaleRedemptions,
  forceConfirmInput,
  forceConfirmRedemption,
  issueRedemption,
  issueRedemptionInput,
  loyaltyAdjuster,
  rewardCheckoutCode,
  voidRedemption,
  voidRedemptionInput,
} from './redemption';

export { type AdjustResult, adjustPoints, adjustPointsInput, memberStatusInput, setMemberStatus } from './adjust';

// Reads: the guest's own account, staff lookups, the programme in numbers.
export {
  type AccountDetail,
  type CounterRedemption,
  type HistoryEntry,
  type LookupResult,
  type LoyaltySummary,
  type MemberAccount,
  type MemberCard,
  type MemberSummary,
  type MyLoyalty,
  type RewardOption,
  getAccount,
  getLoyaltySummary,
  getMemberCard,
  getMyLoyalty,
  getMyLoyaltyHistory,
  historyInput,
  listCounterRedemptions,
  listMembers,
  listMembersInput,
  lookupInput,
  lookupMember,
  memberCardInput,
  searchMembers,
  searchMembersInput,
  summaryInput,
} from './reads';

// Scheduled work. The functions are what the jobs run inside a worker's tenant transaction.
export {
  awardBirthdayBonuses,
  birthdayBonusJob,
  birthdayBonusSchedule,
  expirePoints,
  expirePointsJob,
  expirePointsSchedule,
  refreshTiers,
  sweepRedemptionsJob,
  sweepRedemptionsSchedule,
} from './jobs';

export * from './templates';
export * from './tools';
import './hooks';
