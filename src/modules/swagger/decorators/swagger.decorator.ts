import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiOperationOptions } from '@nestjs/swagger/dist/decorators/api-operation.decorator';

import { JWT_AUTH_SCHEME } from '@/config/swagger.config';
import {
  ApiUnifiedResponse,
  ApiUnifiedResponseDecoratorOptions,
} from '@/modules/swagger/decorators/unified-api-response.decorator';

/**
 * Options for the composite `Swagger` decorator. Extends `ApiOperationOptions`
 * (summary, description, deprecated, …) with response, query, body, and auth
 * configuration so a single decorator documents an endpoint end to end.
 */
export interface SwaggerOptions extends ApiOperationOptions {
  // Response options
  responseDto?: ApiUnifiedResponseDecoratorOptions['dto'];
  isResponseArray?: ApiUnifiedResponseDecoratorOptions['isArray'];
  isResponsePaginated?: ApiUnifiedResponseDecoratorOptions['isPaginated'];
  responseStatus?: ApiUnifiedResponseDecoratorOptions['status'];
  responseDescription?: ApiUnifiedResponseDecoratorOptions['description'];

  // Query params DTO (each decorated property becomes a query parameter).
  queryParamsDto?: Type;

  // Request body DTO (usually inferred from the @Body() param, but explicit when needed).
  requestDto?: Type;

  // Auth options — cue-api has a single bearer scheme.
  disableAuth?: boolean;
  authScheme?: typeof JWT_AUTH_SCHEME;

  // Tags for grouping endpoints in the Swagger UI.
  tag?: string | string[];
}

/**
 * Composite decorator that applies the Swagger decorators an endpoint needs:
 * operation metadata, bearer auth, response schema, query params, and request body.
 */
export const Swagger = (options: SwaggerOptions) => {
  const {
    responseDto,
    isResponseArray,
    isResponsePaginated,
    responseStatus,
    responseDescription,
    queryParamsDto,
    requestDto,
    disableAuth,
    authScheme = JWT_AUTH_SCHEME,
    tag,
    ...apiOperationOptions
  } = options;
  const decorators = [ApiOperation(apiOperationOptions)];

  if (tag) {
    const normalizedTags = Array.isArray(tag) ? tag : [tag];

    decorators.push(ApiTags(...normalizedTags));
  }

  if (!disableAuth) {
    decorators.push(ApiBearerAuth(authScheme));
  }

  if (responseDto) {
    decorators.push(
      ApiUnifiedResponse({
        dto: responseDto,
        isArray: isResponseArray,
        isPaginated: isResponsePaginated,
        status: responseStatus,
        description: responseDescription,
      }),
    );
  }

  if (queryParamsDto) {
    decorators.push(ApiQuery({ type: queryParamsDto }));
  }

  if (requestDto) {
    decorators.push(ApiBody({ type: requestDto }));
  }

  return applyDecorators(...decorators);
};
