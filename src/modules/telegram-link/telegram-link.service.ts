import { Injectable } from '@nestjs/common';

import { TelegramLinkDatabaseService } from '@/modules/database/services';

/**
 * Service handling the user-to-Telegram chat linking flow.
 * Skeleton — deep-link token exchange and unlink flows land in later steps.
 */
@Injectable()
export class TelegramLinkService {
  constructor(
    private readonly telegramLinkDatabaseService: TelegramLinkDatabaseService,
  ) {}
}
