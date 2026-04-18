import { NotFoundException } from '@nestjs/common';
import { isString } from '@nestjs/common/utils/shared.utils';
import { EntityTarget } from 'typeorm/common/EntityTarget';

import { BaseEntity } from '@/modules/database/entities';

/**
 * Exception thrown when a lookup for a specific entity returns nothing.
 * Produces a readable 404 response including the entity's class name.
 */
export class EntityNotFoundException<
  Entity extends BaseEntity,
> extends NotFoundException {
  constructor(entity: EntityTarget<Entity> | { name: string }) {
    if (isString(entity)) {
      super(entity);

      return;
    }

    if ('name' in entity) {
      super(`${entity.name} was not found, or you do not have access.`);

      return;
    }

    super();
  }
}
