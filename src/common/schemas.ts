import { z } from 'zod';

/** `:id` route params. Usage: `@Param(new ZodValidationPipe(IdParamSchema)) { id }: IdParam` */
export const IdParamSchema = z.object({ id: z.uuid('Invalid id') });
export type IdParam = z.infer<typeof IdParamSchema>;

/** `?page=&limit=` for list endpoints. */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof PaginationSchema>;

/** The `{ data, total, page, limit }` shape every list endpoint returns. */
export interface Paginated<T> extends Pagination {
  data: T[];
  total: number;
}
