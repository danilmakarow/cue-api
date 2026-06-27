import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ description: 'Apple `sub` claim from Sign in with Apple.' })
  @Column({ unique: true })
  appleUserId: string;

  @ApiProperty({ nullable: true, example: 'jane@example.com' })
  @Column({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ nullable: true, example: 'Jane Appleseed' })
  @Column({ type: String, nullable: true })
  displayName: string | null;

  /**
   * Base64-encoded profile picture. Sourced from the iOS "me" contact photo at
   * sign-in time (Apple Sign-In doesn't expose a profile picture directly).
   * Stored as `text` because PostgreSQL varchar lengths don't fit encoded images.
   */
  @ApiProperty({
    nullable: true,
    description: 'Base64-encoded profile picture (no data-URL prefix).',
  })
  @Column({ type: 'text', nullable: true })
  avatarBase64: string | null;

  @ApiProperty({ example: 'Europe/Berlin' })
  @Column({ default: 'UTC' })
  timezone: string;

  /**
   * Whether the user opts in to the morning-brief notification. Cross-device
   * preference (D8); onboarding-completion stays iOS-local @AppStorage.
   */
  @ApiProperty({ example: true })
  @Column({ default: true })
  morningBriefEnabled: boolean;

  /**
   * Whether the user opts in to the evening-recap notification. Cross-device
   * preference (D8); onboarding-completion stays iOS-local @AppStorage.
   */
  @ApiProperty({ example: true })
  @Column({ default: true })
  eveningRecapEnabled: boolean;

  @OneToMany(() => Device, (device) => device.user)
  devices: Device[];

  @OneToMany(() => TelegramLink, (telegramLink) => telegramLink.user)
  telegramLinks: TelegramLink[];

  @OneToMany(() => Calendar, (calendar) => calendar.owner)
  calendars: Calendar[];
}
