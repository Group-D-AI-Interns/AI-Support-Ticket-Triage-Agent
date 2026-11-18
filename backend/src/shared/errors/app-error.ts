import type { FieldError } from "../contracts/api.ts";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields: FieldError[] | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    fields?: FieldError[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
    this.name = "AppError";
  }
}
