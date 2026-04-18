import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from './base.entity';
import { User } from './user.entity';

/**
 * Enumeration of supported device platforms for push notification tokens.
 */
export enum DevicePlatform {
  IOS = 'ios',
  IPADOS = 'ipados',
  MACOS = 'macos',
}

/**
 * Device entity representing a client device registered for push notifications.
 * Stores APNs tokens and associates them with their owning user. A single user may have many devices.
 */
@Entity()
export class Device extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.devices, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ unique: true })
  apnsToken: string;

  @Column({ type: 'enum', enum: DevicePlatform })
  platform: DevicePlatform;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;
}
