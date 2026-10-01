/** Offers' public surface: what a route, a server action or another module may call. */
export * from './module';

// Offer definitions (console).
export { type OfferKind, type OfferView, type OrderChannel, type PublicOfferView, getOffer, getPublicOffer, listOffers, offerInput, saveOffer } from './definitions';

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
export { type CodeCheck, checkCode, checkCodeInput, offersAdjuster, redeemAtCounterInput, redeemCodeAtCounter } from './redeem';

export { type OfferStats, type OffersSummary, getOffersSummary, offersSummaryInput, offersSummaryTool } from './summary';
export * from './jobs';
export * from './templates';
import './hooks';
