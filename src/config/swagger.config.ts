import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Name of the bearer auth scheme registered on the Swagger document. Must match
 * the `authScheme` used by the `Swagger` decorator and any `@ApiBearerAuth()`.
 */
export const JWT_AUTH_SCHEME = 'JWT-auth';

/**
 * Configures and mounts the Swagger UI for the provided NestJS application.
 * Served at `/docs`; the single bearer scheme matches the `AccessTokenGuard` JWT.
 */
export const initializeSwagger = (app: INestApplication) => {
  const config = new DocumentBuilder()
    .setTitle('Cue API')
    .setDescription('HTTP contract for the Cue iOS planner app.')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter the Cue JWT issued by POST /auth/apple',
        in: 'header',
      },
      // This name must match @ApiBearerAuth() / the Swagger decorator authScheme.
      JWT_AUTH_SCHEME,
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Cue API Swagger',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
};
