import { WellKnownController } from './well-known.controller';

describe('WellKnownController', () => {
  describe('getAppleAppSiteAssociation', () => {
    it('returns the AASA document scoped to the Cue app and linking deep link', () => {
      const controller = new WellKnownController();

      const aasa = controller.getAppleAppSiteAssociation();

      expect(aasa).toEqual({
        applinks: {
          details: [
            {
              appIDs: ['5LKD4S53RU.makarov.cue'],
              components: [
                {
                  '/': '/app/telegram/link',
                  '?': { code: '?*' },
                },
              ],
            },
          ],
        },
      });
    });
  });
});
