// Production flow for a digital print job, in order.
// A job enters "receiving" once the designer uploads an approved / pre-approved PDF,
// and only leaves it when the full required quantity has been received.
export const STAGES = [
  { key: 'receiving', label: 'Qty Receiving' },
  { key: 'printing', label: 'Paper Printing' },
  { key: 'fusing', label: 'Fusing' },
  { key: 'rolling', label: 'Rolling' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'completed', label: 'Dispatched' },
];

export const APPROVAL_STATUSES = ['approved', 'preapproved'];

const STAGE_KEYS = STAGES.map((s) => s.key);

export function stageLabel(key) {
  return STAGES.find((s) => s.key === key)?.label ?? key;
}

export function nextStage(key) {
  const i = STAGE_KEYS.indexOf(key);
  if (i === -1 || i === STAGE_KEYS.length - 1) return null;
  return STAGE_KEYS[i + 1];
}

export function isFullyReceived(job) {
  return job.qty_required > 0 && job.qty_received >= job.qty_required;
}
