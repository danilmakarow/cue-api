import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import {
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { PaginationBaseResponseDto } from '@/modules/swagger/dtos/pagination-base-response.dto';

/**
 * Configuration for documenting a single endpoint response.
 *
 * Unlike the upstream `ownership-monitor-api` helper this is ported from, cue-api
 * returns DTOs verbatim — there is no `{ status, data }` envelope interceptor — so
 * the generated schema references the DTO directly. `isPaginated` documents the
 * `nestjs-paginate` `{ data, meta, links }` shape.
 */
export interface ApiUnifiedResponseDecoratorOptions {
  dto: Type;
  isArray?: boolean;
  isPaginated?: boolean;
  status?: number | 'default' | '1XX' | '2XX' | '3XX' | '4XX' | '5XX';
  description?: string;
}

/**
 * Generates the Swagger response schema for an endpoint that returns a DTO,
 * an array of DTOs, or a `nestjs-paginate` page of DTOs.
 */
export const ApiUnifiedResponse = (
  options: ApiUnifiedResponseDecoratorOptions,
) => {
  const { dto, isArray, isPaginated, status, description } = options;

  if (isPaginated) {
    const page: SchemaObject = {
      allOf: [
        { $ref: getSchemaPath(PaginationBaseResponseDto) },
        {
          properties: {
            data: { type: 'array', items: { $ref: getSchemaPath(dto) } },
          },
        },
      ],
    };

    return applyDecorators(
      ApiExtraModels(dto, PaginationBaseResponseDto),
      ApiResponse({
        status: status ?? HttpStatus.OK,
        description,
        schema: page,
      }),
    );
  }

  const item: ReferenceObject = { $ref: getSchemaPath(dto) };
  const schema: SchemaObject | ReferenceObject = isArray
    ? { type: 'array', items: item }
    : item;

  return applyDecorators(
    ApiExtraModels(dto),
    ApiResponse({ status: status ?? HttpStatus.OK, description, schema }),
  );
};
