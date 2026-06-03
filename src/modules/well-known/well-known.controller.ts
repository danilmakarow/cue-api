import { Controller, Get, Header } from '@nestjs/common';

/**
 * Apple App Site Association app identifier in `TeamID.bundleId` form — the iOS
 * app this API claims its universal links for. Team `5LKD4S53RU`, bundle
 * `makarov.cue`.
 */
const APPLE_APP_ID = '5LKD4S53RU.makarov.cue';

/**
 * The Apple App Site Association (AASA) document Apple fetches over HTTPS to
 * verify which paths this domain hands off to the Cue app. Restricts the
 * handoff to the linking deep link (`/app/telegram/link?code=...`).
 */
interface AppleAppSiteAssociation {
  applinks: {
    details: {
      appIDs: string[];
      components: {
        '/': string;
        '?': { code: string };
      }[];
    }[];
  };
}

/**
 * Serves the `.well-known` documents Apple's CDN fetches over HTTPS. The API is
 * mounted at the root (no global prefix), so the well-known path resolves
 * directly.
 */
@Controller('.well-known')
export class WellKnownController {
  /**
   * Returns the Apple App Site Association document for universal-link
   * verification. Served unauthenticated as `application/json`, with no
   * redirect or file extension, per Apple's requirements.
   */
  @Get('apple-app-site-association')
  @Header('Content-Type', 'application/json')
  getAppleAppSiteAssociation(): AppleAppSiteAssociation {
    return {
      applinks: {
        details: [
          {
            appIDs: [APPLE_APP_ID],
            components: [
              {
                '/': '/app/telegram/link',
                '?': { code: '?*' },
              },
            ],
          },
        ],
      },
    };
  }
}
