import { paginate, PaginateConfig, PaginateQuery } from 'nestjs-paginate';
import { Column, Order } from 'nestjs-paginate/lib/helper';
import { Repository } from 'typeorm';
import { EntityTarget } from 'typeorm/common/EntityTarget';
import { EntityManager } from 'typeorm/entity-manager/EntityManager';

import { BaseEntity } from '../entities';
import { IPaginationOptions } from '../types/repository.types';

/**
 * Maximum number of items allowed per page in pagination queries.
 */
export const OFFSET_MAX = 100;

/**
 * Default number of items per page when no explicit limit is specified.
 */
export const OFFSET_DEFAULT = 25;

/**
 * Base repository class providing common database operations for all entities.
 * Extends TypeORM's Repository with pagination, filtering, and utility helpers.
 */
export class BaseRepository<
  TEntity extends BaseEntity,
> extends Repository<TEntity> {
  constructor(entity: EntityTarget<TEntity>, entityManager: EntityManager) {
    super(entity, entityManager);
  }

  /**
   * Retrieves all property keys from the entity metadata.
   * Used for dynamic query building and field selection.
   */
  private getEntityKeys() {
    return Object.keys(this.metadata.propertiesMap) as Array<keyof TEntity>;
  }

  /**
   * Calculates skip and take values for pagination based on page and offset options.
   * Clamps the take value to OFFSET_MAX to prevent excessive reads.
   */
  private calculatePagination(options?: IPaginationOptions) {
    const page = options?.page || 1;
    let take = options?.offset;

    if (!take || take > OFFSET_MAX) {
      take = OFFSET_MAX;
    }

    const skip = (page - 1) * take;

    return { skip, take };
  }

  /**
   * Filters entity keys to exclude the provided fields plus all relation keys.
   */
  protected excludeSelect(excludeKeys: Array<keyof TEntity>) {
    const relationKeys = this.metadata.relations.map(
      (relation) => relation.propertyPath,
    );
    const excludeList = [...excludeKeys, ...relationKeys];

    return this.getEntityKeys().filter((key) => !excludeList.includes(key));
  }

  /**
   * Retrieves paginated results using nestjs-paginate with per-entity configuration overrides.
   */
  getPaginated(
    query: PaginateQuery,
    config?: Partial<PaginateConfig<TEntity>>,
  ) {
    const mergedConfig: PaginateConfig<TEntity> = {
      sortableColumns: ['id', 'updatedAt', 'createdAt'] as Column<TEntity>[],
      defaultSortBy: [['id', 'DESC']] as Order<TEntity>[],
      maxLimit: OFFSET_MAX,
      defaultLimit: OFFSET_DEFAULT,
      ...config,
    };

    return paginate(query, this, mergedConfig);
  }
}
