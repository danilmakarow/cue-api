import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * TelegramLink entity representing a one-to-one binding between a Cue user and a Telegram chat.
 * Used to deliver Telegram-channel notifications and to authenticate inbound bot messages.
 */
@Entity()
export class TelegramLink extends BaseEntity {
  @Column({ unique: true })
  userId: string;

  @ManyToOne(() => User, (user) => user.telegramLinks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Telegram chat id. TypeORM's bigint driver returns string values for Postgres bigint columns,
   * so we store and handle this field as a string end-to-end.
   */
  @Column({ type: 'bigint' })
  telegramChatId: string;

  @Column({ type: String, nullable: true })
  telegramUsername: string | null;

  @Column({ type: 'timestamptz' })
  linkedAt: Date;
}
