export type FieldError = { field: string; message: string };

export type ApiError = {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: FieldError[];
  };
};

export type ApiSuccess<T> = { data: T; requestId: string };

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type PaginatedSuccess<T> = {
  data: T[];
  pagination: { page: number; pageSize: number; total: number };
  requestId: string;
};

export type SuccessEnvelope<T> = { data: T; requestId: string };
export type PaginatedEnvelope<T> = { data: T[]; pagination: { page: number; pageSize: number; total: number }; requestId: string };
