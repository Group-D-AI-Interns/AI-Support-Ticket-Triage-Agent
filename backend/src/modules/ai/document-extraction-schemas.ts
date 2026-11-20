import * as z from 'zod';
import type { ApprovedExtractionSchemas } from './provider-document-extraction.adapter.js';

/** Candidate shapes only. All extracted values still require explicit administrator review. */
export const documentExtractionSchemas: ApprovedExtractionSchemas = {
  response_time: { description: 'An explicitly stated first-response target expressed in hours; never invent a value.',
    payload: z.strictObject({ targetHours: z.number().finite().nonnegative() }) },
  document_clause: { description: 'A useful policy, support instruction or troubleshooting clause. Copy the original wording verbatim into text and excerpt; do not invent instructions.',
    payload: z.strictObject({ text: z.string().trim().min(1).max(2_000) }) },
};
