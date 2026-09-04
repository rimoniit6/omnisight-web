export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'IGNORED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const isLeadStatus = (value: string): value is LeadStatus =>
  (LEAD_STATUSES as readonly string[]).includes(value);
