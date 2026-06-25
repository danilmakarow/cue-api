import { UserSettingsController } from './user-settings.controller';
import { UserService } from './user.service';
import { User } from '@/modules/database/entities';

/**
 * Builds the controller over a mocked {@link UserService}, so the GET/PATCH
 * `/users/me/settings` surface (the user-timezone endpoint behind
 * `AccessTokenGuard`) is exercised in isolation: GET maps the injected current
 * user, PATCH delegates to `updateSettings` and maps the PERSISTED row (not the
 * inbound dto), which is what makes a no-op PATCH return the unchanged zone.
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

const userWith = (timezone: string): User =>
  ({ id: 'user-1', timezone }) as User;

describe('UserSettingsController', () => {
  it('GET returns the current user account settings shape (their timezone)', () => {
    const { controller } = buildController();

    expect(controller.get(userWith('Europe/Moscow'))).toEqual({
      timezone: 'Europe/Moscow',
    });
  });

  it('PATCH delegates to updateSettings and returns the PERSISTED timezone', async () => {
    const { controller, userService } = buildController();

    // The service is the source of truth for what landed — the controller maps
    // its returned row, not the inbound dto.
    userService.updateSettings.mockResolvedValue(userWith('Europe/Berlin'));

    const result = await controller.update(userWith('UTC'), {
      timezone: 'Europe/Berlin',
    });

    expect(userService.updateSettings).toHaveBeenCalledWith('user-1', {
      timezone: 'Europe/Berlin',
    });
    expect(result).toEqual({ timezone: 'Europe/Berlin' });
  });

  it('PATCH with an unchanged timezone round-trips it (service no-op returns the row as-is)', async () => {
    const { controller, userService } = buildController();

    userService.updateSettings.mockResolvedValue(userWith('UTC'));

    const result = await controller.update(userWith('UTC'), {
      timezone: 'UTC',
    });

    expect(result).toEqual({ timezone: 'UTC' });
  });
});
