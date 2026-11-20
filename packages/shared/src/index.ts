export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export const documentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const maxTitleLength = 100;
export const maxGuestNameLength = 32;
export const guestColors = ['#7c3aed', '#b91c1c', '#0369a1', '#047857', '#a16207', '#be185d'] as const;

export const wire = { sync: 0, awareness: 1, queryAwareness: 3 } as const;

export function isDocumentSummary(value: unknown): value is DocumentSummary {
  return !!value && typeof value === 'object' &&
    'id' in value && typeof value.id === 'string' && documentIdPattern.test(value.id) &&
    'title' in value && typeof value.title === 'string' &&
    'updatedAt' in value && typeof value.updatedAt === 'string';
}
