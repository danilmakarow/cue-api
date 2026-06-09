import { ApiProperty } from '@nestjs/swagger';

/**
 * Base shape of a `nestjs-paginate` page response, used by `ApiUnifiedResponse`
 * to document paginated endpoints. The concrete `data` item type is grafted on
 * per endpoint via the decorator's `allOf` composition.
 */
export class PaginationBaseResponseDto {
  data: unknown[];

  @ApiProperty({
    example: {
      itemsPerPage: 20,
      totalItems: 42,
      currentPage: 2,
      totalPages: 3,
      sortBy: [],
      searchBy: [],
      search: '',
      filter: {},
    },
  })
  meta: object;

  @ApiProperty({
    example: {
      first: 'http://127.0.0.1:3000?page=1&limit=20',
      previous: 'http://127.0.0.1:3000?page=1&limit=20',
      current: 'http://127.0.0.1:3000?page=2&limit=20',
      next: 'http://127.0.0.1:3000?page=3&limit=20',
      last: 'http://127.0.0.1:3000?page=3&limit=20',
    },
  })
  links: object;
}
