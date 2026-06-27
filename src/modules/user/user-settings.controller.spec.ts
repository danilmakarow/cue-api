import { UserSettingsController } from './user-settings.controller';
import { UserService } from './user.service';
import { User } from '@/modules/database/entities';

/**
 * Builds the controller over a mocked {@link UserService}, so the GET/PATCH
 * `/users/me/settings` surface (the user account-settings endpoints behind
 * `AccessTokenGuard`) is exercised in isolation: GET maps the injected current
 * user, PATCH delegates to `updateSettings` and maps the PERSISTED row (not the
 * inbound dto), which is what makes a no-op PATCH return the unchanged row.
 */
const buildController = () => {
  const userService = {
    updateSettings: jest.fn(),
  };
  const controller = new UserSettingsController(
    userService as unknown as UserService,
  );

  return { controller, userService };
};

const userWith = (overrides: Partial<User>): User =>
  ({
    id: 'user-1',
    timezone: 'UTC',
    displayName: 'Jane',
    avatarBase64: null,
    morningBriefEnabled: true,
    eveningRecapEnabled: true,
    ...overrides,
  }) as User;

describe('UserSettingsController', () => {
  it('GET returns the full account-settings shape', () => {
    const { controller } = buildController();

    expect(controller.get(userWith({ timezone: 'Europe/Moscow' }))).toEqual({
      timezone: 'Europe/Moscow',
      displayName: 'Jane',
      avatarBase64: null,
      morningBriefEnabled: true,
      eveningRecapEnabled: true,
    });
  });

  it('PATCH delegates to updateSettings and returns the PERSISTED row', async () => {
    const { controller, userService } = buildController();

    // The service is the source of truth for what landed — the controller maps
    // its returned row, not the inbound dto.
    userService.updateSettings.mockResolvedValue(
      userWith({ timezone: 'Europe/Berlin', displayName: 'Jane Appleseed' }),
    );

    const result = await controller.update(userWith({}), {
      timezone: 'Europe/Berlin',
      displayName: 'Jane Appleseed',
    });

    expect(userService.updateSettings).toHaveBeenCalledWith('user-1', {
      timezone: 'Europe/Berlin',
      displayName: 'Jane Appleseed',
    });
    expect(result).toMatchObject({
      timezone: 'Europe/Berlin',
      displayName: 'Jane Appleseed',
    });
  });

  it('PATCH with an unchanged timezone round-trips it (service no-op returns the row as-is)', async () => {
    const { controller, userService } = buildController();

    userService.updateSettings.mockResolvedValue(userWith({ timezone: 'UTC' }));

    const result = await controller.update(userWith({}), { timezone: 'UTC' });

    expect(result).toMatchObject({ timezone: 'UTC' });
  });
});
