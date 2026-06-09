import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Root application controller exposing basic infrastructure endpoints.
 * Currently only hosts the health-check route used by probes and load balancers.
 */
@ApiTags('Health')
@Controller()
export class AppController {
  /**
   * Health-check endpoint returning a stable OK payload for probes.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe.' })
  @ApiOkResponse({ schema: { type: 'string', example: 'OK' } })
  getHealth() {
    return 'OK';
  }
}
