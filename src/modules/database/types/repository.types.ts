/**
 * Interface defining pagination options for database queries.
 */
export interface IPaginationOptions {
  page?: number;
  offset?: number;
}

/**
 * Interface defining the structure of paginated data responses.
 */
export interface IPaginatedData<TEntity> {
  data: TEntity[];
  total: number;
}
