import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type RequestContext = { requestId: string };

export function createRequestContext(request: IncomingMessage): RequestContext {
  const supplied = request.headers["x-request-id"];
  return {
    requestId: typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied) ? supplied : `req_${randomUUID()}`,
  };
}
