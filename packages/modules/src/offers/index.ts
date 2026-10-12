/** Offers' public surface: what a route, a server action or another module may call. */
export * from './module';

// Offer definitions (console): the model, its status, the plain-words summary.
export {
  type ListOffersOptions,
  type OfferAppliesTo,
  type OfferAudience,
  type OfferInput,
  type OfferKind,
  type OfferMethod,
  type OfferStatus,
  type OfferView,
  type OrderChannel,
  type PublicOfferView,
  type SummaryExtras,
  categoryWords,
  clockWords,
  daysWords,
  getOffer,
  getPublicOffer,
  listOffers,
  offerInput,
  offerStatus,
  offerSummary,
  offersUsingList,
  saveOffer,
  switchOffer,
} from './definitions';

// Codes: issuing (flows, campaigns, a manager), the public sign-up and claim pages, the console list.
// expireCodes is the expiry job's work.
export {
  type BulkIssueResult,
  type CodeStatus,
  type CodeView,
  type IssueResult,
  claimCode,
  expireCodes,
  issueCode,
  issueCodeInput,
  issueCodes,
  issueCodesInput,
  listCodes,
  listCodesInput,
  listMyCodes,
  previewCode,
  requestCodeInput,
  requestOfferCode,
  voidCode,
  voidCodeInput,
} from './codes';

// Redeeming. The adjuster is registered with ordering; the till path runs from the ledger hook.
export { type CodeCheck, checkCode, checkCodeInput, codeCombinesWith, offersAdjuster, redeemAtCounterInput, redeemCodeAtCounter } from './redeem';

// Eligibility and automatic offers: what ordering calls beside the code adjusters (see CLAUDE.md).
export { type OfferClass, type UseMoment, automaticAdjustments, canCombine, combinesWithApplied, offerBlockedReason, offerClass, offerUseCount } from './eligibility';

// Surcharges: their own object; ordering applies them through applicableSurcharges.
export {
  type ApplicableSurcharge,
  type DocketLine,
  type SurchargeInput,
  type SurchargeKind,
  type SurchargeView,
  AU_NATIONAL_PUBLIC_HOLIDAYS,
  CARD_SURCHARGE_BAN_DATE,
  CARD_SURCHARGE_BAN_SOURCE,
  CARD_SURCHARGE_REFUSAL,
  applicableSurcharges,
  deleteSurcharge,
  getSurcharge,
  isCardSurchargeName,
  listSurcharges,
  percentWords,
  publicHolidayName,
  saveSurcharge,
  surchargeAmountCents,
  surchargeDocketLines,
  surchargeDocketText,
  surchargeInput,
  surchargeNotice,
  surchargeNoticeLine,
  whenWords,
} from './surcharges';

export { type OfferStats, type OffersSummary, getOffersSummary, offersSummaryInput, offersSummaryTool } from './summary';
export * from './tools';
export * from './jobs';
export * from './templates';
import './hooks';
