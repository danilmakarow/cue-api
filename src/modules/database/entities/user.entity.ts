import { Column, Entity, OneToMany } from 'typeorm';

import { BaseEntity } from './base.entity';
import { Calendar } from './calendar.entity';
import { Device } from './device.entity';
import { TelegramLink } from './telegram-link.entity';

/**
 * User entity representing an authenticated Cue user.
 * The appleUserId column holds Apple's `sub` claim from Sign in with Apple.
 */
@Entity()
export class User extends BaseEntity {
  @Column({ unique: true })
  appleUserId: string;

  @Column({ type: String, nullable: true })
  email: string | null;

  @Column({ type: String, nullable: true })
  displayName: string | null;

  /**
   * Base64-encoded profile picture. Sourced from the iOS "me" contact photo at
   * sign-in time (Apple Sign-In doesn't expose a profile picture directly).
   * Stored as `text` because PostgreSQL varchar lengths don't fit encoded images.
   */
  @Column({ type: 'text', nullable: true })
  avatarBase64: string | null;

  @Column({ default: 'UTC' })
  timezone: string;

  @OneToMany(() => Device, (device) => device.user)
  devices: Device[];

  @OneToMany(() => TelegramLink, (telegramLink) => telegramLink.user)
  telegramLinks: TelegramLink[];

  @OneToMany(() => Calendar, (calendar) => calendar.owner)
  calendars: Calendar[];
}
