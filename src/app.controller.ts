import { Controller, Get } from '@nestjs/common';

/**
 * Root application controller exposing basic infrastructure endpoints.
 * Currently only hosts the health-check route used by probes and load balancers.
 */
@Controller()
export class AppController {
  /**
   * Health-check endpoint returning a stable OK payload for probes.
   */
  @Get('health')
  getHealth() {
    return 'OK';
  }
}
