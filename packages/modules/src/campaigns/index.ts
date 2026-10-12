/** Campaigns' public surface: what the console, the worker, the hub and other modules may call. */
export * from './module';
export * from './settings';
export * from './templates';

// Segments (guest lists): the plain query language or a rule tree, counts, stored and default lists.
export {
  type SegmentLeaf,
  type SegmentPreview,
  type SegmentQuery,
  type SegmentRule,
  type SegmentUsage,
  type SegmentView,
  RFM_SEGMENTS,
  SYSTEM_SEGMENTS,
  compileSegmentRule,
  deleteSegment,
  ensureSystemSegments,
  getSegment,
  isQueryRule,
  isSegmentMember,
  listSegments,
  parseSegmentRule,
  previewSegment,
  previewSegmentInput,
  saveSegment,
  saveSegmentInput,
  segmentNames,
  segmentRule,
  segmentUsage,
} from './segments';
export * from './segment-tools';

// Lifecycle flows: the console's list and switches, the run, the approved-batch send.
export {
  type FlowBatchPayload,
  type FlowConfig,
  type FlowKey,
  type FlowTemplate,
  type FlowView,
  type VenueRunResult,
  FLOW_BATCH_APPROVAL,
  FLOW_KEYS,
  FLOW_TEMPLATES,
  INITIAL_FLOW_VERSION,
  effectiveMode,
  effectiveModeAt,
  ensureFlows,
  flowBatchSendJob,
  flowConfig,
  flowRunJob,
  listFlows,
  pinFlowTemplate,
  pinFlowTemplateInput,
  runFlowNow,
  runFlows,
  sendFlowBatch,
  setFlowMode,
  setFlowModeInput,
  updateFlow,
  updateFlowInput,
} from './flows';

// One-off campaigns.
export {
  type CampaignResults,
  type CampaignStatus,
  type CampaignView,
  CAMPAIGN_SEND_APPROVAL,
  campaignSendJob,
  cancelCampaign,
  draftCampaign,
  draftCampaignInput,
  getCampaign,
  getCampaignResults,
  listCampaigns,
  listCampaignsInput,
  sendCampaignWave,
  submitCampaign,
  updateCampaign,
  updateCampaignInput,
} from './campaigns';

export { type CampaignCopy, campaignCopySchema, draftCampaignCopy, draftCopyInput, redactContacts } from './copy';
export * from './jobs';
export * from './tools';
import './hooks';
