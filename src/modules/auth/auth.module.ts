import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AppleTokenVerifier } from './apple-token.verifier';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DevAuthController } from './dev-auth.controller';
import { EnvironmentVariables } from '@/config/env.config';
import { AccessTokenGuard } from '@/guards/access-token.guard';
import { DevOnlyGuard } from '@/guards/dev-only.guard';
import { DatabaseModule } from '@/modules/database/database.module';

/**
 * Auth module — wires Apple Sign-In exchange, JWT issuance/verification,
 * and exposes the `AccessTokenGuard` globally so feature controllers can
 * apply it with `@UseGuards(AccessTokenGuard)` without re-importing.
 */
@Global()
@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (
        configService: ConfigService<EnvironmentVariables, true>,
      ) => ({
        secret: configService.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController, DevAuthController],
  providers: [AuthService, AppleTokenVerifier, AccessTokenGuard, DevOnlyGuard],
  exports: [AuthService, AccessTokenGuard, JwtModule],
})
export class AuthModule {}
