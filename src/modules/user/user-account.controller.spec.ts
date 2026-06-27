import { UserAccountController } from './user-account.controller';
import { UserService } from './user.service';
import { User } from '@/modules/database/entities';

/**
 * Builds the {@link UserAccountController} over a mocked {@link UserService} so
 * the `DELETE /users/me` route (account deletion behind `AccessTokenGuard`) is
 * exercised in isolation: it must delegate to `deleteAccount` with the current
 * user's id and acknowledge with `{ ok: true }`.
 */
const buildController = () => {
  const userService = {
    deleteAccount: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new UserAccountController(
    userService as unknown as UserService,
  );

  return { controller, userService };
};

describe('UserAccountController', () => {
  it('DELETE delegates to deleteAccount and acknowledges with { ok: true }', async () => {
    const { controller, userService } = buildController();

    const result = await controller.delete({ id: 'user-1' } as User);

    expect(userService.deleteAccount).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ ok: true });
  });
});
