export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiError {
  success: false;
  error: string;
  code?: string;
  details?: ApiFieldError[];
}

export const success = <T>(data: T): ApiSuccess<T> => ({ success: true, data });

export const failure = (error: string, code?: string, details?: ApiFieldError[]): ApiError => ({
  success: false,
  error,
  ...(code && { code }),
  ...(details && { details }),
});
